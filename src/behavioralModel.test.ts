import { test } from "node:test";
import assert from "node:assert/strict";
import { CandidateVote, GameConfig, World } from "./types";
import { generateWorlds } from "./generateWorlds";
import { GameSetting, processEvidence } from "./processEvidence";
import { Evidence, EvidenceContext } from "./evidence";
import { getProbability } from "./probability";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { initAliveState } from "./facts";
import {
  BehavioralModelParams,
  TeamAlignmentBehaviorParams,
  KeepOrEliminateBehaviorParams,
  defaultBehavioralModelParams,
  createBehavioralHandlers,
  createBehavioralLikelihoodModel,
} from "./behavioralModel";

/**
 * Behavioral Model v1: tests genuinely new properties only (role/team-
 * conditioned public behavior, symmetry, neutrality, and composition with
 * the existing inference pipeline). Deterministic mechanics, the Bayesian
 * core, and every already-covered evidence-handler property are NOT
 * re-tested here - see updateProbabilities.test.ts, syntheticScenarios.test.ts,
 * realisticScenarios.test.ts. Every non-default parameter below is local to
 * its own test, chosen to make the property measurable - never a claim
 * about real players, and never derived from the two held-out real games.
 */

function ctxFor(config: GameConfig): EvidenceContext {
  return {
    config,
    roles: defaultRoleRegistry,
    groups: defaultGroupRegistry,
    alive: initAliveState(config),
    history: [],
  };
}

const fivePlayerGame: GameConfig = {
  players: ["1", "2", "3", "4", "5"],
  roles: ["don", "mafia", "doctor", "commissioner", "citizen"],
};

function worldWithActor(role: string): World {
  return {
    probability: 1,
    roles: { "1": role, "2": "citizen", "3": "citizen", "4": "citizen", "5": "citizen" } as World["roles"],
  };
}

// ============================================================
// A. Role-conditioned claims
// ============================================================

test("A: a Commissioner self-claim is scored as truthful; a false claim's likelihood depends on the claimant's own team, not just true/false", () => {
  const ctx = ctxFor(fivePlayerGame);
  const params: BehavioralModelParams = {
    ...defaultBehavioralModelParams,
    selfRoleClaim: { truthful: 0.8, falseSameTeam: 0.3, falseDifferentTeam: 0.1 },
  };
  const handlers = createBehavioralHandlers(params);
  const observation = {
    type: "selfRoleClaim" as const,
    round: 1,
    actor: "1",
    claim: { kind: "role" as const, role: "commissioner" as const },
  };

  // Commissioner claiming Commissioner: truthful
  assert.equal(handlers.selfRoleClaim(observation, worldWithActor("commissioner"), ctx), 0.8);
  // Citizen claiming Commissioner: false, but SAME team as the claim (both Town)
  assert.equal(handlers.selfRoleClaim(observation, worldWithActor("citizen"), ctx), 0.3);
  // Doctor claiming Commissioner: also false-same-team (Doctor is Town too)
  assert.equal(handlers.selfRoleClaim(observation, worldWithActor("doctor"), ctx), 0.3);
  // Mafia claiming Commissioner: false, and a DIFFERENT likelihood from the
  // Citizen case above - this is the genuinely new capability
  assert.equal(handlers.selfRoleClaim(observation, worldWithActor("mafia"), ctx), 0.1);
  // Don claiming Commissioner: same bucket as plain Mafia (both Mafia-team)
  assert.equal(handlers.selfRoleClaim(observation, worldWithActor("don"), ctx), 0.1);

  // Commissioner claiming Commissioner is strictly more plausible than
  // either false case
  assert.ok(0.8 > 0.3 && 0.3 > 0.1);

  // the exact posterior odds ratio matches the configured likelihood ratio:
  // Commissioner-vs-Citizen moves odds by 0.8/0.3, Commissioner-vs-Mafia by
  // 0.8/0.1 - both directly the ratio of the two raw handler outputs above,
  // since a single SelfRoleClaim's likelihood factor is exactly what
  // multiplies the prior odds (see updateProbabilities.ts)
  const oddsRatioVsCitizen = 0.8 / 0.3;
  const oddsRatioVsMafia = 0.8 / 0.1;
  assert.ok(Math.abs(oddsRatioVsMafia - 8) < 1e-9);
  assert.ok(Math.abs(oddsRatioVsCitizen - 8 / 3) < 1e-9);
});

