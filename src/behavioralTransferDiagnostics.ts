import fs from "fs";
import { GameConfig, PlayerId } from "./types";
import { Evidence } from "./evidence";
import { generateWorlds } from "./generateWorlds";
import { GameSetting, processEvidence } from "./processEvidence";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { evaluateGame, summarizeGameEvaluation, StepEvaluation } from "./gameEvaluation";
import { syntheticBehavioralModelParams } from "./syntheticBehavioralModel";
import {
  ALL_BEHAVIORAL_EVIDENCE_TYPES,
  BehavioralEvidenceType,
  buildAblatedBehavioralModel,
  cumulativeCandidateVoteLogLikelihood,
  cumulativeTeamAlignmentLogLikelihood,
  empiricalTargetDirection,
  mafiaVsTownLikelihoodRatio,
  roleClaimLikelihoodRatios,
  suspectBreakdown,
} from "./behavioralLikelihoodDiagnostics";
import { GroundTruthRoles, GroundTruthTeams } from "./replay";
import { game1Config, game1Evidence, game1GroundTruth, game1GroundTruthTeams } from "./game1";
import { game2Config, game2Evidence, game2GroundTruth, game2GroundTruthTeams } from "./game2";

/**
 * DIAGNOSTIC ONLY (feature-level synthetic->human transfer investigation -
 * see this milestone's own report). Builds directly on the opinion-chain
 * diagnostic's conclusion (same-target double-counting does not explain most
 * of the real-game degradation) to ask, per behavioral evidence TYPE actually
 * observed in the two real games, how strongly and in which direction it
 * transfers. Reuses buildAblatedBehavioralModel/mafiaVsTownLikelihoodRatio/
 * roleClaimLikelihoodRatios (behavioralLikelihoodDiagnostics.ts) and the
 * already-computed behavioral-feature-ablation-report.json
 * (behavioralFeatureAblationReport.ts) rather than re-implementing ablation
 * or re-running the slow 18-scenario x 12-dataset sweep. Makes no Claude
 * calls, generates no games, changes no production parameter, does not tune
 * against the real games. Invoke directly:
 * `npx ts-node src/behavioralTransferDiagnostics.ts`.
 */

const ABLATION_REPORT_PATH = "/tmp/claude-502/behavioral-feature-ablation-report.json";
const SYNTHETIC_DIR =
  "/private/tmp/claude-502/-Users-yurii-Documents-personal-mafia-game-predictor/29f99942-d7c7-41c9-8d93-8a8624b90714/scratchpad/synthetic-experiment-1000";
const SYNTHETIC_SEEDS = [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009];
const REAL_OBSERVED_TYPES: BehavioralEvidenceType[] = ["selfRoleClaim", "suspect", "defend", "nominate", "candidateVote"];

interface Dataset {
  name: string;
  config: GameConfig;
  evidence: Evidence[];
  groundTruth: GroundTruthRoles;
  groundTruthTeams: GroundTruthTeams;
}

const game1: Dataset = { name: "game1", config: game1Config, evidence: game1Evidence, groundTruth: game1GroundTruth, groundTruthTeams: game1GroundTruthTeams };
const game2: Dataset = { name: "game2", config: game2Config, evidence: game2Evidence, groundTruth: game2GroundTruth, groundTruthTeams: game2GroundTruthTeams };

function loadSyntheticDataset(seed: number): Dataset {
  const raw = JSON.parse(fs.readFileSync(`${SYNTHETIC_DIR}/synthetic-game-${seed}-output.json`, "utf8"));
  const roles: Record<PlayerId, string> = raw.groundTruth.roles;
  const isMafia: Record<PlayerId, boolean> = {};
  Object.entries(roles).forEach(([p, role]) => {
    isMafia[p] = (defaultRoleRegistry as any)[role].team === "mafia";
  });
  return { name: `synthetic-${seed}`, config: raw.config, evidence: raw.publicEvidence, groundTruth: { roles: roles as any }, groundTruthTeams: { isMafia } };
}
const syntheticDatasets = SYNTHETIC_SEEDS.map(loadSyntheticDataset);

// ============================================================
// 1. Exact likelihood ratios for every real-observed type
// ============================================================

function likelihoodRatioReport() {
  const params = syntheticBehavioralModelParams;
  return {
    selfRoleClaim: roleClaimLikelihoodRatios(params.selfRoleClaim),
    suspect: {
      townTarget: mafiaVsTownLikelihoodRatio(params.suspect, "town"),
      mafiaTarget: mafiaVsTownLikelihoodRatio(params.suspect, "mafia"),
    },
    defend: {
      townTarget: mafiaVsTownLikelihoodRatio(params.defend, "town"),
      mafiaTarget: mafiaVsTownLikelihoodRatio(params.defend, "mafia"),
    },
    nominate: {
      townTarget: mafiaVsTownLikelihoodRatio(params.nominate, "town"),
      mafiaTarget: mafiaVsTownLikelihoodRatio(params.nominate, "mafia"),
    },
    candidateVoteRaisedHand: {
      townCandidate: mafiaVsTownLikelihoodRatio(params.candidateVote.vote, "town"),
      mafiaCandidate: mafiaVsTownLikelihoodRatio(params.candidateVote.vote, "mafia"),
    },
    candidateVoteAbstain: { mafia: params.candidateVote.abstain.mafia, town: params.candidateVote.abstain.town },
  };
}

