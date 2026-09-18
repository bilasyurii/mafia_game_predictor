import fs from "fs";
import path from "path";
import { GameConfig, PlayerId, RoleId } from "./types";
import { Evidence } from "./evidence";
import { generateWorlds } from "./generateWorlds";
import { GameSetting, processEvidence } from "./processEvidence";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { evaluateGame, summarizeGameEvaluation, StepEvaluation } from "./gameEvaluation";
import { syntheticBehavioralModelParams } from "./syntheticBehavioralModel";
import {
  ALL_BEHAVIORAL_EVIDENCE_TYPES,
  BehavioralEvidenceType,
  buildAblatedBehavioralModel,
} from "./behavioralLikelihoodDiagnostics";
import { GroundTruthRoles, GroundTruthTeams } from "./replay";
import { game1Config, game1Evidence, game1GroundTruth, game1GroundTruthTeams } from "./game1";
import { game2Config, game2Evidence, game2GroundTruth, game2GroundTruthTeams } from "./game2";

/**
 * DIAGNOSTIC ONLY (feature-level investigation - see this milestone's own
 * report). Evaluates every behavioral-evidence-type ablation scenario (ALL,
 * NONE, ONLY_X for each of the 8 types, WITHOUT_X for each of the 8 types)
 * against the 10 already-generated synthetic games AND the two real
 * recorded games, using buildAblatedBehavioralModel
 * (behavioralLikelihoodDiagnostics.ts) - never a production parameter
 * change. Makes no Claude calls, generates no games, does not touch
 * defaultBehavioralModelParams/syntheticBehavioralModelParams or the real
 * games' own files. Invoke directly:
 * `npx ts-node src/behavioralFeatureAblationReport.ts`.
 */

const SYNTHETIC_DIR =
  "/private/tmp/claude-502/-Users-yurii-Documents-personal-mafia-game-predictor/29f99942-d7c7-41c9-8d93-8a8624b90714/scratchpad/synthetic-experiment-1000";
const SEEDS = [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009];

interface Dataset {
  name: string;
  config: GameConfig;
  evidence: Evidence[];
  groundTruth: GroundTruthRoles;
  groundTruthTeams: GroundTruthTeams;
}

function loadSyntheticDataset(seed: number): Dataset {
  const raw = JSON.parse(fs.readFileSync(path.join(SYNTHETIC_DIR, `synthetic-game-${seed}-output.json`), "utf8"));
  const roles: Record<PlayerId, RoleId> = raw.groundTruth.roles;
  const isMafia: Record<PlayerId, boolean> = {};
  Object.entries(roles).forEach(([p, role]) => {
    isMafia[p] = (defaultRoleRegistry as any)[role].team === "mafia";
  });
  return {
    name: `synthetic-${seed}`,
    config: raw.config,
    evidence: raw.publicEvidence,
    groundTruth: { roles },
    groundTruthTeams: { isMafia },
  };
}

const syntheticDatasets = SEEDS.map(loadSyntheticDataset);
const realDatasets: Dataset[] = [
  { name: "game1", config: game1Config, evidence: game1Evidence, groundTruth: game1GroundTruth, groundTruthTeams: game1GroundTruthTeams },
  { name: "game2", config: game2Config, evidence: game2Evidence, groundTruth: game2GroundTruth, groundTruthTeams: game2GroundTruthTeams },
];

// ---- Scenarios ----
const ALL = new Set<BehavioralEvidenceType>(ALL_BEHAVIORAL_EVIDENCE_TYPES);
type Scenario = { label: string; enabled: Set<BehavioralEvidenceType> };
const scenarios: Scenario[] = [
  { label: "FULL", enabled: new Set(ALL) },
  { label: "NONE", enabled: new Set() },
  ...ALL_BEHAVIORAL_EVIDENCE_TYPES.map((t) => ({ label: `ONLY_${t}`, enabled: new Set([t]) })),
  ...ALL_BEHAVIORAL_EVIDENCE_TYPES.map((t) => ({
    label: `WITHOUT_${t}`,
    enabled: new Set(ALL_BEHAVIORAL_EVIDENCE_TYPES.filter((x) => x !== t)),
  })),
];

