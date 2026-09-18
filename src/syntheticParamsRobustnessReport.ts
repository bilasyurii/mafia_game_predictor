import fs from "fs";
import { GameConfig } from "./types";
import { SimulationOutput } from "./simulation/types";
import { BehavioralModelParams } from "./behavioralModel";
import { syntheticBehavioralModelParams } from "./syntheticBehavioralModel";
import {
  PerGameCounts,
  SummedCounts,
  buildParamsFromCounts,
  computePerGameCounts,
  leaveOneOut,
  sumPerGameCounts,
} from "./syntheticParamsRobustness";
import { investigationReportLikelihoodRatios, mafiaVsTownLikelihoodRatio, roleClaimLikelihoodRatios } from "./behavioralLikelihoodDiagnostics";

/**
 * DIAGNOSTIC ONLY (leave-one-synthetic-game-out robustness investigation -
 * see this milestone's own report). For each of the 10 synthetic games,
 * removes that game entirely and recomputes syntheticBehavioralModelParams'
 * exact smoothing procedure (syntheticParamsRobustness.ts - imports
 * smoothedSplit/computeBehavioralStats UNCHANGED, never reimplements or
 * retunes them) from the remaining 9 games, producing 10 alternate parameter
 * sets. Compares their likelihood ratios against the real, currently-used
 * full-10-game syntheticBehavioralModelParams. Never touches either real
 * game, never touches syntheticBehavioralModelParams itself, never changes
 * the smoothing constant. Invoke directly:
 * `npx ts-node src/syntheticParamsRobustnessReport.ts`.
 */

const SYNTHETIC_DIR =
  "/private/tmp/claude-502/-Users-yurii-Documents-personal-mafia-game-predictor/29f99942-d7c7-41c9-8d93-8a8624b90714/scratchpad/synthetic-experiment-1000";
const SEEDS = [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009];

function loadPerGameCounts(seed: number): PerGameCounts {
  const raw = JSON.parse(fs.readFileSync(`${SYNTHETIC_DIR}/synthetic-game-${seed}-output.json`, "utf8"));
  const config: GameConfig = raw.config;
  const output: SimulationOutput = raw;
  return computePerGameCounts(seed, config, output);
}

const perGame = SEEDS.map(loadPerGameCounts);
const fullCounts = sumPerGameCounts(perGame);
const fullParams = buildParamsFromCounts(fullCounts);

// sanity: fullParams must exactly equal the real, currently-used syntheticBehavioralModelParams
const fullMatchesProduction =
  JSON.stringify(fullParams.suspect) === JSON.stringify(syntheticBehavioralModelParams.suspect) &&
  JSON.stringify(fullParams.defend) === JSON.stringify(syntheticBehavioralModelParams.defend) &&
  JSON.stringify(fullParams.nominate) === JSON.stringify(syntheticBehavioralModelParams.nominate) &&
  JSON.stringify(fullParams.candidateVote) === JSON.stringify(syntheticBehavioralModelParams.candidateVote) &&
  JSON.stringify(fullParams.selfRoleClaim) === JSON.stringify(syntheticBehavioralModelParams.selfRoleClaim) &&
  JSON.stringify(fullParams.investigationReport) === JSON.stringify(syntheticBehavioralModelParams.investigationReport);

const logoCounts: SummedCounts[] = SEEDS.map((_, i) => leaveOneOut(perGame, i));
const logoParams: BehavioralModelParams[] = logoCounts.map(buildParamsFromCounts);

// ============================================================
// Ratio extraction per params set
// ============================================================

interface RatioSet {
  suspectTown: number;
  suspectMafia: number;
  defendTown: number;
  defendMafia: number;
  nominateTown: number;
  nominateMafia: number;
  candidateVoteTown: number;
  candidateVoteMafia: number;
  selfRoleClaimTruthfulVsFalseSame: number;
  selfRoleClaimTruthfulVsFalseDiff: number;
  investigationTruthfulVsFalseResult: number;
  investigationTruthfulVsBluff: number;
}

function extractRatios(params: BehavioralModelParams): RatioSet {
  const rc = roleClaimLikelihoodRatios(params.selfRoleClaim);
  const ir = investigationReportLikelihoodRatios(params.investigationReport);
  return {
    suspectTown: mafiaVsTownLikelihoodRatio(params.suspect, "town").ratio,
    suspectMafia: mafiaVsTownLikelihoodRatio(params.suspect, "mafia").ratio,
    defendTown: mafiaVsTownLikelihoodRatio(params.defend, "town").ratio,
    defendMafia: mafiaVsTownLikelihoodRatio(params.defend, "mafia").ratio,
    nominateTown: mafiaVsTownLikelihoodRatio(params.nominate, "town").ratio,
    nominateMafia: mafiaVsTownLikelihoodRatio(params.nominate, "mafia").ratio,
    candidateVoteTown: mafiaVsTownLikelihoodRatio(params.candidateVote.vote, "town").ratio,
    candidateVoteMafia: mafiaVsTownLikelihoodRatio(params.candidateVote.vote, "mafia").ratio,
    selfRoleClaimTruthfulVsFalseSame: rc.truthfulVsFalseSameTeam,
    selfRoleClaimTruthfulVsFalseDiff: rc.truthfulVsFalseDifferentTeam,
    investigationTruthfulVsFalseResult: ir.truthfulVsFalseResult,
    investigationTruthfulVsBluff: ir.truthfulVsBluff,
  };
}

