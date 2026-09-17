import { test } from "node:test";
import assert from "node:assert/strict";
import { AliveState, GameConfig, PlayerId, RoleId, SelfRoleClaim, World } from "./types";
import { generateWorlds } from "./generateWorlds";
import { initAliveState } from "./facts";
import { createLikelihoodModel, EvidenceContext } from "./evidence";
import { createHandlers } from "./likelihoodHandlers";
import {
  createBruteForceNightResultHandler,
  createNightResultHandler,
  createOptimizedNightResultHandler,
} from "./nightResultLikelihood";
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

// --- doctor repeat-target inclusion at round 1 (no previous night exists) ---

test("the handler never throws at round 1, since there is no previous night to constrain it", () => {
  const handler = createNightResultHandler(createUniformActionModel(defaultRoleRegistry));
  const ctx = makeCtx(fivePlayerConfig);

  // round 1 has no earlier NightResultFact in ctx.history, so there is
  // nothing to exclude - matches "no previous target restriction" per
  // requirement 1. See the "cross-night Doctor consecutive-target
  // constraint" tests below for round 2+, where a real (marginalized)
  // exclusion now genuinely applies.
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

// =====================================================================
// Optimized (FactoredActionModel) path
// =====================================================================

// --- createNightResultHandler must never apply the fast path to a plain,
// non-factored (possibly correlated) ActionModel ---

test("a correlated, non-factored ActionModel is scored by brute force, and produces the correct correlated value", () => {
  // Deliberately NOT independent across blocks: weight is 1 only when the
  // Don's own kill choice equals the Commissioner's check target - a
  // classic non-product ("diagonal") joint distribution. This ActionModel
  // does not implement FactoredActionModel (TypeScript itself would refuse
  // to pass it to createOptimizedNightResultHandler), so
  // createNightResultHandler must route it through brute force. The
  // expected values below were independently derived (by hand, then
  // cross-checked with a standalone script using enumerateHiddenNightActions
  // + resolveNight directly) - only a correct full-space brute-force sum
  // can reproduce them; no factored shortcut is even expressible for this
  // weight function.
  const config: GameConfig = {
    players: ["1", "2", "3", "4"],
    roles: ["don", "mafia", "doctor", "commissioner"],
  };
  const world: World = {
    probability: 1,
    roles: { "1": "don", "2": "mafia", "3": "doctor", "4": "commissioner" },
  };
  const correlatedModel: ActionModel = {
    probability: (actions) =>
      actions.mafiaTargetChoices["1"] === actions.commissionerCheckTarget ? 1 : 0,
  };
  const handler = createNightResultHandler(correlatedModel);
  const ctx = makeCtx(config);

  assert.equal(handler(nightResult(1, []), world, ctx), 136);
  assert.equal(handler(nightResult(1, ["1"]), world, ctx), 48);
  assert.equal(handler(nightResult(1, ["2"]), world, ctx), 48);
  assert.equal(handler(nightResult(1, ["3"]), world, ctx), 12);
  assert.equal(handler(nightResult(1, ["4"]), world, ctx), 12);

  // proves this is exactly the brute-force reference, not a coincidence
  const bruteForceHandler = createBruteForceNightResultHandler(correlatedModel);
  ["1", "2", "3", "4"].forEach((p) => {
    assert.equal(
      handler(nightResult(1, [p]), world, ctx),
      bruteForceHandler(nightResult(1, [p]), world, ctx)
    );
  });
});

// --- pinned edge cases, each verified against both the brute-force
// reference and a hand/script-derived exact expected value ---

test("zero mafia killers: died is always [], with probability exactly 1", () => {
  const config: GameConfig = {
    players: ["1", "2", "3"],
    roles: ["doctor", "commissioner", "citizen"],
  };
  const world: World = {
    probability: 1,
    roles: { "1": "doctor", "2": "commissioner", "3": "citizen" },
  };
  const actionModel = createUniformActionModel(defaultRoleRegistry);
  const ctx = makeCtx(config);

  const optimized = createOptimizedNightResultHandler(actionModel);
  const bruteForce = createBruteForceNightResultHandler(actionModel);

  assert.ok(Math.abs(optimized(nightResult(1, []), world, ctx) - 1) < 1e-9);
  assert.ok(Math.abs(bruteForce(nightResult(1, []), world, ctx) - 1) < 1e-9);
  assert.equal(optimized(nightResult(1, ["1"]), world, ctx), 0);
  assert.equal(bruteForce(nightResult(1, ["1"]), world, ctx), 0);
});

test("exactly 1 mafia killer: no-consensus outcome is impossible (matches the brute-force reference)", () => {
  const config: GameConfig = { players: ["1", "2"], roles: ["mafia", "citizen"] };
  const world: World = { probability: 1, roles: { "1": "mafia", "2": "citizen" } };
  const actionModel = createUniformActionModel(defaultRoleRegistry);
  const ctx = makeCtx(config);

  const optimized = createOptimizedNightResultHandler(actionModel);
  assert.equal(optimized(nightResult(1, []), world, ctx), 0);
});

test("2 mafia killers (don + mafia): hand-computable 1/9 / 2/3 cases match through the optimized path", () => {
  const actionModel = createUniformActionModel(defaultRoleRegistry);
  const optimized = createOptimizedNightResultHandler(actionModel);
  const ctx = makeCtx(threePlayerConfig);

  ["1", "2", "3"].forEach((target) => {
    const result = optimized(nightResult(1, [target]), threePlayerWorld, ctx);
    assert.ok(Math.abs(result - 1 / 9) < 1e-12, `target ${target}: got ${result}`);
  });
  const noDeath = optimized(nightResult(1, []), threePlayerWorld, ctx);
  assert.ok(Math.abs(noDeath - 2 / 3) < 1e-12);
});

test("mafia kill + doctor save on the same target cancels it: hand-computable 1/2, 1/4, 1/4", () => {
  const config: GameConfig = { players: ["1", "2"], roles: ["doctor", "mafia"] };
  const world: World = { probability: 1, roles: { "1": "doctor", "2": "mafia" } };
  const actionModel = createUniformActionModel(defaultRoleRegistry);
  const ctx = makeCtx(config);

  const optimized = createOptimizedNightResultHandler(actionModel);
  const bruteForce = createBruteForceNightResultHandler(actionModel);

  [optimized, bruteForce].forEach((handler) => {
    assert.ok(Math.abs(handler(nightResult(1, []), world, ctx) - 0.5) < 1e-9);
    assert.ok(Math.abs(handler(nightResult(1, ["1"]), world, ctx) - 0.25) < 1e-9);
    assert.ok(Math.abs(handler(nightResult(1, ["2"]), world, ctx) - 0.25) < 1e-9);
  });
});

test("commissioner killing an actual mafia target, vs. checking a non-mafia target, vs. self-targeting", () => {
  // 1 killer ("1", mafia) always succeeds; no doctor present, so the mafia's
  // target always dies. Commissioner "2" additionally kills only when it
  // checks the mafia player "1" - proving both "commissioner kills a mafia
  // target" and "commissioner checking a non-mafia target causes no extra
  // death". Commissioner checking itself (target "2") is included too,
  // proving self-targeting is not special-cased away.
  const config: GameConfig = {
    players: ["1", "2", "3"],
    roles: ["mafia", "commissioner", "citizen"],
  };
  const world: World = {
    probability: 1,
    roles: { "1": "mafia", "2": "commissioner", "3": "citizen" },
  };
  const actionModel = createUniformActionModel(defaultRoleRegistry);
  const ctx = makeCtx(config);

  const optimized = createOptimizedNightResultHandler(actionModel);
  const bruteForce = createBruteForceNightResultHandler(actionModel);

  const expected: Array<[PlayerId[], number]> = [
    [["1"], 1 / 3], // mafia's target survives commissioner-scrutiny in isolation
    [["2"], 2 / 9], // mafia kills "2", commissioner check doesn't land on "1"
    [["3"], 2 / 9], // mafia kills "3", commissioner check doesn't land on "1"
    [["1", "2"], 1 / 9], // mafia kills "2" AND commissioner catches/kills "1"
    [["1", "3"], 1 / 9], // mafia kills "3" AND commissioner catches/kills "1"
    [[], 0],
    [["2", "3"], 0],
  ];

  expected.forEach(([died, value]) => {
    [optimized, bruteForce].forEach((handler) => {
      const result = handler(nightResult(1, died), world, ctx);
      assert.ok(
        Math.abs(result - value) < 1e-9,
        `died=${JSON.stringify(died)}: expected ${value}, got ${result}`
      );
    });
  });

  const total = expected.reduce((sum, [, value]) => sum + value, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test("multiple killers, some dead: dead mafia members are excluded, dead Don removes the extra killer", () => {
  const config: GameConfig = {
    players: ["1", "2", "3", "4", "5", "6"],
    roles: ["don", "mafia", "doctor", "commissioner", "citizen", "citizen"],
  };
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
  const actionModel = createUniformActionModel(defaultRoleRegistry);
  const optimized = createOptimizedNightResultHandler(actionModel);
  const bruteForce = createBruteForceNightResultHandler(actionModel);

  const deadDon = makeCtx(config, { alive: { "1": false, "2": true, "3": true, "4": true, "5": true, "6": true } });
  const deadDoctor = makeCtx(config, { alive: { "1": true, "2": true, "3": false, "4": true, "5": true, "6": true } });
  const deadCommissioner = makeCtx(config, { alive: { "1": true, "2": true, "3": true, "4": false, "5": true, "6": true } });

  [
    { ctx: deadDon, label: "dead Don" },
    { ctx: deadDoctor, label: "dead Doctor" },
    { ctx: deadCommissioner, label: "dead Commissioner" },
  ].forEach(({ ctx, label }) => {
    ["5", "6", []].forEach((died) => {
      const diedArr = Array.isArray(died) ? died : [died];
      const o = optimized(nightResult(1, diedArr), world, ctx);
      const b = bruteForce(nightResult(1, diedArr), world, ctx);
      assert.ok(Math.abs(o - b) < 1e-9, `${label}, died=${JSON.stringify(diedArr)}: opt=${o} brute=${b}`);
    });
  });
});

// --- randomized differential tests: optimized vs. brute-force reference,
// over many small, randomly generated valid worlds/alive states ---

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RandomWorld {
  config: GameConfig;
  world: World;
  alive: Record<PlayerId, boolean>;
}

function randomWorld(rand: () => number): RandomWorld {
  const roles: RoleId[] = [];
  if (rand() < 0.6) roles.push("don");
  if (rand() < 0.6) roles.push("doctor");
  if (rand() < 0.6) roles.push("commissioner");
  if (rand() < 0.8) {
    const mafiaCount = 1 + Math.floor(rand() * 2);
    for (let i = 0; i < mafiaCount; i++) roles.push("mafia");
  }
  const targetSize = 2 + Math.floor(rand() * 5); // 2..6
  while (roles.length < targetSize) roles.push("citizen");

  // shuffle (Fisher-Yates)
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }

  const players = roles.map((_, i) => String(i + 1));
  const worldRoles: Record<PlayerId, RoleId> = {};
  players.forEach((p, i) => {
    worldRoles[p] = roles[i];
  });

  const alive: Record<PlayerId, boolean> = {};
  players.forEach((p) => {
    alive[p] = rand() >= 0.3; // ~30% chance dead
  });
  // guarantee at least one living player, otherwise every dimension is empty
  if (!players.some((p) => alive[p])) {
    alive[players[0]] = true;
  }

  return {
    config: { players, roles },
    world: { probability: 1, roles: worldRoles },
    alive,
  };
}

test("randomized differential test: optimized likelihood matches brute-force reference across many small worlds", () => {
  const rand = mulberry32(42);
  const actionModel = createUniformActionModel(defaultRoleRegistry);
  const optimized = createOptimizedNightResultHandler(actionModel);
  const bruteForce = createBruteForceNightResultHandler(actionModel);

  const TRIALS = 150;
  let comparisons = 0;

  for (let trial = 0; trial < TRIALS; trial++) {
    const { config, world, alive } = randomWorld(rand);
    const ctx = makeCtx(config, { alive });
    const livingPlayers = config.players.filter((p) => alive[p]);

    const candidateFacts: PlayerId[][] = [[]];
    if (livingPlayers.length > 0) {
      candidateFacts.push([livingPlayers[Math.floor(rand() * livingPlayers.length)]]);
    }
    if (livingPlayers.length > 1) {
      const a = livingPlayers[Math.floor(rand() * livingPlayers.length)];
      let b = livingPlayers[Math.floor(rand() * livingPlayers.length)];
      if (b === a) b = livingPlayers[(livingPlayers.indexOf(a) + 1) % livingPlayers.length];
      candidateFacts.push([a, b]);
      candidateFacts.push([b, a]); // order-independence, exercised for free
    }
    // an impossible fact: every living player dying at once is usually unreachable
    candidateFacts.push(livingPlayers);

    candidateFacts.forEach((died) => {
      const fact = nightResult(1, died);
      const o = optimized(fact, world, ctx);
      const b = bruteForce(fact, world, ctx);
      assert.ok(
        Math.abs(o - b) < 1e-9,
        `trial ${trial}, world=${JSON.stringify(world.roles)}, alive=${JSON.stringify(
          alive
        )}, died=${JSON.stringify(died)}: optimized=${o}, bruteForce=${b}`
      );
      comparisons++;
    });
  }

  assert.ok(comparisons > 300, `expected substantial coverage, got ${comparisons} comparisons`);
});

// =====================================================================
// Cross-night Doctor consecutive-target constraint
// =====================================================================

const doctorMafiaConfig: GameConfig = { players: ["1", "2"], roles: ["doctor", "mafia"] };
const doctorMafiaWorld: World = { probability: 1, roles: { "1": "doctor", "2": "mafia" } };
const doctorMafiaAlive: AliveState = { "1": true, "2": true };

function ctxWithHistory(history: NightResultFact[]): EvidenceContext {
  return makeCtx(doctorMafiaConfig, { alive: doctorMafiaAlive, history });
}

function bothHandlers(actionModel: ReturnType<typeof createUniformActionModel>) {
  return [
    createBruteForceNightResultHandler(actionModel),
    createOptimizedNightResultHandler(actionModel),
  ];
}

test("hand-computable: night 1's death pins the Doctor's target to certainty, making a repeat impossible on night 2", () => {
  // night 1 died=["1"] is only reachable via (mafia targets "1", doctor
  // saves "2") - the ONLY matching hypothesis out of 4 - so given this
  // observation the Doctor certainly saved "2" last night. Night 2 must
  // therefore exclude "2", forcing the Doctor onto "1" with certainty (only
  // 2 living players): "1" can never die tonight, and died=[]/died=["2"]
  // split the remaining probability mass evenly.
  const ctx = ctxWithHistory([nightResult(1, ["1"])]);
  const actionModel = createUniformActionModel(defaultRoleRegistry);

  bothHandlers(actionModel).forEach((handler) => {
    assert.equal(handler(nightResult(2, ["1"]), doctorMafiaWorld, ctx), 0);
    assert.ok(Math.abs(handler(nightResult(2, []), doctorMafiaWorld, ctx) - 0.5) < 1e-12);
    assert.ok(Math.abs(handler(nightResult(2, ["2"]), doctorMafiaWorld, ctx) - 0.5) < 1e-12);
  });
});

test("hand-computable: an ambiguous night 1 (no death) gives a 50/50 belief, correctly combined for night 2", () => {
  // night 1 died=[] is reachable via EITHER (mafia targets "1", doctor
  // saves "1") OR (mafia targets "2", doctor saves "2"), each equally
  // weighted - so the belief over the Doctor's real target is exactly
  // 50/50. Night 2's likelihood is the WEIGHTED COMBINATION of both
  // branches (doctor forced onto "2" in one, onto "1" in the other),
  // which for this specific 2-player world happens to reproduce the same
  // 1/2, 1/4, 1/4 split as an unconstrained single night - a genuine
  // multi-branch belief combination, verified exactly, not a coincidence
  // that would show up as a difference from the unconstrained baseline.
  const ctx = ctxWithHistory([nightResult(1, [])]);
  const actionModel = createUniformActionModel(defaultRoleRegistry);

  bothHandlers(actionModel).forEach((handler) => {
    assert.ok(Math.abs(handler(nightResult(2, []), doctorMafiaWorld, ctx) - 0.5) < 1e-12);
    assert.ok(Math.abs(handler(nightResult(2, ["1"]), doctorMafiaWorld, ctx) - 0.25) < 1e-12);
    assert.ok(Math.abs(handler(nightResult(2, ["2"]), doctorMafiaWorld, ctx) - 0.25) < 1e-12);
  });
});

test("a Doctor who dies during night 1 imposes no constraint on night 2 (no living Doctor to have a target)", () => {
  const config: GameConfig = {
    players: ["1", "2", "3"],
    roles: ["doctor", "mafia", "citizen"],
  };
  const world: World = { probability: 1, roles: { "1": "doctor", "2": "mafia", "3": "citizen" } };
  const alive2: AliveState = { "1": false, "2": true, "3": true }; // the Doctor died night 1

  const ctx = makeCtx(config, { alive: alive2, history: [nightResult(1, ["1"])] });
  const actionModel = createUniformActionModel(defaultRoleRegistry);

  bothHandlers(actionModel).forEach((handler) => {
    // no Doctor alive tonight - a lone mafia killer always succeeds, so a
    // "no death" night 2 is exactly impossible, same as the no-special-
    // roles baseline (proves no stray exclusion carried forward)
    assert.equal(handler(nightResult(2, []), world, ctx), 0);
    assert.ok(handler(nightResult(2, ["2"]), world, ctx) > 0);
    assert.ok(handler(nightResult(2, ["3"]), world, ctx) > 0);
  });
});

test("randomized multi-night differential test: optimized matches brute-force reference across 2-night sequences with a living Doctor", () => {
  const rand = mulberry32(7);
  const actionModel = createUniformActionModel(defaultRoleRegistry);
  const optimized = createOptimizedNightResultHandler(actionModel);
  const bruteForce = createBruteForceNightResultHandler(actionModel);

  const TRIALS = 60;
  let comparisons = 0;

  for (let trial = 0; trial < TRIALS; trial++) {
    const { config, world } = randomWorld(rand);
    if (!config.roles.includes("doctor")) continue; // only meaningful with a Doctor present
    const aliveAtNight1: AliveState = {};
    config.players.forEach((p) => {
      aliveAtNight1[p] = true;
    });

    const livingAtNight1 = config.players;
    const night1Died: PlayerId[] =
      rand() < 0.5 ? [] : [livingAtNight1[Math.floor(rand() * livingAtNight1.length)]];

    const aliveAtNight2: AliveState = { ...aliveAtNight1 };
    night1Died.forEach((p) => {
      aliveAtNight2[p] = false;
    });
    const livingAtNight2 = config.players.filter((p) => aliveAtNight2[p]);
    if (livingAtNight2.length === 0) continue;

    const ctx = makeCtx(config, {
      alive: aliveAtNight2,
      history: [nightResult(1, night1Died)],
    });

    const candidateFacts: PlayerId[][] = [[]];
    candidateFacts.push([livingAtNight2[Math.floor(rand() * livingAtNight2.length)]]);

    candidateFacts.forEach((died) => {
      const fact = nightResult(2, died);
      const o = optimized(fact, world, ctx);
      const b = bruteForce(fact, world, ctx);
      assert.ok(
        Math.abs(o - b) < 1e-9,
        `trial ${trial}, world=${JSON.stringify(world.roles)}, night1Died=${JSON.stringify(
          night1Died
        )}, died=${JSON.stringify(died)}: optimized=${o}, bruteForce=${b}`
      );
      comparisons++;
    });
  }

  assert.ok(comparisons > 20, `expected substantial coverage, got ${comparisons} comparisons`);
});

test("a sole-survivor Doctor forced into a repeat makes that world impossible for the following night, at the handler level", () => {
  // in the 2-player {doctor, mafia} world, night 1 died=["1"] pins the
  // Doctor's night-1 target to certainty (see the hand-computable test
  // above). In the world where "1" was the mafia (and so died, leaving
  // only the Doctor "2" alive), the Doctor is now the SOLE living player,
  // excluded from re-targeting the one and only legal choice (themselves)
  // - there is no legal Doctor action left at all, so this world's
  // likelihood is exactly 0 for every possible night-2 fact.
  const config: GameConfig = { players: ["1", "2"], roles: ["doctor", "mafia"] };
  const worldMafiaFirst: World = { probability: 1, roles: { "1": "mafia", "2": "doctor" } };
  const alive2: AliveState = { "1": false, "2": true };
  const ctx = makeCtx(config, { alive: alive2, history: [nightResult(1, ["1"])] });
  const actionModel = createUniformActionModel(defaultRoleRegistry);

  bothHandlers(actionModel).forEach((handler) => {
    [[], ["2"]].forEach((died) => {
      assert.equal(handler(nightResult(2, died), worldMafiaFirst, ctx), 0);
    });
  });
});

test("integration through processEvidence: a 3-night log with a surviving Doctor stays normalized and non-negative throughout", () => {
  // a larger config with citizens present, so the Doctor's living-target
  // domain never shrinks to the degenerate single-forced-choice case
  // exercised in the test above.
  const config: GameConfig = {
    players: ["1", "2", "3", "4"],
    roles: ["doctor", "mafia", "citizen", "citizen"],
  };
  const setting: GameSetting = {
    config,
    roles: defaultRoleRegistry,
    groups: defaultGroupRegistry,
  };
  const model = createNightResultHandler(createUniformActionModel(defaultRoleRegistry));
  const likelihoodModel = createLikelihoodModel(createHandlers({ truthful: 0.9, false: 0.1 }), model);

  const log: NightResultFact[] = [nightResult(1, []), nightResult(2, []), nightResult(3, [])];

  const worlds = generateWorlds(config);
  const steps = processEvidence(worlds, log, likelihoodModel, setting);

  assert.equal(steps.length, log.length);
  steps.forEach((step) => {
    const total = step.posterior.reduce((sum, w) => sum + w.probability, 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
    assert.ok(step.posterior.every((w) => w.probability >= 0));
  });
});
