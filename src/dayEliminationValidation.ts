import { AliveState, CandidateVote, DayEliminationFact, KeepOrEliminateVote, PlayerId } from "./types";
import { resolveCandidateVote, resolveKeepOrEliminateVote } from "./voting";

/**
 * Deterministic validation that a recorded dayElimination fact genuinely
 * matches what its day's votes decided - pure game-rule checking, nothing
 * to do with the old Bayesian evidence layer (which this was extracted
 * from, as `resolveDayElimination`'s likelihood handler, before this app's
 * relationship-based redesign removed the Bayesian engine entirely). A day
 * either records a further revote or the final keep-or-eliminate vote
 * after a tie - never skipped, never reordered - and the day's actual
 * elimination must equal what the LAST recorded vote of that round
 * resolved to.
 */

function sameEliminatedSet(a: PlayerId[], b: PlayerId[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const p of setA) {
    if (!setB.has(p)) return false;
  }
  return true;
}

function requiredPredecessorKind(vote: CandidateVote | KeepOrEliminateVote): "initial" | "revote" | "none" {
  if (vote.type === "candidateVote" && vote.stage === "revote") return "initial";
  if (vote.type === "keepOrEliminateVote") return "revote";
  return "none";
}

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
      throw new Error(`${subject} must be the first vote of its round, but a vote event already precedes it in round ${vote.round}`);
    }
    return;
  }

  if (precedingSameRoundVote === undefined || precedingSameRoundVote.type !== "candidateVote" || precedingSameRoundVote.stage !== requiredKind) {
    throw new Error(`${subject} must immediately follow a ${requiredKind} candidateVote of the same round`);
  }

  const outcome = resolveCandidateVote(precedingSameRoundVote, alive);
  if (outcome.kind !== "tie") {
    throw new Error(`${subject} must follow a tie, but its preceding ${requiredKind} vote had a unique winner ("${outcome.candidate}")`);
  }
  if (!sameEliminatedSet(outcome.candidates, vote.candidates)) {
    throw new Error(`${subject}'s candidates [${vote.candidates.join(", ")}] do not match the preceding tie [${outcome.candidates.join(", ")}]`);
  }
}

function expectedElimination(vote: CandidateVote | KeepOrEliminateVote, alive: AliveState): PlayerId[] {
  if (vote.type === "candidateVote") {
    const outcome = resolveCandidateVote(vote, alive);
    if (outcome.kind === "tie") {
      throw new Error(
        `round ${vote.round}'s last recorded vote (stage=${vote.stage}) ended in a tie among [${outcome.candidates.join(", ")}] with no revote or keep-or-eliminate vote recorded to resolve it`
      );
    }
    return [outcome.candidate];
  }
  const outcome = resolveKeepOrEliminateVote(vote, alive);
  return outcome.kind === "eliminateAll" ? [...outcome.candidates] : [];
}

/**
 * Throws unless `fact` is exactly what round `fact.round`'s recorded vote
 * chain (in `history`) actually decided. `alive` must be the alive state at
 * the START of `fact.round`'s day (before this elimination).
 */
export function validateDayElimination(fact: DayEliminationFact, history: readonly (CandidateVote | KeepOrEliminateVote)[], alive: AliveState): void {
  const dayVotes = history.filter((event) => event.round === fact.round);

  if (dayVotes.length === 0) {
    throw new Error(`dayElimination for round ${fact.round} has no preceding candidateVote or keepOrEliminateVote to validate against`);
  }

  dayVotes.forEach((vote, i) => validateVoteChainStep(vote, dayVotes[i - 1], alive));

  const decisive = dayVotes[dayVotes.length - 1];
  const expected = expectedElimination(decisive, alive);

  if (!sameEliminatedSet(expected, fact.eliminated)) {
    throw new Error(
      `dayElimination for round ${fact.round} (eliminated=[${fact.eliminated.join(", ")}]) is inconsistent with its resolved vote (expected=[${expected.join(", ")}])`
    );
  }
}
