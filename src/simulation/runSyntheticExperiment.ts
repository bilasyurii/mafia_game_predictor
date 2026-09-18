import { GameConfig } from "../types";
import { GameOutcome } from "../gameOutcome";
import { DEFAULT_CLAUDE_CLI_MODEL_ID } from "./claudeCliAgent";
import {
  BehavioralStats,
  DEFAULT_SEVEN_PLAYER_CONFIG,
  DistributionStats,
  GameRunResult,
  TeamBucket,
  distributionStats,
  runOneGame,
  writeFailedGameFile,
  writeGameFiles,
} from "./syntheticGame";
import fs from "fs";
import path from "path";

/**
 * Multi-game synthetic experiment runner, built around runOneGame
 * (syntheticGame.ts) - the exact same per-decision Claude CLI provider,
 * one-`claude -p`-process-per-decision architecture, and per-decision
 * instrumentation as the single-game script. Games run strictly
 * SEQUENTIALLY (never in parallel), each with its own seed and completely
 * fresh game state - no conversational/session state is shared between
 * games, since every decision in every game is still an independent `claude
 * -p` invocation. Never batches. Never calibrates predictor parameters:
 * this file only ever produces raw behavioral observations for later
 * inspection.
 *
 * Invoke: `npx ts-node src/simulation/runSyntheticExperiment.ts --games 5 --seed 1000`
 */

export interface ExperimentArgs {
  games: number;
  baseSeed: number;
}

/** Pure argument parsing - no I/O, no defaults hidden from the caller except baseSeed's Date.now() fallback. */
export function parseExperimentArgs(argv: string[]): ExperimentArgs {
  let games = 1;
  let baseSeed = Date.now();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--games") {
      const raw = argv[++i];
      const parsed = Number(raw);
      if (raw === undefined || !Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`--games must be a positive integer, got ${JSON.stringify(raw)}`);
      }
      games = parsed;
    } else if (arg === "--seed") {
      const raw = argv[++i];
      const parsed = Number(raw);
      if (raw === undefined || !Number.isInteger(parsed)) {
        throw new Error(`--seed must be an integer, got ${JSON.stringify(raw)}`);
      }
      baseSeed = parsed;
    } else {
      throw new Error(`unrecognized argument: ${JSON.stringify(arg)}`);
    }
  }

  return { games, baseSeed };
}

export interface PerGameSummary {
  seed: number;
  status: "completed" | "failed";
  outcome?: GameOutcome;
  calls: number;
  retries: number;
  costUsd: number;
  durationMs: number;
  error?: string;
}

export interface AggregateBehavioralStats extends Omit<BehavioralStats, "repeatedTargets"> {
  /** Same shape as a single game's repeatedTargets, plus which game (by seed) it happened in. */
  repeatedTargets: { actor: string; type: string; target: string; gameSeed: number }[];
}

export interface AggregateReport {
  gamesRequested: number;
  gamesCompleted: number;
  gamesFailed: number;
  outcomesByTeam: Partial<Record<GameOutcome, number>>;
  totalClaudeCalls: number;
  /** Only summed across COMPLETED games - driver.ts's own retry count is not returned on a failed game. */
  totalRetries: number;
  /** Failed decision attempts inside games that ultimately failed outright (a distinct figure from totalRetries - see PerGameSummary). */
  totalFailedGameAttempts: number;
  totalWallClockMs: number;
  totalCostUsd: number;
  callsPerGame: DistributionStats;
  costPerGame: DistributionStats;
  durationPerGameMs: DistributionStats;
  behavioralStats: AggregateBehavioralStats;
  perGame: PerGameSummary[];
}

function mergeBucket(a: TeamBucket, b: TeamBucket): TeamBucket {
  return {
    townToMafia: a.townToMafia + b.townToMafia,
    townToTown: a.townToTown + b.townToTown,
    mafiaToMafia: a.mafiaToMafia + b.mafiaToMafia,
    mafiaToTown: a.mafiaToTown + b.mafiaToTown,
  };
}

const emptyBucket = (): TeamBucket => ({ townToMafia: 0, townToTown: 0, mafiaToMafia: 0, mafiaToTown: 0 });

/**
 * Pure aggregation over already-produced GameRunResults (no file I/O, no
 * Claude calls) - kept separate from runExperiment so it's directly
 * testable against hand-built fixtures.
 */
