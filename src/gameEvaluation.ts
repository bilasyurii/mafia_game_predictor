import { Evidence } from "./evidence";
import { EvidenceStep } from "./processEvidence";
import { GameConfig, PlayerId, RoleExpression, RoleId } from "./types";
import { GroupRegistry } from "./roleGroups";
import { getExpressionProbability, rankByProbability } from "./probability";
import { GroundTruthRoles, GroundTruthTeams } from "./replay";

/**
 * A small, reusable EVALUATION-ONLY layer on top of replay.ts: measures how
 * good the CURRENT model's forecasts were on a finished, held-out game,
 * against known ground truth. Nothing here changes any likelihood, any
 * parameter, or any inference path - every function takes an already-
 * computed EvidenceStep[] (from processEvidence) plus caller-supplied
 * ground truth, and only reads step.prior/step.posterior. Built to be
 * game-agnostic (nothing here references game1 specifically) precisely so
 * the exact same evaluation can run against a second recorded game and be
 * compared - see gameEvaluation.test.ts and this milestone's report for how
 * to run it against game1.
 */

const MAFIA_GROUP: RoleExpression = { kind: "group", group: "mafia" };

// ============================================================
// Small numeric primitives
// ============================================================

/** Avoids -Infinity for a forecast of exactly 0 or 1 against the opposite outcome. */
const LOG_LOSS_EPSILON = 1e-9;

function clampProbability(p: number): number {
  return Math.min(1 - LOG_LOSS_EPSILON, Math.max(LOG_LOSS_EPSILON, p));
}

/** Brier score for one binary forecast: (p - y)^2, y in {0,1}. Lower is better; 0 is perfect. */
export function brierScore(probability: number, actual: boolean): number {
  const y = actual ? 1 : 0;
  return (probability - y) ** 2;
}

/** Log loss for one binary forecast, with safe clamping at the 0/1 extremes. Lower is better. */
export function logLoss(probability: number, actual: boolean): number {
  const p = clampProbability(probability);
  return actual ? -Math.log(p) : -Math.log(1 - p);
}

function mean(values: number[]): number {
  return values.length === 0 ? NaN : values.reduce((s, v) => s + v, 0) / values.length;
}

// ============================================================
// Per-player, per-step probability traces (ALL players, not just the
// living - a dead player's Mafia-team probability keeps being refined by
// later evidence through the shared role pool, and both the "when did the
// model first suspect the real Mafia" and Brier/log-loss questions need
// that full trace, not just the "who's currently a live suspect" view
// replay.ts's ReplayStepView deliberately restricts to (see its own doc).
// ============================================================

function mafiaProbabilityForAllPlayers(
  config: GameConfig,
  groups: GroupRegistry,
  worlds: EvidenceStep["posterior"]
): Record<PlayerId, number> {
  const result: Record<PlayerId, number> = {};
  config.players.forEach((p) => {
    result[p] = getExpressionProbability(worlds, p, MAFIA_GROUP, groups);
  });
  return result;
}

/** Human-readable one-line description of an Evidence item, for reports. */
export function describeEvidence(evidence: Evidence): string {
  switch (evidence.type) {
    case "selfRoleClaim":
      return `${evidence.actor} claims ${describeExpression(evidence.claim)}`;
    case "roleAssertion":
      return `${evidence.actor} asserts ${evidence.target} is ${describeExpression(evidence.claim)}`;
    case "investigationReport":
      return `${evidence.actor} reports ${evidence.mechanic} on ${evidence.target} = ${evidence.result}`;
    case "suspect":
      return `${evidence.actor} suspects ${evidence.target}`;
    case "defend":
      return `${evidence.actor} defends ${evidence.target}`;
    case "nominate":
      return `${evidence.actor} nominates ${evidence.target}`;
    case "candidateVote":
      return `vote (${evidence.stage}): candidates=[${evidence.candidates.join(",")}]`;
    case "keepOrEliminateVote":
      return `keep/eliminate vote: candidates=[${evidence.candidates.join(",")}]`;
    case "nightResult":
      return `night ${evidence.round}: died=[${evidence.died.join(",")}]`;
    case "dayElimination":
      return `day ${evidence.round} elimination: [${evidence.eliminated.join(",")}]`;
  }
}

