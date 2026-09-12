import { EvidenceContext, ObservationHandler } from "./evidence";
import { SelfRoleClaim, World } from "./types";
import { satisfiedBy } from "./roleGroups";

/** Either a fixed number, or a function computed from the full evidence. */
export type SelfRoleClaimLikelihood =
  | number
  | ((observation: SelfRoleClaim, world: World, ctx: EvidenceContext) => number);

/**
 * Configurable parameters for scoring a SelfRoleClaim. These are NOT a
 * behavioral claim about how honest players are - just two injectable
 * values, kept separate from any specific number, until real calibration
 * (data, or a deliberate design choice) exists. Each may be a plain number
 * for the simple case, or a function when the likelihood needs to depend
 * on the actor, the claimed/actual role, public state, or prior
 * observations.
 */
export interface SelfRoleClaimLikelihoodParams {
  /** P(observation | claim is satisfied by world.roles[actor]) */
  truthful: SelfRoleClaimLikelihood;
  /** P(observation | claim is not satisfied by world.roles[actor]) */
  false: SelfRoleClaimLikelihood;
}

function resolve(
  value: SelfRoleClaimLikelihood,
  observation: SelfRoleClaim,
  world: World,
  ctx: EvidenceContext
): number {
  return typeof value === "function" ? value(observation, world, ctx) : value;
}

/**
 * Builds the SelfRoleClaim handler for a given set of parameters. The
 * handler itself only distinguishes two cases - truthful vs. false - per
 * this step's scope; it does not model *why* a claim might be false (bluff
 * vs. mistake), and doesn't learn or adapt on its own.
 */
export function createSelfRoleClaimHandler(
  params: SelfRoleClaimLikelihoodParams
): ObservationHandler<SelfRoleClaim> {
  return (observation, world, ctx) =>
    satisfiedBy(observation.claim, world.roles[observation.actor], ctx.groups)
      ? resolve(params.truthful, observation, world, ctx)
      : resolve(params.false, observation, world, ctx);
}
