import { test } from "node:test";
import assert from "node:assert/strict";
import { GameConfig, RoleExpression, World } from "./types";
import { generateWorlds } from "./generateWorlds";
import { getExpressionProbability, getProbability } from "./probability";
import { updateProbabilities } from "./updateProbabilities";
import { initAliveState } from "./facts";
import { createLikelihoodModel, EvidenceContext } from "./evidence";
import { createHandlers } from "./likelihoodHandlers";
import { createSelfRoleClaimHandler } from "./selfRoleClaimLikelihood";
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

function makeCtx(): EvidenceContext {
  return {
    config: game,
    roles: defaultRoleRegistry,
    groups: defaultGroupRegistry,
    alive: initAliveState(game),
    history: [],
  };
}

const exactRole = (role: World["roles"][string]): RoleExpression => ({
  kind: "role",
  role,
});

const world: World = {
  probability: 1,
  roles: {
    "1": "commissioner",
    "2": "don",
    "3": "mafia",
    "4": "doctor",
    "5": "citizen",
    "6": "citizen",
    "7": "citizen",
    "8": "citizen",
  },
};

test("handler returns the configured truthful value when the claim matches", () => {
  const handler = createSelfRoleClaimHandler({ truthful: 0.7, false: 0.2 });
  const result = handler(
    { type: "selfRoleClaim", round: 1, actor: "1", claim: exactRole("commissioner") },
    world,
    makeCtx()
  );
  assert.equal(result, 0.7);
});

test("handler returns the configured false value when the claim does not match", () => {
  const handler = createSelfRoleClaimHandler({ truthful: 0.7, false: 0.2 });
  const result = handler(
    { type: "selfRoleClaim", round: 1, actor: "1", claim: exactRole("doctor") },
    world,
    makeCtx()
  );
  assert.equal(result, 0.2);
});

function posteriorFor(truthful: number, falseValue: number): number {
  const worlds = generateWorlds(game);
  const ctx = makeCtx();
  const model = createLikelihoodModel(
    createHandlers({ truthful, false: falseValue })
  );
  const posteriorWorlds = updateProbabilities(
    worlds,
    { type: "selfRoleClaim", round: 1, actor: "1", claim: exactRole("commissioner") },
    model,
    ctx
  );
  return getProbability(posteriorWorlds, "1", "commissioner");
}

test("different likelihood parameters produce different, correctly-computed posteriors", () => {
  // prior P(1 = commissioner) = 0.125 in every case below

  const posteriorA = posteriorFor(0.9, 0.1);
  assert.ok(Math.abs(posteriorA - 0.5625) < 1e-9, `got ${posteriorA}`);

  const posteriorB = posteriorFor(0.6, 0.3);
  const expectedB = (0.125 * 0.6) / (0.125 * 0.6 + 0.875 * 0.3);
  assert.ok(Math.abs(posteriorB - expectedB) < 1e-9, `got ${posteriorB}`);
  assert.ok(Math.abs(posteriorB - 2 / 9) < 1e-9, `got ${posteriorB}`);
});

test("equal truthful/false likelihood leaves the posterior equal to the prior (uninformative)", () => {
  const posterior = posteriorFor(0.5, 0.5);
  assert.ok(Math.abs(posterior - 0.125) < 1e-9, `got ${posterior}`);
});

test("createHandlers only replaces selfRoleClaim - other types stay uncalibrated stubs", () => {
  const model = createLikelihoodModel(
    createHandlers({ truthful: 0.9, false: 0.1 })
  );
  assert.throws(() => {
    model.likelihood(
      {
        type: "candidateVote",
        round: 1,
        stage: "initial",
        candidates: ["2"],
        handsRaised: { "2": ["1"] },
      },
      world,
      makeCtx()
    );
  });
});

// --- constant-or-function extension ---

test("a truthful function can inspect observation.actor", () => {
  const handler = createSelfRoleClaimHandler({
    truthful: (observation) => (observation.actor === "1" ? 0.8 : 0.4),
    false: 0.1,
  });
  assert.equal(
    handler(
      { type: "selfRoleClaim", round: 1, actor: "1", claim: exactRole("commissioner") },
      world,
      makeCtx()
    ),
    0.8
  );
  assert.equal(
    handler(
      { type: "selfRoleClaim", round: 1, actor: "2", claim: exactRole("don") },
      world,
      makeCtx()
    ),
    0.4
  );
});