// ============================================================
// 2. Per-feature summary table, pulled from the existing ablation report
// ============================================================

function loadAblationReport(): any {
  return JSON.parse(fs.readFileSync(ABLATION_REPORT_PATH, "utf8"));
}

function netEffectLabel(game1Delta: number, game2Delta: number): string {
  const g1Beneficial = game1Delta > 0;
  const g2Beneficial = game2Delta > 0;
  if (g1Beneficial && g2Beneficial) return "beneficial on both real games";
  if (!g1Beneficial && !g2Beneficial) return "harmful on both real games";
  return "mixed (differs between the two real games)";
}

function featureSummaryTable(ablationReport: any) {
  return REAL_OBSERVED_TYPES.map((type) => {
    const f = ablationReport.features[type];
    return {
      type,
      events: { synthetic: f.synthetic.events, game1: f.game1.events, game2: f.game2.events },
      avgBrierDeltaVsFull: { synthetic: f.synthetic.deltaVsFull.avgBrier, game1: f.game1.deltaVsFull.avgBrier, game2: f.game2.deltaVsFull.avgBrier },
      netEffectOnRealGames: netEffectLabel(f.game1.deltaVsFull.avgBrier, f.game2.deltaVsFull.avgBrier),
      maxPosteriorMovement: { synthetic: f.synthetic.posteriorChange.max, game1: f.game1.posteriorChange.max, game2: f.game2.posteriorChange.max },
    };
  });
}

// cumulative log-likelihood contribution: computed via
// cumulativeTeamAlignmentLogLikelihood/cumulativeCandidateVoteLogLikelihood
// (behavioralLikelihoodDiagnostics.ts) - well-defined for the team-alignment
// family (suspect/defend/nominate/candidateVote); not directly comparable
// for selfRoleClaim (branches on claim truth, not a single target team),
// reported separately and qualitatively instead.

// ============================================================
// 3. FULL vs FULL-feature (single-feature removal), from the existing report
// ============================================================

function fullVsFullMinusFeature(ablationReport: any) {
  return REAL_OBSERVED_TYPES.map((type) => {
    const f = ablationReport.features[type];
    return {
      type,
      game1: { full: pick(ablationReport.game1Full), fullMinusFeature: pick(f.game1.without) },
      game2: { full: pick(ablationReport.game2Full), fullMinusFeature: pick(f.game2.without) },
    };
  });
}
function pick(s: any) {
  return { avgBrier: s.avgBrier, finalBrier: s.finalBrier, avgLogLoss: s.avgLogLoss, finalLogLoss: s.finalLogLoss };
}
function sum(values: number[]): number {
  return values.reduce((s, v) => s + v, 0);
}

// ============================================================
// 4. Combinatorial suspect-family ablation (A-E)
// ============================================================

const ALL = new Set<BehavioralEvidenceType>(ALL_BEHAVIORAL_EVIDENCE_TYPES);
function without(...types: BehavioralEvidenceType[]): Set<BehavioralEvidenceType> {
  const s = new Set(ALL);
  types.forEach((t) => s.delete(t));
  return s;
}

const COMBINATORIAL_SCENARIOS: { label: string; enabled: Set<BehavioralEvidenceType> }[] = [
  { label: "A_FULL", enabled: without() },
  { label: "B_FULL_minus_suspect", enabled: without("suspect") },
  { label: "C_FULL_minus_suspect_nominate", enabled: without("suspect", "nominate") },
  { label: "D_FULL_minus_suspect_candidateVote", enabled: without("suspect", "candidateVote") },
  { label: "E_FULL_minus_suspect_nominate_candidateVote", enabled: without("suspect", "nominate", "candidateVote") },
];

