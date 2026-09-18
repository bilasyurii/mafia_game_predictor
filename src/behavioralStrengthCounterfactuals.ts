import { BehavioralModelParams, createBehavioralHandlers } from "./behavioralModel";
import { defaultRoleRegistry } from "./roles";
import { ActionModel } from "./actionModel";
import { createUniformActionModel } from "./uniformActionModel";
import { createNightResultHandler } from "./nightResultLikelihood";
import { LikelihoodModel, ObservationHandler, ObservationHandlerMap, createLikelihoodModel } from "./evidence";
import { ALL_BEHAVIORAL_EVIDENCE_TYPES, BehavioralEvidenceType } from "./behavioralLikelihoodDiagnostics";

/**
 * DIAGNOSTIC ONLY (controlled counterfactual strength experiment - see this
 * milestone's own report). Generalizes the existing global
 * `behavioralEvidenceWeight` tempering (evidence.ts's createLikelihoodModel,
 * unchanged, Phase I) to PER-FEATURE-TYPE likelihood powers: `L' = L ** w`,
 * with a possibly different `w` for each of the 8 behavioral evidence types,
 * default 1 (no change) for any type not named. A single global weight
 * (createBehavioralLikelihoodModel's own `behavioralEvidenceWeight`
 * parameter) is a special case of this - reused directly, not reimplemented,
 * for the "global power" sweep in this milestone's report. This file adds NO
 * new production parameter and changes NO existing likelihood
 * implementation; it only decides, per already-computed handler return
 * value, whether and how much to exponentiate it before
 * updateProbabilities' prior-multiply-and-renormalize step - exactly the
 * same chokepoint evidence.ts's own weight already uses, just applied
 * per-type instead of uniformly. w=0 for a type makes it a world-independent
 * constant (1, via the `x**0===1` identity noted in evidence.ts) that
 * cancels exactly in renormalization - mathematically identical to that
 * type's contribution under buildAblatedBehavioralModel's NONE/WITHOUT_X
 * scenarios (behavioralLikelihoodDiagnostics.ts), just reached via a power
 * instead of a constant-1 replacement.
 */

export type FeatureWeights = Partial<Record<BehavioralEvidenceType, number>>;

/**
 * Builds a LikelihoodModel where each behavioral evidence type's real
 * (BehavioralModelParams-configured) likelihood is raised to
 * `weights[type] ?? 1` before being returned - types not present in
 * `weights` are left at full, untempered strength (w=1). Mechanical evidence
 * (nightResult, dayElimination) is never touched - wired up via the same
 * production createNightResultHandler/createBehavioralHandlers as
 * createBehavioralLikelihoodModel, so every configuration still has full,
 * unmodified mechanical grounding.
 */
export function buildFeatureWeightedBehavioralModel(
  params: BehavioralModelParams,
  weights: FeatureWeights,
  actionModel: ActionModel = createUniformActionModel(defaultRoleRegistry)
): LikelihoodModel {
  const real = createBehavioralHandlers(params);
  const weighted = { ...real } as ObservationHandlerMap;
  ALL_BEHAVIORAL_EVIDENCE_TYPES.forEach((type) => {
    const w = weights[type] ?? 1;
    if (w === 1) return; // leave the real handler exactly as-is - guarantees byte-identical output at w=1
    const rawHandler = real[type] as ObservationHandler;
    const tempered: ObservationHandler = (observation, world, ctx) => rawHandler(observation, world, ctx) ** w;
    (weighted as Record<string, ObservationHandler>)[type] = tempered;
  });
  return createLikelihoodModel(weighted, createNightResultHandler(actionModel));
}