const fullRatios = extractRatios(fullParams);
const logoRatios: RatioSet[] = logoParams.map(extractRatios);

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return { min: sorted[0], median, max: sorted[sorted.length - 1] };
}

function ratioComparison(key: keyof RatioSet) {
  const values = logoRatios.map((r) => r[key]);
  const s = stats(values);
  const full = fullRatios[key];
  const absoluteRange = s.max - s.min;
  const relativeRange = full !== 0 ? absoluteRange / full : undefined;
  // influence: which held-out seed's LOGO ratio is farthest (in log-space) from the full estimate
  let mostInfluentialSeed = SEEDS[0];
  let largestLogShift = -Infinity;
  SEEDS.forEach((seed, i) => {
    const shift = Math.abs(Math.log(logoRatios[i][key]) - Math.log(full));
    if (shift > largestLogShift) {
      largestLogShift = shift;
      mostInfluentialSeed = seed;
    }
  });
  return { full, logoMin: s.min, logoMedian: s.median, logoMax: s.max, absoluteRange, relativeRange, mostInfluentialSeed, largestLogShift };
}

const RATIO_KEYS: (keyof RatioSet)[] = [
  "suspectTown",
  "suspectMafia",
  "defendTown",
  "defendMafia",
  "nominateTown",
  "nominateMafia",
  "candidateVoteTown",
  "candidateVoteMafia",
  "selfRoleClaimTruthfulVsFalseSame",
  "selfRoleClaimTruthfulVsFalseDiff",
  "investigationTruthfulVsFalseResult",
  "investigationTruthfulVsBluff",
];

const ratioComparisons = Object.fromEntries(RATIO_KEYS.map((k) => [k, ratioComparison(k)]));

// ============================================================
// Zero-cell sensitivity
// ============================================================

const zeroCellReport = {
  suspectMafiaToMafia: {
    fullAggregateCount: fullCounts.suspectCounts.mafiaToMafia,
    zeroInEveryGame: perGame.every((g) => g.suspectCounts.mafiaToMafia === 0),
    smoothedValue: fullParams.suspect.mafia!.ownTeam,
    pseudoCountShare: 5 / (fullCounts.suspectCounts.mafiaToMafia + fullCounts.suspectCounts.mafiaToTown + 10),
  },
  nominateMafiaToMafia: {
    fullAggregateCount: fullCounts.nominateCounts.mafiaToMafia,
    zeroInEveryGame: perGame.every((g) => g.nominateCounts.mafiaToMafia === 0),
    smoothedValue: fullParams.nominate.mafia!.ownTeam,
    pseudoCountShare: 5 / (fullCounts.nominateCounts.mafiaToMafia + fullCounts.nominateCounts.mafiaToTown + 10),
  },
  candidateVoteMafiaForMafiaCandidate: {
    fullAggregateCount: fullCounts.voteCounts.mafia.forMafiaCandidate,
    zeroInEveryGame: perGame.every((g) => g.voteCounts.mafia.forMafiaCandidate === 0),
    smoothedValue: fullParams.candidateVote.vote.mafia!.ownTeam,
    pseudoCountShare: 5 / (fullCounts.voteCounts.mafia.forMafiaCandidate + fullCounts.voteCounts.mafia.forTownCandidate + 10),
  },
  selfRoleClaimFalseSameTeam: {
    fullAggregateCount: fullCounts.roleClaims.falseSameTeam,
    zeroInEveryGame: perGame.every((g) => g.roleClaims.falseSameTeam === 0),
    smoothedValue: fullParams.selfRoleClaim.falseSameTeam,
    pseudoCountShare: (10 / 3) / (fullCounts.roleClaims.truthful + fullCounts.roleClaims.falseSameTeam + fullCounts.roleClaims.falseDifferentTeam + 10),
  },
};

// ============================================================
// Per-game raw counts table
// ============================================================

const perGameCountsTable = perGame.map((g) => ({
  seed: g.seed,
  suspect: g.suspectCounts,
  nominate: g.nominateCounts,
  defend: g.defendCounts,
  candidateVote: g.voteCounts,
}));

// ============================================================
// Assemble and save
// ============================================================

const report = {
  fullMatchesProduction,
  fullRatios,
  ratioComparisons,
  zeroCellReport,
  perGameCountsTable,
};

console.log(JSON.stringify(report, null, 2));
const outPath = "/tmp/claude-502/synthetic-params-robustness-report.json";
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\nSaved to ${outPath}`);
