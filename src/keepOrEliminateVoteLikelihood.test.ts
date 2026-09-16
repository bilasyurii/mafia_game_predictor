import { test } from "node:test";
import assert from "node:assert/strict";
import { GameConfig, KeepOrEliminateVote, World } from "./types";
import { generateWorlds } from "./generateWorlds";
import { updateProbabilities } from "./updateProbabilities";
import { initAliveState, markDead } from "./facts";
import { createLikelihoodModel, EvidenceContext } from "./evidence";
import { createHandlers } from "./likelihoodHandlers";
import { createKeepOrEliminateVoteHandler } from "./keepOrEliminateVoteLikelihood";
import { resolveKeepOrEliminateVote } from "./voting";
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

function makeCtx(overrides: Partial<EvidenceContext> = {}): EvidenceContext {
  return {
    config: game,
    roles: defaultRoleRegistry,
    groups: defaultGroupRegistry,
    alive: initAliveState(game),
    history: [],
    ...overrides,
  };
}

const world: World = {
  probability: 1,
  roles: {
    "1": "don", // mafia team
    "2": "mafia", // mafia team
    "3": "doctor", // town team
    "4": "commissioner", // town team
    "5": "citizen", // town team
    "6": "citizen", // town team
    "7": "citizen", // town team
    "8": "citizen", // town team
  },
};

// Synthetic test data only - not a calibration claim about real players.
const params = {
  eliminateSharedTeam: 0.7,
  keepSharedTeam: 0.5,
  eliminateNoSharedTeam: 0.2,
  keepNoSharedTeam: 0.4,
};

function keepOrEliminate(
  candidates: string[],
  eliminateHands: string[]
): KeepOrEliminateVote {
  return { type: "keepOrEliminateVote", round: 1, candidates, eliminateHands };
}

function onlyAlive(...players: string[]) {
  let alive = initAliveState(game);
  game.players
    .filter((p) => !players.includes(p))
    .forEach((p) => {
      alive = markDead(alive, p);
    });
  return alive;
}

// candidates "5" and "6" are both town, so mafia voters ("1", "2") never
// share a team with them, while every town voter always does.
const townCandidates = ["5", "6"];

test("eliminateSharedTeam branch: a town voter raises an eliminate hand against a town candidate group", () => {
  const handler = createKeepOrEliminateVoteHandler(params);
  const alive = onlyAlive("5", "6", "3");
  const observation = keepOrEliminate(townCandidates, ["3"]);
  const result = handler(observation, world, makeCtx({ alive }));

  // "3" eliminates (sharedTeam); "5" and "6" don't vote -> keep (sharedTeam)
  const expected = params.eliminateSharedTeam * params.keepSharedTeam ** 2;
  assert.ok(Math.abs(result - expected) < 1e-12, `got ${result}, expected ${expected}`);
});

test("keepSharedTeam branch: a town voter does not raise a hand against a town candidate group", () => {
  const handler = createKeepOrEliminateVoteHandler(params);
  const alive = onlyAlive("5", "6", "3");
  const observation = keepOrEliminate(townCandidates, []); // nobody eliminates
  const result = handler(observation, world, makeCtx({ alive }));

  const expected = params.keepSharedTeam ** 3; // "3", "5", "6" all keep (sharedTeam)
  assert.ok(Math.abs(result - expected) < 1e-12, `got ${result}, expected ${expected}`);
});

test("eliminateNoSharedTeam branch: a mafia voter raises an eliminate hand against a town candidate group", () => {
  const handler = createKeepOrEliminateVoteHandler(params);
  const alive = onlyAlive("5", "6", "1");
  const observation = keepOrEliminate(townCandidates, ["1"]);
  const result = handler(observation, world, makeCtx({ alive }));

  // "1" (mafia) eliminates (noSharedTeam); "5", "6" don't vote -> keep (sharedTeam)
  const expected = params.eliminateNoSharedTeam * params.keepSharedTeam ** 2;
  assert.ok(Math.abs(result - expected) < 1e-12, `got ${result}, expected ${expected}`);
});

test("keepNoSharedTeam branch: a mafia voter does not raise a hand against a town candidate group", () => {
  const handler = createKeepOrEliminateVoteHandler(params);
  const alive = onlyAlive("5", "6", "1");
  const observation = keepOrEliminate(townCandidates, []);
  const result = handler(observation, world, makeCtx({ alive }));

  // "1" (mafia) keeps (noSharedTeam); "5", "6" keep (sharedTeam)
  const expected = params.keepNoSharedTeam * params.keepSharedTeam ** 2;
  assert.ok(Math.abs(result - expected) < 1e-12, `got ${result}, expected ${expected}`);
});

test("mixed candidate teams: ANY shared team (not ALL) determines the bucket", () => {
  const handler = createKeepOrEliminateVoteHandler(params);
  // candidates "1" (mafia) and "5" (town) - a mixed group
  const alive = onlyAlive("1", "2", "5");
  const observation = keepOrEliminate(["1", "5"], ["2"]);
  const result = handler(observation, world, makeCtx({ alive }));

  // "2" (mafia) shares a team with "1" only, NOT with "5" - under ALL this
  // would be noSharedTeam, but ANY means it's still sharedTeam
  // "1" and "5" don't vote -> each keeps, and each trivially shares a team
  // with itself, so both are sharedTeam too
  const expected = params.eliminateSharedTeam * params.keepSharedTeam ** 2;
  assert.ok(Math.abs(result - expected) < 1e-12, `got ${result}, expected ${expected}`);
});