export function aggregateGameReports(results: GameRunResult[]): AggregateReport {
  const behavioralStats: AggregateBehavioralStats = {
    suspectCounts: emptyBucket(),
    defendCounts: emptyBucket(),
    nominateCounts: emptyBucket(),
    roleClaims: { truthful: 0, falseSameTeam: 0, falseDifferentTeam: 0 },
    investigationReports: { truthfulHolder: 0, bluffNonHolder: 0, resultMatchesTruth: 0, resultContradictsTruth: 0 },
    voteCounts: {
      town: { forMafiaCandidate: 0, forTownCandidate: 0, abstain: 0 },
      mafia: { forMafiaCandidate: 0, forTownCandidate: 0, abstain: 0 },
    },
    repeatedTargets: [],
  };

  const outcomesByTeam: Partial<Record<GameOutcome, number>> = {};
  const perGame: PerGameSummary[] = [];
  const callCounts: number[] = [];
  const costs: number[] = [];
  const durations: number[] = [];
  let totalClaudeCalls = 0;
  let totalRetries = 0;
  let totalFailedGameAttempts = 0;
  let totalWallClockMs = 0;
  let totalCostUsd = 0;
  let gamesCompleted = 0;
  let gamesFailed = 0;

  for (const result of results) {
    if (result.status === "completed") {
      gamesCompleted += 1;
      const { report } = result;
      const outcome = report.game.outcome;
      outcomesByTeam[outcome] = (outcomesByTeam[outcome] ?? 0) + 1;

      const calls = report.performance.totalDecisions;
      const costUsd = report.performance.totalCostUsd;
      const durationMs = report.performance.totalWallClockMs;
      callCounts.push(calls);
      costs.push(costUsd);
      durations.push(durationMs);
      totalClaudeCalls += calls;
      totalRetries += report.usage.retries;
      totalWallClockMs += durationMs;
      totalCostUsd += costUsd;

      perGame.push({ seed: result.seed, status: "completed", outcome, calls, retries: report.usage.retries, costUsd, durationMs });

      const bs = report.behavioralStats;
      behavioralStats.suspectCounts = mergeBucket(behavioralStats.suspectCounts, bs.suspectCounts);
      behavioralStats.defendCounts = mergeBucket(behavioralStats.defendCounts, bs.defendCounts);
      behavioralStats.nominateCounts = mergeBucket(behavioralStats.nominateCounts, bs.nominateCounts);
      behavioralStats.roleClaims.truthful += bs.roleClaims.truthful;
      behavioralStats.roleClaims.falseSameTeam += bs.roleClaims.falseSameTeam;
      behavioralStats.roleClaims.falseDifferentTeam += bs.roleClaims.falseDifferentTeam;
      behavioralStats.investigationReports.truthfulHolder += bs.investigationReports.truthfulHolder;
      behavioralStats.investigationReports.bluffNonHolder += bs.investigationReports.bluffNonHolder;
      behavioralStats.investigationReports.resultMatchesTruth += bs.investigationReports.resultMatchesTruth;
      behavioralStats.investigationReports.resultContradictsTruth += bs.investigationReports.resultContradictsTruth;
      behavioralStats.voteCounts.town.forMafiaCandidate += bs.voteCounts.town.forMafiaCandidate;
      behavioralStats.voteCounts.town.forTownCandidate += bs.voteCounts.town.forTownCandidate;
      behavioralStats.voteCounts.town.abstain += bs.voteCounts.town.abstain;
      behavioralStats.voteCounts.mafia.forMafiaCandidate += bs.voteCounts.mafia.forMafiaCandidate;
      behavioralStats.voteCounts.mafia.forTownCandidate += bs.voteCounts.mafia.forTownCandidate;
      behavioralStats.voteCounts.mafia.abstain += bs.voteCounts.mafia.abstain;
      bs.repeatedTargets.forEach((t) => behavioralStats.repeatedTargets.push({ ...t, gameSeed: result.seed }));
    } else {
      gamesFailed += 1;
      const calls = result.performance.totalDecisions;
      const costUsd = result.performance.totalCostUsd;
      const durationMs = result.performance.totalWallClockMs;
      const failedAttempts = result.attemptedCalls - calls;
      callCounts.push(calls);
      costs.push(costUsd);
      durations.push(durationMs);
      totalClaudeCalls += calls;
      totalFailedGameAttempts += failedAttempts;
      totalWallClockMs += durationMs;
      totalCostUsd += costUsd;

      perGame.push({ seed: result.seed, status: "failed", calls, retries: failedAttempts, costUsd, durationMs, error: result.error });
    }
  }

  return {
    gamesRequested: results.length,
    gamesCompleted,
    gamesFailed,
    outcomesByTeam,
    totalClaudeCalls,
    totalRetries,
    totalFailedGameAttempts,
    totalWallClockMs,
    totalCostUsd,
    callsPerGame: distributionStats(callCounts),
    costPerGame: distributionStats(costs),
    durationPerGameMs: distributionStats(durations),
    behavioralStats,
    perGame,
  };
}

async function main() {
  const args = parseExperimentArgs(process.argv.slice(2));
  const model = process.env.SIMULATION_MODEL_ID ?? DEFAULT_CLAUDE_CLI_MODEL_ID;
  const config: GameConfig = DEFAULT_SEVEN_PLAYER_CONFIG;
  const outDir = process.env.SIMULATION_OUTPUT_DIR ?? ".";

  console.log(`Experiment: ${args.games} game(s), base seed ${args.baseSeed}, model ${model}`);
  console.log(`Config: ${config.players.length} players, roles = [${config.roles.join(", ")}]`);

  const results: GameRunResult[] = [];
  for (let i = 0; i < args.games; i++) {
    const seed = args.baseSeed + i;
    console.log(`\n=== Game ${i + 1}/${args.games} (seed=${seed}) ===`);
    const result = await runOneGame({ config, seed, model, logPrefix: `[game ${i + 1}/${args.games}] ` });
    results.push(result);

    if (result.status === "failed") {
      console.error(`Game ${i + 1}/${args.games} (seed=${seed}) FAILED: ${result.error}`);
      writeFailedGameFile(outDir, result);
    } else {
      console.log(
        `Game ${i + 1}/${args.games} (seed=${seed}) completed: outcome=${result.report.game.outcome} ` +
          `calls=${result.report.performance.totalDecisions} costUsd=${result.report.performance.totalCostUsd.toFixed(4)}`
      );
      writeGameFiles(outDir, seed, result.output, result.report);
    }
  }

  const aggregate = aggregateGameReports(results);

  console.log("\n=== AGGREGATE REPORT ===");
  console.log(JSON.stringify(aggregate, null, 2));

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `synthetic-experiment-${args.baseSeed}-aggregate.json`), JSON.stringify(aggregate, null, 2));
  console.log(`\nSaved aggregate report to ${outDir}`);
}

if (require.main === module) {
  main();
}
