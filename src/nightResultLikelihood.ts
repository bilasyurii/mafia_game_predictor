import { AliveState, PlayerId, World } from "./types";
import { EvidenceContext, NightResultHandler } from "./evidence";
import { ActionModel, FactoredActionModel } from "./actionModel";
import {
  enumerateHiddenNightActions,
  NightResultFact,
  resolveDeaths,
  resolveNight,
} from "./night";
import { getInvestigationResult } from "./investigation";
import { hasMechanic, RoleRegistry } from "./roles";
import { getAliveStateAt } from "./facts";

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
 * A single night's outcome likelihood, grouped by which player the Doctor
 * actually protected (or the key `undefined` when the Doctor wasn't alive
 * that night, so there is no target dimension at all). This is the one
 * primitive both the brute-force and optimized paths need: everything
 * about the Doctor's consecutive-target constraint is built on top of it
 * by nightResultLikelihoodAcrossNights below, never inside this function -
 * `excludedTarget` here is always a single, DEFINITE assumption (a term of
 * an outer sum), never a distribution; see nightResultLikelihoodAcrossNights
 * for where the real uncertainty is handled.
 */
type GroupedByDoctorTarget = Map<PlayerId | undefined, number>;

function scoreGroupedBruteForce(
  fact: NightResultFact,
  world: World,
  alive: AliveState,
  registry: RoleRegistry,
  actionModel: ActionModel,
  excludedTarget: PlayerId | undefined
): GroupedByDoctorTarget {
  const hypotheses = enumerateHiddenNightActions(world, alive, registry);
  const history = excludedTarget === undefined ? {} : { previousDoctorSaveTarget: excludedTarget };

  const grouped: GroupedByDoctorTarget = new Map();
  hypotheses.forEach((hypothesis) => {
    const resolution = resolveNight(world, hypothesis, alive, {}, registry);
    if (!sameDeathSet(resolution.died, fact.died)) return;
    const weight = actionModel.probability(hypothesis, world, alive, history);
    if (weight === 0) return;
    const key = hypothesis.doctorSaveTarget;
    grouped.set(key, (grouped.get(key) ?? 0) + weight);
  });
  return grouped;
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

function scoreGroupedOptimized(
  fact: NightResultFact,
  world: World,
  alive: AliveState,
  registry: RoleRegistry,
  actionModel: FactoredActionModel,
  excludedTarget: PlayerId | undefined
): GroupedByDoctorTarget {
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
  const doctorTargets: Array<PlayerId | undefined> = doctorAlive ? livingPlayers : [undefined];
  const history =
    excludedTarget === undefined ? {} : { previousDoctorSaveTarget: excludedTarget };

  const grouped: GroupedByDoctorTarget = new Map();

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
            : actionModel.doctorSaveTargetProbability(doctorSavedTarget, world, alive, history);
        if (doctorProbability === 0) continue;

        const { died } = resolveDeaths({
          mafiaKillSucceeded: outcome.succeeded,
          mafiaKillTarget: outcome.target,
          commissionerCheckTarget,
          commissionerCheckResult,
          doctorSavedTarget,
        });

        if (!sameDeathSet(died, fact.died)) continue;

        const weight = outcome.probability * commissionerProbability * doctorProbability;
        grouped.set(doctorSavedTarget, (grouped.get(doctorSavedTarget) ?? 0) + weight);
      }
    }
  }

  return grouped;
}

/** A normalized (sums to 1) belief over which player the Doctor actually
 * protected on the most recent night the Doctor was alive - the key
 * `undefined` means "no exclusion" (either no such night has happened yet,
 * or the Doctor wasn't alive that night). Always has at least one entry. */
type DoctorTargetBelief = Map<PlayerId | undefined, number>;

const NO_CONSTRAINT: DoctorTargetBelief = new Map([[undefined, 1]]);

function sumValues(map: GroupedByDoctorTarget): number {
  let total = 0;
  map.forEach((v) => {
    total += v;
  });
  return total;
}

