import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GameConfig,
  RoleAssertion,
  RoleExpression,
  RoleId,
  World,
} from "./types";
import { generateWorlds } from "./generateWorlds";
import { getExpressionProbability, getProbability } from "./probability";
import { updateProbabilities } from "./updateProbabilities";
import { initAliveState } from "./facts";
import { createLikelihoodModel, EvidenceContext } from "./evidence";
import { createHandlers } from "./likelihoodHandlers";
import { createRoleAssertionHandler } from "./roleAssertionLikelihood";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";

const game: GameConfig = {
  players: ["1", "2", "3", "4", "5", "6", "7", "8"],
  roles: [
    "don",
    "mafia",
    "doctor",
    "commissioner",
    "citizen",
    "citizen",
    "citizen",
    "citizen",
  ],
};

const ALL_ROLES: RoleId[] = ["don", "mafia", "doctor", "commissioner", "citizen"];

function makeCtx(): EvidenceContext {
  return {
    config: game,
    roles: defaultRoleRegistry,
    groups: defaultGroupRegistry,
    alive: initAliveState(game),
    history: [],
  };
}

const exactRole = (role: RoleId): RoleExpression => ({ kind: "role", role });

/**
 * A single valid world where player "5" holds `role`. Player "5" swaps
 * roles with whoever held it in the base assignment, so every world stays a
 * permutation of game.roles.
 */
function worldWithPlayer5As(role: RoleId): World {
  const roles: World["roles"] = {
    "1": "citizen",
    "2": "don",
    "3": "mafia",
    "4": "doctor",
    "5": "citizen",
    "6": "commissioner",
    "7": "citizen",
    "8": "citizen",
  };
  const holder = Object.keys(roles).find((p) => roles[p] === role)!;
  roles[holder] = roles["5"];
  roles["5"] = role;
  return { probability: 1, roles };
}

/** "Player 1: Player 5 is <claim>" */
function assertion(claim: RoleExpression): RoleAssertion {
  return { type: "roleAssertion", round: 1, actor: "1", target: "5", claim };
}

function scoreAgainstEachRole(claim: RoleExpression): Record<RoleId, number> {
  const handler = createRoleAssertionHandler({ truthful: 0.9, false: 0.1 });
  const ctx = makeCtx();
  const result = {} as Record<RoleId, number>;
  ALL_ROLES.forEach((role) => {
    result[role] = handler(assertion(claim), worldWithPlayer5As(role), ctx);
  });
  return result;
}

test("exact assertion 'Player 5 is Commissioner' is truthful only for commissioner", () => {
  assert.deepEqual(scoreAgainstEachRole(exactRole("commissioner")), {
    don: 0.1,
    mafia: 0.1,
    doctor: 0.1,
    commissioner: 0.9,
    citizen: 0.1,
  });
});

test("group assertion 'Player 5 is Mafia' is truthful for both Don and ordinary Mafia", () => {
  assert.deepEqual(scoreAgainstEachRole({ kind: "group", group: "mafia" }), {
    don: 0.9,
    mafia: 0.9,
    doctor: 0.1,
    commissioner: 0.1,
    citizen: 0.1,
  });
});

test("group assertion 'Player 5 is Town' is truthful for Citizen, Doctor, Commissioner", () => {
  assert.deepEqual(scoreAgainstEachRole({ kind: "group", group: "town" }), {
    don: 0.1,
    mafia: 0.1,
    doctor: 0.9,
    commissioner: 0.9,
    citizen: 0.9,
  });
});

test("group assertion 'Player 5 is Active Town' is truthful for Doctor and Commissioner, not Citizen", () => {
  assert.deepEqual(scoreAgainstEachRole({ kind: "group", group: "activeTown" }), {
    don: 0.1,
    mafia: 0.1,
    doctor: 0.9,
    commissioner: 0.9,
    citizen: 0.1,
  });
});

test("the target's role decides truthfulness, not the actor's", () => {
  const handler = createRoleAssertionHandler({ truthful: 0.9, false: 0.1 });
  // actor "1" is citizen here; asserting the target is Town must not be
  // scored against the actor's own role
  const world = worldWithPlayer5As("don");
  assert.equal(world.roles["1"], "citizen");
  assert.equal(
    handler(assertion({ kind: "group", group: "town" }), world, makeCtx()),
    0.1
  );
});

// --- constant-or-function parameters ---

test("function-valued truthful/false receive the same (observation, world, ctx) arguments", () => {
  const calls: { branch: string; args: unknown[] }[] = [];
  const handler = createRoleAssertionHandler({
    truthful: (...args) => {
      calls.push({ branch: "truthful", args });
      return 0.8;
    },
    false: (...args) => {
      calls.push({ branch: "false", args });
      return 0.05;
    },
  });
  const ctx = makeCtx();
  const observation = assertion({ kind: "group", group: "mafia" });

  const donWorld = worldWithPlayer5As("don");
  assert.equal(handler(observation, donWorld, ctx), 0.8);

  const citizenWorld = worldWithPlayer5As("citizen");
  assert.equal(handler(observation, citizenWorld, ctx), 0.05);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].branch, "truthful");
  assert.equal(calls[0].args.length, 3);
  assert.equal(calls[0].args[0], observation);
  assert.equal(calls[0].args[1], donWorld);
  assert.equal(calls[0].args[2], ctx);
  assert.equal(calls[1].branch, "false");
  assert.equal(calls[1].args[0], observation);
  assert.equal(calls[1].args[1], citizenWorld);
  assert.equal(calls[1].args[2], ctx);
});

