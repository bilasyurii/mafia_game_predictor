import { test } from "node:test";
import assert from "node:assert/strict";
import { GameConfig, RoleId, World } from "./types";
import { generateWorlds } from "./generateWorlds";
import { getProbability } from "./probability";
import { updateProbabilities } from "./updateProbabilities";
import { initAliveState } from "./facts";
import {
  createLikelihoodModel,
  EvidenceContext,
  ObservationHandlerMap,
} from "./evidence";
import { defaultRoleRegistry, validateGameConfig } from "./roles";
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

function notExercised(): never {
  throw new Error("handler not exercised in this synthetic test");
}

/**
 * Purely synthetic likelihood, chosen only to exercise the Bayesian math in
 * updateProbabilities() - NOT a behavioral claim about how honest players
 * are. Real calibration is a separate, later step.
 */
const syntheticSelfClaimHandlers: ObservationHandlerMap = {
  selfRoleClaim(observation, world) {
    return observation.claim.kind === "role" &&
      world.roles[observation.actor] === observation.claim.role
      ? 0.9
      : 0.1;
  },
  roleAssertion: notExercised,
  investigationReport: notExercised,
  candidateVote: notExercised,
  keepOrEliminateVote: notExercised,
  suspect: notExercised,
  defend: notExercised,
  nominate: notExercised,
};

function sumProbabilities(worlds: World[]): number {
  return worlds.reduce((sum, w) => sum + w.probability, 0);
}

test("generateWorlds produces no duplicate role assignments", () => {
  const worlds = generateWorlds(game);
  const seen = new Set(
    worlds.map((w) =>
      JSON.stringify(game.players.map((p) => w.roles[p]))
    )
  );
  assert.equal(seen.size, worlds.length);
});

test("prior P(1 = commissioner) is 12.5%", () => {
  validateGameConfig(game, defaultRoleRegistry);
  const worlds = generateWorlds(game);
  const prior = getProbability(worlds, "1", "commissioner");
  assert.ok(Math.abs(prior - 0.125) < 1e-9, `prior was ${prior}`);
});

test("Bayesian update: synthetic 0.9/0.1 selfRoleClaim moves 12.5% -> 56.25%", () => {
  const worlds = generateWorlds(game);
  const ctx = makeCtx();
  const model = createLikelihoodModel(syntheticSelfClaimHandlers);

  const posteriorWorlds = updateProbabilities(
    worlds,
    {
      type: "selfRoleClaim",
      round: 1,
      actor: "1",
      claim: { kind: "role", role: "commissioner" },
    },
    model,
    ctx
  );

  const posterior = getProbability(posteriorWorlds, "1", "commissioner");
  assert.ok(Math.abs(posterior - 0.5625) < 1e-9, `posterior was ${posterior}`);
});

test("posterior probabilities sum to 1 and are all non-negative", () => {
  const worlds = generateWorlds(game);
  const ctx = makeCtx();
  const model = createLikelihoodModel(syntheticSelfClaimHandlers);

  const posteriorWorlds = updateProbabilities(
    worlds,
    {
      type: "selfRoleClaim",
      round: 1,
      actor: "1",
      claim: { kind: "role", role: "commissioner" },
    },
    model,
    ctx
  );

  const total = sumProbabilities(posteriorWorlds);
  assert.ok(Math.abs(total - 1) < 1e-9, `total was ${total}`);
  assert.ok(posteriorWorlds.every((w) => w.probability >= 0));
});

test("posterior contains no duplicate role assignments", () => {
  const worlds = generateWorlds(game);
  const ctx = makeCtx();
  const model = createLikelihoodModel(syntheticSelfClaimHandlers);

  const posteriorWorlds = updateProbabilities(
    worlds,
    {
      type: "selfRoleClaim",
      round: 1,
      actor: "1",
      claim: { kind: "role", role: "commissioner" },
    },
    model,
    ctx
  );

  const seen = new Set(
    posteriorWorlds.map((w) =>
      JSON.stringify(game.players.map((p) => w.roles[p]))
    )
  );
  assert.equal(seen.size, posteriorWorlds.length);
});

test("marginal probability over all roles for player 1 sums to 1 after update", () => {
  const worlds = generateWorlds(game);
  const ctx = makeCtx();
  const model = createLikelihoodModel(syntheticSelfClaimHandlers);

  const posteriorWorlds = updateProbabilities(
    worlds,
    {
      type: "selfRoleClaim",
      round: 1,
      actor: "1",
      claim: { kind: "role", role: "commissioner" },
    },
    model,
    ctx
  );

  const marginalSum = ALL_ROLES.reduce(
    (sum, role) => sum + getProbability(posteriorWorlds, "1", role),
    0
  );
  assert.ok(Math.abs(marginalSum - 1) < 1e-9, `marginal sum was ${marginalSum}`);
});

