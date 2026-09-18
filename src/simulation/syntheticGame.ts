import fs from "fs";
import path from "path";
import { GameConfig } from "../types";
import { defaultRoleRegistry, hasMechanic } from "../roles";
import { defaultGroupRegistry } from "../roleGroups";
import { getInvestigationResult } from "../investigation";
import { getAliveStateAt } from "../facts";
import { generateWorlds } from "../generateWorlds";
import { GameSetting, processEvidence } from "../processEvidence";
import { createBehavioralLikelihoodModel, defaultBehavioralModelParams } from "../behavioralModel";
import { runSimulation } from "./driver";
import { createClaudeCliAgent } from "./claudeCliAgent";
import { PublicGameStateView, SimulationAgent, SimulationDecisionRequest, SimulationOutput } from "./types";

/**
 * The reusable "run one synthetic game via the Claude CLI provider, then
 * build its report" logic - extracted so both the single-game script
 * (runOneSyntheticGame.ts) and the multi-game experiment runner
 * (runSyntheticExperiment.ts) share exactly one implementation instead of
 * two copies drifting apart. Nothing here modifies the predictor, the
 * Behavioral Model, or the two real recorded games; every game is still one
 * fresh `claude -p` process per decision (see claudeCliAgent.ts) - no
 * batching, no parallelism, no shared session state between games.
 */

export const DEFAULT_SEVEN_PLAYER_CONFIG: GameConfig = {
  players: ["1", "2", "3", "4", "5", "6", "7"],
  roles: ["don", "mafia", "commissioner", "doctor", "citizen", "citizen", "citizen"],
};

function teamOf(roles: Record<string, string>, player: string): string {
  return (defaultRoleRegistry as any)[roles[player]].team;
}

function claimedTeam(claim: { kind: "role"; role: string } | { kind: "group"; group: string }): string {
  if (claim.kind === "role") return (defaultRoleRegistry as any)[claim.role].team;
  const members: string[] = (defaultGroupRegistry as any)[claim.group];
  return (defaultRoleRegistry as any)[members[0]].team;
}

export interface CallRecord {
  callNumber: number;
  round: number;
  phase: "day" | "night";
  player: string;
  kind: string;
  attempt: number;
  elapsedMs: number;
  costUsd?: number;
}

export interface DistributionStats {
  min?: number;
  median?: number;
  mean?: number;
  max?: number;
}

export function distributionStats(values: number[]): DistributionStats {
  if (values.length === 0) return {};
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return {
    min: sorted[0],
    median,
    mean: sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
    max: sorted[sorted.length - 1],
  };
}

export interface PerformanceStats {
  totalDecisions: number;
  totalWallClockMs: number;
  callDurationMs: DistributionStats;
  totalCostUsd: number;
  callCostUsd: DistributionStats;
  callLog: CallRecord[];
}

export type TeamBucket = { townToMafia: number; townToTown: number; mafiaToMafia: number; mafiaToTown: number };

export interface BehavioralStats {
  suspectCounts: TeamBucket;
  defendCounts: TeamBucket;
  nominateCounts: TeamBucket;
  roleClaims: { truthful: number; falseSameTeam: number; falseDifferentTeam: number };
  investigationReports: {
    truthfulHolder: number;
    bluffNonHolder: number;
    resultMatchesTruth: number;
    resultContradictsTruth: number;
  };
  voteCounts: {
    town: { forMafiaCandidate: number; forTownCandidate: number; abstain: number };
    mafia: { forMafiaCandidate: number; forTownCandidate: number; abstain: number };
  };
  repeatedTargets: { actor: string; type: string; target: string }[];
}

export interface GameReport {
  game: {
    seed: number;
    model: string;
    playerCount: number;
    roleComposition: string[];
    roundsPlayed: number;
    terminatedByRoundCap: boolean;
    publicEvidenceLength: number;
    outcome: SimulationOutput["outcome"];
    groundTruthRoles: Record<string, string>;
  };
  usage: SimulationOutput["stats"];
  cost: {
    measuredCostUsd: number | undefined;
    tokenRateCrossCheckUsd: { inputCost: number; outputCost: number };
  };
  behavioralStats: BehavioralStats;
  sanity: {
    boundaryViolations: string[];
    replayOk: boolean;
    replaySteps: number;
    worldCount: number;
  };
  performance: PerformanceStats;
}

export type GameRunResult =
  | { status: "completed"; seed: number; model: string; output: SimulationOutput; report: GameReport }
  | { status: "failed"; seed: number; model: string; error: string; attemptedCalls: number; performance: PerformanceStats };

export interface RunOneGameOptions {
  config: GameConfig;
  seed: number;
  model: string;
  /** Prepended to every per-decision START/DONE/FAILED log line - useful to tell games apart in a multi-game run. */
  logPrefix?: string;
  maxRounds?: number;
}