test("a function can inspect the RoleExpression claim and the actor's role in the world", () => {
  const handler = createRoleAssertionHandler({
    truthful: (observation, w, ctx) =>
      observation.claim.kind === "group" &&
      ctx.roles[w.roles[observation.actor]].team === "mafia"
        ? 0.3
        : 0.7,
    false: 0.1,
  });
  const observation: RoleAssertion = {
    type: "roleAssertion",
    round: 1,
    actor: "2",
    target: "5",
    claim: { kind: "group", group: "mafia" },
  };

  // "5" is ordinary mafia, actor "2" is don
  const world = worldWithPlayer5As("mafia");
  assert.equal(world.roles["2"], "don");
  assert.equal(handler(observation, world, makeCtx()), 0.3);

  // same claim as an exact role takes the other branch of the function
  assert.equal(
    handler({ ...observation, claim: exactRole("mafia") }, world, makeCtx()),
    0.7
  );
});

// --- full Bayesian update ---

function updateWith(claim: RoleExpression): World[] {
  const model = createLikelihoodModel(
    createHandlers({ truthful: 0.5, false: 0.5 }, { truthful: 0.9, false: 0.1 })
  );
  return updateProbabilities(generateWorlds(game), assertion(claim), model, makeCtx());
}

function assertNormalized(worlds: World[]): void {
  const total = worlds.reduce((sum, w) => sum + w.probability, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `total was ${total}`);
  assert.ok(worlds.every((w) => w.probability >= 0));
  const marginal = ALL_ROLES.reduce(
    (sum, role) => sum + getProbability(worlds, "5", role),
    0
  );
  assert.ok(Math.abs(marginal - 1) < 1e-9, `marginal was ${marginal}`);
}

test("Bayesian update: exact assertion 'Player 5 is Commissioner' moves 12.5% -> 56.25%", () => {
  const posterior = updateWith(exactRole("commissioner"));
  assertNormalized(posterior);
  const p = getProbability(posterior, "5", "commissioner");
  assert.ok(Math.abs(p - 0.5625) < 1e-9, `got ${p}`);
});

test("Bayesian update: group assertion 'Player 5 is Mafia' moves the group 25% -> 75%, split across exact roles", () => {
  const posterior = updateWith({ kind: "group", group: "mafia" });
  assertNormalized(posterior);

  const group = getExpressionProbability(
    posterior,
    "5",
    { kind: "group", group: "mafia" },
    defaultGroupRegistry
  );
  // 0.25 * 0.9 / (0.25 * 0.9 + 0.75 * 0.1)
  assert.ok(Math.abs(group - 0.75) < 1e-9, `got ${group}`);

  // the group value is derived from exact-role worlds, which carry it equally
  const don = getProbability(posterior, "5", "don");
  const mafia = getProbability(posterior, "5", "mafia");
  assert.ok(Math.abs(don - 0.375) < 1e-9, `don ${don}`);
  assert.ok(Math.abs(mafia - 0.375) < 1e-9, `mafia ${mafia}`);
  assert.ok(Math.abs(group - (don + mafia)) < 1e-9);
});

test("Bayesian update: 'Player 5 is Active Town' raises doctor/commissioner and lowers citizen", () => {
  const posterior = updateWith({ kind: "group", group: "activeTown" });
  assertNormalized(posterior);

  // prior active town = 2/8; posterior = 0.25 * 0.9 / 0.3 = 0.75
  const doctor = getProbability(posterior, "5", "doctor");
  const commissioner = getProbability(posterior, "5", "commissioner");
  const citizen = getProbability(posterior, "5", "citizen");
  assert.ok(Math.abs(doctor - 0.375) < 1e-9, `doctor ${doctor}`);
  assert.ok(Math.abs(commissioner - 0.375) < 1e-9, `commissioner ${commissioner}`);
  // prior citizen = 4/8 -> 0.5 * 0.1 / 0.3
  assert.ok(Math.abs(citizen - 1 / 6) < 1e-9, `citizen ${citizen}`);
});

test("createHandlers without roleAssertion params leaves roleAssertion an uncalibrated stub", () => {
  const model = createLikelihoodModel(createHandlers({ truthful: 0.9, false: 0.1 }));
  assert.throws(
    () =>
      model.likelihood(
        assertion({ kind: "group", group: "town" }),
        worldWithPlayer5As("citizen"),
        makeCtx()
      ),
    /roleAssertion likelihood not calibrated yet/
  );
});
