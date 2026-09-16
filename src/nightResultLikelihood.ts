import { PlayerId } from "./types";
import { NightResultHandler } from "./evidence";
import { ActionModel } from "./actionModel";
import { enumerateHiddenNightActions, resolveNight } from "./night";

function sameDeathSet(a: PlayerId[], b: PlayerId[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const p of setA) {
    if (!setB.has(p)) return false;
  }
  return true;
}

/**
 * Builds the NightResultFact handler: marginalizes over every hypothesis
 * enumerateHiddenNightActions produces, weighting each via `actionModel`,
 * resolving it deterministically via the existing, untouched resolveNight,
 * and summing the weight of every hypothesis whose resulting `died` set
 * (order-independent) matches the observed fact. A world/fact combination
 * with zero matching hypotheses is never special-cased - it naturally sums
 * to 0.
 *
 * Every hypothesis is resolved against an EMPTY NightHistoryContext,
 * regardless of any real earlier-night information: by the time a later
 * night is being scored, the doctor's actual previous save target has
 * itself been marginalized away, so there is no fact left to enforce the
 * "cannot repeat" rule against. This means resolveNight is never given a
 * reason to throw here, and repeat-target hypotheses are included and
 * scored like any other - a documented v1 simplification, not an
 * oversight (see enumerateHiddenNightActions's docs, and this module's
 * tests).
 */
export function createNightResultHandler(actionModel: ActionModel): NightResultHandler {
  return (fact, world, ctx) => {
    const hypotheses = enumerateHiddenNightActions(world, ctx.alive, ctx.roles);

    return hypotheses.reduce((sum, hypothesis) => {
      const resolution = resolveNight(world, hypothesis, ctx.alive, {}, ctx.roles);
      if (!sameDeathSet(resolution.died, fact.died)) {
        return sum;
      }
      return sum + actionModel.probability(hypothesis, world, ctx.alive, {});
    }, 0);
  };
}