test("A: the same role-conditioning applies to RoleAssertion, keyed by the ACCUSER's own team", () => {
  const ctx = ctxFor(fivePlayerGame);
  const params: BehavioralModelParams = {
    ...defaultBehavioralModelParams,
    roleAssertion: { truthful: 0.7, falseSameTeam: 0.25, falseDifferentTeam: 0.05 },
  };
  const handlers = createBehavioralHandlers(params);
  // "1" (Mafia, so different team from Town's Commissioner) asserts "2 is Commissioner"
  const observation = {
    type: "roleAssertion" as const,
    round: 1,
    actor: "1",
    target: "2",
    claim: { kind: "role" as const, role: "commissioner" as const },
  };
  const worldTrue: World = { probability: 1, roles: { "1": "mafia", "2": "commissioner", "3": "citizen", "4": "citizen", "5": "citizen" } as World["roles"] };
  const worldFalseDifferentTeam: World = { probability: 1, roles: { "1": "mafia", "2": "citizen", "3": "citizen", "4": "citizen", "5": "citizen" } as World["roles"] };
  const worldFalseSameTeam: World = { probability: 1, roles: { "1": "citizen", "2": "citizen", "3": "citizen", "4": "citizen", "5": "citizen" } as World["roles"] };

  assert.equal(handlers.roleAssertion(observation, worldTrue, ctx), 0.7);
  assert.equal(handlers.roleAssertion(observation, worldFalseDifferentTeam, ctx), 0.05); // Mafia accuser, false claim
  assert.equal(handlers.roleAssertion(observation, worldFalseSameTeam, ctx), 0.25); // Town accuser, false claim
});

// ============================================================
// B. Role-conditioned investigation reports
// ============================================================

test("B: a checkIsMafia report's likelihood is distinctly configured for a truthful Commissioner report, a false-result Commissioner report, and a non-Commissioner bluff", () => {
  const ctx = ctxFor(fivePlayerGame);
  const params: BehavioralModelParams = {
    ...defaultBehavioralModelParams,
    investigationReport: { truthful: 0.8, falseResult: 0.15, bluff: 0.25 },
  };
  const handlers = createBehavioralHandlers(params);
  const observation = {
    type: "investigationReport" as const,
    round: 1,
    actor: "1",
    target: "2",
    mechanic: "checkIsMafia" as const,
    result: true,
  };
  const worldOf = (actorRole: string, targetRole: string): World => ({
    probability: 1,
    roles: { "1": actorRole, "2": targetRole, "3": "citizen", "4": "citizen", "5": "citizen" } as World["roles"],
  });

  const truthful = handlers.investigationReport(observation, worldOf("commissioner", "mafia"), ctx);
  const falseResult = handlers.investigationReport(observation, worldOf("commissioner", "citizen"), ctx);
  const citizenBluff = handlers.investigationReport(observation, worldOf("citizen", "mafia"), ctx);
  const mafiaBluff = handlers.investigationReport(observation, worldOf("mafia", "mafia"), ctx);

  assert.equal(truthful, 0.8);
  assert.equal(falseResult, 0.15);
  assert.equal(citizenBluff, 0.25);
  assert.equal(mafiaBluff, 0.25); // any non-Commissioner bluffs identically, regardless of which non-Commissioner role

  // all three configured buckets are genuinely distinct
  assert.notEqual(truthful, falseResult);
  assert.notEqual(truthful, citizenBluff);
  assert.notEqual(falseResult, citizenBluff);
});

// ============================================================
// C. Role-conditioned team behavior (the same observed vote scored
// differently depending on the ACTOR's own team)
// ============================================================

