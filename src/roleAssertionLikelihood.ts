import { EvidenceContext, ObservationHandler } from "./evidence";
import { RoleAssertion, World } from "./types";
import { satisfiedBy } from "./roleGroups";

/** Either a fixed number, or a function computed from the full evidence. */
export type RoleAssertionLikelihood =
  | number
  | ((observation: RoleAssertion, world: World, ctx: EvidenceContext) => number);

/**
 * Configurable parameters for scoring a RoleAssertion. Same shape as
 * SelfRoleClaimLikelihoodParams: two injectable values, not a behavioral
 * claim about how reliable accusations are. Each may be a plain number, or
 * a function when the likelihood needs to depend on the actor, the target,
 * the claim, public state, or prior observations.
 */
export interface RoleAssertionLikelihoodParams {
  /** P(observation | claim is satisfied by world.roles[target]) */
  truthful: RoleAssertionLikelihood;
  /** P(observation | claim is not satisfied by world.roles[target]) */
  false: RoleAssertionLikelihood;
}

function resolve(
  value: RoleAssertionLikelihood,
  observation: RoleAssertion,
  world: World,
  ctx: EvidenceContext
): number {
  return typeof value === "function" ? value(observation, world, ctx) : value;
}

/**
 * Builds the RoleAssertion handler for a given set of parameters. The
 * handler only distinguishes whether world.roles[target] satisfies the
 * claimed expression (exact role or group); any dependence on the actor's
 * own role is left to function-valued parameters.
 */
export function createRoleAssertionHandler(
  params: RoleAssertionLikelihoodParams
): ObservationHandler<RoleAssertion> {
  return (observation, world, ctx) =>
    satisfiedBy(observation.claim, world.roles[observation.target], ctx.groups)
      ? resolve(params.truthful, observation, world, ctx)
      : resolve(params.false, observation, world, ctx);
}
