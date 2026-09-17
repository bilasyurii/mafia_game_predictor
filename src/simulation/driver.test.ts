import { test } from "node:test";
import assert from "node:assert/strict";
import { AliveState, CandidateVote, GameConfig, PlayerId } from "../types";
import { resolveCandidateVote } from "../voting";
import { resolveNight } from "../night";
import { defaultRoleRegistry } from "../roles";
import { generateWorlds } from "../generateWorlds";
import { GameSetting, processEvidence } from "../processEvidence";
import { defaultGroupRegistry } from "../roleGroups";
import { createBehavioralLikelihoodModel, defaultBehavioralModelParams } from "../behavioralModel";
import { runSimulation } from "./driver";
import { firstNonTeammateTargetAgent, passiveAgent } from "./testAgents";
import { SimulationAgent, SimulationDecisionRequest } from "./types";
import { SimulationValidationError } from "./validation";

/**
 * Integration tests for the simulation harness, driven entirely by the
 * deterministic fake agents in testAgents.ts - no network/API call is ever
 * made here, per this milestone's explicit restriction. These tests exercise
 * the driver end to end (full synthetic games reaching a resolved outcome),
 * not statistical quality of any decision - see this milestone's own scope
 * notes for why.
 */

const sixPlayerConfig: GameConfig = {
  players: ["1", "2", "3", "4", "5", "6"],
  roles: ["don", "mafia", "commissioner", "doctor", "citizen", "citizen"],
};

test("a full synthetic game, driven by the deterministic test agent, reaches a resolved outcome (not a round-cap timeout)", async () => {
  const output = await runSimulation(sixPlayerConfig, {
    seed: 42,
    agent: firstNonTeammateTargetAgent,
    maxRounds: 12,
  });

  assert.notEqual(output.outcome, "ongoing");
  assert.equal(output.terminatedByRoundCap, false);
  assert.ok(output.publicEvidence.length > 0);
  assert.ok(output.stats.llmCalls > 0);
});

test("dead players are never asked to act: every recorded request's player was alive in that request's own view", async () => {
  const calls: SimulationDecisionRequest[] = [];
  const spyAgent: SimulationAgent = {
    async decide(request) {
      calls.push(request);
      return firstNonTeammateTargetAgent.decide(request);
    },
  };

  await runSimulation(sixPlayerConfig, { seed: 5, agent: spyAgent, maxRounds: 12 });

  assert.ok(calls.length > 0);
  calls.forEach((request) => {
    assert.ok(
      request.view.alive.includes(request.player),
      `request ${request.kind} was made for dead player ${request.player}`
    );
  });
});

test("candidateVote tallying and the resulting dayElimination are computed by voting.ts, not by any agent", async () => {
  const day0Nominations: Record<PlayerId, PlayerId | undefined> = { "1": "3", "2": "4" };
  const day0Votes: Record<PlayerId, PlayerId | null> = { "1": "3", "2": "3", "3": null, "4": "4", "5": "4", "6": null };

  const scriptedAgent: SimulationAgent = {
    async decide(request) {
      if (request.kind === "dayAction" && request.view.phase.round === 0) {
        const nominate = day0Nominations[request.player];
        return { decision: { type: "dayAction", ...(nominate ? { nominate } : {}) } };
      }
      if (request.kind === "vote" && request.view.phase.round === 0 && request.stage === "initial") {
        return { decision: { type: "vote", candidate: day0Votes[request.player] } };
      }
      return firstNonTeammateTargetAgent.decide(request);
    },
  };

  const output = await runSimulation(sixPlayerConfig, { seed: 1, agent: scriptedAgent, maxRounds: 12 });

  const day0Vote = output.publicEvidence.find(
    (e): e is CandidateVote => e.type === "candidateVote" && e.round === 0 && e.stage === "initial"
  );
  assert.ok(day0Vote);
  assert.deepEqual(day0Vote.candidates, ["3", "4"]);
  assert.deepEqual(day0Vote.handsRaised, { "3": ["1", "2"], "4": ["4", "5"] });

  const day0Elimination = output.publicEvidence.find((e) => e.type === "dayElimination" && e.round === 0);
  assert.ok(day0Elimination);
  assert.ok(day0Elimination.type === "dayElimination");

  const aliveAtDay0: AliveState = Object.fromEntries(sixPlayerConfig.players.map((p) => [p, true]));
  const outcome = resolveCandidateVote(day0Vote, aliveAtDay0);
  assert.deepEqual(outcome, { kind: "winner", candidate: "4" });
  if (day0Elimination.type === "dayElimination") {
    assert.deepEqual(day0Elimination.eliminated, ["4"]);
  }
});

test("night resolution (who actually dies) is computed by resolveNight, not reported by any agent", async () => {
  const output = await runSimulation(sixPlayerConfig, { seed: 9, agent: firstNonTeammateTargetAgent, maxRounds: 12 });

  assert.ok(output.groundTruth.nights.length > 0);
  const firstNight = output.groundTruth.nights[0];

  // independently recompute resolveNight from the SAME recorded ground-truth
  // inputs, and confirm it matches exactly what the driver recorded/published
  const world = { roles: output.groundTruth.roles, probability: 1 };
  const aliveBeforeNight1: AliveState = Object.fromEntries(sixPlayerConfig.players.map((p) => [p, true]));
  const recomputed = resolveNight(world, firstNight.actions, aliveBeforeNight1, {}, defaultRoleRegistry);
  assert.deepEqual(recomputed, firstNight.resolution);

  const publicNightFact = output.publicEvidence.find((e) => e.type === "nightResult" && e.round === 1);
  assert.ok(publicNightFact);
  if (publicNightFact?.type === "nightResult") {
    assert.deepEqual(publicNightFact.died, recomputed.died);
  }
});