test("a truthful function can inspect observation.claim", () => {
  const handler = createSelfRoleClaimHandler({
    truthful: (observation) =>
      observation.claim.kind === "role" &&
      observation.claim.role === "commissioner"
        ? 0.95
        : 0.3,
    false: 0.1,
  });
  assert.equal(
    handler(
      { type: "selfRoleClaim", round: 1, actor: "1", claim: exactRole("commissioner") },
      world,
      makeCtx()
    ),
    0.95
  );
  assert.equal(
    handler(
      { type: "selfRoleClaim", round: 1, actor: "2", claim: exactRole("don") },
      world,
      makeCtx()
    ),
    0.3
  );
});

test("a false function can inspect world.roles[observation.actor]", () => {
  const handler = createSelfRoleClaimHandler({
    truthful: 0.9,
    false: (observation, w) =>
      w.roles[observation.actor] === "mafia" ? 0.05 : 0.2,
  });
  // actor "3" is actually mafia, falsely claims citizen
  assert.equal(
    handler(
      { type: "selfRoleClaim", round: 1, actor: "3", claim: exactRole("citizen") },
      world,
      makeCtx()
    ),
    0.05
  );
  // actor "5" is actually citizen, falsely claims doctor
  assert.equal(
    handler(
      { type: "selfRoleClaim", round: 1, actor: "5", claim: exactRole("doctor") },
      world,
      makeCtx()
    ),
    0.2
  );
});

test("a function can inspect ctx.history", () => {
  const handler = createSelfRoleClaimHandler({
    truthful: (_observation, _world, ctx) =>
      ctx.history.length > 0 ? 0.95 : 0.7,
    false: 0.1,
  });
  const emptyHistoryCtx = makeCtx();
  const withHistoryCtx: EvidenceContext = {
    ...makeCtx(),
    history: [
      {
        type: "candidateVote",
        round: 1,
        stage: "initial",
        candidates: ["3"],
        handsRaised: { "3": ["2"] },
      },
    ],
  };

  assert.equal(
    handler(
      { type: "selfRoleClaim", round: 1, actor: "1", claim: exactRole("commissioner") },
      world,
      emptyHistoryCtx
    ),
    0.7
  );
  assert.equal(
    handler(
      { type: "selfRoleClaim", round: 1, actor: "1", claim: exactRole("commissioner") },
      world,
      withHistoryCtx
    ),
    0.95
  );
});

test("a function-based likelihood is actually used by the Bayesian pipeline", () => {
  const worlds = generateWorlds(game);
  const ctx = makeCtx();
  const model = createLikelihoodModel(
    createHandlers({
      truthful: (observation) => (observation.actor === "1" ? 0.9 : 0.9),
      false: (observation, w) => (w.roles[observation.actor] ? 0.1 : 0.1),
    })
  );
  const posteriorWorlds = updateProbabilities(
    worlds,
    { type: "selfRoleClaim", round: 1, actor: "1", claim: exactRole("commissioner") },
    model,
    ctx
  );
  const posterior = getProbability(posteriorWorlds, "1", "commissioner");
  // same 0.9/0.1 shape as the numeric case - proves the function branch
  // drives the same real Bayesian math, not a bypassed/ignored value
  assert.ok(Math.abs(posterior - 0.5625) < 1e-9, `got ${posterior}`);
});

// --- role groups ---

test("exact Commissioner claim: only the commissioner-holding world is truthful", () => {
  const handler = createSelfRoleClaimHandler({ truthful: 0.9, false: 0.1 });
  assert.equal(
    handler(
      { type: "selfRoleClaim", round: 1, actor: "1", claim: exactRole("commissioner") },
      world,
      makeCtx()
    ),
    0.9
  );
  assert.equal(
    handler(
      { type: "selfRoleClaim", round: 1, actor: "2", claim: exactRole("commissioner") },
      world,
      makeCtx()
    ),
    0.1
  );
});

test("Mafia group claim matches both Don and ordinary Mafia", () => {
  const handler = createSelfRoleClaimHandler({ truthful: 0.9, false: 0.1 });
  const mafiaClaim: RoleExpression = { kind: "group", group: "mafia" };

  assert.equal(
    handler({ type: "selfRoleClaim", round: 1, actor: "2", claim: mafiaClaim }, world, makeCtx()),
    0.9 // "2" is don
  );
  assert.equal(
    handler({ type: "selfRoleClaim", round: 1, actor: "3", claim: mafiaClaim }, world, makeCtx()),
    0.9 // "3" is ordinary mafia
  );
  assert.equal(
    handler({ type: "selfRoleClaim", round: 1, actor: "1", claim: mafiaClaim }, world, makeCtx()),
    0.1 // "1" is commissioner, not mafia
  );
});

