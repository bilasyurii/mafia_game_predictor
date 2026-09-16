import { EvidenceContext, ObservationHandler } from "./evidence";
import { InvestigationReport, World } from "./types";
import { hasMechanic } from "./roles";
import { getInvestigationResult } from "./investigation";

/** Either a fixed number, or a function computed from the full evidence. */
export type InvestigationReportLikelihood =
  | number
  | ((observation: InvestigationReport, world: World, ctx: EvidenceContext) => number);

/**
 * Configurable parameters for scoring an InvestigationReport. Three buckets,
 * not two: whether world.roles[actor] holds `observation.mechanic` and
 * whether observation.result matches what the check would really return
 * (getInvestigationResult) are two independent facts, but they only produce
 * three behaviorally distinct situations - see createInvestigationReportHandler.
 * None of these are a behavioral claim about real players; just three
 * injectable values until real calibration exists.
 */
export interface InvestigationReportLikelihoodParams {
  /** P(observation | actor can perform the mechanic AND the result is correct) */
  truthful: InvestigationReportLikelihood;
  /** P(observation | actor can perform the mechanic AND the result is wrong) - a lie about a real check */
  falseResult: InvestigationReportLikelihood;
  /**
   * P(observation | actor cannot perform the mechanic in this world) - a
   * bluff. Applies regardless of whether the claimed result happens to
   * match reality: an actor without the mechanic has no access to the
   * target's true role, so their report can't be conditioned on it - a
   * "lucky" and an "unlucky" bluff are the same event from their
   * perspective, and MUST be scored identically (never 0, since anyone
   * can bluff).
   */
  bluff: InvestigationReportLikelihood;
}

function resolve(
  value: InvestigationReportLikelihood,
  observation: InvestigationReport,
  world: World,
  ctx: EvidenceContext
): number {
  return typeof value === "function" ? value(observation, world, ctx) : value;
}

/**
 * Builds the InvestigationReport handler for a given set of parameters.
 * Dispatches on two mechanical, world-derived facts - never a role name,
 * never a behavioral guess:
 *  - canPerform: does world.roles[actor] hold observation.mechanic?
 *  - matchesActual: does observation.result equal what the check would
 *    really return against world.roles[target] in this world?
 */
export function createInvestigationReportHandler(
  params: InvestigationReportLikelihoodParams
): ObservationHandler<InvestigationReport> {
  return (observation, world, ctx) => {
    const canPerform = hasMechanic(
      ctx.roles,
      world.roles[observation.actor],
      observation.mechanic
    );
    if (!canPerform) {
      return resolve(params.bluff, observation, world, ctx);
    }

    const matchesActual =
      getInvestigationResult(
        ctx.roles,
        observation.mechanic,
        world.roles[observation.target]
      ) === observation.result;

    return matchesActual
      ? resolve(params.truthful, observation, world, ctx)
      : resolve(params.falseResult, observation, world, ctx);
  };
}