interface ScoreSummary {
  avgBrier: number;
  finalBrier: number;
  avgLogLoss: number;
  finalLogLoss: number;
  steps: number;
}

function evaluateDataset(dataset: Dataset, enabled: Set<BehavioralEvidenceType>): ScoreSummary {
  const model = buildAblatedBehavioralModel(syntheticBehavioralModelParams, enabled);
  const worlds = generateWorlds(dataset.config);
  const setting: GameSetting = { config: dataset.config, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const steps = processEvidence(worlds, dataset.evidence, model, setting);
  const perStep = evaluateGame(steps, dataset.groundTruth, dataset.groundTruthTeams);
  const summary = summarizeGameEvaluation(perStep, dataset.groundTruth, dataset.groundTruthTeams);
  return {
    avgBrier: summary.averageBrierScore,
    finalBrier: summary.finalBrierScore,
    avgLogLoss: summary.averageLogLoss,
    finalLogLoss: summary.finalLogLoss,
    steps: perStep.length,
  };
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
    steps: scores.reduce((s, v) => s + v.steps, 0),
  };
}

// ---- Event counts per feature per dataset ----
function eventCounts(evidence: Evidence[]): Record<string, number> {
  const counts: Record<string, number> = {};
  evidence.forEach((e) => {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
  });
  return counts;
}

// ---- Posterior-change stats per feature, from the FULL scenario ----
function featurePosteriorChangeStats(dataset: Dataset, fullPerStep: StepEvaluation[], type: BehavioralEvidenceType) {
  const deltas: number[] = [];
  dataset.evidence.forEach((e, i) => {
    if (e.type !== type) return;
    const top = fullPerStep[i].largestChanges[0];
    if (top) deltas.push(Math.abs(top.delta));
  });
  if (deltas.length === 0) return { n: 0, mean: undefined as number | undefined, max: undefined as number | undefined };
  return { n: deltas.length, mean: mean(deltas), max: Math.max(...deltas) };
}

// ==============================================================
// Run everything, collect into a structured report object
// ==============================================================

interface FeatureReport {
  synthetic: { events: number; only: ScoreSummary; without: ScoreSummary; deltaVsFull: Partial<ScoreSummary>; posteriorChange: any };
  game1: { events: number; only: ScoreSummary; without: ScoreSummary; deltaVsFull: Partial<ScoreSummary>; posteriorChange: any };
  game2: { events: number; only: ScoreSummary; without: ScoreSummary; deltaVsFull: Partial<ScoreSummary>; posteriorChange: any };
}

function diff(full: ScoreSummary, without: ScoreSummary): Partial<ScoreSummary> {
  return {
    avgBrier: without.avgBrier - full.avgBrier,
    finalBrier: without.finalBrier - full.finalBrier,
    avgLogLoss: without.avgLogLoss - full.avgLogLoss,
    finalLogLoss: without.finalLogLoss - full.finalLogLoss,
  };
}

console.log("Running feature-ablation report across 10 synthetic games + 2 real games x 18 scenarios...\n");

const syntheticFull = meanScores(syntheticDatasets.map((d) => evaluateDataset(d, ALL)));
const syntheticNone = meanScores(syntheticDatasets.map((d) => evaluateDataset(d, new Set())));
const game1Full = evaluateDataset(realDatasets[0], ALL);
const game1None = evaluateDataset(realDatasets[0], new Set());
const game2Full = evaluateDataset(realDatasets[1], ALL);
const game2None = evaluateDataset(realDatasets[1], new Set());

