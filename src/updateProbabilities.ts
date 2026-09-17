import { World } from "./types";
import { Evidence, EvidenceContext, LikelihoodModel } from "./evidence";

/**
 * Bayesian update: posterior(world) ∝ prior(world) × P(evidence | world),
 * renormalized so probabilities sum back to 1.
 *
 * This function is intentionally generic: it knows nothing about roles,
 * mechanics, or evidence types. All of that lives behind `model`
 * (see evidence.ts / likelihoodHandlers.ts) - adding a new role or a new
 * evidence type never requires touching this file.
 *
 * Identifiability note: because of the final renormalization, any part of
 * model.likelihood(evidence, world, ctx)'s output that is the SAME
 * multiplicative constant for every world in `worlds` has zero effect on
 * the posterior - it cancels in the division by `total`. This is not
 * specific to the constant 1 (e.g. DayEliminationFact's uninformative
 * contribution) - ANY shared constant cancels, including a uniform
 * multiplicative rescaling applied to every bucket of a configurable
 * likelihood parameter set (sameTeamVote/differentTeamVote/abstain, etc.):
 * for a fixed living-player count, only the RATIOS between such a
 * handler's configured values are identifiable from a single Bayesian
 * update - their absolute scale is not, and never needs to be calibrated
 * separately from that ratio.
 */
export function updateProbabilities(
  worlds: World[],
  evidence: Evidence,
  model: LikelihoodModel,
  ctx: EvidenceContext
): World[] {
  const weighted = worlds.map((world) => ({
    ...world,
    probability: world.probability * model.likelihood(evidence, world, ctx),
  }));

  const total = weighted.reduce((sum, world) => sum + world.probability, 0);
  if (total === 0) {
    throw new Error(
      "Observation is inconsistent with every remaining world (total likelihood is 0)"
    );
  }

  return weighted.map((world) => ({
    ...world,
    probability: world.probability / total,
  }));
}
