import { test } from "node:test";
import assert from "node:assert/strict";
import { AliveState, World } from "./types";
import { defaultRoleRegistry } from "./roles";
import { enumerateHiddenNightActions } from "./night";
import { createUniformActionModel } from "./uniformActionModel";

const world: World = {
  probability: 1,
  roles: {
    "1": "don",
    "2": "mafia",
    "3": "doctor",
    "4": "commissioner",
    "5": "citizen",
    "6": "citizen",
  },
};

const aliveAll: AliveState = {
  "1": true,
  "2": true,
  "3": true,
  "4": true,
  "5": true,
  "6": true,
};

test("every hypothesis for a world gets exactly equal probability", () => {
  const actionModel = createUniformActionModel(defaultRoleRegistry);
  const hypotheses = enumerateHiddenNightActions(world, aliveAll, defaultRoleRegistry);
  const expected = 1 / hypotheses.length;

  hypotheses.forEach((h) => {
    assert.ok(
      Math.abs(actionModel.probability(h, world, aliveAll, {}) - expected) < 1e-15
    );
  });
});

test("probabilities sum to 1 over the full hypothesis space", () => {
  const actionModel = createUniformActionModel(defaultRoleRegistry);
  const alive = { ...aliveAll, "1": false }; // smaller space, still meaningful
  const hypotheses = enumerateHiddenNightActions(world, alive, defaultRoleRegistry);

  const total = hypotheses.reduce(
    (sum, h) => sum + actionModel.probability(h, world, alive, {}),
    0
  );
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test("different (world, alive) pairs get their own independent hypothesis counts", () => {
  const actionModel = createUniformActionModel(defaultRoleRegistry);
  const fullSpace = enumerateHiddenNightActions(world, aliveAll, defaultRoleRegistry);
  const smallerAlive = { ...aliveAll, "1": false, "4": false };
  const smallerSpace = enumerateHiddenNightActions(world, smallerAlive, defaultRoleRegistry);

  const pFull = actionModel.probability(fullSpace[0], world, aliveAll, {});
  const pSmaller = actionModel.probability(smallerSpace[0], world, smallerAlive, {});

  assert.equal(pFull, 1 / fullSpace.length);
  assert.equal(pSmaller, 1 / smallerSpace.length);
  assert.notEqual(pFull, pSmaller);
});

// --- FactoredActionModel: block marginals ---

test("mafiaConsensusProbability: with 2 killers (don + mafia), each specific target is (1/livingCount)^2", () => {
  const actionModel = createUniformActionModel(defaultRoleRegistry);
  const expected = 1 / 6 ** 2;
  ["1", "2", "3", "4", "5", "6"].forEach((target) => {
    assert.ok(
      Math.abs(actionModel.mafiaConsensusProbability(target, world, aliveAll, {}) - expected) <
        1e-15
    );
  });
});

test("mafiaConsensusProbability: consensus mass plus leftover no-consensus mass sums to 1", () => {
  const actionModel = createUniformActionModel(defaultRoleRegistry);
  const living = ["1", "2", "3", "4", "5", "6"];
  const consensusMass = living.reduce(
    (sum, target) => sum + actionModel.mafiaConsensusProbability(target, world, aliveAll, {}),
    0
  );
  assert.ok(consensusMass < 1);
  assert.ok(Math.abs(consensusMass - 6 * (1 / 36)) < 1e-15);
});

test("mafiaConsensusProbability: with exactly 1 killer, consensus mass sums to exactly 1 (no-consensus is impossible)", () => {
  const actionModel = createUniformActionModel(defaultRoleRegistry);
  const alive = { ...aliveAll, "1": false }; // only mafia "2" remains a killer
  const living = ["2", "3", "4", "5", "6"];
  const consensusMass = living.reduce(
    (sum, target) => sum + actionModel.mafiaConsensusProbability(target, world, alive, {}),
    0
  );
  assert.ok(Math.abs(consensusMass - 1) < 1e-12);
});

test("donCheckTargetProbability, commissionerCheckTargetProbability, doctorSaveTargetProbability are each uniform over living players", () => {
  const actionModel = createUniformActionModel(defaultRoleRegistry);
  const living = ["1", "2", "3", "4", "5", "6"];
  const expected = 1 / 6;

  living.forEach((target) => {
    assert.ok(
      Math.abs(actionModel.donCheckTargetProbability(target, world, aliveAll, {}) - expected) <
        1e-15
    );
    assert.ok(
      Math.abs(
        actionModel.commissionerCheckTargetProbability(target, world, aliveAll, {}) - expected
      ) < 1e-15
    );
    assert.ok(
      Math.abs(
        actionModel.doctorSaveTargetProbability(target, world, aliveAll, {}) - expected
      ) < 1e-15
    );
  });

  const total = living.reduce(
    (sum, target) => sum + actionModel.doctorSaveTargetProbability(target, world, aliveAll, {}),
    0
  );
  assert.ok(Math.abs(total - 1) < 1e-9);
});

// --- history-aware Doctor consecutive-target exclusion ---

test("doctorSaveTargetProbability excludes the previous target and renormalizes over the rest", () => {
  const actionModel = createUniformActionModel(defaultRoleRegistry);
  const living = ["1", "2", "3", "4", "5", "6"];
  const history = { previousDoctorSaveTarget: "5" };

  assert.equal(actionModel.doctorSaveTargetProbability("5", world, aliveAll, history), 0);
  living
    .filter((p) => p !== "5")
    .forEach((target) => {
      assert.ok(
        Math.abs(
          actionModel.doctorSaveTargetProbability(target, world, aliveAll, history) - 1 / 5
        ) < 1e-15
      );
    });

  const total = living.reduce(
    (sum, target) => sum + actionModel.doctorSaveTargetProbability(target, world, aliveAll, history),
    0
  );
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test("probability() excludes the same hypothesis and renormalizes over the rest", () => {
  const actionModel = createUniformActionModel(defaultRoleRegistry);
  const hypotheses = enumerateHiddenNightActions(world, aliveAll, defaultRoleRegistry);
  const history = { previousDoctorSaveTarget: "5" };

  const excluded = hypotheses.filter((h) => h.doctorSaveTarget === "5");
  const remaining = hypotheses.filter((h) => h.doctorSaveTarget !== "5");
  assert.ok(excluded.length > 0 && remaining.length > 0);

  excluded.forEach((h) => {
    assert.equal(actionModel.probability(h, world, aliveAll, history), 0);
  });

  const total = remaining.reduce(
    (sum, h) => sum + actionModel.probability(h, world, aliveAll, history),
    0
  );
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test("excluding a target who is no longer alive is a no-op (never a legal choice anyway)", () => {
  const actionModel = createUniformActionModel(defaultRoleRegistry);
  const aliveWithoutSix = { ...aliveAll, "6": false };
  const history = { previousDoctorSaveTarget: "6" }; // "6" already dead tonight

  const withoutExclusion = actionModel.doctorSaveTargetProbability("1", world, aliveWithoutSix, {});
  const withExclusion = actionModel.doctorSaveTargetProbability("1", world, aliveWithoutSix, history);
  assert.equal(withExclusion, withoutExclusion);
});

test("excluding a target when the Doctor isn't even alive tonight is a no-op", () => {
  const actionModel = createUniformActionModel(defaultRoleRegistry);
  const aliveWithoutDoctor = { ...aliveAll, "3": false };
  const history = { previousDoctorSaveTarget: "5" };

  // no doctorSaveTarget dimension exists at all; probability() must be
  // unaffected by an exclusion that has nothing to apply to
  const hypotheses = enumerateHiddenNightActions(world, aliveWithoutDoctor, defaultRoleRegistry);
  const total = hypotheses.reduce(
    (sum, h) => sum + actionModel.probability(h, world, aliveWithoutDoctor, history),
    0
  );
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test("a sole-survivor Doctor forced to repeat has probability exactly 0 - no legal target remains", () => {
  const soleWorld: World = { probability: 1, roles: { "1": "doctor" } };
  const soleAlive: AliveState = { "1": true };
  const actionModel = createUniformActionModel(defaultRoleRegistry);
  const history = { previousDoctorSaveTarget: "1" };

  assert.equal(actionModel.doctorSaveTargetProbability("1", soleWorld, soleAlive, history), 0);
  assert.equal(
    actionModel.probability({ mafiaTargetChoices: {}, doctorSaveTarget: "1" }, soleWorld, soleAlive, history),
    0
  );
});