test("an invalid decision triggers a bounded retry, and only the corrected decision ever enters the game state", async () => {
  const config: GameConfig = { players: ["1", "2", "3"], roles: ["mafia", "citizen", "citizen"] };
  let calls = 0;
  const agent: SimulationAgent = {
    async decide(request) {
      if (request.kind === "dayAction" && request.player === "1" && request.view.phase.round === 0) {
        calls += 1;
        if (calls === 1) {
          return { decision: { type: "dayAction", suspect: ["99"] } }; // "99" is not a player in this game
        }
        return { decision: { type: "dayAction" } };
      }
      return firstNonTeammateTargetAgent.decide(request);
    },
  };

  const output = await runSimulation(config, { seed: 1, agent, maxRounds: 4 });
  assert.equal(calls, 2);
  assert.ok(output.stats.retries >= 1);
  assert.ok(!output.publicEvidence.some((e) => e.type === "suspect" && e.target === "99"));
});

test("a decision that never becomes valid exhausts its retries and throws, rather than silently entering the game state", async () => {
  const config: GameConfig = { players: ["1", "2", "3"], roles: ["mafia", "citizen", "citizen"] };
  const agent: SimulationAgent = {
    async decide(request) {
      if (request.kind === "dayAction" && request.player === "1") {
        return { decision: { type: "dayAction", nominate: "99" } };
      }
      return firstNonTeammateTargetAgent.decide(request);
    },
  };

  await assert.rejects(
    () => runSimulation(config, { seed: 1, agent, maxRetriesPerDecision: 1 }),
    SimulationValidationError
  );
});

test("ground truth is returned as a field structurally separate from the public evidence trajectory, never embedded inside it", async () => {
  const config: GameConfig = { players: ["1", "2", "3"], roles: ["mafia", "citizen", "citizen"] };
  const output = await runSimulation(config, { seed: 3, agent: firstNonTeammateTargetAgent, maxRounds: 6 });

  assert.ok(output.groundTruth.roles);
  assert.ok(Array.isArray(output.groundTruth.nights));
  output.publicEvidence.forEach((e) => {
    assert.ok(!("roles" in e));
    assert.ok(!("mafiaTargetChoices" in e));
    assert.ok(!("donCheckTarget" in e));
    assert.ok(!("commissionerCheckTarget" in e));
    assert.ok(!("doctorSaveTarget" in e));
  });
});

test("same config+seed with a deterministic agent produces an identical role assignment and an identical public evidence trajectory", async () => {
  const a = await runSimulation(sixPlayerConfig, { seed: 7, agent: firstNonTeammateTargetAgent, maxRounds: 12 });
  const b = await runSimulation(sixPlayerConfig, { seed: 7, agent: firstNonTeammateTargetAgent, maxRounds: 12 });
  assert.deepEqual(a.groundTruth.roles, b.groundTruth.roles);
  assert.deepEqual(a.publicEvidence, b.publicEvidence);
  assert.equal(a.outcome, b.outcome);
});

test("the synthetic public evidence log replays cleanly through the existing processEvidence/inference pipeline, exactly like a real recorded game", async () => {
  const output = await runSimulation(sixPlayerConfig, { seed: 42, agent: firstNonTeammateTargetAgent, maxRounds: 12 });

  const worlds = generateWorlds(sixPlayerConfig);
  const setting: GameSetting = { config: sixPlayerConfig, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const model = createBehavioralLikelihoodModel(defaultBehavioralModelParams);
  const steps = processEvidence(worlds, output.publicEvidence, model, setting);

  assert.equal(steps.length, output.publicEvidence.length);
  steps.forEach((s) => {
    const total = s.posterior.reduce((sum, w) => sum + w.probability, 0);
    assert.ok(Math.abs(total - 1) < 1e-6);
    assert.ok(s.posterior.every((w) => Number.isFinite(w.probability) && w.probability >= 0));
  });
});

test("a passive agent that never nominates anyone produces a game with zero votes, resolved purely by night mechanics", async () => {
  const config: GameConfig = { players: ["1", "2", "3", "4"], roles: ["mafia", "citizen", "citizen", "citizen"] };
  const agent: SimulationAgent = {
    async decide(request) {
      if (request.kind === "dayAction" || request.kind === "vote" || request.kind === "keepOrEliminateVote") {
        return passiveAgent.decide(request);
      }
      return firstNonTeammateTargetAgent.decide(request);
    },
  };

  const output = await runSimulation(config, { seed: 2, agent, maxRounds: 6 });
  assert.equal(output.terminatedByRoundCap, false);
  assert.ok(!output.publicEvidence.some((e) => e.type === "candidateVote" || e.type === "dayElimination"));
  assert.equal(output.outcome, "mafiaWon"); // with nobody ever eliminated by vote, sole-Mafia attrition wins eventually
});
