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
import { buildAblatedBehavioralModel, buildUninformativeBehavioralParams } from "./behavioralLikelihoodDiagnostics";
import { buildFeatureWeightedBehavioralModel, FeatureWeights } from "./behavioralStrengthCounterfactuals";
import { LikelihoodModel } from "./evidence";
import { GroundTruthRoles, GroundTruthTeams } from "./replay";
import { game1Config, game1Evidence, game1GroundTruth, game1GroundTruthTeams } from "./game1";
import { game2Config, game2Evidence, game2GroundTruth, game2GroundTruthTeams } from "./game2";

/**
 * DIAGNOSTIC ONLY (controlled counterfactual strength experiment - see this
 * milestone's own report). Evaluates a grid of behavioral-evidence-strength
 * counterfactuals (global likelihood power via the existing
 * behavioralEvidenceWeight, feature-specific likelihood power via the new
 * buildFeatureWeightedBehavioralModel) against the 10 synthetic games AND
 * the two real recorded games - never used to select or tune a production
 * value. Invoke directly:
 * `npx ts-node src/behavioralStrengthExperimentReport.ts`.
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

interface ScoreSummary {
  avgBrier: number;
  finalBrier: number;
  avgLogLoss: number;
  finalLogLoss: number;
}

function evaluateDataset(dataset: Dataset, model: LikelihoodModel): { summary: ScoreSummary; perStep: StepEvaluation[] } {
  const worlds = generateWorlds(dataset.config);
  const setting: GameSetting = { config: dataset.config, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const steps = processEvidence(worlds, dataset.evidence, model, setting);
  const perStep = evaluateGame(steps, dataset.groundTruth, dataset.groundTruthTeams);
  const summary = summarizeGameEvaluation(perStep, dataset.groundTruth, dataset.groundTruthTeams);
  return {
    summary: { avgBrier: summary.averageBrierScore, finalBrier: summary.finalBrierScore, avgLogLoss: summary.averageLogLoss, finalLogLoss: summary.finalLogLoss },
    perStep,
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
  };
}

function evaluateConfiguration(label: string, model: LikelihoodModel) {
  const syntheticScores = syntheticDatasets.map((d) => evaluateDataset(d, model).summary);
  const g1 = evaluateDataset(game1, model);
  const g2 = evaluateDataset(game2, model);
  return {
    label,
    synthetic: meanScores(syntheticScores),
    game1: g1.summary,
    game2: g2.summary,
  };
}

const WEIGHTS = [0, 0.25, 0.5, 0.75, 1.0];

// ============================================================
// Reference configurations
// ============================================================

const fullModel = createBehavioralLikelihoodModel(syntheticBehavioralModelParams);
const mechanicalOnlyModel = buildAblatedBehavioralModel(syntheticBehavioralModelParams, new Set());
const flatNeutralModel = createBehavioralLikelihoodModel(buildUninformativeBehavioralParams(syntheticBehavioralModelParams));

const references = [
  evaluateConfiguration("FULL (all weights=1)", fullModel),
  evaluateConfiguration("MECHANICAL_ONLY (all behavioral ablated to constant 1)", mechanicalOnlyModel),
  evaluateConfiguration("FLAT_NEUTRAL_BASELINE (uninformative BehavioralModelParams)", flatNeutralModel),
];

// sanity: confirm (or refute) that MECHANICAL_ONLY and FLAT_NEUTRAL_BASELINE
// are posterior-identical, per updateProbabilities' own "world-independent
// constant cancels" identifiability note - both replace every behavioral
// handler's output with a WORLD-INDEPENDENT constant per observation (1 vs
// 0.5-ish/(1/3)-ish respectively), which should cancel identically in
// renormalization regardless of the constant's specific value.
const mechAndFlatIdentical =
  JSON.stringify(references[1].synthetic) === JSON.stringify(references[2].synthetic) &&
  JSON.stringify(references[1].game1) === JSON.stringify(references[2].game1) &&
  JSON.stringify(references[1].game2) === JSON.stringify(references[2].game2);

// ============================================================
// B. Global likelihood power sweep
// ============================================================

const globalSweep = WEIGHTS.map((w) => evaluateConfiguration(`GLOBAL w=${w}`, createBehavioralLikelihoodModel(syntheticBehavioralModelParams, undefined, w)));

// ============================================================
// C. Feature-specific likelihood power sweeps
// ============================================================

function weightedModel(weights: FeatureWeights): LikelihoodModel {
  return buildFeatureWeightedBehavioralModel(syntheticBehavioralModelParams, weights);
}

const suspectOnlySweep = WEIGHTS.map((w) => evaluateConfiguration(`SUSPECT_ONLY w=${w}`, weightedModel({ suspect: w })));
const candidateVoteOnlySweep = WEIGHTS.map((w) => evaluateConfiguration(`CANDIDATEVOTE_ONLY w=${w}`, weightedModel({ candidateVote: w })));
const bothSweep = WEIGHTS.map((w) => evaluateConfiguration(`BOTH(suspect+candidateVote) w=${w}`, weightedModel({ suspect: w, candidateVote: w })));

// ============================================================
// 4. Player 6 (Game1) diagnostic for the suspect-weight sweep
// ============================================================

function player6FinalForModel(model: LikelihoodModel): number {
  const { perStep } = evaluateDataset(game1, model);
  return perStep[perStep.length - 1].mafiaProbability["6"];
}

const player6Diagnostic = [
  { label: "FULL (suspect w=1)", player6FinalMafia: player6FinalForModel(fullModel) },
  ...[0.75, 0.5, 0.25, 0].map((w) => ({ label: `suspect w=${w}`, player6FinalMafia: player6FinalForModel(weightedModel({ suspect: w })) })),
  { label: "MECHANICAL_ONLY", player6FinalMafia: player6FinalForModel(mechanicalOnlyModel) },
];

// ============================================================
// Assemble and save
// ============================================================

const report = {
  references: { list: references, mechanicalOnlyEqualsFlatNeutral: mechAndFlatIdentical },
  globalSweep,
  suspectOnlySweep,
  candidateVoteOnlySweep,
  bothSweep,
  player6Diagnostic,
};

console.log(JSON.stringify(report, null, 2));
const outPath = "/tmp/claude-502/behavioral-strength-experiment-report.json";
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\nSaved to ${outPath}`);
