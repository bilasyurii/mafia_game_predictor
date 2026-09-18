import { GameConfig, World } from "./types";
import { Evidence, EvidenceContext } from "./evidence";
import { getAliveStateForEvidence, getHistoryBefore } from "./facts";
import { GameSetting, EvidenceStep } from "./processEvidence";
import { BehavioralModelParams, createBehavioralHandlers } from "./behavioralModel";
import { defaultRoleRegistry } from "./roles";
import { ActionModel } from "./actionModel";
import { createUniformActionModel } from "./uniformActionModel";
import { createNightResultHandler } from "./nightResultLikelihood";
import { ALL_BEHAVIORAL_EVIDENCE_TYPES, BehavioralEvidenceType } from "./behavioralLikelihoodDiagnostics";

/**
 * DIAGNOSTIC ONLY (cumulative behavioral evidence cap counterfactual - see
 * this milestone's own report). Implements `S_f = Sum_i ln L_f(e_i|W)`,
 * `S'_f = clamp(S_f, -C, C)`, `L'_f(W) = exp(S'_f(W))` as a SCALAR-PER-WORLD
 * construction, never as independently-capped pairwise ratios (see this
 * milestone's report for why the pairwise formulation is mathematically
 * ill-defined for more than 2 worlds - clamp is not additive, so capping
 * each pairwise ratio separately cannot in general be represented by any
 * single consistent per-world likelihood).
 *
 * This CANNOT be expressed as a plain evidence.ts LikelihoodModel plugged
 * into the existing processEvidence/updateProbabilities per-step API: a
 * capped feature's per-step multiplicative factor depends on the ENTIRE
 * cumulative history of that feature's raw (uncapped) per-event
 * log-likelihoods, each of which must be recomputed against ITS OWN
 * original EvidenceContext (alive state, history-so-far) - reusing a LATER
 * step's context to rescore an EARLIER event would silently corrupt
 * history-sensitive handlers (teamAlignmentParamsFrom's repeatedPosition,
 * candidateVote's per-voter tally against ctx.alive). So this file
 * implements a SEPARATE, self-contained replay loop instead of a
 * LikelihoodModel - reusing, unchanged: createBehavioralHandlers (the real,
 * production per-event likelihood functions), createNightResultHandler
 * (mechanical evidence, NEVER capped), and getAliveStateForEvidence/
 * getHistoryBefore (facts.ts, for building each event's own correct
 * context, exactly as processEvidence.ts itself does - context construction
 * never depends on which model scores it). Renormalization is a direct,
 * literal copy of updateProbabilities.ts's own 5-line formula (prior x
 * likelihood, then divide by the sum) - not reimplemented differently, just
 * inlined because the per-step "likelihood" here is a precomputed number
 * per world rather than something a LikelihoodModel.likelihood() call can
 * produce without the full step-index context array in hand.
 *
 * The result is an EvidenceStep[] array with EXACTLY the same shape
 * processEvidence produces, so evaluateGame/summarizeGameEvaluation
 * (gameEvaluation.ts, UNCHANGED) work on it identically to any real replay.
 */

export type CapGroupKey = (type: BehavioralEvidenceType) => string;

/** Variant A: every behavioral type pools into ONE group ("ALL"), capped once as a single combined scalar per world. */
export const GLOBAL_CAP_GROUP: CapGroupKey = () => "ALL";

/** Variant B: each behavioral type has its OWN independent group/cap (evaluated with the same numeric C per this milestone's grid, never searched independently per feature). */
export const PER_FEATURE_CAP_GROUP: CapGroupKey = (type) => type;

