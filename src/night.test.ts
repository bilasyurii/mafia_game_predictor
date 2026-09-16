import { test } from "node:test";
import assert from "node:assert/strict";
import { AliveState, World } from "./types";
import { defaultRoleRegistry } from "./roles";
import {
  enumerateHiddenNightActions,
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

// --- enumerateHiddenNightActions ---

test("enumeration count for a fully-alive 6-player world with every mechanic present", () => {
  const hypotheses = enumerateHiddenNightActions(world, aliveAll, defaultRoleRegistry);
  // killers: don + mafia (2), each choosing among 6 living players;
  // don/commissioner/doctor each choosing among 6 living players too
  const expected = 6 ** 2 * 6 * 6 * 6;
  assert.equal(hypotheses.length, expected);
});

test("a dead Don, Commissioner, or Doctor removes that dimension entirely", () => {
  const withoutDon = enumerateHiddenNightActions(
    world,
    { ...aliveAll, "1": false },
    defaultRoleRegistry
  );
  // 5 living players now; killers: just mafia "2" (1); no don check dimension
  assert.equal(withoutDon.length, 5 ** 1 * 5 * 5); // mafia choice, commissioner, doctor
  assert.ok(withoutDon.every((h) => h.donCheckTarget === undefined));

  const withoutCommissioner = enumerateHiddenNightActions(
    world,
    { ...aliveAll, "4": false },
    defaultRoleRegistry
  );
  assert.ok(withoutCommissioner.every((h) => h.commissionerCheckTarget === undefined));

  const withoutDoctor = enumerateHiddenNightActions(
    world,
    { ...aliveAll, "3": false },
    defaultRoleRegistry
  );
  assert.ok(withoutDoctor.every((h) => h.doctorSaveTarget === undefined));
});

test("a dead mafia member cannot contribute a kill choice", () => {
  const alive = { ...aliveAll, "2": false };
  const hypotheses = enumerateHiddenNightActions(world, alive, defaultRoleRegistry);
  assert.ok(hypotheses.every((h) => h.mafiaTargetChoices["2"] === undefined));
  // 5 living players now; only don remains as a killer
  assert.equal(hypotheses.length, 5 ** 4); // don kill choice, don check, commissioner check, doctor save
});

test("self-targeting is included for every mechanic", () => {
  const hypotheses = enumerateHiddenNightActions(world, aliveAll, defaultRoleRegistry);
  assert.ok(hypotheses.some((h) => h.mafiaTargetChoices["1"] === "1"));
  assert.ok(hypotheses.some((h) => h.donCheckTarget === "1"));
  assert.ok(hypotheses.some((h) => h.commissionerCheckTarget === "4"));
  assert.ok(hypotheses.some((h) => h.doctorSaveTarget === "3"));
});

test("doctor repeat-target hypotheses are intentionally included, unlike resolveNight called with real history", () => {
  const hypotheses = enumerateHiddenNightActions(world, aliveAll, defaultRoleRegistry);
  // every living player appears as a doctorSaveTarget, including "5" - even
  // though a real previous night might have also targeted "5"
  const doctorTargets = new Set(hypotheses.map((h) => h.doctorSaveTarget));
  assert.deepEqual([...doctorTargets].sort(), Object.keys(world.roles).sort());

  // resolveNight itself WOULD throw if actually given that history - proving
  // the constraint is real and enumeration is knowingly not applying it here
  const repeatHypothesis = hypotheses.find((h) => h.doctorSaveTarget === "5")!;
  assert.throws(() =>
    resolveNight(
      world,
      repeatHypothesis,
      aliveAll,
      { previousDoctorSaveTarget: "5" },
      defaultRoleRegistry
    )
  );
});
