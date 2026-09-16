import { EvidenceContext, ObservationHandler } from "./evidence";
import { DefendAction, NominateAction, SuspectAction, World } from "./types";
import { sameTeam } from "./roles";

/**
 * suspect/defend/nominate share one shape ({ actor, target }, nothing else)
 * and, per the role registry, no role has any mechanic tied to any of them -
 * they're pure public speech/behavior anyone can produce. The only fact a
 * candidate world can mechanically offer about them is whether actor and
 * target are on the same team - so, unlike SelfRoleClaim/RoleAssertion
 * (checked against a claim) or InvestigationReport (checked against a
 * mechanic's result), there's no separate "content" to verify here: team
 * alignment IS both the mechanical fact and the only available behavioral
 * axis.
 */
export type TeamAlignmentObservation = SuspectAction | DefendAction | NominateAction;

/** Either a fixed number, or a function computed from the full evidence. */
export type TeamAlignmentLikelihood<O extends TeamAlignmentObservation> =
  | number
  | ((observation: O, world: World, ctx: EvidenceContext) => number);

/**
 * Configurable parameters for scoring a team-alignment observation. Not a
 * behavioral claim about real players - two injectable values (or
 * functions), calibrated separately per observation type even though the
 * mechanical shape is shared.
 */
export interface TeamAlignmentLikelihoodParams<O extends TeamAlignmentObservation> {
  /** P(observation | actor and target are on the same team in this world) */
  sameTeam: TeamAlignmentLikelihood<O>;
  /** P(observation | actor and target are on different teams in this world) */
  differentTeam: TeamAlignmentLikelihood<O>;
}

function resolve<O extends TeamAlignmentObservation>(
  value: TeamAlignmentLikelihood<O>,
  observation: O,
  world: World,
  ctx: EvidenceContext
): number {
  return typeof value === "function" ? value(observation, world, ctx) : value;
}

/**
 * Builds a handler for any team-alignment observation (suspect, defend, or
 * nominate). Dispatches purely on sameTeam(ctx.roles, ...) - never a
 * literal role or team name - so the same factory works unchanged for any
 * future role/team added to the registry.
 */
export function createTeamAlignmentHandler<O extends TeamAlignmentObservation>(
  params: TeamAlignmentLikelihoodParams<O>
): ObservationHandler<O> {
  return (observation, world, ctx) =>
    sameTeam(
      ctx.roles,
      world.roles[observation.actor],
      world.roles[observation.target]
    )
      ? resolve(params.sameTeam, observation, world, ctx)
      : resolve(params.differentTeam, observation, world, ctx);
}