test("C: P(Mafia votes for Mafia) and P(Town votes for Mafia) are independently configurable and genuinely different for the identical raised hand", () => {
  const game: GameConfig = { players: ["1", "2", "3", "4"], roles: ["mafia", "mafia", "citizen", "citizen"] };
  const worlds = generateWorlds(game);
  const ctx = ctxFor(game);
  const vote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "initial",
    candidates: ["2"],
    handsRaised: { "2": ["1"] },
  };
  const params: BehavioralModelParams = {
    ...defaultBehavioralModelParams,
    candidateVote: {
      vote: { mafia: { ownTeam: 0.9, otherTeam: 0.1 }, town: { ownTeam: 0.2, otherTeam: 0.7 } },
      abstain: { mafia: 0.2, town: 0.2 },
    },
  };
  const handlers = createBehavioralHandlers(params);

  const worldMafiaVotesMafia = worlds.find((w) => w.roles["1"] === "mafia" && w.roles["2"] === "mafia")!;
  const worldTownVotesMafia = worlds.find((w) => w.roles["1"] === "citizen" && w.roles["2"] === "mafia")!;
  const worldMafiaVotesTown = worlds.find((w) => w.roles["1"] === "mafia" && w.roles["2"] === "citizen")!;
  const worldTownVotesTown = worlds.find((w) => w.roles["1"] === "citizen" && w.roles["2"] === "citizen")!;

  // abstain params are flat here (0.2 for both teams), so the 3 abstainers
  // contribute the identical 0.2^3 factor in all four worlds below - the
  // raised-hand factor alone accounts for every difference
  const abstainFactor = 0.2 ** 3;
  assert.ok(Math.abs(handlers.candidateVote(vote, worldMafiaVotesMafia, ctx) - 0.9 * abstainFactor) < 1e-12);
  assert.ok(Math.abs(handlers.candidateVote(vote, worldTownVotesMafia, ctx) - 0.7 * abstainFactor) < 1e-12);
  assert.ok(Math.abs(handlers.candidateVote(vote, worldMafiaVotesTown, ctx) - 0.1 * abstainFactor) < 1e-12);
  assert.ok(Math.abs(handlers.candidateVote(vote, worldTownVotesTown, ctx) - 0.2 * abstainFactor) < 1e-12);

  // the SAME observed hand (voter "1" for candidate "2", both Mafia) is
  // scored differently purely because of who actually holds Mafia
  const mafiaVotesMafia = handlers.candidateVote(vote, worldMafiaVotesMafia, ctx);
  const townVotesMafia = handlers.candidateVote(vote, worldTownVotesMafia, ctx);
  assert.notEqual(mafiaVotesMafia, townVotesMafia);
  assert.ok(mafiaVotesMafia > townVotesMafia);
});

// ============================================================
// D. History-sensitive behavior (the one small, concrete case)
// ============================================================

test("D: repeating an earlier public suspicion of the same target multiplies the likelihood by the configured repeatFactor; a different earlier target does not", () => {
  const game: GameConfig = { players: ["1", "2", "3"], roles: ["citizen", "citizen", "mafia"] };
  const worlds = generateWorlds(game);
  const world = worlds.find((w) => w.roles["1"] === "citizen" && w.roles["2"] === "citizen" && w.roles["3"] === "mafia")!;
  const params: BehavioralModelParams = {
    ...defaultBehavioralModelParams,
    suspect: { mafia: { ownTeam: 0.4, otherTeam: 0.6 }, town: { ownTeam: 0.3, otherTeam: 0.7 } },
    repeatFactor: 2,
  };
  const handlers = createBehavioralHandlers(params);
  const observation = { type: "suspect" as const, round: 2, actor: "1", target: "2" };

  const baseCtx = ctxFor(game);
  const withoutHistory: EvidenceContext = { ...baseCtx, history: [] };
  const priorSameTarget: Evidence = { type: "suspect", round: 1, actor: "1", target: "2" };
  const withMatchingHistory: EvidenceContext = { ...baseCtx, history: [priorSameTarget] };
  const priorDifferentTarget: Evidence = { type: "suspect", round: 1, actor: "1", target: "3" };
  const withDifferentTargetHistory: EvidenceContext = { ...baseCtx, history: [priorDifferentTarget] };

  const base = handlers.suspect(observation, world, withoutHistory);
  const repeated = handlers.suspect(observation, world, withMatchingHistory);
  const differentTarget = handlers.suspect(observation, world, withDifferentTargetHistory);

  assert.equal(base, 0.3); // "1" and "2" are both Town here: ownTeam for Town
  assert.equal(repeated, 0.6); // exactly base * repeatFactor
  assert.equal(differentTarget, base); // an earlier position on someone ELSE doesn't trigger the bonus
});

