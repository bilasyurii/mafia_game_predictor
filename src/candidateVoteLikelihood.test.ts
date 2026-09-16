import { test } from "node:test";
import assert from "node:assert/strict";
import { CandidateVote, GameConfig, World } from "./types";
import { generateWorlds } from "./generateWorlds";
import { updateProbabilities } from "./updateProbabilities";
import { initAliveState, markDead } from "./facts";
import { createLikelihoodModel, EvidenceContext } from "./evidence";
import { createHandlers } from "./likelihoodHandlers";
import { createCandidateVoteHandler } from "./candidateVoteLikelihood";
import { resolveCandidateVote } from "./voting";
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
    "1": "don",
    "2": "mafia",
    "3": "doctor",
    "4": "commissioner",
    "5": "citizen",
    "6": "citizen",
    "7": "citizen",
    "8": "citizen",
  },
};

// Synthetic test data only - not a calibration claim about real players.
const params = { sameTeamVote: 0.6, differentTeamVote: 0.3, abstain: 0.1 };

function vote(
  candidates: string[],
  handsRaised: CandidateVote["handsRaised"]
): CandidateVote {
  return { type: "candidateVote", round: 1, stage: "initial", candidates, handsRaised };
}

test("sameTeamVote branch: a voter raises a hand for a candidate on their own team", () => {
  const handler = createCandidateVoteHandler(params);
  // "1" (don) votes for "2" (mafia) - same team; everyone else abstains
  const observation = vote(["2"], { "2": ["1"] });
  const result = handler(observation, world, makeCtx());

  // 7 other living players all abstain, including candidate "2" itself,
  // who never raised its own hand
  const expected = params.sameTeamVote * params.abstain ** 7;
  assert.ok(Math.abs(result - expected) < 1e-12, `got ${result}, expected ${expected}`);
});

test("differentTeamVote branch: a voter raises a hand for a candidate on a different team", () => {
  const handler = createCandidateVoteHandler(params);
  // "1" (don, mafia team) votes for "4" (commissioner, town team)
  const observation = vote(["4"], { "4": ["1"] });
  const result = handler(observation, world, makeCtx());

  const expected = params.differentTeamVote * params.abstain ** 7;
  assert.ok(Math.abs(result - expected) < 1e-12, `got ${result}, expected ${expected}`);
});

test("abstain branch and multiple voters: the likelihood is the product of every living voter's own factor", () => {
  const handler = createCandidateVoteHandler(params);
  // "1" (don/mafia) -> "2" (mafia): same team
  // "3" (doctor/town) -> "5" (citizen/town): same team
  // "4" (commissioner/town) -> "5" (citizen/town): same team
  // remaining living players ("2", "5", "6", "7", "8") abstain
  const observation = vote(["2", "5"], { "2": ["1"], "5": ["3", "4"] });
  const result = handler(observation, world, makeCtx());

  const expected = params.sameTeamVote ** 3 * params.abstain ** 5;
  assert.ok(Math.abs(result - expected) < 1e-12, `got ${result}, expected ${expected}`);
});

test("mixed same-team and different-team votes multiply correctly", () => {
  const handler = createCandidateVoteHandler(params);
  // "1" (don/mafia) -> "2" (mafia): same team
  // "3" (doctor/town) -> "2" (mafia): different team
  const observation = vote(["2"], { "2": ["1", "3"] });
  const result = handler(observation, world, makeCtx());

  // "2" itself never raised its own hand, so it's also an abstainer
  const expected =
    params.sameTeamVote * params.differentTeamVote * params.abstain ** 6;
  assert.ok(Math.abs(result - expected) < 1e-12, `got ${result}, expected ${expected}`);
});

test("dead players are neither voters nor abstainers - only living voters contribute a factor", () => {
  const handler = createCandidateVoteHandler(params);
  const alive = markDead(initAliveState(game), "8");
  const observation = vote(["2"], { "2": ["1"] });
  const result = handler(observation, world, makeCtx({ alive }));

  // 7 living players total: 1 raised a hand, 6 others (not 7) abstain
  const expected = params.sameTeamVote * params.abstain ** 6;
  assert.ok(Math.abs(result - expected) < 1e-12, `got ${result}, expected ${expected}`);
});