test("sanity: uniform likelihood leaves the posterior identical to the prior", () => {
  const worlds = generateWorlds(game);
  const ctx = makeCtx();

  const uniformHandlers: ObservationHandlerMap = {
    selfRoleClaim: () => 1,
    roleAssertion: notExercised,
    investigationReport: notExercised,
    candidateVote: notExercised,
    keepOrEliminateVote: notExercised,
    suspect: notExercised,
    defend: notExercised,
    nominate: notExercised,
  };
  const model = createLikelihoodModel(uniformHandlers);

  const posteriorWorlds = updateProbabilities(
    worlds,
    {
      type: "selfRoleClaim",
      round: 1,
      actor: "1",
      claim: { kind: "role", role: "commissioner" },
    },
    model,
    ctx
  );

  worlds.forEach((prior, i) => {
    assert.ok(
      Math.abs(prior.probability - posteriorWorlds[i].probability) < 1e-12
    );
  });
});

test("sanity: scaling every world's likelihood by the same nonzero constant leaves the posterior unchanged", () => {
  const worlds = generateWorlds(game);
  const ctx = makeCtx();

  // generalizes the constant-1 case above to a non-1 constant, so this
  // actually proves cancellation happens via normalization (dividing by
  // the total), not because 1 is treated as a special no-op value - this
  // is exactly what makes DayEliminationFact's constant-1 contribution,
  // and any other world-independent likelihood, provably a no-op
  // regardless of which constant it happens to be.
  const scaledHandlers: ObservationHandlerMap = {
    selfRoleClaim: () => 7,
    roleAssertion: notExercised,
    investigationReport: notExercised,
    candidateVote: notExercised,
    keepOrEliminateVote: notExercised,
    suspect: notExercised,
    defend: notExercised,
    nominate: notExercised,
  };
  const model = createLikelihoodModel(scaledHandlers);

  const posteriorWorlds = updateProbabilities(
    worlds,
    {
      type: "selfRoleClaim",
      round: 1,
      actor: "1",
      claim: { kind: "role", role: "commissioner" },
    },
    model,
    ctx
  );

  worlds.forEach((prior, i) => {
    assert.ok(
      Math.abs(prior.probability - posteriorWorlds[i].probability) < 1e-12
    );
  });
});

test("repeated identical evidence compounds odds multiplicatively, as conditional independence given the world implies", () => {
  const worlds = generateWorlds(game);
  const ctx = makeCtx();
  const model = createLikelihoodModel(syntheticSelfClaimHandlers);
  const claim = {
    type: "selfRoleClaim" as const,
    round: 1,
    actor: "1",
    claim: { kind: "role" as const, role: "commissioner" as const },
  };

  const once = updateProbabilities(worlds, claim, model, ctx);
  const twice = updateProbabilities(once, claim, model, ctx);

  const oddsOf = (p: number) => p / (1 - p);
  const pOnce = getProbability(once, "1", "commissioner");
  const pTwice = getProbability(twice, "1", "commissioner");

  // the current model treats sequential evidence as independent factors
  // given the world (see updateProbabilities.ts's doc and this session's
  // model-coherence audit) - so a second, identical observation must move
  // the ODDS by exactly the same multiplicative factor (the likelihood
  // ratio) as the first one did, not some smaller "diminishing returns"
  // amount - there is no actor-repetition memory anywhere in this model.
  const likelihoodRatio = oddsOf(pOnce) / oddsOf(0.125);
  const expectedOddsTwice = oddsOf(pOnce) * likelihoodRatio;
  const expectedPTwice = expectedOddsTwice / (1 + expectedOddsTwice);

  assert.ok(
    Math.abs(pTwice - expectedPTwice) < 1e-9,
    `pTwice=${pTwice}, expected=${expectedPTwice}`
  );
  // concretely, for this handler's 0.9/0.1 ratio from a 1/8 prior: 81/88
  assert.ok(Math.abs(pTwice - 81 / 88) < 1e-9, `pTwice=${pTwice}`);
});

test("sanity: a 1/0 hard-split likelihood fully filters out the excluded worlds", () => {
  const worlds = generateWorlds(game);
  const ctx = makeCtx();

  const hardSplitHandlers: ObservationHandlerMap = {
    selfRoleClaim(observation, world) {
      return observation.claim.kind === "role" &&
        world.roles[observation.actor] === observation.claim.role
        ? 1
        : 0;
    },
    roleAssertion: notExercised,
    investigationReport: notExercised,
    candidateVote: notExercised,
    keepOrEliminateVote: notExercised,
    suspect: notExercised,
    defend: notExercised,
    nominate: notExercised,
  };
  const model = createLikelihoodModel(hardSplitHandlers);

  const posteriorWorlds = updateProbabilities(
    worlds,
    {
      type: "selfRoleClaim",
      round: 1,
      actor: "1",
      claim: { kind: "role", role: "commissioner" },
    },
    model,
    ctx
  );

  const survivingCount = posteriorWorlds.filter(
    (w) => w.roles["1"] === "commissioner"
  ).length;
  posteriorWorlds.forEach((w) => {
    if (w.roles["1"] === "commissioner") {
      // all surviving worlds shared equal prior, so after renormalizing
      // among just the survivors they're still equal, at 1/survivingCount
      assert.ok(Math.abs(w.probability - 1 / survivingCount) < 1e-9);
    } else {
      assert.equal(w.probability, 0);
    }
  });
  assert.ok(
    Math.abs(getProbability(posteriorWorlds, "1", "commissioner") - 1) < 1e-9
  );
});