function describeExpression(expr: RoleExpression): string {
  return expr.kind === "role" ? expr.role : `<${expr.group}>`;
}

// ============================================================
// Per-step evaluation record
// ============================================================

export interface RankedMafiaEntry {
  player: PlayerId;
  /** 1-based rank among ALL players (dead or alive) by Mafia-team probability at this step. */
  rank: number;
  probability: number;
}

export interface ProbabilityChange {
  player: PlayerId;
  from: number;
  to: number;
  delta: number;
}

export interface StepEvaluation {
  index: number;
  evidenceType: Evidence["type"];
  description: string;
  /** Living players at the start of this evidence's own phase. */
  alive: PlayerId[];
  /** P(player is Mafia-team), for EVERY player - see this file's top doc for why. */
  mafiaProbability: Record<PlayerId, number>;
  /** Known true role (POST-GAME EVALUATION ONLY), for players it's known for. */
  actualRole: Partial<Record<PlayerId, RoleId>>;
  /** Known true Mafia-team membership (POST-GAME EVALUATION ONLY), complete when known. */
  actualMafiaTeam: Record<PlayerId, boolean>;
  /** Rank + probability, among ALL players, of every player known to actually be Mafia-team. */
  rankOfActualMafia: RankedMafiaEntry[];
  /** Top 3 CURRENTLY-LIVING players by Mafia-team probability - the practical "who to suspect now" view. */
  aliveTop3ByMafia: { player: PlayerId; probability: number }[];
  /** Every player's prior -> posterior Mafia-probability change THIS step, sorted by |delta| descending. */
  largestChanges: ProbabilityChange[];
  /** Mean Brier score across every player with known team ground truth, at this step. */
  stepBrierScore: number;
  /** Mean log loss across every player with known team ground truth, at this step. */
  stepLogLoss: number;
}

/**
 * Evaluates one EvidenceStep. `groundTruth`/`groundTruthTeams` are read-only
 * inputs used purely for REPORTING - see this file's top doc.
 */