test("function-valued params receive the full (observation, world, ctx) triple", () => {
  let seen: { observation?: CandidateVote; world?: World; ctx?: EvidenceContext } = {};
  const handler = createCandidateVoteHandler({
    sameTeamVote: (observation, w, ctx) => {
      seen = { observation, world: w, ctx };
      return 0.5;
    },
    differentTeamVote: 0.2,
    abstain: 0.1,
  });

  const observation = vote(["2"], { "2": ["1"] });
  const ctx = makeCtx();
  handler(observation, world, ctx);

  assert.equal(seen.observation, observation);
  assert.equal(seen.world, world);
  assert.equal(seen.ctx, ctx);
});

test("validation propagates unchanged: a malformed vote throws the same error tallyCandidateVote would", () => {
  const handler = createCandidateVoteHandler(params);
  const alive = markDead(initAliveState(game), "5");
  // "5" is dead but raised a hand
  const observation = vote(["2"], { "2": ["5"] });

  assert.throws(
    () => handler(observation, world, makeCtx({ alive })),
    /voter "5" is not a living player/
  );
});

test("no winner/tie double-counting: reordering candidates (which flips the resolved winner via the abstention rule) does not change the likelihood", () => {
  const handler = createCandidateVoteHandler(params);
  const handsRaised: CandidateVote["handsRaised"] = { "2": ["1"], "5": ["3", "4"] };

  const orderA = vote(["2", "5"], handsRaised);
  const orderB = vote(["5", "2"], handsRaised);

  // sanity check: reordering really does flip who wins, via the
  // abstention-goes-to-the-last-candidate rule - otherwise this test
  // wouldn't be checking anything meaningful
  const outcomeA = resolveCandidateVote(orderA, initAliveState(game));
  const outcomeB = resolveCandidateVote(orderB, initAliveState(game));
  assert.equal(outcomeA.kind, "winner");
  assert.equal(outcomeB.kind, "winner");
  assert.notEqual(
    outcomeA.kind === "winner" && outcomeA.candidate,
    outcomeB.kind === "winner" && outcomeB.candidate
  );

  const resultA = handler(orderA, world, makeCtx());
  const resultB = handler(orderB, world, makeCtx());
  assert.ok(Math.abs(resultA - resultB) < 1e-12, `${resultA} !== ${resultB}`);
});

test("createHandlers only replaces candidateVote when its params are given, and keepOrEliminateVote stays uncalibrated", () => {
  const model = createLikelihoodModel(createHandlers({ truthful: 0.9, false: 0.1 }));
  const ctx = makeCtx();
  const cv = vote(["2"], { "2": ["1"] });
  const kv = { type: "keepOrEliminateVote" as const, round: 1, candidates: ["2", "5"], eliminateHands: ["1"] };

  assert.throws(() => model.likelihood(cv, world, ctx), /candidateVote likelihood not calibrated yet/);
  assert.throws(() => model.likelihood(kv, world, ctx), /keepOrEliminateVote likelihood not calibrated yet/);
});

test("end-to-end: a candidateVote drives a real, normalized Bayesian posterior", () => {
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
      params // candidateVote
    )
  );

  const observation = vote(["2", "5"], { "2": ["1"], "5": ["3", "4"] });
  const posteriorWorlds = updateProbabilities(worlds, observation, model, ctx);

  const total = posteriorWorlds.reduce((sum, w) => sum + w.probability, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `total was ${total}`);
  assert.ok(posteriorWorlds.every((w) => w.probability >= 0));

  const changed = posteriorWorlds.some(
    (w, i) => Math.abs(w.probability - worlds[i].probability) > 1e-12
  );
  assert.ok(changed, "the vote should have actually moved the posterior");
});
