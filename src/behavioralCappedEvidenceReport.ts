import fs from "fs";
import { GameConfig, PlayerId } from "./types";
import { Evidence } from "./evidence";
import { generateWorlds } from "./generateWorlds";
import { GameSetting, processEvidence } from "./processEvidence";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { evaluateGame, summarizeGameEvaluation, StepEvaluation } from "./gameEvaluation";
import { createBehavioralLikelihoodModel } from "./behavioralModel";
import { syntheticBehavioralModelParams } from "./syntheticBehavioralModel";
import { GLOBAL_CAP_GROUP, PER_FEATURE_CAP_GROUP, runCappedReplay } from "./behavioralCappedEvidence";
import { GroundTruthRoles, GroundTruthTeams } from "./replay";
import { game1Config, game1Evidence, game1GroundTruth, game1GroundTruthTeams } from "./game1";
import { game2Config, game2Evidence, game2GroundTruth, game2GroundTruthTeams } from "./game2";

/**
 * DIAGNOSTIC ONLY (cumulative behavioral-evidence cap counterfactual - see
 * this milestone's own report). Evaluates the coarse cap grid C in
 * {0,0.5,1,2,4,8} nats, under both Variant A (one global pooled cumulative
 * sum) and Variant B (one independent cumulative sum per feature type),
 * against the 10 synthetic games AND the two real recorded games, using
 * runCappedReplay (behavioralCappedEvidence.ts, unchanged) - never used to
 * select or tune a production cap. Invoke directly:
 * `npx ts-node src/behavioralCappedEvidenceReport.ts`.
 */

const SYNTHETIC_DIR =
  "/private/tmp/claude-502/-Users-yurii-Documents-personal-mafia-game-predictor/29f99942-d7c7-41c9-8d93-8a8624b90714/scratchpad/synthetic-experiment-1000";
const SEEDS = [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009];
const CAP_GRID = [0, 0.5, 1, 2, 4, 8];
const FEATURES_OF_INTEREST = ["suspect", "candidateVote", "nominate", "defend", "selfRoleClaim", "investigationReport"] as const;

interface Dataset {
  name: string;
  config: GameConfig;
  evidence: Evidence[];
  groundTruth: GroundTruthRoles;
  groundTruthTeams: GroundTruthTeams;
}

function loadSyntheticDataset(seed: number): Dataset {
  const raw = JSON.parse(fs.readFileSync(`${SYNTHETIC_DIR}/synthetic-game-${seed}-output.json`, "utf8"));
  const roles: Record<PlayerId, string> = raw.groundTruth.roles;
  const isMafia: Record<PlayerId, boolean> = {};
  Object.entries(roles).forEach(([p, role]) => {
    isMafia[p] = (defaultRoleRegistry as any)[role].team === "mafia";
  });
  return { name: `synthetic-${seed}`, config: raw.config, evidence: raw.publicEvidence, groundTruth: { roles: roles as any }, groundTruthTeams: { isMafia } };
}

const syntheticDatasets = SEEDS.map(loadSyntheticDataset);
const game1: Dataset = { name: "game1", config: game1Config, evidence: game1Evidence, groundTruth: game1GroundTruth, groundTruthTeams: game1GroundTruthTeams };
const game2: Dataset = { name: "game2", config: game2Config, evidence: game2Evidence, groundTruth: game2GroundTruth, groundTruthTeams: game2GroundTruthTeams };
const allDatasets = [...syntheticDatasets, game1, game2];

interface ScoreSummary {
  avgBrier: number;
  finalBrier: number;
  avgLogLoss: number;
  finalLogLoss: number;
}

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}
function meanScores(scores: ScoreSummary[]): ScoreSummary {
  return {
    avgBrier: mean(scores.map((s) => s.avgBrier)),
    finalBrier: mean(scores.map((s) => s.finalBrier)),
    avgLogLoss: mean(scores.map((s) => s.avgLogLoss)),
    finalLogLoss: mean(scores.map((s) => s.finalLogLoss)),
  };
}

function maxConfidence(perStep: StepEvaluation[]): number {
  let max = 0;
  perStep.forEach((s) => {
    Object.values(s.mafiaProbability).forEach((p) => {
      max = Math.max(max, p, 1 - p);
    });
  });
  return max;
}

