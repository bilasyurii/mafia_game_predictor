import fs from "fs";
import path from "path";
import { GameConfig, PlayerId, RoleId } from "./types";
import { Evidence } from "./evidence";
import { generateWorlds } from "./generateWorlds";
import { GameSetting, processEvidence } from "./processEvidence";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { createBehavioralLikelihoodModel } from "./behavioralModel";
import { syntheticBehavioralModelParams } from "./syntheticBehavioralModel";
import { evaluateGame, summarizeGameEvaluation } from "./gameEvaluation";
import { GroundTruthRoles, GroundTruthTeams } from "./replay";

/**
 * DIAGNOSTIC ONLY. Evaluates behavioralEvidenceWeight across a fixed grid
 * (1.0/0.75/0.5/0.25/0.0) against the 10 ALREADY-GENERATED synthetic games
 * from the earlier experiment (seeds 1000-1009) - their own saved
 * output.json ground truth, never the two real recorded games. This is
 * purely to check the tempering implementation behaves as expected on data
 * already in hand; it is NOT a weight-selection step, and its output must
 * never be used to tune defaultBehavioralModelParams,
 * syntheticBehavioralModelParams, or the two real games' held-out results.
 * Makes no Claude calls, generates no new games. Invoke directly:
 * `npx ts-node src/behavioralEvidenceWeightSyntheticEval.ts`.
 */

const OUTPUT_DIR =
  "/private/tmp/claude-502/-Users-yurii-Documents-personal-mafia-game-predictor/29f99942-d7c7-41c9-8d93-8a8624b90714/scratchpad/synthetic-experiment-1000";
const SEEDS = [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009];
const WEIGHTS = [1.0, 0.75, 0.5, 0.25, 0.0];

interface SyntheticOutput {
  config: GameConfig;
  publicEvidence: Evidence[];
  groundTruth: { roles: Record<PlayerId, RoleId> };
}

function loadGame(seed: number): SyntheticOutput {
  const raw = fs.readFileSync(path.join(OUTPUT_DIR, `synthetic-game-${seed}-output.json`), "utf8");
  return JSON.parse(raw);
}

function groundTruthFor(roles: Record<PlayerId, RoleId>): { gt: GroundTruthRoles; gtTeams: GroundTruthTeams } {
  const isMafia: Record<PlayerId, boolean> = {};
  Object.entries(roles).forEach(([p, role]) => {
    isMafia[p] = (defaultRoleRegistry as any)[role].team === "mafia";
  });
  return { gt: { roles }, gtTeams: { isMafia } };
}

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

const games = SEEDS.map(loadGame);

console.log(`Synthetic weight-grid evaluation: ${games.length} games (seeds ${SEEDS.join(",")}), weights [${WEIGHTS.join(", ")}]`);
console.log("Uses ONLY the 10 already-generated synthetic games' own saved ground truth - never the two real games.\n");

const rows: {
  weight: number;
  games: number;
  totalSteps: number;
  meanAvgBrier: number;
  meanFinalBrier: number;
  meanAvgLogLoss: number;
  meanFinalLogLoss: number;
}[] = [];

WEIGHTS.forEach((weight) => {
  const model = createBehavioralLikelihoodModel(syntheticBehavioralModelParams, undefined, weight);
  const perGame = games.map((g) => {
    const worlds = generateWorlds(g.config);
    const setting: GameSetting = { config: g.config, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
    const { gt, gtTeams } = groundTruthFor(g.groundTruth.roles);
    const steps = processEvidence(worlds, g.publicEvidence, model, setting);
    const perStep = evaluateGame(steps, gt, gtTeams);
    const summary = summarizeGameEvaluation(perStep, gt, gtTeams);
    return { steps: perStep.length, summary };
  });

  rows.push({
    weight,
    games: perGame.length,
    totalSteps: perGame.reduce((s, g) => s + g.steps, 0),
    meanAvgBrier: mean(perGame.map((g) => g.summary.averageBrierScore)),
    meanFinalBrier: mean(perGame.map((g) => g.summary.finalBrierScore)),
    meanAvgLogLoss: mean(perGame.map((g) => g.summary.averageLogLoss)),
    meanFinalLogLoss: mean(perGame.map((g) => g.summary.finalLogLoss)),
  });
});

console.log("weight | games | totalSteps | meanAvgBrier | meanFinalBrier | meanAvgLogLoss | meanFinalLogLoss");
rows.forEach((r) => {
  console.log(
    `${r.weight.toFixed(2)}   | ${r.games}    | ${r.totalSteps}         | ${r.meanAvgBrier.toFixed(4)}       | ${r.meanFinalBrier.toFixed(4)}         | ${r.meanAvgLogLoss.toFixed(4)}         | ${r.meanFinalLogLoss.toFixed(4)}`
  );
});
