import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateGameReports, parseExperimentArgs } from "./runSyntheticExperiment";
import { GameReport, GameRunResult, PerformanceStats, TeamBucket } from "./syntheticGame";
import { SimulationOutput } from "./types";

/**
 * Tests for the multi-game experiment runner's two pure, I/O-free functions:
 * argument parsing and result aggregation. Never invokes runOneGame or the
 * real Claude CLI - fixtures below stand in for a completed/failed
 * GameRunResult exactly as runOneGame would produce them.
 */

const emptyBucket = (): TeamBucket => ({ townToMafia: 0, townToTown: 0, mafiaToMafia: 0, mafiaToTown: 0 });

function performanceFixture(overrides: Partial<PerformanceStats> = {}): PerformanceStats {
  return {
    totalDecisions: 3,
    totalWallClockMs: 30_000,
    callDurationMs: { min: 9000, median: 10000, mean: 10000, max: 11000 },
    totalCostUsd: 0.03,
    callCostUsd: { min: 0.009, median: 0.01, mean: 0.01, max: 0.011 },
    callLog: [],
    ...overrides,
  };
}

function completedResultFixture(seed: number, overrides: Partial<GameReport> = {}): Extract<GameRunResult, { status: "completed" }> {
  const report: GameReport = {
    game: {
      seed,
      model: "claude-haiku-4-5-20251001",
      playerCount: 7,
      roleComposition: ["don", "mafia", "commissioner", "doctor", "citizen", "citizen", "citizen"],
      roundsPlayed: 1,
      terminatedByRoundCap: false,
      publicEvidenceLength: 5,
      outcome: "townWon",
      groundTruthRoles: { "1": "citizen" },
    },
    usage: { llmCalls: 3, retries: 0, decisionsByRequestKind: {}, callsWithReportedUsage: 3, totalCostUsd: 0.03 },
    cost: { measuredCostUsd: 0.03, tokenRateCrossCheckUsd: { inputCost: 0.0001, outputCost: 0.001 } },
    behavioralStats: {
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
    },
    sanity: { boundaryViolations: [], replayOk: true, replaySteps: 1, worldCount: 1 },
    performance: performanceFixture(),
    ...overrides,
  };

  const output = {} as SimulationOutput; // aggregation never reads GameRunResult.output directly
  return { status: "completed", seed, model: report.game.model, output, report };
}

function failedResultFixture(seed: number, attemptedCalls: number, performance: PerformanceStats): Extract<GameRunResult, { status: "failed" }> {
  return { status: "failed", seed, model: "claude-haiku-4-5-20251001", error: "agent decision failed validation after 3 attempt(s)", attemptedCalls, performance };
}

// ---- parseExperimentArgs ----

test("parseExperimentArgs: defaults to 1 game and a Date.now()-based seed when no args given", () => {
  const before = Date.now();
  const args = parseExperimentArgs([]);
  const after = Date.now();
  assert.equal(args.games, 1);
  assert.ok(args.baseSeed >= before && args.baseSeed <= after);
});

test("parseExperimentArgs: parses --games and --seed", () => {
  const args = parseExperimentArgs(["--games", "5", "--seed", "1000"]);
  assert.deepEqual(args, { games: 5, baseSeed: 1000 });
});

test("parseExperimentArgs: rejects a non-positive-integer --games", () => {
  assert.throws(() => parseExperimentArgs(["--games", "0"]), /--games/);
  assert.throws(() => parseExperimentArgs(["--games", "-3"]), /--games/);
  assert.throws(() => parseExperimentArgs(["--games", "2.5"]), /--games/);
  assert.throws(() => parseExperimentArgs(["--games", "notanumber"]), /--games/);
});

test("parseExperimentArgs: rejects a non-integer --seed", () => {
  assert.throws(() => parseExperimentArgs(["--seed", "1.5"]), /--seed/);
  assert.throws(() => parseExperimentArgs(["--seed", "abc"]), /--seed/);
});

test("parseExperimentArgs: rejects an unrecognized argument", () => {
  assert.throws(() => parseExperimentArgs(["--bogus"]), /unrecognized argument/);
});

// ---- aggregateGameReports ----