/**
 * The sequential/Bayesian filtering step this entire module exists for.
 * The Doctor's real target on any given night is never publicly revealed -
 * only `died` is. So enforcing "cannot repeat the immediately preceding
 * target" for night `fact.round` requires a full posterior distribution
 * over "what was the Doctor's actual target on the most recent night they
 * were alive", not a single looked-up value - see this module's top-of-file
 * intent and actionModel.ts's docs for why NightHistoryContext.
 * previousDoctorSaveTarget is a single DEFINITE assumption, never a
 * distribution: this function supplies that assumption one term at a time
 * (via `scoreGrouped`) and combines the terms itself.
 *
 * Walks forward through every earlier NightResultFact recorded in
 * ctx.history (recorded order is already guaranteed chronological by
 * getHistoryBefore, so no extra sorting is needed), re-deriving each
 * night's own alive state via getAliveStateAt exactly as processEvidence
 * itself would have when that fact was originally scored. At each step the
 * current belief (a set of weighted "assume the exclusion was X" terms) is
 * combined with that night's grouped likelihood to produce the NEXT
 * belief, renormalized to sum to 1. A night where the resulting total is 0
 * (this world is already impossible given an earlier fact) resets to
 * NO_CONSTRAINT rather than dividing by zero - harmless, since the
 * eventual scalar this feeds into a world already destined for probability
 * 0 in the real posterior (updateProbabilities multiplies by the prior,
 * which is 0 for such a world) - the only requirement here is to never
 * produce NaN, which would corrupt every other world's renormalization.
 * A night where the Doctor wasn't alive collapses the belief back to
 * NO_CONSTRAINT too, via scoreGrouped naturally returning everything under
 * the single key `undefined` in that case (enumerateHiddenNightActions
 * omits the doctorSaveTarget dimension whenever the Doctor isn't alive) -
 * exactly matching "no previous target restriction" when the Doctor was
 * dead the night before.
 *
 * Finally scores `fact` itself the same way, combining the last belief
 * with fact's own grouped likelihood, returning the scalar total - this is
 * what createBruteForceNightResultHandler/createOptimizedNightResultHandler
 * actually return.
 */
function nightResultLikelihoodAcrossNights(
  fact: NightResultFact,
  world: World,
  ctx: EvidenceContext,
  scoreGrouped: (
    f: NightResultFact,
    alive: AliveState,
    excludedTarget: PlayerId | undefined
  ) => GroupedByDoctorTarget
): number {
  const priorNights = ctx.history.filter(
    (event): event is NightResultFact =>
      event.type === "nightResult" && event.round < fact.round
  );

  let belief: DoctorTargetBelief = NO_CONSTRAINT;
  priorNights.forEach((priorFact) => {
    const aliveThen = getAliveStateAt(ctx.config, ctx.history, {
      phase: "night",
      round: priorFact.round,
    });

    const combined: GroupedByDoctorTarget = new Map();
    belief.forEach((priorWeight, excluded) => {
      const grouped = scoreGrouped(priorFact, aliveThen, excluded);
      grouped.forEach((weight, target) => {
        combined.set(target, (combined.get(target) ?? 0) + priorWeight * weight);
      });
    });

    const total = sumValues(combined);
    belief =
      total === 0
        ? NO_CONSTRAINT
        : new Map([...combined].map(([target, weight]) => [target, weight / total]));
  });

  let total = 0;
  belief.forEach((priorWeight, excluded) => {
    total += priorWeight * sumValues(scoreGrouped(fact, ctx.alive, excluded));
  });
  return total;
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
 * Every hypothesis is resolved against an EMPTY NightHistoryContext -
 * resolveNight itself is never given a reason to throw here. The Doctor's
 * consecutive-target constraint is enforced entirely through
 * nightResultLikelihoodAcrossNights and the ActionModel's own history-aware
 * probability()/doctorSaveTargetProbability(), never through resolveNight's
 * own throw path.
 */
export function createBruteForceNightResultHandler(
  actionModel: ActionModel
): NightResultHandler {
  return (fact, world, ctx) =>
    nightResultLikelihoodAcrossNights(fact, world, ctx, (f, alive, excluded) =>
      scoreGroupedBruteForce(f, world, alive, ctx.roles, actionModel, excluded)
    );
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
 * The Doctor's consecutive-target constraint adds one further layer,
 * handled entirely by nightResultLikelihoodAcrossNights: because the
 * previous night's real target is itself uncertain, this optimized
 * per-round computation is run once per plausible previous target
 * (weighted by that belief), not once overall - the collapsed mafia/
 * commissioner math inside a single run is unaffected and stays exactly as
 * fast as before; only the outer number of runs grows with the size of the
 * belief (at most one per living player from the previous night).
 *
 * See nightResultLikelihood.test.ts for randomized differential tests
 * proving this agrees with createBruteForceNightResultHandler.
 */
export function createOptimizedNightResultHandler(
  actionModel: FactoredActionModel
): NightResultHandler {
  return (fact, world, ctx) =>
    nightResultLikelihoodAcrossNights(fact, world, ctx, (f, alive, excluded) =>
      scoreGroupedOptimized(f, world, alive, ctx.roles, actionModel, excluded)
    );
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