/**
 * Heuristic post-hoc check that no sent request's PublicGameStateView leaked
 * information a real player in that seat wouldn't legitimately have. Only
 * `view.private` is scanned for another player's true role: `publicHistory`
 * is intentionally identical for every player and may legitimately contain
 * ANY role name via a public `selfRoleClaim` (a player may truthfully or
 * falsely claim to be any role - that's in-character bluffing, not a leak,
 * and once claimed it's public knowledge for the rest of the game). Scanning
 * the whole serialized view (as an earlier version of this check did)
 * produces false positives every time any player makes a public role claim -
 * confirmed against the 10-game synthetic experiment, where 9/10 games
 * "failed" this check purely because of legitimate public bluffing. The
 * actual information boundary is enforced by construction in
 * playerView.ts's buildPlayerView (see playerView.test.ts) - this is only a
 * secondary sanity net over the real requests a run actually sent.
 */
export function checkInformationBoundary(
  config: GameConfig,
  groundTruthRoles: Record<string, string>,
  sentViews: PublicGameStateView[]
): string[] {
  const violations: string[] = [];
  sentViews.forEach((view, i) => {
    const serializedPrivate = JSON.stringify(view.private);
    const trueRole = groundTruthRoles[view.self];
    const actorTeam = teamOf(groundTruthRoles, view.self);
    config.players.forEach((other) => {
      if (other === view.self) return;
      const otherRole = groundTruthRoles[other];
      const otherTeam = teamOf(groundTruthRoles, other);
      const legitimatelyKnown = actorTeam === "mafia" && otherTeam === "mafia";
      if (!legitimatelyKnown && serializedPrivate.includes(`"${otherRole}"`) && otherRole !== trueRole) {
        violations.push(`request #${i} (self=${view.self}) may reference role "${otherRole}" of "${other}" in private knowledge`);
      }
    });
    if (actorTeam !== "mafia" && view.private.teammates !== undefined) {
      violations.push(`request #${i}: non-Mafia player ${view.self} was given a "teammates" field`);
    }
  });
  return violations;
}

export function computeBehavioralStats(config: GameConfig, output: SimulationOutput): BehavioralStats {
  const emptyBucket = (): TeamBucket => ({ townToMafia: 0, townToTown: 0, mafiaToMafia: 0, mafiaToTown: 0 });
  const suspectCounts = emptyBucket();
  const defendCounts = emptyBucket();
  const nominateCounts = emptyBucket();
  const roleClaims = { truthful: 0, falseSameTeam: 0, falseDifferentTeam: 0 };
  const investigationReports = { truthfulHolder: 0, bluffNonHolder: 0, resultMatchesTruth: 0, resultContradictsTruth: 0 };
  const voteCounts = {
    town: { forMafiaCandidate: 0, forTownCandidate: 0, abstain: 0 },
    mafia: { forMafiaCandidate: 0, forTownCandidate: 0, abstain: 0 },
  };
  const seenPositions = new Set<string>();
  const repeatedTargets: { actor: string; type: string; target: string }[] = [];

  const addToBucket = (bucket: TeamBucket, actorTeam: string, targetTeam: string) => {
    if (actorTeam === "town" && targetTeam === "mafia") bucket.townToMafia += 1;
    else if (actorTeam === "town") bucket.townToTown += 1;
    else if (actorTeam === "mafia" && targetTeam === "mafia") bucket.mafiaToMafia += 1;
    else if (actorTeam === "mafia") bucket.mafiaToTown += 1;
  };

  output.publicEvidence.forEach((e) => {
    if (e.type === "suspect" || e.type === "defend" || e.type === "nominate") {
      const actorTeam = teamOf(output.groundTruth.roles, e.actor);
      const targetTeam = teamOf(output.groundTruth.roles, e.target);
      addToBucket(e.type === "suspect" ? suspectCounts : e.type === "defend" ? defendCounts : nominateCounts, actorTeam, targetTeam);

      const key = `${e.actor}|${e.type}|${e.target}`;
      if (seenPositions.has(key)) repeatedTargets.push({ actor: e.actor, type: e.type, target: e.target });
      seenPositions.add(key);
    }
    if (e.type === "selfRoleClaim") {
      const actorRole = output.groundTruth.roles[e.actor];
      const isTrue =
        e.claim.kind === "role" ? e.claim.role === actorRole : (defaultGroupRegistry as any)[e.claim.group].includes(actorRole);
      if (isTrue) roleClaims.truthful += 1;
      else if (claimedTeam(e.claim) === teamOf(output.groundTruth.roles, e.actor)) roleClaims.falseSameTeam += 1;
      else roleClaims.falseDifferentTeam += 1;
    }
    if (e.type === "investigationReport") {
      const holds = hasMechanic(defaultRoleRegistry, output.groundTruth.roles[e.actor] as any, e.mechanic);
      if (holds) investigationReports.truthfulHolder += 1;
      else investigationReports.bluffNonHolder += 1;
      const actualResult = getInvestigationResult(defaultRoleRegistry, e.mechanic, output.groundTruth.roles[e.target] as any);
      if (actualResult === e.result) investigationReports.resultMatchesTruth += 1;
      else investigationReports.resultContradictsTruth += 1;
    }
    if (e.type === "candidateVote") {
      const alive = getAliveStateAt(config, output.publicEvidence, { phase: "day", round: e.round });
      const votedPlayers = new Set(Object.values(e.handsRaised).flatMap((v) => v ?? []));
      config.players.forEach((p) => {
        if (alive[p] !== true || votedPlayers.has(p)) return;
        const bucket = voteCounts[teamOf(output.groundTruth.roles, p) === "mafia" ? "mafia" : "town"];
        bucket.abstain += 1;
      });
      Object.entries(e.handsRaised).forEach(([candidate, voters]) => {
        const candidateTeam = teamOf(output.groundTruth.roles, candidate);
        (voters ?? []).forEach((voter) => {
          const bucket = voteCounts[teamOf(output.groundTruth.roles, voter) === "mafia" ? "mafia" : "town"];
          if (candidateTeam === "mafia") bucket.forMafiaCandidate += 1;
          else bucket.forTownCandidate += 1;
        });
      });
    }
  });

  return { suspectCounts, defendCounts, nominateCounts, roleClaims, investigationReports, voteCounts, repeatedTargets };
}