function maxDiffFromFull(perStep: StepEvaluation[], fullPerStep: StepEvaluation[]): number {
  let max = 0;
  perStep.forEach((s, i) => {
    Object.keys(s.mafiaProbability).forEach((p) => {
      max = Math.max(max, Math.abs(s.mafiaProbability[p] - fullPerStep[i].mafiaProbability[p]));
    });
  });
  return max;
}

// ---- FULL (uncapped) baseline, computed once per dataset - reused as the "FULL model" comparison point ----

function fullModelPerStep(d: Dataset): StepEvaluation[] {
  const model = createBehavioralLikelihoodModel(syntheticBehavioralModelParams);
  const worlds = generateWorlds(d.config);
  const setting: GameSetting = { config: d.config, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const steps = processEvidence(worlds, d.evidence, model, setting);
  return evaluateGame(steps, d.groundTruth, d.groundTruthTeams);
}

const fullPerStepByDataset = new Map<string, StepEvaluation[]>(allDatasets.map((d) => [d.name, fullModelPerStep(d)]));

function fullSummary(d: Dataset): ScoreSummary {
  const perStep = fullPerStepByDataset.get(d.name)!;
  const summary = summarizeGameEvaluation(perStep, d.groundTruth, d.groundTruthTeams);
  return { avgBrier: summary.averageBrierScore, finalBrier: summary.finalBrierScore, avgLogLoss: summary.averageLogLoss, finalLogLoss: summary.finalLogLoss };
}

// ---- one capped configuration, evaluated on one dataset ----

function evaluateCappedOnDataset(d: Dataset, cap: number, groupKeyOf: typeof GLOBAL_CAP_GROUP) {
  const worlds = generateWorlds(d.config);
  const setting: GameSetting = { config: d.config, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const { steps, groupStats } = runCappedReplay(d.config, d.evidence, worlds, setting, syntheticBehavioralModelParams, cap, groupKeyOf);
  const perStep = evaluateGame(steps, d.groundTruth, d.groundTruthTeams);
  const summary = summarizeGameEvaluation(perStep, d.groundTruth, d.groundTruthTeams);
  const fullPerStep = fullPerStepByDataset.get(d.name)!;
  return {
    summary: { avgBrier: summary.averageBrierScore, finalBrier: summary.finalBrierScore, avgLogLoss: summary.averageLogLoss, finalLogLoss: summary.finalLogLoss } as ScoreSummary,
    maxConfidence: maxConfidence(perStep),
    maxDiffFromFull: maxDiffFromFull(perStep, fullPerStep),
    groupStats,
  };
}

// ---- assemble one cap's full row (variant A or B) across all datasets ----

function evaluateCapRow(cap: number, groupKeyOf: typeof GLOBAL_CAP_GROUP, variantLabel: string) {
  const syntheticResults = syntheticDatasets.map((d) => evaluateCappedOnDataset(d, cap, groupKeyOf));
  const game1Result = evaluateCappedOnDataset(game1, cap, groupKeyOf);
  const game2Result = evaluateCappedOnDataset(game2, cap, groupKeyOf);

  // aggregate per-feature groupStats across the 10 synthetic games (sum
  // counts, max of maxes) - only meaningful for the per-feature variant,
  // but computed generically (Variant A's pooled "ALL" group is reported
  // the same way, just as a single row).
  const syntheticGroupKeys = new Set<string>();
  syntheticResults.forEach((r) => Object.keys(r.groupStats).forEach((k) => syntheticGroupKeys.add(k)));
  const syntheticGroupStats: Record<string, any> = {};
  syntheticGroupKeys.forEach((key) => {
    const rows = syntheticResults.map((r) => r.groupStats[key]).filter(Boolean);
    syntheticGroupStats[key] = {
      totalObservations: rows.reduce((s, r) => s + r.observationCount, 0),
      maxAbsSingleEventLogRatio: Math.max(0, ...rows.map((r) => r.maxAbsSingleEventLogRatio)),
      maxAbsUncappedCumulative: Math.max(0, ...rows.map((r) => r.maxAbsUncappedCumulative)),
      maxAbsCappedCumulative: Math.max(0, ...rows.map((r) => r.maxAbsCappedCumulative)),
      meanFractionStatesCapped: mean(rows.map((r) => r.fractionStatesCapped)),
    };
  });

  return {
    variant: variantLabel,
    cap,
    synthetic: { ...meanScores(syntheticResults.map((r) => r.summary)), maxConfidence: mean(syntheticResults.map((r) => r.maxConfidence)), maxDiffFromFull: mean(syntheticResults.map((r) => r.maxDiffFromFull)), groupStats: syntheticGroupStats },
    game1: { ...game1Result.summary, maxConfidence: game1Result.maxConfidence, maxDiffFromFull: game1Result.maxDiffFromFull, groupStats: game1Result.groupStats },
    game2: { ...game2Result.summary, maxConfidence: game2Result.maxConfidence, maxDiffFromFull: game2Result.maxDiffFromFull, groupStats: game2Result.groupStats },
  };
}

console.log("Running capped-evidence experiment: 6 caps x 2 variants x 12 datasets...\n");

const variantA = CAP_GRID.map((c) => evaluateCapRow(c, GLOBAL_CAP_GROUP, "A_global"));
const variantB = CAP_GRID.map((c) => evaluateCapRow(c, PER_FEATURE_CAP_GROUP, "B_perFeature"));

// ---- baselines ----

const fullBaseline = {
  synthetic: meanScores(syntheticDatasets.map(fullSummary)),
  game1: fullSummary(game1),
  game2: fullSummary(game2),
};

// ---- per-feature table (item "Important diagnostic") - from Variant B's uncapped-magnitude row (cap=8, the loosest grid point, closest to uncapped) ----

const looseB = variantB[variantB.length - 1]; // cap=8
const featureTable = FEATURES_OF_INTEREST.map((f) => ({
  feature: f,
  syntheticObservations: looseB.synthetic.groupStats[f]?.totalObservations ?? 0,
  game1Observations: looseB.game1.groupStats[f]?.observationCount ?? 0,
  game2Observations: looseB.game2.groupStats[f]?.observationCount ?? 0,
  maxAbsSingleEventLogRatio: {
    synthetic: looseB.synthetic.groupStats[f]?.maxAbsSingleEventLogRatio ?? 0,
    game1: looseB.game1.groupStats[f]?.maxAbsSingleEventLogRatio ?? 0,
    game2: looseB.game2.groupStats[f]?.maxAbsSingleEventLogRatio ?? 0,
  },
  maxAbsUncappedCumulative: {
    synthetic: looseB.synthetic.groupStats[f]?.maxAbsUncappedCumulative ?? 0,
    game1: looseB.game1.groupStats[f]?.maxAbsUncappedCumulative ?? 0,
    game2: looseB.game2.groupStats[f]?.maxAbsUncappedCumulative ?? 0,
  },
  fractionStatesCappedByCapGrid: CAP_GRID.map((c, i) => ({
    cap: c,
    synthetic: variantB[i].synthetic.groupStats[f]?.meanFractionStatesCapped ?? 0,
    game1: variantB[i].game1.groupStats[f]?.fractionStatesCapped ?? 0,
    game2: variantB[i].game2.groupStats[f]?.fractionStatesCapped ?? 0,
  })),
}));

// ---- toy sequence experiment: repeated identical behavioral evidence ----
// uncapped grows linearly; tempered (L^w) grows linearly but slower;
// capped saturates. Uses suspect's real otherTeam-vs-ownTeam ratio
// (syntheticBehavioralModelParams) as the single per-event ln-ratio, purely
// analytically - no game/world simulation at all.

const suspectTownParams = syntheticBehavioralModelParams.suspect.town!;
const perEventLnRatio = Math.log(suspectTownParams.otherTeam / suspectTownParams.ownTeam); // one repeated identical "suspect town target" event's own log-odds contribution
const N_EVENTS = 20;
const TEMPER_W = 0.5;
const TOY_CAP = 2;

const toySequence = Array.from({ length: N_EVENTS }, (_, i) => i + 1).map((n) => ({
  n,
  uncapped: n * perEventLnRatio,
  tempered_w0_5: n * perEventLnRatio * TEMPER_W,
  capped_C2: Math.max(-TOY_CAP, Math.min(TOY_CAP, n * perEventLnRatio)),
}));

const report = {
  perEventLnRatioUsedInToyExperiment: perEventLnRatio,
  fullBaseline,
  capGrid: CAP_GRID,
  variantA,
  variantB,
  featureTable,
  toySequence,
};

console.log(JSON.stringify(report, null, 2));
const outPath = "/tmp/claude-502/behavioral-capped-evidence-report.json";
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\nSaved to ${outPath}`);