export function evaluateStep(
  step: EvidenceStep,
  groundTruth: GroundTruthRoles,
  groundTruthTeams: GroundTruthTeams
): StepEvaluation {
  const config = step.context.config;
  const groups = step.context.groups;
  const alive = config.players.filter((p) => step.context.alive[p] === true);

  const priorMafia = mafiaProbabilityForAllPlayers(config, groups, step.prior);
  const posteriorMafia = mafiaProbabilityForAllPlayers(config, groups, step.posterior);

  const fullRanking = rankByProbability(step.posterior, config.players, MAFIA_GROUP, groups);
  const rankOf = new Map(fullRanking.map((r, i) => [r.player, i + 1]));

  const knownMafiaPlayers = Object.entries(groundTruthTeams.isMafia)
    .filter(([, isMafia]) => isMafia)
    .map(([p]) => p);

  const rankOfActualMafia: RankedMafiaEntry[] = knownMafiaPlayers.map((player) => ({
    player,
    rank: rankOf.get(player)!,
    probability: posteriorMafia[player],
  }));

  const aliveRanking = rankByProbability(step.posterior, alive, MAFIA_GROUP, groups);
  const aliveTop3ByMafia = aliveRanking.slice(0, 3);

  const largestChanges: ProbabilityChange[] = config.players
    .map((player) => ({
      player,
      from: priorMafia[player],
      to: posteriorMafia[player],
      delta: posteriorMafia[player] - priorMafia[player],
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const knownEntries = Object.entries(groundTruthTeams.isMafia);
  const stepBrierScore = mean(knownEntries.map(([p, isMafia]) => brierScore(posteriorMafia[p], isMafia)));
  const stepLogLoss = mean(knownEntries.map(([p, isMafia]) => logLoss(posteriorMafia[p], isMafia)));

  return {
    index: step.index,
    evidenceType: step.evidence.type,
    description: describeEvidence(step.evidence),
    alive,
    mafiaProbability: posteriorMafia,
    actualRole: groundTruth.roles,
    actualMafiaTeam: groundTruthTeams.isMafia,
    rankOfActualMafia,
    aliveTop3ByMafia,
    largestChanges,
    stepBrierScore,
    stepLogLoss,
  };
}

/** evaluateStep, applied to every step of a full processEvidence run. */
export function evaluateGame(
  steps: EvidenceStep[],
  groundTruth: GroundTruthRoles,
  groundTruthTeams: GroundTruthTeams
): StepEvaluation[] {
  return steps.map((step) => evaluateStep(step, groundTruth, groundTruthTeams));
}

// ============================================================
// Whole-game summary
// ============================================================

export interface ThresholdCrossings {
  /** First step index at which P(mafia) for this player exceeded 0.25/0.5/0.75, or undefined if it never did. */
  above25: number | undefined;
  above50: number | undefined;
  above75: number | undefined;
}

export interface GameEvaluationSummary {
  perStep: StepEvaluation[];
  /** Mean Brier/log-loss across every (known-ground-truth player, step) pair in the whole game. */
  averageBrierScore: number;
  averageLogLoss: number;
  /** Mean Brier/log-loss across known-ground-truth players at the LAST step only. */
  finalBrierScore: number;
  finalLogLoss: number;
  /** Step index at which each known-Mafia player first appeared in the alive-only top 3, or undefined. */
  firstEnteredTop3: Record<PlayerId, number | undefined>;
  /** Step index of each known-Mafia player's first crossing of 25/50/75%. */
  thresholdCrossings: Record<PlayerId, ThresholdCrossings>;
  /** The known-innocent player (if any) whose Mafia probability peaked highest, and when. */
  mostOverconfidentInnocent: { player: PlayerId; step: number; probability: number } | undefined;
  /** The single largest |delta| for any player's Mafia probability, across the whole game. */
  largestSingleChange: (ProbabilityChange & { step: number; description: string }) | undefined;
  /** Every player's FINAL Mafia probability, ranked - includes dead players (see this file's top doc). */
  finalRanking: { player: PlayerId; probability: number; actualRole?: RoleId; isMafia?: boolean }[];
}

function firstStepAbove(perStep: StepEvaluation[], player: PlayerId, threshold: number): number | undefined {
  const found = perStep.find((s) => s.mafiaProbability[player] > threshold);
  return found?.index;
}

/**
 * Aggregates evaluateGame's per-step output into the whole-game questions
 * this milestone asks (forecast quality over time, when the model caught
 * up to the real Mafia, overconfidence, largest single swings, final
 * ranking). Takes `perStep` rather than re-deriving it so a caller can
 * inspect/reuse the per-step records too (see gameEvaluation.test.ts).
 */
export function summarizeGameEvaluation(
  perStep: StepEvaluation[],
  groundTruth: GroundTruthRoles,
  groundTruthTeams: GroundTruthTeams
): GameEvaluationSummary {
  const allPairs: { probability: number; isMafia: boolean }[] = [];
  perStep.forEach((s) => {
    Object.entries(groundTruthTeams.isMafia).forEach(([p, isMafia]) => {
      allPairs.push({ probability: s.mafiaProbability[p], isMafia });
    });
  });
  const averageBrierScore = mean(allPairs.map((e) => brierScore(e.probability, e.isMafia)));
  const averageLogLoss = mean(allPairs.map((e) => logLoss(e.probability, e.isMafia)));

  const lastStep = perStep[perStep.length - 1];
  const finalEntries = Object.entries(groundTruthTeams.isMafia);
  const finalBrierScore = mean(finalEntries.map(([p, isMafia]) => brierScore(lastStep.mafiaProbability[p], isMafia)));
  const finalLogLoss = mean(finalEntries.map(([p, isMafia]) => logLoss(lastStep.mafiaProbability[p], isMafia)));

  const knownMafiaPlayers = Object.entries(groundTruthTeams.isMafia)
    .filter(([, isMafia]) => isMafia)
    .map(([p]) => p);
  const knownInnocentPlayers = Object.entries(groundTruthTeams.isMafia)
    .filter(([, isMafia]) => !isMafia)
    .map(([p]) => p);

  const firstEnteredTop3: Record<PlayerId, number | undefined> = {};
  const thresholdCrossings: Record<PlayerId, ThresholdCrossings> = {};
  knownMafiaPlayers.forEach((player) => {
    const found = perStep.find((s) => s.aliveTop3ByMafia.some((e) => e.player === player));
    firstEnteredTop3[player] = found?.index;
    thresholdCrossings[player] = {
      above25: firstStepAbove(perStep, player, 0.25),
      above50: firstStepAbove(perStep, player, 0.5),
      above75: firstStepAbove(perStep, player, 0.75),
    };
  });

  let mostOverconfidentInnocent: GameEvaluationSummary["mostOverconfidentInnocent"];
  knownInnocentPlayers.forEach((player) => {
    perStep.forEach((s) => {
      const probability = s.mafiaProbability[player];
      if (!mostOverconfidentInnocent || probability > mostOverconfidentInnocent.probability) {
        mostOverconfidentInnocent = { player, step: s.index, probability };
      }
    });
  });

  let largestSingleChange: GameEvaluationSummary["largestSingleChange"];
  perStep.forEach((s) => {
    const top = s.largestChanges[0];
    if (top && (!largestSingleChange || Math.abs(top.delta) > Math.abs(largestSingleChange.delta))) {
      largestSingleChange = { ...top, step: s.index, description: s.description };
    }
  });

  const finalRanking = Object.entries(lastStep.mafiaProbability)
    .map(([player, probability]) => ({
      player,
      probability,
      actualRole: groundTruth.roles[player],
      isMafia: groundTruthTeams.isMafia[player],
    }))
    .sort((a, b) => b.probability - a.probability);

  return {
    perStep,
    averageBrierScore,
    averageLogLoss,
    finalBrierScore,
    finalLogLoss,
    firstEnteredTop3,
    thresholdCrossings,
    mostOverconfidentInnocent,
    largestSingleChange,
    finalRanking,
  };
}

/** Human-readable rendering of a GameEvaluationSummary - for terminal inspection only. */
export function formatGameEvaluationSummary(summary: GameEvaluationSummary): string {
  const lines: string[] = [];
  lines.push(`Steps: ${summary.perStep.length}`);
  lines.push(
    `Brier score: avg=${summary.averageBrierScore.toFixed(4)}, final=${summary.finalBrierScore.toFixed(4)}`
  );
  lines.push(`Log loss:    avg=${summary.averageLogLoss.toFixed(4)}, final=${summary.finalLogLoss.toFixed(4)}`);
  lines.push("");
  lines.push("Known-Mafia players:");
  Object.entries(summary.firstEnteredTop3).forEach(([player, step]) => {
    const t = summary.thresholdCrossings[player];
    lines.push(
      `  ${player}: first in alive top-3 at step ${step ?? "never"}; >25% at ${t.above25 ?? "never"}, >50% at ${
        t.above50 ?? "never"
      }, >75% at ${t.above75 ?? "never"}`
    );
  });
  lines.push("");
  if (summary.mostOverconfidentInnocent) {
    const o = summary.mostOverconfidentInnocent;
    lines.push(`Most overconfident about an innocent: ${o.player} reached P(mafia)=${o.probability.toFixed(3)} at step ${o.step}`);
  }
  if (summary.largestSingleChange) {
    const c = summary.largestSingleChange;
    lines.push(
      `Largest single swing: ${c.player} ${c.from.toFixed(3)} -> ${c.to.toFixed(3)} (Δ=${c.delta.toFixed(3)}) at step ${c.step} (${c.description})`
    );
  }
  lines.push("");
  lines.push("Final ranking:");
  summary.finalRanking.forEach(({ player, probability, actualRole, isMafia }) => {
    lines.push(`  ${player}: P(mafia)=${probability.toFixed(3)}${actualRole ? ` (actual: ${actualRole})` : ""}${isMafia !== undefined ? ` [${isMafia ? "MAFIA" : "town"}]` : ""}`);
  });
  return lines.join("\n");
}
