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
