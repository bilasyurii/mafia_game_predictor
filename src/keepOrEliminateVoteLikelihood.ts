import { EvidenceContext, ObservationHandler } from "./evidence";
import { KeepOrEliminateVote, PlayerId, World } from "./types";
import { sameTeam } from "./roles";
import { tallyKeepOrEliminateVote } from "./voting";

/** Either a fixed number, or a function computed from the full evidence. */
export type KeepOrEliminateVoteLikelihood =
  | number
  | ((observation: KeepOrEliminateVote, world: World, ctx: EvidenceContext) => number);

/**
 * Configurable parameters for scoring a KeepOrEliminateVote. Unlike
 * CandidateVote, there's no single per-voter target - every living player
 * chooses only Eliminate or Keep for the same fixed group of tied
 * candidates. The one mechanically-grounded, voter-relative fact available
 * is whether the voter shares a team with at least one of those candidates
 * (mafia mutually recognize each other, so a mafia voter has certain,
 * personal knowledge of this; town voters never have that certainty about
 * anyone). Crossing that with the voter's own choice gives four buckets -
 * none of them collapse the way investigationReport's did, since a voter's
 * choice is always a real, informed option regardless of which bucket they
 * fall in. These are behavioral likelihood categories to be calibrated
 * later, not a claim about what players know or how they "should" vote.
 */
export interface KeepOrEliminateVoteLikelihoodParams {
  /** P(voter raises an eliminate hand | shares a team with >=1 candidate), per voter */
  eliminateSharedTeam: KeepOrEliminateVoteLikelihood;
  /** P(voter does not raise a hand | shares a team with >=1 candidate), per voter */
  keepSharedTeam: KeepOrEliminateVoteLikelihood;
  /** P(voter raises an eliminate hand | shares a team with no candidate), per voter */
  eliminateNoSharedTeam: KeepOrEliminateVoteLikelihood;
  /** P(voter does not raise a hand | shares a team with no candidate), per voter */
  keepNoSharedTeam: KeepOrEliminateVoteLikelihood;
}

function resolve(
  value: KeepOrEliminateVoteLikelihood,
  observation: KeepOrEliminateVote,
  world: World,
  ctx: EvidenceContext
): number {
  return typeof value === "function" ? value(observation, world, ctx) : value;
}

/**
 * Builds the KeepOrEliminateVote handler for a given set of parameters.
 *
 * Like CandidateVote, this is one public event covering every living voter
 * at once. Scored as the PRODUCT of each living voter's own factor - an
 * explicit independence assumption between voters (real coordination, e.g.
 * mafia jointly deciding to sacrifice or protect a teammate, is ignored),
 * chosen as the smallest workable model, not a claim that voters actually
 * act independently.
 *
 * Deliberately does NOT call resolveKeepOrEliminateVote: the eliminateAll/
 * keepAll outcome is a deterministic function of the same eliminateHands
 * already scored below, so scoring it too would double-count the identical
 * event. Only the raw eliminate/keep split (via tallyKeepOrEliminateVote,
 * which also provides validation) is ever consulted.
 */
export function createKeepOrEliminateVoteHandler(
  params: KeepOrEliminateVoteLikelihoodParams
): ObservationHandler<KeepOrEliminateVote> {
  return (observation, world, ctx) => {
    const tally = tallyKeepOrEliminateVote(observation, ctx.alive);

    const sharesTeamWithAnyCandidate = (voter: PlayerId): boolean =>
      observation.candidates.some((candidate) =>
        sameTeam(ctx.roles, world.roles[voter], world.roles[candidate])
      );

    let likelihood = 1;
    tally.eliminate.forEach((voter) => {
      const factor = sharesTeamWithAnyCandidate(voter)
        ? params.eliminateSharedTeam
        : params.eliminateNoSharedTeam;
      likelihood *= resolve(factor, observation, world, ctx);
    });
    tally.keep.forEach((voter) => {
      const factor = sharesTeamWithAnyCandidate(voter)
        ? params.keepSharedTeam
        : params.keepNoSharedTeam;
      likelihood *= resolve(factor, observation, world, ctx);
    });

    return likelihood;
  };
}
