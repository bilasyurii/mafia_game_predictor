import { test } from "node:test";
import assert from "node:assert/strict";
import { GameConfig, SelfRoleClaim, World } from "./types";
import { generateWorlds } from "./generateWorlds";
import { initAliveState } from "./facts";
import { createLikelihoodModel, EvidenceContext } from "./evidence";
import { createHandlers } from "./likelihoodHandlers";
import { createNightResultHandler } from "./nightResultLikelihood";
import { createUniformActionModel } from "./uniformActionModel";
import { ActionModel } from "./actionModel";
import { NightResultFact } from "./night";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { GameSetting, processEvidence } from "./processEvidence";

function makeCtx(
  config: GameConfig,
  overrides: Partial<EvidenceContext> = {}
): EvidenceContext {
  return {
    config,
    roles: defaultRoleRegistry,
    groups: defaultGroupRegistry,
    alive: initAliveState(config),
    history: [],
    ...overrides,
  };
}

function nightResult(round: number, died: string[]): NightResultFact {
  return { type: "nightResult", round, died };
}

// --- impossible outcome -> exactly 0 ---

test("a lone mafia member always succeeds, so 'no death' is exactly impossible", () => {
  const config: GameConfig = { players: ["1", "2"], roles: ["mafia", "citizen"] };
  const world: World = { probability: 1, roles: { "1": "mafia", "2": "citizen" } };
  const handler = createNightResultHandler(createUniformActionModel(defaultRoleRegistry));
  const ctx = makeCtx(config);

  const result = handler(nightResult(1, []), world, ctx);
  assert.equal(result, 0);
});

// --- hand-computable exact probabilities ---

const threePlayerConfig: GameConfig = {
  players: ["1", "2", "3"],
  roles: ["mafia", "mafia", "citizen"],
};
const threePlayerWorld: World = {
  probability: 1,
  roles: { "1": "mafia", "2": "mafia", "3": "citizen" },
};

test("intermediate probability: exactly 1/9 for each specific unanimous kill target", () => {
  const handler = createNightResultHandler(createUniformActionModel(defaultRoleRegistry));
  const ctx = makeCtx(threePlayerConfig);

  ["1", "2", "3"].forEach((target) => {
    const result = handler(nightResult(1, [target]), threePlayerWorld, ctx);
    assert.ok(Math.abs(result - 1 / 9) < 1e-12, `target ${target}: got ${result}`);
  });
});

test("no-death probability with a live kill mechanic: exactly 6/9 (2/3)", () => {
  const handler = createNightResultHandler(createUniformActionModel(defaultRoleRegistry));
  const ctx = makeCtx(threePlayerConfig);

  const result = handler(nightResult(1, []), threePlayerWorld, ctx);
  assert.ok(Math.abs(result - 2 / 3) < 1e-12, `got ${result}`);
});

test("all outcomes for the 3-player world sum to 1", () => {
  const handler = createNightResultHandler(createUniformActionModel(defaultRoleRegistry));
  const ctx = makeCtx(threePlayerConfig);

  const total =
    handler(nightResult(1, []), threePlayerWorld, ctx) +
    handler(nightResult(1, ["1"]), threePlayerWorld, ctx) +
    handler(nightResult(1, ["2"]), threePlayerWorld, ctx) +
    handler(nightResult(1, ["3"]), threePlayerWorld, ctx);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

// --- the handler genuinely delegates to whatever ActionModel it's given ---

test("the handler sums exactly the weights a custom ActionModel returns, not a hardcoded uniform value", () => {
  // unnormalized on purpose - the handler's job is only to sum matching
  // hypotheses' weights, not to normalize the model's output
  const testModel: ActionModel = {
    probability: (actions) => (actions.mafiaTargetChoices["1"] === "2" ? 1 : 0),
  };
  const handler = createNightResultHandler(testModel);
  const ctx = makeCtx(threePlayerConfig);

  // only one of the 9 hypotheses has action1="2" AND action2="2" (unanimous on "2")
  assert.equal(handler(nightResult(1, ["2"]), threePlayerWorld, ctx), 1);
  // two of the 9 have action1="2" but action2 disagrees (weight 1 each, died=[])
  assert.equal(handler(nightResult(1, []), threePlayerWorld, ctx), 2);
  // no hypothesis with action1="2" ever produces died=["1"] or died=["3"]
  assert.equal(handler(nightResult(1, ["1"]), threePlayerWorld, ctx), 0);
  assert.equal(handler(nightResult(1, ["3"]), threePlayerWorld, ctx), 0);
});

// --- order-independent death-set comparison ---

const fivePlayerConfig: GameConfig = {
  players: ["1", "2", "3", "4", "5"],
  roles: ["don", "mafia", "doctor", "commissioner", "citizen"],
};
const fivePlayerWorld: World = {
  probability: 1,
  roles: { "1": "don", "2": "mafia", "3": "doctor", "4": "commissioner", "5": "citizen" },
};

test("death-set comparison is order-independent", () => {
  const handler = createNightResultHandler(createUniformActionModel(defaultRoleRegistry));
  const ctx = makeCtx(fivePlayerConfig);

  // a world where both a mafia kill (on "5") and a commissioner-caused
  // death (checking "2", a mafia target) are possible in the same night,
  // giving a two-player died set
  const natural = handler(nightResult(1, ["5", "2"]), fivePlayerWorld, ctx);
  const reversed = handler(nightResult(1, ["2", "5"]), fivePlayerWorld, ctx);
  assert.equal(natural, reversed);
  assert.ok(natural > 0);
});

// --- doctor repeat-target inclusion, at the handler level ---

test("the handler never throws over a doctor repeat, because it never carries real cross-night history", () => {
  const handler = createNightResultHandler(createUniformActionModel(defaultRoleRegistry));
  const ctx = makeCtx(fivePlayerConfig);

  // this would be a "repeat" if night 0 had also saved "5" - the handler has
  // no way to even express that, by design (see night.ts's docs), so it
  // just scores normally instead of throwing
  assert.doesNotThrow(() => handler(nightResult(1, []), fivePlayerWorld, ctx));
  assert.doesNotThrow(() => handler(nightResult(1, ["5"]), fivePlayerWorld, ctx));
});

// --- integration through processEvidence ---

test("a NightResultFact followed by a day claim processes end to end with a normalized, non-negative posterior", () => {
  const config: GameConfig = {
    players: ["1", "2", "3", "4"],
    roles: ["don", "mafia", "doctor", "commissioner"],
  };
  const setting: GameSetting = {
    config,
    roles: defaultRoleRegistry,
    groups: defaultGroupRegistry,
  };
  const model = createLikelihoodModel(
    createHandlers({ truthful: 0.9, false: 0.1 }),
    createNightResultHandler(createUniformActionModel(defaultRoleRegistry))
  );

  const claim: SelfRoleClaim = {
    type: "selfRoleClaim",
    round: 1,
    actor: "1",
    claim: { kind: "role", role: "commissioner" },
  };
  const log = [nightResult(1, ["3"]), claim];

  const worlds = generateWorlds(config);
  const steps = processEvidence(worlds, log, model, setting);

  assert.equal(steps.length, 2);
  steps.forEach((step) => {
    const total = step.posterior.reduce((sum, w) => sum + w.probability, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `step total was ${total}`);
    assert.ok(step.posterior.every((w) => w.probability >= 0));
  });

  const changed = steps[0].posterior.some(
    (w, i) => Math.abs(w.probability - steps[0].prior[i].probability) > 1e-15
  );
  assert.ok(changed, "the night result should have actually moved the posterior");
});
