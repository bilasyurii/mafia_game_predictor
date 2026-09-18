import { generateWorlds } from "./generateWorlds";
import { GameSetting, processEvidence } from "./processEvidence";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { createBehavioralLikelihoodModel } from "./behavioralModel";
import { syntheticBehavioralModelParams } from "./syntheticBehavioralModel";
import { evaluateGame, summarizeGameEvaluation, formatGameEvaluationSummary } from "./gameEvaluation";
import { game1Config, game1Evidence, game1GroundTruth, game1GroundTruthTeams } from "./game1";
import { game2Config, game2Evidence, game2GroundTruth, game2GroundTruthTeams } from "./game2";

/**
 * Held-out evaluation: runs the synthetic-derived behavioral priors
 * (syntheticBehavioralModel.ts, built ONLY from the 10-game synthetic
 * experiment) against the two real recorded games, which were never
 * inspected while those priors were being built. Prints the full per-step
 * and whole-game evaluation for each. Not a library module - invoke
 * directly (`npx ts-node src/evaluateRealGames.ts`). Makes no Claude calls,
 * changes no parameters, and this script itself must never be edited to
 * "improve" the numbers after seeing its own output.
 */

const model = createBehavioralLikelihoodModel(syntheticBehavioralModelParams);

function evaluate(label: string, config: typeof game1Config, evidence: typeof game1Evidence, groundTruth: typeof game1GroundTruth, groundTruthTeams: typeof game1GroundTruthTeams) {
  console.log(`\n${"=".repeat(60)}\n${label}\n${"=".repeat(60)}`);
  console.log(`players=${config.players.length}, roles=[${config.roles.join(", ")}]`);

  const worlds = generateWorlds(config);
  const setting: GameSetting = { config, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const steps = processEvidence(worlds, evidence, model, setting);
  const perStep = evaluateGame(steps, groundTruth, groundTruthTeams);
  const summary = summarizeGameEvaluation(perStep, groundTruth, groundTruthTeams);

  console.log(formatGameEvaluationSummary(summary));

  console.log("\nPer-step detail:");
  perStep.forEach((s) => {
    console.log(
      `  [${s.index}] ${s.evidenceType}: ${s.description} | Brier=${s.stepBrierScore.toFixed(4)} logLoss=${s.stepLogLoss.toFixed(4)}`
    );
    console.log(
      `        top3(alive)=${s.aliveTop3ByMafia.map((e) => `${e.player}:${e.probability.toFixed(3)}`).join(", ")}`
    );
  });

  return summary;
}

const summary1 = evaluate("GAME 1 (game1.ts) - 10 players", game1Config, game1Evidence, game1GroundTruth, game1GroundTruthTeams);
const summary2 = evaluate("GAME 2 (game2.ts) - 9 players", game2Config, game2Evidence, game2GroundTruth, game2GroundTruthTeams);

console.log(`\n${"=".repeat(60)}\nSUMMARY\n${"=".repeat(60)}`);
console.log(`Game 1: avgBrier=${summary1.averageBrierScore.toFixed(4)} avgLogLoss=${summary1.averageLogLoss.toFixed(4)} finalBrier=${summary1.finalBrierScore.toFixed(4)} finalLogLoss=${summary1.finalLogLoss.toFixed(4)}`);
console.log(`Game 2: avgBrier=${summary2.averageBrierScore.toFixed(4)} avgLogLoss=${summary2.averageLogLoss.toFixed(4)} finalBrier=${summary2.finalBrierScore.toFixed(4)} finalLogLoss=${summary2.finalLogLoss.toFixed(4)}`);
