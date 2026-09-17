import { AliveState, PlayerId, World } from "./types";
import { NightResultHandler } from "./evidence";
import { ActionModel, FactoredActionModel } from "./actionModel";
import {
  enumerateHiddenNightActions,
  resolveDeaths,
  resolveNight,
} from "./night";
import { getInvestigationResult } from "./investigation";
import { hasMechanic } from "./roles";

function sameDeathSet(a: PlayerId[], b: PlayerId[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const p of setA) {
    if (!setB.has(p)) return false;
  }
  return true;
}

function isFactoredActionModel(model: ActionModel): model is FactoredActionModel {
  const candidate = model as Partial<FactoredActionModel>;
  return (
    typeof candidate.mafiaConsensusProbability === "function" &&
    typeof candidate.donCheckTargetProbability === "function" &&
    typeof candidate.commissionerCheckTargetProbability === "function" &&
    typeof candidate.doctorSaveTargetProbability === "function"
  );
}

/**
 * The reference implementation: marginalizes over every hypothesis
 * enumerateHiddenNightActions produces, weighting each via `actionModel`,
 * resolving it deterministically via the existing, untouched resolveNight,
 * and summing the weight of every hypothesis whose resulting `died` set
 * (order-independent) matches the observed fact. Makes no assumption about
 * `actionModel`'s internal structure - correct for ANY ActionModel,
 * including ones whose hidden-action dimensions are correlated with one
 * another. Kept as the permanent reference/oracle: createOptimizedNightResultHandler's
 * output must always agree with this one (see nightResultLikelihood.test.ts's
 * differential tests), and this is also the only correct choice for a
 * plain ActionModel that does not implement FactoredActionModel.
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
export function createBruteForceNightResultHandler(
  actionModel: ActionModel
): NightResultHandler {
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

interface MafiaOutcome {
  succeeded: boolean;
  target?: PlayerId;
  probability: number;
}

/**
 * Every distinct mafia-kill outcome and its probability, without ever
 * enumerating the full N^killerCount space of raw per-killer choices: "all
 * killers unanimously target t" is exactly one point in that space for each
 * living t, so a single mafiaConsensusProbability query per t is enough.
 * "No consensus" is whatever probability mass is left over - it never needs
 * its own query, and is clamped to 0 to absorb floating-point noise (a
 * correctly-normalized FactoredActionModel never has consensus mass
 * exceeding 1). With zero killers there is no mafia block at all - a single
 * fixed "no kill" outcome with probability 1, mirroring
 * enumerateHiddenNightActions leaving mafiaTargetChoices empty in that case.
 */
function mafiaOutcomes(
  killers: PlayerId[],
  livingPlayers: PlayerId[],
  actionModel: FactoredActionModel,
  world: World,
  alive: AliveState
): MafiaOutcome[] {
  if (killers.length === 0) {
    return [{ succeeded: false, target: undefined, probability: 1 }];
  }

  let consensusMass = 0;
  const outcomes: MafiaOutcome[] = livingPlayers.map((target) => {
    const probability = actionModel.mafiaConsensusProbability(target, world, alive, {});
    consensusMass += probability;
    return { succeeded: true, target, probability };
  });
  outcomes.push({
    succeeded: false,
    target: undefined,
    probability: Math.max(0, 1 - consensusMass),
  });
  return outcomes;
}

/**
 * The optimized marginalization path, valid only for a FactoredActionModel
 * (see actionModel.ts's docs for the independence assumption this relies
 * on). Instead of enumerating the full Cartesian product of hidden actions,
 * it enumerates only (mafia outcome x Commissioner target x Doctor target):
 *
 *  - donCheckTarget is dropped entirely - resolveDeaths (and resolveNight,
 *    which calls the same function) never reads it, so it can never affect
 *    `died`; under the independence assumption its marginal sums to exactly
 *    1 and contributes nothing.
 *  - the mafia-team's joint per-killer choice is collapsed to its induced
 *    outcome (consensus on a specific living player, or no consensus) via
 *    mafiaOutcomes() above.
 *  - each resulting (mafiaOutcome, commissionerTarget, doctorTarget) triple
 *    is resolved into a death set via resolveDeaths - the exact same pure
 *    function resolveNight itself calls - so this path can never silently
 *    diverge from the brute-force reference's death-combination rule.
 *
 * See nightResultLikelihood.test.ts for randomized differential tests
 * proving this agrees with createBruteForceNightResultHandler.
 */
export function createOptimizedNightResultHandler(
  actionModel: FactoredActionModel
): NightResultHandler {
  return (fact, world, ctx) => {
    const { roles: registry, alive } = ctx;
    const players = Object.keys(world.roles);
    const isAlive = (p: PlayerId) => alive[p] === true;
    const livingPlayers = players.filter(isAlive);

    const killers = players.filter(
      (p) => isAlive(p) && hasMechanic(registry, world.roles[p], "unanimousNightKill")
    );
    const commissionerAlive = players.some(
      (p) => isAlive(p) && hasMechanic(registry, world.roles[p], "checkIsMafia")
    );
    const doctorAlive = players.some(
      (p) => isAlive(p) && hasMechanic(registry, world.roles[p], "protect")
    );

    const outcomes = mafiaOutcomes(killers, livingPlayers, actionModel, world, alive);
    const commissionerTargets: Array<PlayerId | undefined> = commissionerAlive
      ? livingPlayers
      : [undefined];
    const doctorTargets: Array<PlayerId | undefined> = doctorAlive
      ? livingPlayers
      : [undefined];

    let total = 0;
    for (const outcome of outcomes) {
      if (outcome.probability === 0) continue;
      for (const commissionerCheckTarget of commissionerTargets) {
        const commissionerCheckResult =
          commissionerCheckTarget === undefined
            ? undefined
            : getInvestigationResult(
                registry,
                "checkIsMafia",
                world.roles[commissionerCheckTarget]
              );
        const commissionerProbability =
          commissionerCheckTarget === undefined
            ? 1
            : actionModel.commissionerCheckTargetProbability(
                commissionerCheckTarget,
                world,
                alive,
                {}
              );

        for (const doctorSavedTarget of doctorTargets) {
          const doctorProbability =
            doctorSavedTarget === undefined
              ? 1
              : actionModel.doctorSaveTargetProbability(doctorSavedTarget, world, alive, {});

          const { died } = resolveDeaths({
            mafiaKillSucceeded: outcome.succeeded,
            mafiaKillTarget: outcome.target,
            commissionerCheckTarget,
            commissionerCheckResult,
            doctorSavedTarget,
          });

          if (!sameDeathSet(died, fact.died)) continue;

          total += outcome.probability * commissionerProbability * doctorProbability;
        }
      }
    }

    return total;
  };
}

/**
 * Builds the NightResultFact handler: uses the optimized marginalization
 * path when `actionModel` implements FactoredActionModel, otherwise falls
 * back to the brute-force reference. The independence assumption the
 * optimized path relies on is never applied to a plain ActionModel - a
 * model that only implements the base interface is always scored by
 * createBruteForceNightResultHandler, exactly as before this optimization
 * existed.
 */
export function createNightResultHandler(actionModel: ActionModel): NightResultHandler {
  if (isFactoredActionModel(actionModel)) {
    return createOptimizedNightResultHandler(actionModel);
  }
  return createBruteForceNightResultHandler(actionModel);
}
