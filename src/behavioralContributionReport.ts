import { generateWorlds } from "./generateWorlds";
import { GameSetting, processEvidence } from "./processEvidence";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { createBehavioralLikelihoodModel } from "./behavioralModel";
import { syntheticBehavioralModelParams } from "./syntheticBehavioralModel";
import { evaluateGame, StepEvaluation } from "./gameEvaluation";
import { buildUninformativeBehavioralParams, mafiaVsTownLikelihoodRatio } from "./behavioralLikelihoodDiagnostics";
import { game1Config, game1Evidence, game1GroundTruth, game1GroundTruthTeams } from "./game1";
import { game2Config, game2Evidence, game2GroundTruth, game2GroundTruthTeams } from "./game2";
import { GameConfig } from "./types";
import { Evidence } from "./evidence";
import { GroundTruthRoles, GroundTruthTeams } from "./replay";

/**
 * DIAGNOSTIC ONLY (investigation phase - see this milestone's report). Runs
 * each real recorded game TWICE: once with the full synthetic-derived
 * behavioral priors (syntheticBehavioralModelParams, unchanged), and once
 * with buildUninformativeBehavioralParams (zero behavioral information,
 * mechanical/deterministic evidence only - nightResult + dayElimination).
 * The difference isolates how much the behavioral layer alone moved each
 * known-Mafia player's probability, without changing any parameter. Also
 * ranks every suspect/nominate observation by its own likelihood ratio and
 * every step by its largest single posterior swing. Makes no Claude calls,
 * generates no games, changes no production parameters. Invoke directly:
 * `npx ts-node src/behavioralContributionReport.ts`.
 */

const BEHAVIORAL_TYPES = new Set([
  "selfRoleClaim",
  "roleAssertion",
  "investigationReport",
  "suspect",
  "defend",
  "nominate",
  "candidateVote",
  "keepOrEliminateVote",
]);

// game1's exact-role ground truth is only known for 4/10 players (see
// game1.ts) - TEAM membership (isMafia) is the only COMPLETE ground truth
// for every player in both games, so team lookups must use it, never
// defaultRoleRegistry-via-groundTruth.roles (which would throw/be wrong for
// a player whose exact role was never confirmed).
function teamOf(groundTruthTeams: GroundTruthTeams, player: string): "mafia" | "town" {
  return groundTruthTeams.isMafia[player] ? "mafia" : "town";
}