/**
 * Runs exactly one synthetic game through the Claude CLI provider, end to
 * end, and returns a discriminated result instead of throwing - a fatal
 * decision failure (driver.ts's bounded retry exhausted) is reported as
 * `status: "failed"` with whatever partial call/cost data was captured
 * before the failure, never re-attempted here. Never batches, never runs
 * decisions in parallel: one `claude -p` process per decision, exactly as
 * claudeCliAgent.ts implements it.
 */
export async function runOneGame(options: RunOneGameOptions): Promise<GameRunResult> {
  const { config, seed, model, maxRounds = 12 } = options;
  const logPrefix = options.logPrefix ?? "";

  const cliAgent = createClaudeCliAgent({ model, effort: "low" });
  const sentViews: PublicGameStateView[] = [];

  // Progress instrumentation only - no mechanics/behavior here. Every call
  // (including retries, since driver.ts's ask() re-invokes options.agent.decide
  // on the SAME request object per attempt) is logged the instant it starts,
  // so a hang is visible as "the last START with no matching DONE/FAILED",
  // and again the instant it finishes, with per-call cost/duration. These
  // counters live in THIS closure, not in SimulationOutput, so they survive
  // even if runSimulation below ultimately throws.
  let callCounter = 0;
  let cumulativeCostUsd = 0;
  let cumulativeSuccessfulCalls = 0;
  const callRecords: CallRecord[] = [];
  const attemptCounts = new WeakMap<SimulationDecisionRequest, number>();

  const instrumentedAgent: SimulationAgent = {
    async decide(request) {
      sentViews.push(request.view);

      callCounter += 1;
      const callNumber = callCounter;
      const attempt = (attemptCounts.get(request) ?? 0) + 1;
      attemptCounts.set(request, attempt);
      const { phase, round } = request.view.phase;
      const player = request.player;
      const kind = request.kind;

      console.log(`${logPrefix}[call ${callNumber}] START round=${round} phase=${phase} player=${player} kind=${kind} attempt=${attempt}`);
      const startedAt = Date.now();

      try {
        const response = await cliAgent.decide(request);
        const elapsedMs = Date.now() - startedAt;
        const costUsd = response.usage?.costUsd;
        cumulativeSuccessfulCalls += 1;
        if (costUsd !== undefined) cumulativeCostUsd += costUsd;
        callRecords.push({ callNumber, round, phase, player, kind, attempt, elapsedMs, costUsd });
        console.log(
          `${logPrefix}[call ${callNumber}] DONE round=${round} phase=${phase} player=${player} kind=${kind} attempt=${attempt} ` +
            `elapsedMs=${elapsedMs} costUsd=${costUsd ?? "n/a"} cumulativeCostUsd=${cumulativeCostUsd.toFixed(6)} ` +
            `cumulativeSuccessfulCalls=${cumulativeSuccessfulCalls}`
        );
        return response;
      } catch (err) {
        const elapsedMs = Date.now() - startedAt;
        console.log(
          `${logPrefix}[call ${callNumber}] FAILED round=${round} phase=${phase} player=${player} kind=${kind} attempt=${attempt} ` +
            `elapsedMs=${elapsedMs} error=${err instanceof Error ? err.message : String(err)}`
        );
        throw err;
      }
    },
  };

  const gameStartedAt = Date.now();
  let output: SimulationOutput;
  try {
    output = await runSimulation(config, { seed, agent: instrumentedAgent, maxRounds });
  } catch (err) {
    const totalWallClockMs = Date.now() - gameStartedAt;
    const callDurationsMs = callRecords.map((r) => r.elapsedMs);
    const callCostsUsd = callRecords.filter((r) => r.costUsd !== undefined).map((r) => r.costUsd as number);
    const performance: PerformanceStats = {
      totalDecisions: callRecords.length,
      totalWallClockMs,
      callDurationMs: distributionStats(callDurationsMs),
      totalCostUsd: cumulativeCostUsd,
      callCostUsd: distributionStats(callCostsUsd),
      callLog: callRecords,
    };
    return {
      status: "failed",
      seed,
      model,
      error: err instanceof Error ? err.message : String(err),
      attemptedCalls: callCounter,
      performance,
    };
  }
  const totalWallClockMs = Date.now() - gameStartedAt;

  // ---- Information-boundary validation, against the REAL requests actually sent ----
  const boundaryViolations = checkInformationBoundary(config, output.groundTruth.roles, sentViews);

  // ---- Rule/infrastructure sanity: replay through the existing predictor pipeline ----
  let replayOk = false;
  let replaySteps = 0;
  let worldCount = 0;
  try {
    const worlds = generateWorlds(config);
    worldCount = worlds.length;
    const setting: GameSetting = { config, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
    const model2 = createBehavioralLikelihoodModel(defaultBehavioralModelParams);
    const steps = processEvidence(worlds, output.publicEvidence, model2, setting);
    replaySteps = steps.length;
    replayOk = steps.every((s) => Math.abs(s.posterior.reduce((sum, w) => sum + w.probability, 0) - 1) < 1e-6);
  } catch (err) {
    replayOk = false;
    console.error(`${logPrefix}Replay through processEvidence FAILED:`, err instanceof Error ? err.message : String(err));
  }

  const behavioralStats = computeBehavioralStats(config, output);

  const callDurationsMs = callRecords.map((r) => r.elapsedMs);
  const callCostsUsd = callRecords.filter((r) => r.costUsd !== undefined).map((r) => r.costUsd as number);
  const performance: PerformanceStats = {
    totalDecisions: callRecords.length,
    totalWallClockMs,
    callDurationMs: distributionStats(callDurationsMs),
    totalCostUsd: cumulativeCostUsd,
    callCostUsd: distributionStats(callCostsUsd),
    callLog: callRecords,
  };

  const report: GameReport = {
    game: {
      seed,
      model,
      playerCount: config.players.length,
      roleComposition: config.roles,
      roundsPlayed: output.roundsPlayed,
      terminatedByRoundCap: output.terminatedByRoundCap,
      publicEvidenceLength: output.publicEvidence.length,
      outcome: output.outcome,
      groundTruthRoles: output.groundTruth.roles,
    },
    usage: output.stats,
    cost: {
      // The authoritative figure: summed directly from claude -p's own reported
      // total_cost_usd per call (see claudeCliAgent.ts) - never recomputed from
      // token counts, since the CLI's own accounting already reflects cache
      // write/read multipliers this project doesn't otherwise have visibility into.
      measuredCostUsd: output.stats.totalCostUsd,
      // A secondary, clearly-labeled cross-check only: what a flat $1/$5 per-MTok
      // Haiku rate would imply from the raw token counts alone (ignores caching
      // entirely, so it is expected to diverge from measuredCostUsd).
      tokenRateCrossCheckUsd: {
        inputCost: ((output.stats.totalInputTokens ?? 0) / 1_000_000) * 1,
        outputCost: ((output.stats.totalOutputTokens ?? 0) / 1_000_000) * 5,
      },
    },
    behavioralStats,
    sanity: { boundaryViolations, replayOk, replaySteps, worldCount },
    performance,
  };

  return { status: "completed", seed, model, output, report };
}

export function writeGameFiles(outDir: string, seed: number, output: SimulationOutput, report: GameReport): void {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `synthetic-game-${seed}-output.json`), JSON.stringify(output, null, 2));
  fs.writeFileSync(path.join(outDir, `synthetic-game-${seed}-report.json`), JSON.stringify(report, null, 2));
}

export function writeFailedGameFile(
  outDir: string,
  result: Extract<GameRunResult, { status: "failed" }>
): void {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `synthetic-game-${result.seed}-failed.json`), JSON.stringify(result, null, 2));
}
