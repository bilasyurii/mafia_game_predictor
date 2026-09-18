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
import { mafiaVsTownLikelihoodRatio, cumulativeRatioForDistinctTargets } from "./behavioralLikelihoodDiagnostics";
import {
  buildCollapsedChainModel,
  computeClusterStats,
  extractTargetedActs,
  groupIntoChains,
  ClusterStats,
} from "./opinionChainDiagnostics";
import { GroundTruthRoles, GroundTruthTeams } from "./replay";
import { game1Config, game1Evidence, game1GroundTruth, game1GroundTruthTeams } from "./game1";
import { game2Config, game2Evidence, game2GroundTruth, game2GroundTruthTeams } from "./game2";

/**
 * DIAGNOSTIC ONLY. Investigates whether suspect/nominate/vote form
 * same-target "opinion chains" that the current sequential Bayesian update
 * double-counts as independent evidence - see opinionChainDiagnostics.ts
 * for the sequence-extraction/chain-classification/collapsed-model
 * machinery this builds on. Makes no Claude calls, generates no games,
 * changes no production parameter. Invoke directly:
 * `npx ts-node src/opinionChainReport.ts`.
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
  return { name: `synthetic-${seed}`, config: raw.config, evidence: raw.publicEvidence, groundTruth: { roles }, groundTruthTeams: { isMafia } };
}

const syntheticDatasets = SEEDS.map(loadSyntheticDataset);
const game1: Dataset = { name: "game1", config: game1Config, evidence: game1Evidence, groundTruth: game1GroundTruth, groundTruthTeams: game1GroundTruthTeams };
const game2: Dataset = { name: "game2", config: game2Config, evidence: game2Evidence, groundTruth: game2GroundTruth, groundTruthTeams: game2GroundTruthTeams };

function sumStats(all: ClusterStats[]): ClusterStats {
  const sum: ClusterStats = {
    numSuspect: 0, numNominate: 0, numVotes: 0, numDistinctActorTargetPairs: 0, numChains: 0,
    totalTargetedActs: 0, avgActionsPerTarget: 0, maxActionsPerTarget: 0,
    categoryCounts: { A_suspectOnly: 0, B_suspectNominate: 0, C_suspectVote: 0, D_suspectNominateVote: 0, E_nominateVote: 0, F_voteOnly: 0, other: 0 },
    repeatedTypeChains: 0, distinctTargetActors: 0,
  };
  all.forEach((s) => {
    sum.numSuspect += s.numSuspect;
    sum.numNominate += s.numNominate;
    sum.numVotes += s.numVotes;
    sum.numDistinctActorTargetPairs += s.numDistinctActorTargetPairs;
    sum.numChains += s.numChains;
    sum.totalTargetedActs += s.totalTargetedActs;
    sum.maxActionsPerTarget = Math.max(sum.maxActionsPerTarget, s.maxActionsPerTarget);
    sum.repeatedTypeChains += s.repeatedTypeChains;
    sum.distinctTargetActors += s.distinctTargetActors;
    (Object.keys(s.categoryCounts) as (keyof typeof s.categoryCounts)[]).forEach((k) => {
      sum.categoryCounts[k] += s.categoryCounts[k];
    });
  });
  sum.avgActionsPerTarget = sum.numChains === 0 ? 0 : sum.totalTargetedActs / sum.numChains;
  return sum;
}

// ============================================================
// 1 & 2 & 3. Sequence extraction + clustering + category counts
// ============================================================
console.log("=".repeat(70));
console.log("1-3. SEQUENCE EXTRACTION, CLUSTERING, CATEGORY COUNTS");
console.log("=".repeat(70));

const syntheticStatsPerGame = syntheticDatasets.map((d) => computeClusterStats(extractTargetedActs(d.evidence), groupIntoChains(extractTargetedActs(d.evidence))));
const syntheticStats = sumStats(syntheticStatsPerGame);
const game1Stats = computeClusterStats(extractTargetedActs(game1.evidence), groupIntoChains(extractTargetedActs(game1.evidence)));
const game2Stats = computeClusterStats(extractTargetedActs(game2.evidence), groupIntoChains(extractTargetedActs(game2.evidence)));

console.log("\nSynthetic (10 games, summed):", JSON.stringify(syntheticStats, null, 2));
console.log("\nGame1:", JSON.stringify(game1Stats, null, 2));
console.log("\nGame2:", JSON.stringify(game2Stats, null, 2));

// ============================================================
// 4. Cumulative likelihood ratios for same-target chains
// ============================================================
console.log("\n" + "=".repeat(70));
console.log("4. CUMULATIVE LIKELIHOOD RATIOS (syntheticBehavioralModelParams)");
console.log("=".repeat(70));

const suspectTown = mafiaVsTownLikelihoodRatio(syntheticBehavioralModelParams.suspect, "town").ratio;
const suspectMafia = mafiaVsTownLikelihoodRatio(syntheticBehavioralModelParams.suspect, "mafia").ratio;
const nominateTown = mafiaVsTownLikelihoodRatio(syntheticBehavioralModelParams.nominate, "town").ratio;
const nominateMafia = mafiaVsTownLikelihoodRatio(syntheticBehavioralModelParams.nominate, "mafia").ratio;
const voteTown = mafiaVsTownLikelihoodRatio(syntheticBehavioralModelParams.candidateVote.vote, "town").ratio;
const voteMafia = mafiaVsTownLikelihoodRatio(syntheticBehavioralModelParams.candidateVote.vote, "mafia").ratio;

console.log(`\nsuspect: townTarget=${suspectTown.toFixed(4)} mafiaTarget=${suspectMafia.toFixed(4)}`);
console.log(`nominate: townTarget=${nominateTown.toFixed(4)} mafiaTarget=${nominateMafia.toFixed(4)}`);
console.log(`vote: townTarget=${voteTown.toFixed(4)} mafiaTarget=${voteMafia.toFixed(4)}`);

console.log("\nSame-target chain cumulative ratios (target's team held fixed):");
console.log(`  suspect+nominate (town target): ${(suspectTown * nominateTown).toFixed(4)}`);
console.log(`  suspect+vote (town target): ${(suspectTown * voteTown).toFixed(4)}`);
console.log(`  suspect+nominate+vote (town target): ${(suspectTown * nominateTown * voteTown).toFixed(4)}`);
console.log(`  suspect+nominate (mafia target): ${(suspectMafia * nominateMafia).toFixed(4)}`);
console.log(`  suspect+vote (mafia target): ${(suspectMafia * voteMafia).toFixed(4)}`);
console.log(`  suspect+nominate+vote (mafia target): ${(suspectMafia * nominateMafia * voteMafia).toFixed(4)}`);

// ============================================================
// 5. Same-target vs different-target accumulation
// ============================================================
console.log("\n" + "=".repeat(70));
console.log("5. SAME-TARGET vs DIFFERENT-TARGET ACCUMULATION (3 acts, town-aligned target(s))");
console.log("=".repeat(70));
const sameTargetChain = suspectTown * nominateTown * voteTown; // SUSPECT(X)->NOMINATE(X)->VOTE(X)
const differentTargetChain = cumulativeRatioForDistinctTargets(suspectTown, 3); // SUSPECT(X)->SUSPECT(Y)->SUSPECT(Z)
console.log(`  SUSPECT(X)->NOMINATE(X)->VOTE(X) [same target, 3 different evidence TYPES]: ${sameTargetChain.toFixed(4)}`);
console.log(`  SUSPECT(X)->SUSPECT(Y)->SUSPECT(Z) [3 different targets, same evidence TYPE]: ${differentTargetChain.toFixed(4)}`);
console.log(`  SUSPECT(X)->SUSPECT(X)->SUSPECT(X) [same target, same TYPE 3x - no repeat-target damping exists]: ${(suspectTown ** 3).toFixed(4)}`);

// ============================================================
// 6 & 7. CURRENT vs COLLAPSED replay
// ============================================================
console.log("\n" + "=".repeat(70));
console.log("6-7. CURRENT vs COLLAPSED-SAME-TARGET-CHAIN REPLAY");
console.log("=".repeat(70));

function evaluateBoth(d: Dataset) {
  const worlds = generateWorlds(d.config);
  const setting: GameSetting = { config: d.config, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const currentModel = createBehavioralLikelihoodModel(syntheticBehavioralModelParams);
  const collapsedModel = buildCollapsedChainModel(syntheticBehavioralModelParams);

  const currentSteps = processEvidence(worlds, d.evidence, currentModel, setting);
  const collapsedSteps = processEvidence(worlds, d.evidence, collapsedModel, setting);

  const currentEval = evaluateGame(currentSteps, d.groundTruth, d.groundTruthTeams);
  const collapsedEval = evaluateGame(collapsedSteps, d.groundTruth, d.groundTruthTeams);
  const currentSummary = summarizeGameEvaluation(currentEval, d.groundTruth, d.groundTruthTeams);
  const collapsedSummary = summarizeGameEvaluation(collapsedEval, d.groundTruth, d.groundTruthTeams);

  // Posterior differences: over EVERY player at EVERY step (not just known-mafia, for a complete picture)
  const allDiffs: number[] = [];
  currentEval.forEach((s, i) => {
    Object.keys(s.mafiaProbability).forEach((p) => {
      allDiffs.push(Math.abs(s.mafiaProbability[p] - collapsedEval[i].mafiaProbability[p]));
    });
  });
  const finalDiffs: number[] = Object.keys(currentEval[currentEval.length - 1].mafiaProbability).map((p) =>
    Math.abs(currentEval[currentEval.length - 1].mafiaProbability[p] - collapsedEval[collapsedEval.length - 1].mafiaProbability[p])
  );

  return {
    current: { avgBrier: currentSummary.averageBrierScore, finalBrier: currentSummary.finalBrierScore, avgLogLoss: currentSummary.averageLogLoss, finalLogLoss: currentSummary.finalLogLoss },
    collapsed: { avgBrier: collapsedSummary.averageBrierScore, finalBrier: collapsedSummary.finalBrierScore, avgLogLoss: collapsedSummary.averageLogLoss, finalLogLoss: collapsedSummary.finalLogLoss },
    posteriorDiff: {
      meanAllSteps: allDiffs.length ? allDiffs.reduce((s, v) => s + v, 0) / allDiffs.length : 0,
      maxAllSteps: allDiffs.length ? Math.max(...allDiffs) : 0,
      meanFinalStep: finalDiffs.length ? finalDiffs.reduce((s, v) => s + v, 0) / finalDiffs.length : 0,
      maxFinalStep: finalDiffs.length ? Math.max(...finalDiffs) : 0,
    },
  };
}

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

const syntheticResults = syntheticDatasets.map(evaluateBoth);
const syntheticAgg = {
  current: {
    avgBrier: mean(syntheticResults.map((r) => r.current.avgBrier)),
    finalBrier: mean(syntheticResults.map((r) => r.current.finalBrier)),
    avgLogLoss: mean(syntheticResults.map((r) => r.current.avgLogLoss)),
    finalLogLoss: mean(syntheticResults.map((r) => r.current.finalLogLoss)),
  },
  collapsed: {
    avgBrier: mean(syntheticResults.map((r) => r.collapsed.avgBrier)),
    finalBrier: mean(syntheticResults.map((r) => r.collapsed.finalBrier)),
    avgLogLoss: mean(syntheticResults.map((r) => r.collapsed.avgLogLoss)),
    finalLogLoss: mean(syntheticResults.map((r) => r.collapsed.finalLogLoss)),
  },
  posteriorDiff: {
    meanAllSteps: mean(syntheticResults.map((r) => r.posteriorDiff.meanAllSteps)),
    maxAllSteps: Math.max(...syntheticResults.map((r) => r.posteriorDiff.maxAllSteps)),
    meanFinalStep: mean(syntheticResults.map((r) => r.posteriorDiff.meanFinalStep)),
    maxFinalStep: Math.max(...syntheticResults.map((r) => r.posteriorDiff.maxFinalStep)),
  },
};
const game1Result = evaluateBoth(game1);
const game2Result = evaluateBoth(game2);

console.log("\nSynthetic (mean across 10 games):", JSON.stringify(syntheticAgg, null, 2));
console.log("\nGame1:", JSON.stringify(game1Result, null, 2));
console.log("\nGame2:", JSON.stringify(game2Result, null, 2));

// ============================================================
// 8. Game 1 player 6 trace
// ============================================================
console.log("\n" + "=".repeat(70));
console.log("8. GAME 1 PLAYER 6 - FULL BEHAVIORAL EVIDENCE TRACE");
console.log("=".repeat(70));
const player6Events = game1Evidence
  .map((e, i) => ({ i, e }))
  .filter(({ e }) => (e as any).actor === "6" || (e.type === "candidateVote" && Object.values(e.handsRaised).some((v) => v?.includes("6"))));
player6Events.forEach(({ i, e }) => console.log(`  [${i}]`, JSON.stringify(e)));

const player6Chains = groupIntoChains(extractTargetedActs(game1Evidence)).filter((c) => c.actor === "6");
console.log("\nPlayer 6's target-specific chains:");
player6Chains.forEach((c) => console.log(`  target=${c.target} types=[${c.typeSequence.join(",")}] category=${c.category} repeated=${c.hasRepeatedType}`));

// ============================================================
// Save
// ============================================================
const fullReport = {
  clusterStats: { synthetic: syntheticStats, game1: game1Stats, game2: game2Stats },
  cumulativeRatios: {
    suspectTown, suspectMafia, nominateTown, nominateMafia, voteTown, voteMafia,
    sameTargetChainTownTarget: sameTargetChain,
    differentTargetChainTownTargets: differentTargetChain,
  },
  replayComparison: { synthetic: syntheticAgg, game1: game1Result, game2: game2Result },
  player6: { events: player6Events, chains: player6Chains },
};
const outPath = "/tmp/claude-502/opinion-chain-report.json";
fs.writeFileSync(outPath, JSON.stringify(fullReport, null, 2));
console.log(`\nSaved to ${outPath}`);
