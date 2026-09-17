import { EvidenceContext, ObservationHandler } from "./evidence";
import { CandidateVote, PlayerId, World } from "./types";
import { sameTeam } from "./roles";
import { tallyCandidateVote } from "./voting";

/**
 * Either a fixed number, or a function computed from the full evidence PLUS
 * `voter` - the specific living player this factor is being scored for.
 * `voter` is required, not optional: one CandidateVote covers many voters at
 * once (see createCandidateVoteHandler's per-voter loop below), so a
 * function-valued factor that wants to condition on the ACTOR's own role
 * (e.g. "how a Mafia voter behaves" vs "how a Town voter behaves" - see
 * behavioralModel.ts) has no other way to know which voter it is currently
 * being asked about; `observation`/`world`/`ctx` alone never identify one.
 * A callback that ignores `voter` (as every existing test-only function
 * value in this codebase does) remains valid - TypeScript/JS allow calling a
 * function with more arguments than it declares.
 */
export type CandidateVoteLikelihood =
  | number
  | ((observation: CandidateVote, world: World, ctx: EvidenceContext, voter: PlayerId) => number);

/**
 * Configurable parameters for scoring a CandidateVote. Three buckets, one
 * per living voter's choice: a candidate on their own team, a candidate on
 * a different team, or abstaining (no target to compare teams against, so
 * it isn't split further - see the module doc for why). Not a behavioral
 * claim about real players; three injectable values (or functions) until
 * real calibration exists.
 */
export interface CandidateVoteLikelihoodParams {
  /** P(a living voter raises a hand for a candidate on their own team), per voter */
  sameTeamVote: CandidateVoteLikelihood;
  /** P(a living voter raises a hand for a candidate on a different team), per voter */
  differentTeamVote: CandidateVoteLikelihood;
  /** P(a living voter abstains), per voter */
  abstain: CandidateVoteLikelihood;
}

function resolve(
  value: CandidateVoteLikelihood,
  observation: CandidateVote,
  world: World,
  ctx: EvidenceContext,
  voter: PlayerId
): number {
  return typeof value === "function" ? value(observation, world, ctx, voter) : value;
}

/**
 * Builds the CandidateVote handler for a given set of parameters.
 *
 * A CandidateVote is one public event covering every living voter at once,
 * not one observation per voter. This handler scores it as the PRODUCT of
 * each living voter's own factor (their team relative to whoever they
 * raised a hand for, or the flat abstain factor) - an explicit independence
 * assumption between voters, chosen as the smallest workable model, not a
 * claim that real voters (e.g. coordinating mafia members) actually act
 * independently. A joint, correlation-aware model is a legitimate future
 * refinement that would replace only this function's body.
 *
 * Deliberately does NOT call resolveCandidateVote: the winner/tie is a
 * deterministic function of the same raised hands already scored below, so
 * scoring it too would double-count the identical event. Only the raw
 * hands (via tallyCandidateVote, which also provides validation and the
 * abstainer list) are ever consulted.
 */
export function createCandidateVoteHandler(
  params: CandidateVoteLikelihoodParams
): ObservationHandler<CandidateVote> {
  return (observation, world, ctx) => {
    const tally = tallyCandidateVote(observation, ctx.alive);

    let likelihood = 1;
    tally.candidates.forEach((candidateTally) => {
      candidateTally.raisedHands.forEach((voter) => {
        const factor = sameTeam(
          ctx.roles,
          world.roles[voter],
          world.roles[candidateTally.candidate]
        )
          ? params.sameTeamVote
          : params.differentTeamVote;
        likelihood *= resolve(factor, observation, world, ctx, voter);
      });
    });
    tally.abstainers.forEach((voter) => {
      likelihood *= resolve(params.abstain, observation, world, ctx, voter);
    });

    return likelihood;
  };
}