// FULL per-step evaluation (for posterior-change stats), per dataset
const syntheticFullPerStep = syntheticDatasets.map((d) => {
  const model = buildAblatedBehavioralModel(syntheticBehavioralModelParams, ALL);
  const worlds = generateWorlds(d.config);
  const setting: GameSetting = { config: d.config, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const steps = processEvidence(worlds, d.evidence, model, setting);
  return evaluateGame(steps, d.groundTruth, d.groundTruthTeams);
});
function game1FullPerStep(): StepEvaluation[] {
  const model = buildAblatedBehavioralModel(syntheticBehavioralModelParams, ALL);
  const worlds = generateWorlds(game1Config);
  const setting: GameSetting = { config: game1Config, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const steps = processEvidence(worlds, game1Evidence, model, setting);
  return evaluateGame(steps, game1GroundTruth, game1GroundTruthTeams);
}
function game2FullPerStep(): StepEvaluation[] {
  const model = buildAblatedBehavioralModel(syntheticBehavioralModelParams, ALL);
  const worlds = generateWorlds(game2Config);
  const setting: GameSetting = { config: game2Config, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const steps = processEvidence(worlds, game2Evidence, model, setting);
  return evaluateGame(steps, game2GroundTruth, game2GroundTruthTeams);
}
const g1FullPerStep = game1FullPerStep();
const g2FullPerStep = game2FullPerStep();

const featureReports: Record<string, FeatureReport> = {};

ALL_BEHAVIORAL_EVIDENCE_TYPES.forEach((type) => {
  const onlySet = new Set<BehavioralEvidenceType>([type]);
  const withoutSet = new Set<BehavioralEvidenceType>(ALL_BEHAVIORAL_EVIDENCE_TYPES.filter((t) => t !== type));

  const syntheticOnly = meanScores(syntheticDatasets.map((d) => evaluateDataset(d, onlySet)));
  const syntheticWithout = meanScores(syntheticDatasets.map((d) => evaluateDataset(d, withoutSet)));
  const syntheticEvents = syntheticDatasets.reduce((s, d) => s + (eventCounts(d.evidence)[type] ?? 0), 0);
  const syntheticPosteriorChange = {
    n: syntheticDatasets.reduce((s, d, i) => s + featurePosteriorChangeStats(d, syntheticFullPerStep[i], type).n, 0),
    mean: (() => {
      const all: number[] = [];
      syntheticDatasets.forEach((d, i) => {
        d.evidence.forEach((e, j) => {
          if (e.type === type) {
            const top = syntheticFullPerStep[i][j].largestChanges[0];
            if (top) all.push(Math.abs(top.delta));
          }
        });
      });
      return all.length ? mean(all) : undefined;
    })(),
    max: (() => {
      const all: number[] = [];
      syntheticDatasets.forEach((d, i) => {
        d.evidence.forEach((e, j) => {
          if (e.type === type) {
            const top = syntheticFullPerStep[i][j].largestChanges[0];
            if (top) all.push(Math.abs(top.delta));
          }
        });
      });
      return all.length ? Math.max(...all) : undefined;
    })(),
  };

  const game1Only = evaluateDataset(realDatasets[0], onlySet);
  const game1Without = evaluateDataset(realDatasets[0], withoutSet);
  const game1Events = eventCounts(game1Evidence)[type] ?? 0;
  const game1PosteriorChange = featurePosteriorChangeStats(realDatasets[0], g1FullPerStep, type);

  const game2Only = evaluateDataset(realDatasets[1], onlySet);
  const game2Without = evaluateDataset(realDatasets[1], withoutSet);
  const game2Events = eventCounts(game2Evidence)[type] ?? 0;
  const game2PosteriorChange = featurePosteriorChangeStats(realDatasets[1], g2FullPerStep, type);

  featureReports[type] = {
    synthetic: {
      events: syntheticEvents,
      only: syntheticOnly,
      without: syntheticWithout,
      deltaVsFull: diff(syntheticFull, syntheticWithout),
      posteriorChange: syntheticPosteriorChange,
    },
    game1: {
      events: game1Events,
      only: game1Only,
      without: game1Without,
      deltaVsFull: diff(game1Full, game1Without),
      posteriorChange: game1PosteriorChange,
    },
    game2: {
      events: game2Events,
      only: game2Only,
      without: game2Without,
      deltaVsFull: diff(game2Full, game2Without),
      posteriorChange: game2PosteriorChange,
    },
  };
});

const fullReport = {
  syntheticFull,
  syntheticNone,
  game1Full,
  game1None,
  game2Full,
  game2None,
  features: featureReports,
};

console.log(JSON.stringify(fullReport, null, 2));

const outPath = "/tmp/claude-502/behavioral-feature-ablation-report.json";
fs.writeFileSync(outPath, JSON.stringify(fullReport, null, 2));
console.log(`\nSaved to ${outPath}`);