test("mixed eliminate/keep voters across both teams multiply correctly", () => {
  const handler = createKeepOrEliminateVoteHandler(params);
  // all 8 players alive; candidates "5"/"6" are both town
  const observation = keepOrEliminate(townCandidates, ["1", "3"]);
  const result = handler(observation, world, makeCtx());

  // eliminate: "1" (mafia, noSharedTeam), "3" (town, sharedTeam)
  // keep: "2" (mafia, noSharedTeam), "4","5","6","7","8" (town, sharedTeam x5)
  const expected =
    params.eliminateNoSharedTeam *
    params.eliminateSharedTeam *
    params.keepNoSharedTeam *
    params.keepSharedTeam ** 5;
  assert.ok(Math.abs(result - expected) < 1e-12, `got ${result}, expected ${expected}`);
});

test("dead players contribute no factor at all - neither eliminate nor keep", () => {
  const handler = createKeepOrEliminateVoteHandler(params);
  const alive = markDead(initAliveState(game), "8");
  const observation = keepOrEliminate(townCandidates, ["1"]);
  const result = handler(observation, world, makeCtx({ alive }));

  // 7 living: "1" (mafia) eliminates; "2" (mafia) keeps; "3","4","5","6","7"
  // (town) keep - "8" is dead and contributes nothing
  const expected =
    params.eliminateNoSharedTeam * params.keepNoSharedTeam * params.keepSharedTeam ** 5;
  assert.ok(Math.abs(result - expected) < 1e-12, `got ${result}, expected ${expected}`);

  // sanity: this differs from the all-alive equivalent (which would have
  // one more keepSharedTeam factor for "8")
  const allAliveResult = handler(observation, world, makeCtx());
  assert.notEqual(result, allAliveResult);
});

test("function-valued params receive the full (observation, world, ctx) triple", () => {
  let seen: {
    observation?: KeepOrEliminateVote;
    world?: World;
    ctx?: EvidenceContext;
  } = {};
  const handler = createKeepOrEliminateVoteHandler({
    ...params,
    eliminateSharedTeam: (observation, w, ctx) => {
      seen = { observation, world: w, ctx };
      return 0.66;
    },
  });

  const alive = onlyAlive("5", "6", "3");
  const observation = keepOrEliminate(townCandidates, ["3"]);
  const ctx = makeCtx({ alive });
  handler(observation, world, ctx);

  assert.equal(seen.observation, observation);
  assert.equal(seen.world, world);
  assert.equal(seen.ctx, ctx);
});

test("validation propagates unchanged: a malformed vote throws the same error tallyKeepOrEliminateVote would", () => {
  const handler = createKeepOrEliminateVoteHandler(params);
  const alive = markDead(initAliveState(game), "5");
  // "5" is dead but raised an eliminate hand
  const observation = keepOrEliminate(["1", "2"], ["5"]);

  assert.throws(
    () => handler(observation, world, makeCtx({ alive })),
    /voter "5" is not a living player/
  );
});

test("no outcome-dependent double-counting: flipping the result via one voter's hand changes the likelihood by exactly that voter's own factor ratio", () => {
  const handler = createKeepOrEliminateVoteHandler(params);
  const alive = initAliveState(game); // all 8 alive

  // scenario A: 4 eliminate ("1","2","3","4"), 4 keep -> tie -> keepAll
  const scenarioA = keepOrEliminate(townCandidates, ["1", "2", "3", "4"]);
  // scenario B: same, but "5" (town) also switches from keep to eliminate -> eliminateAll
  const scenarioB = keepOrEliminate(townCandidates, ["1", "2", "3", "4", "5"]);

  const outcomeA = resolveKeepOrEliminateVote(scenarioA, alive);
  const outcomeB = resolveKeepOrEliminateVote(scenarioB, alive);
  assert.equal(outcomeA.kind, "keepAll");
  assert.equal(outcomeB.kind, "eliminateAll");

  const resultA = handler(scenarioA, world, makeCtx({ alive }));
  const resultB = handler(scenarioB, world, makeCtx({ alive }));

  // only "5"'s own factor changed, from keepSharedTeam to eliminateSharedTeam
  const expectedRatio = params.eliminateSharedTeam / params.keepSharedTeam;
  const actualRatio = resultB / resultA;
  assert.ok(
    Math.abs(actualRatio - expectedRatio) < 1e-9,
    `ratio was ${actualRatio}, expected ${expectedRatio}`
  );
});

test("createHandlers only replaces keepOrEliminateVote when its params are given", () => {
  const model = createLikelihoodModel(createHandlers({ truthful: 0.9, false: 0.1 }));
  const ctx = makeCtx();
  const observation = keepOrEliminate(townCandidates, ["1"]);

  assert.throws(
    () => model.likelihood(observation, world, ctx),
    /keepOrEliminateVote likelihood not calibrated yet/
  );
});

test("end-to-end: a keepOrEliminateVote drives a real, normalized Bayesian posterior", () => {
  const worlds = generateWorlds(game);
  const ctx = makeCtx();
  const model = createLikelihoodModel(
    createHandlers(
      { truthful: 0.9, false: 0.1 }, // selfRoleClaim - unused here
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      params // keepOrEliminateVote
    )
  );

  const observation = keepOrEliminate(townCandidates, ["1", "3"]);
  const posteriorWorlds = updateProbabilities(worlds, observation, model, ctx);

  const total = posteriorWorlds.reduce((sum, w) => sum + w.probability, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `total was ${total}`);
  assert.ok(posteriorWorlds.every((w) => w.probability >= 0));

  const changed = posteriorWorlds.some(
    (w, i) => Math.abs(w.probability - worlds[i].probability) > 1e-12
  );
  assert.ok(changed, "the vote should have actually moved the posterior");
});