test("Town group claim matches Citizen/Doctor/Commissioner", () => {
  const handler = createSelfRoleClaimHandler({ truthful: 0.9, false: 0.1 });
  const townClaim: RoleExpression = { kind: "group", group: "town" };

  assert.equal(
    handler({ type: "selfRoleClaim", round: 1, actor: "5", claim: townClaim }, world, makeCtx()),
    0.9 // citizen
  );
  assert.equal(
    handler({ type: "selfRoleClaim", round: 1, actor: "4", claim: townClaim }, world, makeCtx()),
    0.9 // doctor
  );
  assert.equal(
    handler({ type: "selfRoleClaim", round: 1, actor: "1", claim: townClaim }, world, makeCtx()),
    0.9 // commissioner
  );
  assert.equal(
    handler({ type: "selfRoleClaim", round: 1, actor: "2", claim: townClaim }, world, makeCtx()),
    0.1 // don
  );
});

test("Active Town claim matches Doctor/Commissioner but not Citizen", () => {
  const handler = createSelfRoleClaimHandler({ truthful: 0.9, false: 0.1 });
  const activeTownClaim: RoleExpression = { kind: "group", group: "activeTown" };

  assert.equal(
    handler({ type: "selfRoleClaim", round: 1, actor: "4", claim: activeTownClaim }, world, makeCtx()),
    0.9 // doctor
  );
  assert.equal(
    handler({ type: "selfRoleClaim", round: 1, actor: "1", claim: activeTownClaim }, world, makeCtx()),
    0.9 // commissioner
  );
  assert.equal(
    handler({ type: "selfRoleClaim", round: 1, actor: "5", claim: activeTownClaim }, world, makeCtx()),
    0.1 // citizen - not active town
  );
});

test("group probability equals the sum of the corresponding exact-role probabilities", () => {
  const worlds = generateWorlds(game);
  const groups = defaultGroupRegistry;

  const mafiaGroupProbability = getExpressionProbability(
    worlds,
    "1",
    { kind: "group", group: "mafia" },
    groups
  );
  const summedExactRoles =
    getProbability(worlds, "1", "don") + getProbability(worlds, "1", "mafia");
  assert.ok(
    Math.abs(mafiaGroupProbability - summedExactRoles) < 1e-9,
    `group=${mafiaGroupProbability} sum=${summedExactRoles}`
  );

  const townGroupProbability = getExpressionProbability(
    worlds,
    "1",
    { kind: "group", group: "town" },
    groups
  );
  const summedTownExactRoles =
    getProbability(worlds, "1", "citizen") +
    getProbability(worlds, "1", "doctor") +
    getProbability(worlds, "1", "commissioner");
  assert.ok(
    Math.abs(townGroupProbability - summedTownExactRoles) < 1e-9,
    `group=${townGroupProbability} sum=${summedTownExactRoles}`
  );
});

test("no separate group probability state is introduced - it's always recomputed from World[]", () => {
  const worlds = generateWorlds(game);
  const groups = defaultGroupRegistry;
  const expr: RoleExpression = { kind: "group", group: "activeTown" };

  const before = getExpressionProbability(worlds, "1", expr, groups);

  // mutate world probabilities directly (simulating a Bayesian update) and
  // confirm the group probability changes accordingly, with nothing else
  // to keep in sync - there is no cached/stored group value anywhere
  const mutatedWorlds = worlds.map((w) => ({
    ...w,
    probability: w.roles["1"] === "commissioner" ? w.probability * 2 : w.probability,
  }));
  const total = mutatedWorlds.reduce((sum, w) => sum + w.probability, 0);
  const renormalized = mutatedWorlds.map((w) => ({
    ...w,
    probability: w.probability / total,
  }));

  const after = getExpressionProbability(renormalized, "1", expr, groups);
  assert.notEqual(after, before);

  // and it still equals the direct sum over the (mutated) posterior
  const directSum = renormalized
    .filter((w) => groups.activeTown.includes(w.roles["1"]))
    .reduce((sum, w) => sum + w.probability, 0);
  assert.ok(Math.abs(after - directSum) < 1e-9);
});
