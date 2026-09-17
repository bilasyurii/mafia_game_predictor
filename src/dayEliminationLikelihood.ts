import { AliveState, CandidateVote, KeepOrEliminateVote, PlayerId, World } from "./types";
import type { DayEliminationFact } from "./facts";
import type { EvidenceContext } from "./evidence";
import { resolveCandidateVote, resolveKeepOrEliminateVote } from "./voting";

function sameEliminatedSet(a: PlayerId[], b: PlayerId[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const p of setA) {
    if (!setB.has(p)) return false;
  }
  return true;
}

/**
 * The CandidateVote/KeepOrEliminateVote stage, if any, `vote` is REQUIRED to
 * immediately follow within its own round's recorded vote sequence, per
 * rules.md's narrated procedure: an initial tie is followed by a revote on
 * exactly the tied candidates, and only if THAT also ties is it followed by
 * a KeepOrEliminateVote on exactly its tied candidates - never skipped,
 * never reordered. "none" means `vote` must be its round's FIRST vote event
 * and nothing else - only an "initial" CandidateVote opens a round's voting,
 * and rules.md narrates the day's entire vote (initial, its optional
 * revote, its optional final keep-or-eliminate) as a single event, with the
 * next round beginning at night right after it: there is no second,
 * independent voting cycle within the same round.
 */
function requiredPredecessorKind(
  vote: CandidateVote | KeepOrEliminateVote
): "initial" | "revote" | "none" {
  if (vote.type === "candidateVote" && vote.stage === "revote") return "initial";
  if (vote.type === "keepOrEliminateVote") return "revote";
  return "none";
}

/**
 * Validates that a vote event legitimately follows the vote immediately
 * before it in ITS OWN round's recorded vote sequence (dayVotes, in
 * resolveDayElimination below) - never an earlier vote further back, and
 * never a later one. An "initial" vote must have no predecessor at all (it
 * opens the round, exactly once - see requiredPredecessorKind); a revote or
 * KeepOrEliminateVote must have a predecessor of the required stage that
 * resolved to a tie, with `vote.candidates` equal (as a set - order never
 * matters, and validateCandidates already rules out duplicates) to exactly
 * that tie. World-independent, and reuses resolveCandidateVote/
 * sameEliminatedSet rather than re-deriving tie outcomes. Only ever called
 * with vote events already known to belong to the same round (see
 * resolveDayElimination's own dayVotes filter) - this never re-derives
 * round membership itself.
 */
function validateVoteChainStep(
  vote: CandidateVote | KeepOrEliminateVote,
  precedingSameRoundVote: CandidateVote | KeepOrEliminateVote | undefined,
  alive: AliveState
): void {
  const requiredKind = requiredPredecessorKind(vote);
  const subject =
    vote.type === "candidateVote"
      ? vote.stage === "initial"
        ? `round ${vote.round}'s initial vote`
        : `round ${vote.round}'s revote`
      : `round ${vote.round}'s keepOrEliminateVote`;

  if (requiredKind === "none") {
    if (precedingSameRoundVote !== undefined) {
      throw new Error(
        `${subject} must be the first vote of its round, but a vote event already precedes it in round ${vote.round}`
      );
    }
    return;
  }

  if (
    precedingSameRoundVote === undefined ||
    precedingSameRoundVote.type !== "candidateVote" ||
    precedingSameRoundVote.stage !== requiredKind
  ) {
    throw new Error(
      `${subject} must immediately follow a ${requiredKind} candidateVote of the same round`
    );
  }

  const outcome = resolveCandidateVote(precedingSameRoundVote, alive);
  if (outcome.kind !== "tie") {
    throw new Error(
      `${subject} must follow a tie, but its preceding ${requiredKind} vote had a unique winner ("${outcome.candidate}")`
    );
  }
  if (!sameEliminatedSet(outcome.candidates, vote.candidates)) {
    throw new Error(
      `${subject}'s candidates [${vote.candidates.join(", ")}] do not match the preceding tie [${outcome.candidates.join(", ")}]`
    );
  }
}

