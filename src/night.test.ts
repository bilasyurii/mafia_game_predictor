import { test } from "node:test";
import assert from "node:assert/strict";
import { AliveState, World } from "./types";
import { defaultRoleRegistry } from "./roles";
import {
  HiddenNightActions,
  NightHistoryContext,
  resolveNight,
} from "./night";

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

const noHistory: NightHistoryContext = {};

function resolve(
  actions: Partial<HiddenNightActions>,
  alive: AliveState = aliveAll,
  history: NightHistoryContext = noHistory
) {
  const full: HiddenNightActions = { mafiaTargetChoices: {}, ...actions };
  return resolveNight(world, full, alive, history, defaultRoleRegistry);
}

test("unanimous mafia kill succeeds when don and mafia agree", () => {
  const result = resolve({
    mafiaTargetChoices: { "1": "5", "2": "5" },
  });
  assert.equal(result.mafiaKillSucceeded, true);
  assert.equal(result.mafiaKillTarget, "5");
  assert.deepEqual(result.died, ["5"]);
});

test("disagreement between mafia members: nobody dies", () => {
  const result = resolve({
    mafiaTargetChoices: { "1": "5", "2": "6" },
  });
  assert.equal(result.mafiaKillSucceeded, false);
  assert.deepEqual(result.died, []);
});

test("dead mafia member is excluded from the unanimity requirement", () => {
  const alive = { ...aliveAll, "2": false };
  // stray entry for the dead mafia member must be ignored, not required
  const result = resolve(
    { mafiaTargetChoices: { "1": "5", "2": "6" } },
    alive
  );
  assert.equal(result.mafiaKillSucceeded, true);
  assert.equal(result.mafiaKillTarget, "5");
});

test("dead Don: no don check happens even if a target is given", () => {
  const alive = { ...aliveAll, "1": false };
  const result = resolve(
    { mafiaTargetChoices: { "2": "5" }, donCheckTarget: "4" },
    alive
  );
  assert.equal(result.donCheckResult, undefined);
});

test("dead Commissioner: no check and no resulting death", () => {
  const alive = { ...aliveAll, "4": false };
  const result = resolve(
    { mafiaTargetChoices: { "1": "5", "2": "6" }, commissionerCheckTarget: "2" },
    alive
  );
  assert.equal(result.commissionerCheckResult, undefined);
  assert.equal(result.commissionerCausedDeath, undefined);
  assert.deepEqual(result.died, []);
});

test("dead Doctor: no save happens even if a target is given", () => {
  const alive = { ...aliveAll, "3": false };
  const result = resolve({
    mafiaTargetChoices: { "1": "5", "2": "5" },
    doctorSaveTarget: "5",
  }, alive);
  assert.equal(result.doctorSavedTarget, undefined);
  assert.deepEqual(result.died, ["5"]);
});

test("Don check: target has the checkIsMafia mechanic -> true", () => {
  const result = resolve({
    mafiaTargetChoices: { "1": "5", "2": "6" },
    donCheckTarget: "4",
  });
  assert.equal(result.donCheckResult, true);
});

test("Don check: target lacks the checkIsMafia mechanic -> false", () => {
  const result = resolve({
    mafiaTargetChoices: { "1": "5", "2": "6" },
    donCheckTarget: "5",
  });
  assert.equal(result.donCheckResult, false);
});

test("Commissioner kills a Mafia target when not saved", () => {
  const result = resolve({
    mafiaTargetChoices: { "1": "5", "2": "6" }, // disagreement, isolates this case
    commissionerCheckTarget: "2",
  });
  assert.equal(result.commissionerCheckResult, true);
  assert.equal(result.commissionerCausedDeath, "2");
  assert.deepEqual(result.died, ["2"]);
});

test("Commissioner does not kill a non-Mafia target", () => {
  const result = resolve({
    mafiaTargetChoices: { "1": "5", "2": "6" },
    commissionerCheckTarget: "5",
  });
  assert.equal(result.commissionerCheckResult, false);
  assert.equal(result.commissionerCausedDeath, undefined);
  assert.deepEqual(result.died, []);
});

test("Doctor protection cancels the mafia kill", () => {
  const result = resolve({
    mafiaTargetChoices: { "1": "5", "2": "5" },
    doctorSaveTarget: "5",
  });
  assert.equal(result.mafiaKillSucceeded, true);
  assert.equal(result.doctorSavedTarget, "5");
  assert.deepEqual(result.died, []);
});

test("mafia kill and commissioner kill on the same target: one death, not two", () => {
  const result = resolve({
    mafiaTargetChoices: { "1": "2", "2": "2" }, // mafia unanimously targets player "2"
    commissionerCheckTarget: "2",
  });
  assert.deepEqual(result.died, ["2"]);
});

test("mafia kill and commissioner kill on different targets: both die", () => {
  const result = resolve({
    mafiaTargetChoices: { "1": "5", "2": "5" },
    commissionerCheckTarget: "2",
  });
  assert.equal(result.died.length, 2);
  assert.ok(result.died.includes("5"));
  assert.ok(result.died.includes("2"));
});

test("doctor can cancel at most one of two resulting deaths", () => {
  const result = resolve({
    mafiaTargetChoices: { "1": "5", "2": "5" },
    commissionerCheckTarget: "2",
    doctorSaveTarget: "5", // only cancels the mafia-kill death
  });
  assert.deepEqual(result.died, ["2"]);
});

test("doctor cannot save the same player on consecutive nights", () => {
  const history: NightHistoryContext = { previousDoctorSaveTarget: "5" };
  assert.throws(() => {
    resolve(
      { mafiaTargetChoices: { "1": "6", "2": "6" }, doctorSaveTarget: "5" },
      aliveAll,
      history
    );
  });
});

test("no death when there is no consensus and no commissioner-caused death", () => {
  const result = resolve({
    mafiaTargetChoices: { "1": "5", "2": "6" },
  });
  assert.deepEqual(result.died, []);
});

test("exactly one death from a successful unanimous kill alone", () => {
  const result = resolve({
    mafiaTargetChoices: { "1": "6", "2": "6" },
  });
  assert.deepEqual(result.died, ["6"]);
});