function report(
  label: string,
  config: GameConfig,
  evidence: Evidence[],
  groundTruth: GroundTruthRoles,
  groundTruthTeams: GroundTruthTeams
) {
  console.log(`\n${"=".repeat(70)}\n${label}\n${"=".repeat(70)}`);

  const worlds = generateWorlds(config);
  const setting: GameSetting = { config, roles: defaultRoleRegistry, groups: defaultGroupRegistry };

  const fullModel = createBehavioralLikelihoodModel(syntheticBehavioralModelParams);
  const mechanicalOnlyModel = createBehavioralLikelihoodModel(
    buildUninformativeBehavioralParams(syntheticBehavioralModelParams)
  );

  const fullSteps = processEvidence(worlds, evidence, fullModel, setting);
  const mechanicalSteps = processEvidence(worlds, evidence, mechanicalOnlyModel, setting);

  const fullEval = evaluateGame(fullSteps, groundTruth, groundTruthTeams);
  const mechanicalEval = evaluateGame(mechanicalSteps, groundTruth, groundTruthTeams);

  const knownMafia = Object.entries(groundTruthTeams.isMafia)
    .filter(([, isMafia]) => isMafia)
    .map(([p]) => p);

  // ---- D: full vs mechanical-only, at every step, for each known-Mafia player ----
  console.log("\n-- Per-step: full posterior vs mechanical-only posterior (known-Mafia players) --");
  fullEval.forEach((fullStep: StepEvaluation, i: number) => {
    const mechStep = mechanicalEval[i];
    const parts = knownMafia.map((p) => {
      const full = fullStep.mafiaProbability[p];
      const mech = mechStep.mafiaProbability[p];
      return `${p}: full=${full.toFixed(3)} mech=${mech.toFixed(3)} behavioralDelta=${(full - mech >= 0 ? "+" : "") + (full - mech).toFixed(3)}`;
    });
    console.log(`  [${i}] ${fullStep.description}`);
    console.log(`        ${parts.join(" | ")}`);
  });

  console.log("\n-- FINAL step: full vs mechanical-only --");
  const lastFull = fullEval[fullEval.length - 1];
  const lastMech = mechanicalEval[mechanicalEval.length - 1];
  knownMafia.forEach((p) => {
    console.log(
      `  ${p} (actual ${groundTruth.roles[p]}): full=${lastFull.mafiaProbability[p].toFixed(3)} mech-only=${lastMech.mafiaProbability[p].toFixed(3)}`
    );
  });

  // ---- E: strongest suspect/nominate likelihood ratios actually observed ----
  console.log("\n-- Strongest suspect/nominate likelihood ratios (actor-vs-flipped-team, target's ACTUAL team) --");
  const ratios: { desc: string; ratio: number }[] = [];
  evidence.forEach((e) => {
    if (e.type !== "suspect" && e.type !== "nominate") return;
    const targetTeam = teamOf(groundTruthTeams, e.target);
    const actorActualTeam = teamOf(groundTruthTeams, e.actor);
    const params = e.type === "suspect" ? syntheticBehavioralModelParams.suspect : syntheticBehavioralModelParams.nominate;
    const { likelihoodIfMafia, likelihoodIfTown, ratio } = mafiaVsTownLikelihoodRatio(params, targetTeam);
    ratios.push({
      desc: `${e.type}: ${e.actor}(actual ${actorActualTeam}) -> ${e.target}(actual ${targetTeam}) | L(actor=mafia)=${likelihoodIfMafia.toFixed(4)} L(actor=town)=${likelihoodIfTown.toFixed(4)}`,
      ratio,
    });
  });
  ratios
    .sort((a, b) => Math.max(b.ratio, 1 / b.ratio) - Math.max(a.ratio, 1 / a.ratio))
    .slice(0, 8)
    .forEach((r) => console.log(`  ratio=${r.ratio.toFixed(3)} (1/ratio=${(1 / r.ratio).toFixed(3)})  ${r.desc}`));

  // ---- largest single posterior shifts caused by BEHAVIORAL evidence specifically ----
  console.log("\n-- Largest single posterior shifts from BEHAVIORAL evidence (any player) --");
  const behavioralSwings = fullEval
    .filter((s) => BEHAVIORAL_TYPES.has(s.evidenceType))
    .map((s) => ({ step: s.index, description: s.description, top: s.largestChanges[0] }))
    .filter((x) => x.top !== undefined)
    .sort((a, b) => Math.abs(b.top!.delta) - Math.abs(a.top!.delta))
    .slice(0, 5);
  behavioralSwings.forEach((x) =>
    console.log(
      `  step ${x.step} (${x.description}): ${x.top!.player} ${x.top!.from.toFixed(3)} -> ${x.top!.to.toFixed(3)} (Δ=${x.top!.delta.toFixed(3)})`
    )
  );

  // ---- cumulative sequences: any actor with 2+ suspect/nominate acts, trace their own P(mafia) ----
  console.log("\n-- Cumulative sequences: actors with 2+ suspect/nominate acts (their OWN P(mafia) trajectory) --");
  const actByPlayer = new Map<string, number[]>();
  fullEval.forEach((s, i) => {
    if (s.evidenceType === "suspect" || s.evidenceType === "nominate") {
      const actor = (evidence[i] as any).actor as string;
      if (!actByPlayer.has(actor)) actByPlayer.set(actor, []);
      actByPlayer.get(actor)!.push(i);
    }
  });
  actByPlayer.forEach((stepIndices, actor) => {
    if (stepIndices.length < 2) return;
    const actorTeam = teamOf(groundTruthTeams, actor);
    const trajectory = stepIndices.map((i) => fullEval[i].mafiaProbability[actor].toFixed(3));
    console.log(`  ${actor} (actual ${groundTruth.roles[actor]}, ${actorTeam}): P(mafia) after each of their ${stepIndices.length} acts = [${trajectory.join(" -> ")}]`);
  });
}

report("GAME 1 (10 players)", game1Config, game1Evidence, game1GroundTruth, game1GroundTruthTeams);
report("GAME 2 (9 players)", game2Config, game2Evidence, game2GroundTruth, game2GroundTruthTeams);
