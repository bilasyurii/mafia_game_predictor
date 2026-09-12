import { AliveState, CandidateVote, KeepOrEliminateVote, PlayerId } from "./types";

/**
 * Deterministic day-voting rules: validating a public voting observation and
 * working out what it decided. No probabilities, no roles, no Bayesian
 * logic, and never mutates AliveState.
 *
 * Every function takes `alive` explicitly - the alive state at the moment of
 * that vote, which is not necessarily the current one.
 */

/** One candidate's result in a CandidateVote, in call order. */
export interface CandidateTally {
  candidate: PlayerId;
  /** As publicly observed. */
  raisedHands: PlayerId[];
  /** Inferred by the abstention rule - only ever non-empty for the last candidate called. */
  abstentionVotes: PlayerId[];
  /** raisedHands.length + abstentionVotes.length */
  count: number;
}

export interface CandidateVoteTally {
  /** Same order as vote.candidates. */
  candidates: CandidateTally[];
  /** Living players who raised no hand for any candidate. */
  abstainers: PlayerId[];
}

export type CandidateVoteOutcome =
  | { kind: "winner"; candidate: PlayerId }
  /** Every candidate sharing the highest count, in call order. */
  | { kind: "tie"; candidates: PlayerId[] };

export interface KeepOrEliminateTally {
  eliminate: PlayerId[];
  /** Living players who raised no hand to eliminate. */
  keep: PlayerId[];
}

export type KeepOrEliminateOutcome = {
  kind: "eliminateAll" | "keepAll";
  candidates: PlayerId[];
};

function livingPlayers(alive: AliveState): PlayerId[] {
  return Object.keys(alive).filter((p) => alive[p] === true);
}

function assertLivingParticipant(
  alive: AliveState,
  player: PlayerId,
  what: string
): void {
  if (alive[player] !== true) {
    throw new Error(`${what} "${player}" is not a living player`);
  }
}

/**
 * Candidates must be living, listed once, and at least `minimum` of them -
 * 1 for an initial vote, 2 for a revote or keep/eliminate vote (which only
 * ever follow a tie).
 */
function validateCandidates(
  candidates: PlayerId[],
  alive: AliveState,
  minimum: number
): void {
  if (candidates.length < minimum) {
    throw new Error(
      `expected at least ${minimum} candidate(s), got ${candidates.length}`
    );
  }
  const seen = new Set<PlayerId>();
  candidates.forEach((candidate) => {
    if (seen.has(candidate)) {
      throw new Error(`candidate "${candidate}" is listed more than once`);
    }
    seen.add(candidate);
    assertLivingParticipant(alive, candidate, "candidate");
  });
}

/**
 * Throws unless the observation could have happened: every hand is for a
 * listed candidate, every voter is alive, and no voter raised a hand more
 * than once in this voting round.
 */
export function validateCandidateVote(
  vote: CandidateVote,
  alive: AliveState
): void {
  validateCandidates(vote.candidates, alive, vote.stage === "revote" ? 2 : 1);

  const voted = new Set<PlayerId>();
  Object.entries(vote.handsRaised).forEach(([candidate, voters]) => {
    if (!vote.candidates.includes(candidate)) {
      throw new Error(`hands raised for "${candidate}", who is not a candidate`);
    }
    (voters ?? []).forEach((voter) => {
      assertLivingParticipant(alive, voter, "voter");
      if (voted.has(voter)) {
        throw new Error(
          `voter "${voter}" raised a hand more than once in round ${vote.round} (${vote.stage})`
        );
      }
      voted.add(voter);
    });
  });
}

/**
 * Validates, then counts: raised hands as observed, plus every abstainer's
 * vote for the last candidate called.
 */
export function tallyCandidateVote(
  vote: CandidateVote,
  alive: AliveState
): CandidateVoteTally {
  validateCandidateVote(vote, alive);

  const voted = new Set(
    Object.values(vote.handsRaised).flatMap((voters) => voters ?? [])
  );
  const abstainers = livingPlayers(alive).filter((p) => !voted.has(p));
  const last = vote.candidates[vote.candidates.length - 1];

  return {
    candidates: vote.candidates.map((candidate) => {
      const raisedHands = vote.handsRaised[candidate] ?? [];
      const abstentionVotes = candidate === last ? abstainers : [];
      return {
        candidate,
        raisedHands,
        abstentionVotes,
        count: raisedHands.length + abstentionVotes.length,
      };
    }),
    abstainers,
  };
}

/** A unique highest count wins, with no majority requirement; otherwise a tie. */
export function resolveCandidateVote(
  vote: CandidateVote,
  alive: AliveState
): CandidateVoteOutcome {
  const { candidates } = tallyCandidateVote(vote, alive);
  const highest = Math.max(...candidates.map((c) => c.count));
  const top = candidates
    .filter((c) => c.count === highest)
    .map((c) => c.candidate);
  return top.length === 1
    ? { kind: "winner", candidate: top[0] }
    : { kind: "tie", candidates: top };
}

/**
 * Throws unless the observation could have happened: every eliminate hand
 * belongs to a living player who raised it at most once.
 */
export function validateKeepOrEliminateVote(
  vote: KeepOrEliminateVote,
  alive: AliveState
): void {
  validateCandidates(vote.candidates, alive, 2);

  const seen = new Set<PlayerId>();
  vote.eliminateHands.forEach((voter) => {
    assertLivingParticipant(alive, voter, "voter");
    if (seen.has(voter)) {
      throw new Error(
        `voter "${voter}" raised a hand more than once in round ${vote.round} (keepOrEliminate)`
      );
    }
    seen.add(voter);
  });
}

/** Validates, then splits living players into eliminate (raised) and keep (didn't). */
export function tallyKeepOrEliminateVote(
  vote: KeepOrEliminateVote,
  alive: AliveState
): KeepOrEliminateTally {
  validateKeepOrEliminateVote(vote, alive);
  const eliminate = new Set(vote.eliminateHands);
  return {
    eliminate: [...vote.eliminateHands],
    keep: livingPlayers(alive).filter((p) => !eliminate.has(p)),
  };
}

/** Eliminate all only if eliminate strictly outnumbers keep; a tie keeps all. */
export function resolveKeepOrEliminateVote(
  vote: KeepOrEliminateVote,
  alive: AliveState
): KeepOrEliminateOutcome {
  const { eliminate, keep } = tallyKeepOrEliminateVote(vote, alive);
  return {
    kind: eliminate.length > keep.length ? "eliminateAll" : "keepAll",
    candidates: [...vote.candidates],
  };
}