// ============================================================
// E. Symmetry
// ============================================================

test("E: two players with identical public history and identical role conditions remain exactly symmetric", () => {
  const standardGame: GameConfig = {
    players: ["1", "2", "3", "4", "5", "6", "7", "8"],
    roles: ["don", "mafia", "doctor", "commissioner", "citizen", "citizen", "citizen", "citizen"],
  };
  const worlds = generateWorlds(standardGame);
  const setting: GameSetting = { config: standardGame, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const params: BehavioralModelParams = {
    ...defaultBehavioralModelParams,
    selfRoleClaim: { truthful: 0.8, falseSameTeam: 0.3, falseDifferentTeam: 0.1 },
  };
  const model = createBehavioralLikelihoodModel(params);
  const log: Evidence[] = [
    { type: "selfRoleClaim", round: 1, actor: "1", claim: { kind: "role", role: "commissioner" } },
  ];
  const steps = processEvidence(worlds, log, model, setting);
  const posterior = steps[0].posterior;

  // "5" and "6" are both untouched Citizens - identical role condition,
  // identical (empty) public history about them specifically
  assert.ok(Math.abs(getProbability(posterior, "5", "citizen") - getProbability(posterior, "6", "citizen")) < 1e-9);
  // "3" and "4" are both untouched Don/Mafia-team-role holders
  assert.ok(Math.abs(getProbability(posterior, "3", "don") - getProbability(posterior, "4", "don")) < 1e-9);
});

// ============================================================
// F. Neutral model
// ============================================================

test("F: when every behavioral parameter is set equal, the behavioral layer contributes zero information beyond deterministic mechanics", () => {
  const worlds = generateWorlds(fivePlayerGame);
  const setting: GameSetting = { config: fivePlayerGame, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const flatMatrix: TeamAlignmentBehaviorParams = {
    mafia: { ownTeam: 0.5, otherTeam: 0.5 },
    town: { ownTeam: 0.5, otherTeam: 0.5 },
  };
  const flatKeepOrEliminate: KeepOrEliminateBehaviorParams = {
    mafia: { eliminateSharedTeam: 0.5, keepSharedTeam: 0.5, eliminateNoSharedTeam: 0.5, keepNoSharedTeam: 0.5 },
    town: { eliminateSharedTeam: 0.5, keepSharedTeam: 0.5, eliminateNoSharedTeam: 0.5, keepNoSharedTeam: 0.5 },
  };
  const allEqualParams: BehavioralModelParams = {
    selfRoleClaim: { truthful: 0.5, falseSameTeam: 0.5, falseDifferentTeam: 0.5 },
    roleAssertion: { truthful: 0.5, falseSameTeam: 0.5, falseDifferentTeam: 0.5 },
    investigationReport: { truthful: 0.5, falseResult: 0.5, bluff: 0.5 },
    suspect: flatMatrix,
    defend: flatMatrix,
    nominate: flatMatrix,
    repeatFactor: 1,
    candidateVote: { vote: flatMatrix, abstain: { mafia: 0.5, town: 0.5 } },
    keepOrEliminateVote: flatKeepOrEliminate,
  };
  const model = createBehavioralLikelihoodModel(allEqualParams);
  const log: Evidence[] = [
    { type: "selfRoleClaim", round: 1, actor: "1", claim: { kind: "role", role: "commissioner" } },
    { type: "roleAssertion", round: 1, actor: "2", target: "3", claim: { kind: "group", group: "mafia" } },
    { type: "suspect", round: 1, actor: "4", target: "5" },
    { type: "candidateVote", round: 1, stage: "initial", candidates: ["2", "3"], handsRaised: { "2": ["1"] } },
  ];
  const steps = processEvidence(worlds, log, model, setting);
  const finalPosterior = steps[steps.length - 1].posterior;

  finalPosterior.forEach((w, i) => {
    assert.ok(Math.abs(w.probability - worlds[i].probability) < 1e-9);
  });
});

// ============================================================
// G. Sequential integration with the existing inference pipeline
// ============================================================

test("G: a small behavioral-model sequence composes correctly through processEvidence - matches direct multiplication, no double counting", () => {
  const worlds = generateWorlds(fivePlayerGame);
  const setting: GameSetting = { config: fivePlayerGame, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const params: BehavioralModelParams = {
    ...defaultBehavioralModelParams,
    selfRoleClaim: { truthful: 0.8, falseSameTeam: 0.3, falseDifferentTeam: 0.1 },
    investigationReport: { truthful: 0.8, falseResult: 0.15, bluff: 0.25 },
  };
  const model = createBehavioralLikelihoodModel(params);
  const log: Evidence[] = [
    { type: "selfRoleClaim", round: 1, actor: "1", claim: { kind: "role", role: "commissioner" } },
    { type: "investigationReport", round: 1, actor: "1", target: "2", mechanic: "checkIsMafia", result: true },
  ];
  const steps = processEvidence(worlds, log, model, setting);

  const combined = worlds.map((w) => {
    let p = w.probability;
    log.forEach((ev, i) => {
      p *= model.likelihood(ev, w, steps[i].context);
    });
    return p;
  });
  const total = combined.reduce((s, x) => s + x, 0);
  const finalPosterior = steps[steps.length - 1].posterior;
  combined.forEach((raw, i) => {
    assert.ok(Math.abs(raw / total - finalPosterior[i].probability) < 1e-9);
  });

  const pCommissioner = getProbability(finalPosterior, "1", "commissioner");
  assert.ok(Math.abs(pCommissioner - 19 / 29) < 1e-6, `pCommissioner=${pCommissioner}`);
});

// ============================================================
// Default parameters: sanity, and the "no hardcoded team bias" guarantee
// ============================================================

test("defaults: the behavioral model runs end to end with the default parameters and stays a well-formed distribution", () => {
  const standardGame: GameConfig = {
    players: ["1", "2", "3", "4", "5", "6", "7", "8"],
    roles: ["don", "mafia", "doctor", "commissioner", "citizen", "citizen", "citizen", "citizen"],
  };
  const worlds = generateWorlds(standardGame);
  const setting: GameSetting = { config: standardGame, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const model = createBehavioralLikelihoodModel(defaultBehavioralModelParams);
  const log: Evidence[] = [
    { type: "selfRoleClaim", round: 1, actor: "1", claim: { kind: "role", role: "commissioner" } },
    { type: "suspect", round: 1, actor: "2", target: "3" },
    { type: "nightResult", round: 2, died: [] },
  ];
  const steps = processEvidence(worlds, log, model, setting);
  steps.forEach((s) => {
    const total = s.posterior.reduce((sum, w) => sum + w.probability, 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
    assert.ok(s.posterior.every((w) => Number.isFinite(w.probability) && w.probability >= 0));
  });
});

test("defaults: no team-directional bias is baked in - a false role-claim's likelihood does not depend on the claimant's team by default", () => {
  const ctx = ctxFor(fivePlayerGame);
  const handlers = createBehavioralHandlers(defaultBehavioralModelParams);
  const observation = {
    type: "selfRoleClaim" as const,
    round: 1,
    actor: "1",
    claim: { kind: "role" as const, role: "commissioner" as const },
  };
  // false-same-team (Citizen) vs false-different-team (Mafia) are equal by default
  assert.equal(
    handlers.selfRoleClaim(observation, worldWithActor("citizen"), ctx),
    handlers.selfRoleClaim(observation, worldWithActor("mafia"), ctx)
  );
});
