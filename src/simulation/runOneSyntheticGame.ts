import { DEFAULT_CLAUDE_CLI_MODEL_ID } from "./claudeCliAgent";
import { DEFAULT_SEVEN_PLAYER_CONFIG, runOneGame, writeFailedGameFile, writeGameFiles } from "./syntheticGame";

/**
 * One-off runner script for this milestone: connects the simulation harness
 * to the user's existing Claude subscription via the `claude -p` CLI (see
 * claudeCliAgent.ts - no Anthropic API key, no SDK) and runs EXACTLY ONE
 * synthetic 7-player game, then prints a full report. Not a library module,
 * not imported by anything else - invoke directly
 * (`npx ts-node src/simulation/runOneSyntheticGame.ts`). Nothing here
 * modifies the predictor, the Behavioral Model, or the two real recorded
 * games. The actual run/report logic lives in syntheticGame.ts, shared with
 * the multi-game experiment runner (runSyntheticExperiment.ts).
 */
async function main() {
  const model = process.env.SIMULATION_MODEL_ID ?? DEFAULT_CLAUDE_CLI_MODEL_ID;
  const config = DEFAULT_SEVEN_PLAYER_CONFIG;
  const seed = Date.now();

  console.log(`Seed: ${seed}`);
  console.log(`Model: ${model}`);
  console.log(`Config: ${config.players.length} players, roles = [${config.roles.join(", ")}]`);

  const result = await runOneGame({ config, seed, model });

  const outDir = process.env.SIMULATION_OUTPUT_DIR ?? ".";

  if (result.status === "failed") {
    console.error("RUN FAILED - the simulation did not complete:");
    console.error(result.error);
    writeFailedGameFile(outDir, result);
    process.exit(1);
    return;
  }

  console.log("\n=== REPORT ===");
  console.log(JSON.stringify(result.report, null, 2));

  writeGameFiles(outDir, seed, result.output, result.report);
  console.log(`\nSaved raw output + report to ${outDir}`);
}

main();