function evaluateScenario(dataset: Dataset, enabled: Set<BehavioralEvidenceType>) {
  const model = buildAblatedBehavioralModel(syntheticBehavioralModelParams, enabled);
  const worlds = generateWorlds(dataset.config);
  const setting: GameSetting = { config: dataset.config, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const steps = processEvidence(worlds, dataset.evidence, model, setting);
  const perStep = evaluateGame(steps, dataset.groundTruth, dataset.groundTruthTeams);
  const summary = summarizeGameEvaluation(perStep, dataset.groundTruth, dataset.groundTruthTeams);
  return { avgBrier: summary.averageBrierScore, finalBrier: summary.finalBrierScore, avgLogLoss: summary.averageLogLoss, finalLogLoss: summary.finalLogLoss, perStep };
}

function combinatorialReport() {
  return COMBINATORIAL_SCENARIOS.map((s) => ({
    label: s.label,
    game1: pick(evaluateScenario(game1, s.enabled)),
    game2: pick(evaluateScenario(game2, s.enabled)),
  }));
}

// ============================================================
// 5. Suspect breakdown by target team / distinct vs repeated targets
// ============================================================

// player6 (game1): reconstruct P(mafia) trajectory under FULL / WITHOUT_SUSPECT / mechanical-only (NONE)
function player6Trajectory() {
  const scenarios: { label: string; enabled: Set<BehavioralEvidenceType> }[] = [
    { label: "FULL", enabled: without() },
    { label: "WITHOUT_SUSPECT", enabled: without("suspect") },
    { label: "MECHANICAL_ONLY", enabled: new Set() },
  ];
  return scenarios.map((s) => {
    const { perStep } = evaluateScenario(game1, s.enabled);
    return {
      label: s.label,
      trajectory: perStep.map((step: StepEvaluation) => ({ step: step.index, description: step.description, player6Mafia: step.mafiaProbability["6"] })),
      final: perStep[perStep.length - 1].mafiaProbability["6"],
    };
  });
}

// ============================================================
// 6. Calibration diagnostic: configured ratio vs empirical direction
// ============================================================

function calibrationTable() {
  const ratios = likelihoodRatioReport();
  return (["suspect", "defend", "nominate"] as const).map((type) => ({
    type,
    configuredRatio: { townTarget: (ratios as any)[type].townTarget.ratio, mafiaTarget: (ratios as any)[type].mafiaTarget.ratio },
    game1Empirical: empiricalTargetDirection(game1.evidence, game1.groundTruthTeams, type),
    game2Empirical: empiricalTargetDirection(game2.evidence, game2.groundTruthTeams, type),
  }));
}

// ============================================================
// Run everything
// ============================================================

function main() {
  const ablationReport = loadAblationReport();

  const report = {
    likelihoodRatios: likelihoodRatioReport(),
    featureSummaryTable: featureSummaryTable(ablationReport),
    cumulativeLogLikelihood: {
      synthetic: {
        suspect: sum(syntheticDatasets.map((d) => cumulativeTeamAlignmentLogLikelihood(d.evidence, d.groundTruthTeams, syntheticBehavioralModelParams.suspect, "suspect"))),
        defend: sum(syntheticDatasets.map((d) => cumulativeTeamAlignmentLogLikelihood(d.evidence, d.groundTruthTeams, syntheticBehavioralModelParams.defend, "defend"))),
        nominate: sum(syntheticDatasets.map((d) => cumulativeTeamAlignmentLogLikelihood(d.evidence, d.groundTruthTeams, syntheticBehavioralModelParams.nominate, "nominate"))),
        candidateVote: sum(syntheticDatasets.map((d) => cumulativeCandidateVoteLogLikelihood(d.evidence, d.groundTruthTeams, syntheticBehavioralModelParams.candidateVote))),
      },
      game1: {
        suspect: cumulativeTeamAlignmentLogLikelihood(game1.evidence, game1.groundTruthTeams, syntheticBehavioralModelParams.suspect, "suspect"),
        defend: cumulativeTeamAlignmentLogLikelihood(game1.evidence, game1.groundTruthTeams, syntheticBehavioralModelParams.defend, "defend"),
        nominate: cumulativeTeamAlignmentLogLikelihood(game1.evidence, game1.groundTruthTeams, syntheticBehavioralModelParams.nominate, "nominate"),
        candidateVote: cumulativeCandidateVoteLogLikelihood(game1.evidence, game1.groundTruthTeams, syntheticBehavioralModelParams.candidateVote),
      },
      game2: {
        suspect: cumulativeTeamAlignmentLogLikelihood(game2.evidence, game2.groundTruthTeams, syntheticBehavioralModelParams.suspect, "suspect"),
        defend: cumulativeTeamAlignmentLogLikelihood(game2.evidence, game2.groundTruthTeams, syntheticBehavioralModelParams.defend, "defend"),
        nominate: cumulativeTeamAlignmentLogLikelihood(game2.evidence, game2.groundTruthTeams, syntheticBehavioralModelParams.nominate, "nominate"),
        candidateVote: cumulativeCandidateVoteLogLikelihood(game2.evidence, game2.groundTruthTeams, syntheticBehavioralModelParams.candidateVote),
      },
    },
    fullVsFullMinusFeature: fullVsFullMinusFeature(ablationReport),
    combinatorial: combinatorialReport(),
    suspectBreakdown: { game1: suspectBreakdown(game1.evidence, game1.groundTruthTeams), game2: suspectBreakdown(game2.evidence, game2.groundTruthTeams) },
    player6Trajectory: player6Trajectory(),
    calibrationTable: calibrationTable(),
  };

  console.log(JSON.stringify(report, null, 2));
  const outPath = "/tmp/claude-502/behavioral-transfer-diagnostics-report.json";
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nSaved to ${outPath}`);
}

main();
