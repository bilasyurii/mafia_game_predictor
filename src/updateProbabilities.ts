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