export interface CappedReplayResult {
  steps: EvidenceStep[];
  /** Per group: diagnostics needed for this milestone's activation/magnitude table. Keyed by the SAME strings groupKeyOf produces. */
  groupStats: Record<
    string,
    {
      observationCount: number;
      maxAbsSingleEventLogRatio: number;
      maxAbsUncappedCumulative: number;
      maxAbsCappedCumulative: number;
      /** Fraction of (world, step-of-this-group's-event) pairs where |running uncapped sum| > C at that point - i.e. the cap was actively engaged. */
      fractionStatesCapped: number;
    }
  >;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

const MECHANICAL_TYPES = new Set(["nightResult", "dayElimination"]);

/**
 * Runs the capped-cumulative-behavioral-evidence counterfactual replay for
 * one dataset against one fixed cap C (nats) and one grouping (global or
 * per-feature). `params` is used only to build the REAL, unmodified
 * per-event handlers (createBehavioralHandlers) - never mutated, never a
 * different parameter set than syntheticBehavioralModelParams in this
 * milestone's report.
 */
export function runCappedReplay(
  config: GameConfig,
  evidence: readonly Evidence[],
  worlds: World[],
  setting: GameSetting,
  params: BehavioralModelParams,
  cap: number,
  groupKeyOf: CapGroupKey,
  actionModel: ActionModel = createUniformActionModel(defaultRoleRegistry)
): CappedReplayResult {
  const realHandlers = createBehavioralHandlers(params);
  const nightResultHandler = createNightResultHandler(actionModel);

  // Step 1: build each event's own correct EvidenceContext - identical to
  // what processEvidence.ts itself builds, independent of any model.
  const contexts: EvidenceContext[] = evidence.map((e, i) => {
    const before = getHistoryBefore(evidence, i);
    return { ...setting, alive: getAliveStateForEvidence(setting.config, before, e), history: before };
  });

  // Step 2: raw (uncapped) per-(event, world) likelihood, using the REAL
  // production handlers - exactly the numbers today's FULL model uses.
  // dayElimination is always exactly 1 (resolveDayElimination is a pure,
  // world-independent validity check - see dayEliminationLikelihood.ts) -
  // passed through directly rather than imported, since this replay only
  // ever runs on already-validated datasets (the 10 synthetic games and the
  // 2 real games), which the production pipeline already replays
  // successfully every time this milestone (and every prior one) has run it.
  const rawValue: number[][] = evidence.map((e, i) => {
    const ctx = contexts[i];
    if (e.type === "dayElimination") return worlds.map(() => 1);
    if (e.type === "nightResult") return worlds.map((w) => nightResultHandler(e, w, ctx));
    const handler = (realHandlers as Record<string, any>)[e.type];
    return worlds.map((w) => handler(e as any, w, ctx));
  });

  // Step 3: walk forward, maintaining per-group cumulative sums PER WORLD,
  // producing this step's per-world multiplicative factor via the
  // telescoping identity: factor = exp(clamp(sum_after) - clamp(sum_before)),
  // which makes the PRODUCT of factors across every event of a group equal
  // exp(clamp(total_sum)) exactly - proven in this milestone's report and
  // in behavioralCappedEvidence.test.ts.
  const groupRunningSum = new Map<string, number[]>(); // group -> per-world running sum
  const groupObservationCount = new Map<string, number>();
  const groupMaxAbsSingleEvent = new Map<string, number>();
  const groupMaxAbsUncapped = new Map<string, number>();
  const groupCappedStates = new Map<string, number>();
  const groupTotalStates = new Map<string, number>();

  const steps: EvidenceStep[] = [];
  let priorWorlds = worlds;

  evidence.forEach((e, i) => {
    const ctx = contexts[i];
    let factors: number[];

    if (MECHANICAL_TYPES.has(e.type)) {
      factors = rawValue[i];
    } else {
      const type = e.type as BehavioralEvidenceType;
      const group = groupKeyOf(type);
      if (!groupRunningSum.has(group)) groupRunningSum.set(group, worlds.map(() => 0));
      const sums = groupRunningSum.get(group)!;

      groupObservationCount.set(group, (groupObservationCount.get(group) ?? 0) + 1);

      // This event's own discriminative spread across the WHOLE world
      // enumeration - ln(max_w L) - ln(min_w L) - the multi-world
      // generalization of a two-hypothesis "likelihood ratio" (reduces to
      // the familiar ln(L_mafia/L_town) exactly when only two role
      // assignments differ for the relevant actor). NOT a per-world
      // absolute log-probability - that would conflate "this event's own
      // discriminative power" with "how improbable this bucket's raw
      // number happens to be," which is a different question.
      const lnRawAllWorlds = rawValue[i].map((v) => Math.log(v));
      const eventSpread = Math.max(...lnRawAllWorlds) - Math.min(...lnRawAllWorlds);
      groupMaxAbsSingleEvent.set(group, Math.max(groupMaxAbsSingleEvent.get(group) ?? 0, eventSpread));

      factors = worlds.map((_w, wi) => {
        const lnRaw = lnRawAllWorlds[wi];
        const before = clamp(sums[wi], -cap, cap);
        sums[wi] += lnRaw;
        const after = clamp(sums[wi], -cap, cap);

        groupMaxAbsUncapped.set(group, Math.max(groupMaxAbsUncapped.get(group) ?? 0, Math.abs(sums[wi])));
        groupTotalStates.set(group, (groupTotalStates.get(group) ?? 0) + 1);
        if (Math.abs(sums[wi]) > cap + 1e-12) {
          groupCappedStates.set(group, (groupCappedStates.get(group) ?? 0) + 1);
        }

        return Math.exp(after - before);
      });
    }

    // Renormalization - the literal formula from updateProbabilities.ts,
    // applied to our precomputed per-world factors instead of a
    // LikelihoodModel.likelihood() call.
    const weighted = priorWorlds.map((w, wi) => ({ ...w, probability: w.probability * factors[wi] }));
    const total = weighted.reduce((s, w) => s + w.probability, 0);
    if (total === 0) {
      throw new Error(`Observation at index ${i} is inconsistent with every remaining world (total likelihood is 0)`);
    }
    const posterior = weighted.map((w) => ({ ...w, probability: w.probability / total }));

    steps.push({ index: i, evidence: e, context: ctx, prior: priorWorlds, posterior });
    priorWorlds = posterior;
  });

  const groupStats: CappedReplayResult["groupStats"] = {};
  groupObservationCount.forEach((count, group) => {
    groupStats[group] = {
      observationCount: count,
      maxAbsSingleEventLogRatio: groupMaxAbsSingleEvent.get(group) ?? 0,
      maxAbsUncappedCumulative: groupMaxAbsUncapped.get(group) ?? 0,
      maxAbsCappedCumulative: Math.min(cap, groupMaxAbsUncapped.get(group) ?? 0),
      fractionStatesCapped: (groupCappedStates.get(group) ?? 0) / (groupTotalStates.get(group) || 1),
    };
  });

  return { steps, groupStats };
}
