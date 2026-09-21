import { PlayerId } from "../types";

/**
 * Pure helpers for the in-progress candidateVote draft's handsRaised map
 * (src/app/types.ts's CandidateVoteDraft). Exist specifically to make one
 * voter belong to at most one candidate's hand IMPOSSIBLE to violate from
 * the UI, by construction - see the "voter raised a hand more than once"
 * crash this was written to fix (voting.ts's validateCandidateVote already
 * rejects that combination correctly; the bug was that the UI could build
 * it in the first place by recording each candidate's hand independently).
 */

export type HandsRaised = Partial<Record<PlayerId, PlayerId[]>>;

/**
 * Removes every voter's later occurrences, keeping only their FIRST
 * occurrence in `candidates` order. A no-op if `handsRaised` already has no
 * voter under more than one candidate. Used both to self-heal a draft saved
 * before this fix existed, and as the single source of truth the voting
 * screen reads from on every render.
 */
export function dedupeHandsRaised(candidates: PlayerId[], handsRaised: HandsRaised): HandsRaised {
  const seen = new Set<PlayerId>();
  const result: HandsRaised = {};
  candidates.forEach((candidate) => {
    result[candidate] = (handsRaised[candidate] ?? []).filter((voter) => {
      if (seen.has(voter)) return false;
      seen.add(voter);
      return true;
    });
  });
  return result;
}

/** True iff some voter appears under more than one candidate - i.e. dedupeHandsRaised would change something. */
export function handsRaisedHasDuplicateVoter(candidates: PlayerId[], handsRaised: HandsRaised): boolean {
  const deduped = dedupeHandsRaised(candidates, handsRaised);
  return candidates.some((c) => (handsRaised[c]?.length ?? 0) !== (deduped[c]?.length ?? 0));
}

/** voter -> the one candidate currently holding their hand, for every voter who has one. Assumes no duplicates (dedupe first if unsure). */
export function voterAssignments(candidates: PlayerId[], handsRaised: HandsRaised): Map<PlayerId, PlayerId> {
  const map = new Map<PlayerId, PlayerId>();
  candidates.forEach((candidate) => {
    (handsRaised[candidate] ?? []).forEach((voter) => map.set(voter, candidate));
  });
  return map;
}

/**
 * What `handsRaised` becomes after assigning `voter` to `candidate` (or,
 * with `candidate: null`, un-assigning them entirely / abstaining-for-now).
 * `voter` is removed from every candidate's hand before being added to at
 * most one, so the result can never have them under two candidates at
 * once - this is the one place a voter's hand should ever be reassigned
 * from. Assumes `handsRaised` has no pre-existing duplicates.
 */
export function assignVoterHands(candidates: PlayerId[], handsRaised: HandsRaised, voter: PlayerId, candidate: PlayerId | null): HandsRaised {
  const result: HandsRaised = {};
  candidates.forEach((c) => {
    const withoutVoter = (handsRaised[c] ?? []).filter((v) => v !== voter);
    result[c] = c === candidate ? [...withoutVoter, voter] : withoutVoter;
  });
  return result;
}