/**
 * The set of players a specific day's vote chain actually resolves to
 * eliminate, per voting.ts's own deterministic rules - never reimplemented
 * here, only consulted. A CandidateVote (initial or revote) that ends in a
 * tie is not itself a resolution: a well-formed day either records a
 * further revote or the final KeepOrEliminateVote after a tie, so a tie
 * being the LAST recorded vote for a round is itself an inconsistency.
 */
function expectedElimination(
  vote: CandidateVote | KeepOrEliminateVote,
  alive: AliveState
): PlayerId[] {
  if (vote.type === "candidateVote") {
    const outcome = resolveCandidateVote(vote, alive);
    if (outcome.kind === "tie") {
      throw new Error(
        `round ${vote.round}'s last recorded vote (stage=${vote.stage}) ended in a tie among [${outcome.candidates.join(
          ", "
        )}] with no revote or keep-or-eliminate vote recorded to resolve it`
      );
    }
    return [outcome.candidate];
  }
  const outcome = resolveKeepOrEliminateVote(vote, alive);
  return outcome.kind === "eliminateAll" ? [...outcome.candidates] : [];
}

/**
 * DayEliminationFact is NOT world-dependent Bayesian evidence: who gets
 * eliminated on a given day is a deterministic function of that day's
 * already-fully-public CandidateVote/KeepOrEliminateVote observations
 * (each scored on its own terms by candidateVoteLikelihood.ts /
 * keepOrEliminateVoteLikelihood.ts) - never of the hidden role assignment.
 * So this never returns a per-world-varying number: a DayEliminationFact
 * consistent with its day's votes contributes exactly 1 (uninformative) to
 * every surviving world, and an inconsistent one is a malformed/impossible
 * history - the same class of error validateCandidateVote,
 * getHistoryBefore, and resolveNight's doctor-repeat check already throw
 * on, not something to silently zero out.
 *
 * The decisive vote for round `fact.round` is the LAST candidateVote or
 * keepOrEliminateVote of that round recorded in ctx.history (recorded
 * order is authoritative within a day - see facts.ts's getHistoryBefore).
 * This mirrors the real procedure exactly: a well-formed day's vote chain
 * (initial vote -> optional revote -> optional final keep-or-eliminate)
 * only ever continues past a tie, so its last recorded vote is always the
 * one that actually decided the day.
 *
 * Before checking the decisive vote's own outcome, every revote or
 * KeepOrEliminateVote in this round's own vote sequence is validated
 * against the vote immediately before it (validateVoteChainStep) - so an
 * illegitimate chain (a revote that isn't preceded by a matching tie, a
 * KeepOrEliminateVote that skips the required revote, etc.) is rejected
 * even if the final DayEliminationFact's own eliminated set happens to
 * look consistent with the (illegitimate) decisive vote's tally.
 *
 * `world` is unused and present only for shape-parity with every other
 * evidence handler in this codebase (ObservationHandler, NightResultHandler)
 * - this fact's likelihood is never a function of it.
 */
export function resolveDayElimination(
  fact: DayEliminationFact,
  _world: World,
  ctx: EvidenceContext
): number {
  const dayVotes = ctx.history.filter(
    (event): event is CandidateVote | KeepOrEliminateVote =>
      (event.type === "candidateVote" || event.type === "keepOrEliminateVote") &&
      event.round === fact.round
  );

  if (dayVotes.length === 0) {
    throw new Error(
      `dayElimination for round ${fact.round} has no preceding candidateVote or keepOrEliminateVote to validate against`
    );
  }

  dayVotes.forEach((vote, i) => {
    validateVoteChainStep(vote, dayVotes[i - 1], ctx.alive);
  });

  const decisive = dayVotes[dayVotes.length - 1];
  const expected = expectedElimination(decisive, ctx.alive);

  if (!sameEliminatedSet(expected, fact.eliminated)) {
    throw new Error(
      `dayElimination for round ${fact.round} (eliminated=[${fact.eliminated.join(
        ", "
      )}]) is inconsistent with its resolved vote (expected=[${expected.join(", ")}])`
    );
  }

  return 1;
}