test("aggregateGameReports: sums behavioralStats, calls, cost and duration across completed games", () => {
  const g1 = completedResultFixture(1, {
    game: { ...completedResultFixture(1).report.game, outcome: "townWon" },
    behavioralStats: {
      ...completedResultFixture(1).report.behavioralStats,
      suspectCounts: { townToMafia: 2, townToTown: 1, mafiaToMafia: 0, mafiaToTown: 0 },
      roleClaims: { truthful: 1, falseSameTeam: 0, falseDifferentTeam: 0 },
    },
    performance: performanceFixture({ totalDecisions: 17, totalCostUsd: 0.37, totalWallClockMs: 238_546 }),
    usage: { llmCalls: 17, retries: 0, decisionsByRequestKind: {}, callsWithReportedUsage: 17 },
  });
  const g2 = completedResultFixture(2, {
    game: { ...completedResultFixture(2).report.game, outcome: "mafiaWon" },
    behavioralStats: {
      ...completedResultFixture(2).report.behavioralStats,
      suspectCounts: { townToMafia: 0, townToTown: 3, mafiaToMafia: 1, mafiaToTown: 0 },
      roleClaims: { truthful: 0, falseSameTeam: 2, falseDifferentTeam: 0 },
    },
    performance: performanceFixture({ totalDecisions: 20, totalCostUsd: 0.4, totalWallClockMs: 250_000 }),
    usage: { llmCalls: 20, retries: 1, decisionsByRequestKind: {}, callsWithReportedUsage: 20 },
  });

  const aggregate = aggregateGameReports([g1, g2]);

  assert.equal(aggregate.gamesRequested, 2);
  assert.equal(aggregate.gamesCompleted, 2);
  assert.equal(aggregate.gamesFailed, 0);
  assert.deepEqual(aggregate.outcomesByTeam, { townWon: 1, mafiaWon: 1 });
  assert.equal(aggregate.totalClaudeCalls, 37);
  assert.equal(aggregate.totalRetries, 1);
  assert.equal(aggregate.totalFailedGameAttempts, 0);
  assert.ok(Math.abs(aggregate.totalCostUsd - 0.77) < 1e-9);
  assert.equal(aggregate.totalWallClockMs, 488_546);
  assert.deepEqual(aggregate.behavioralStats.suspectCounts, { townToMafia: 2, townToTown: 4, mafiaToMafia: 1, mafiaToTown: 0 });
  assert.deepEqual(aggregate.behavioralStats.roleClaims, { truthful: 1, falseSameTeam: 2, falseDifferentTeam: 0 });
  assert.equal(aggregate.callsPerGame.min, 17);
  assert.equal(aggregate.callsPerGame.max, 20);
  assert.equal(aggregate.perGame.length, 2);
  assert.equal(aggregate.perGame[0].status, "completed");
  assert.equal(aggregate.perGame[0].seed, 1);
});

test("aggregateGameReports: a failed game is counted separately and never contributes to behavioralStats or totalRetries", () => {
  const g1 = completedResultFixture(1, {
    performance: performanceFixture({ totalDecisions: 10, totalCostUsd: 0.1, totalWallClockMs: 100_000 }),
    usage: { llmCalls: 10, retries: 2, decisionsByRequestKind: {}, callsWithReportedUsage: 10 },
  });
  const failed = failedResultFixture(
    2,
    /* attemptedCalls */ 8,
    performanceFixture({ totalDecisions: 5, totalCostUsd: 0.05, totalWallClockMs: 60_000 })
  );

  const aggregate = aggregateGameReports([g1, failed]);

  assert.equal(aggregate.gamesRequested, 2);
  assert.equal(aggregate.gamesCompleted, 1);
  assert.equal(aggregate.gamesFailed, 1);
  // failed game contributed its 5 successful-before-failure calls, plus 3 failed attempts (8 - 5)
  assert.equal(aggregate.totalClaudeCalls, 15);
  assert.equal(aggregate.totalFailedGameAttempts, 3);
  assert.equal(aggregate.totalRetries, 2); // only g1's driver-reported retries - failed game has none returned
  assert.ok(Math.abs(aggregate.totalCostUsd - 0.15) < 1e-9);
  assert.deepEqual(aggregate.outcomesByTeam, { townWon: 1 });

  const failedSummary = aggregate.perGame.find((p) => p.seed === 2);
  assert.equal(failedSummary?.status, "failed");
  assert.equal(failedSummary?.error, "agent decision failed validation after 3 attempt(s)");
  assert.equal(failedSummary?.retries, 3);
});

test("aggregateGameReports: repeatedTargets are tagged with the originating game's seed", () => {
  const g1 = completedResultFixture(1, {
    behavioralStats: {
      ...completedResultFixture(1).report.behavioralStats,
      repeatedTargets: [{ actor: "2", type: "suspect", target: "5" }],
    },
  });
  const g2 = completedResultFixture(2, {
    behavioralStats: {
      ...completedResultFixture(2).report.behavioralStats,
      repeatedTargets: [{ actor: "3", type: "nominate", target: "6" }],
    },
  });

  const aggregate = aggregateGameReports([g1, g2]);

  assert.deepEqual(aggregate.behavioralStats.repeatedTargets, [
    { actor: "2", type: "suspect", target: "5", gameSeed: 1 },
    { actor: "3", type: "nominate", target: "6", gameSeed: 2 },
  ]);
});

test("aggregateGameReports: an empty result list produces a well-formed zeroed report, not a crash", () => {
  const aggregate = aggregateGameReports([]);
  assert.equal(aggregate.gamesRequested, 0);
  assert.equal(aggregate.gamesCompleted, 0);
  assert.equal(aggregate.gamesFailed, 0);
  assert.equal(aggregate.totalClaudeCalls, 0);
  assert.deepEqual(aggregate.outcomesByTeam, {});
  assert.deepEqual(aggregate.perGame, []);
  assert.deepEqual(aggregate.callsPerGame, {});
});
