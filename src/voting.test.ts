import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AliveState,
  CandidateVote,
  GameConfig,
  KeepOrEliminateVote,
  PlayerId,
  RoleId,
  World,
} from "./types";
import {
  resolveCandidateVote,
  resolveKeepOrEliminateVote,
  tallyCandidateVote,
  tallyKeepOrEliminateVote,
  validateCandidateVote,
  validateKeepOrEliminateVote,
} from "./voting";
import { initAliveState, markDead } from "./facts";
import { generateWorlds } from "./generateWorlds";
import { createLikelihoodModel, EvidenceContext } from "./evidence";
import { createHandlers } from "./likelihoodHandlers";
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

const aliveAll: AliveState = initAliveState(game);

function candidateVote(
  candidates: PlayerId[],
  handsRaised: CandidateVote["handsRaised"],
  stage: CandidateVote["stage"] = "initial"
): CandidateVote {
  return { type: "candidateVote", round: 1, stage, candidates, handsRaised };
}

function keepOrEliminate(
  candidates: PlayerId[],
  eliminateHands: PlayerId[]
): KeepOrEliminateVote {
  return { type: "keepOrEliminateVote", round: 1, candidates, eliminateHands };
}

function counts(vote: CandidateVote, alive: AliveState = aliveAll): number[] {
  return tallyCandidateVote(vote, alive).candidates.map((c) => c.count);
}

// --- CandidateVote ---

test("normal vote with multiple candidates: raised hands kept as observed, abstainers counted separately", () => {
  const vote = candidateVote(["3", "6"], { "3": ["1", "2", "4"], "6": ["5"] });
  const tally = tallyCandidateVote(vote, aliveAll);

  assert.deepEqual(tally.abstainers, ["3", "6", "7", "8"]);
  assert.deepEqual(tally.candidates, [
    { candidate: "3", raisedHands: ["1", "2", "4"], abstentionVotes: [], count: 3 },
    { candidate: "6", raisedHands: ["5"], abstentionVotes: ["3", "6", "7", "8"], count: 5 },
  ]);
  assert.deepEqual(resolveCandidateVote(vote, aliveAll), { kind: "winner", candidate: "6" });
});

test("4 / 3 / 1 -> the candidate with 4 is eliminated", () => {
  const vote = candidateVote(["1", "2", "3"], {
    "1": ["2", "3", "4", "5"],
    "2": ["6", "7", "8"],
  }); // "1" abstains -> last candidate "3"
  assert.deepEqual(counts(vote), [4, 3, 1]);
  assert.deepEqual(resolveCandidateVote(vote, aliveAll), { kind: "winner", candidate: "1" });
});

test("3 / 2 / 2 / 1 -> the candidate with 3 is eliminated without a majority", () => {
  const vote = candidateVote(["1", "2", "3", "4"], {
    "1": ["5", "6", "7"],
    "2": ["8", "1"],
    "3": ["2", "3"],
  }); // "4" abstains -> last candidate "4"
  assert.deepEqual(counts(vote), [3, 2, 2, 1]);
  assert.deepEqual(resolveCandidateVote(vote, aliveAll), { kind: "winner", candidate: "1" });
});

test("3 / 3 / 2 -> tie between the two candidates with 3", () => {
  const vote = candidateVote(["1", "2", "3"], {
    "1": ["4", "5", "6"],
    "2": ["7", "8", "1"],
    "3": ["2"],
  }); // "3" abstains -> last candidate "3"
  assert.deepEqual(counts(vote), [3, 3, 2]);
  assert.deepEqual(resolveCandidateVote(vote, aliveAll), { kind: "tie", candidates: ["1", "2"] });
});

test("2 / 2 / 2 -> all three candidates tie", () => {
  const alive = markDead(markDead(aliveAll, "7"), "8");
  const vote = candidateVote(["1", "2", "3"], {
    "1": ["4", "5"],
    "2": ["6", "1"],
    "3": ["2"],
  }); // "3" abstains -> last candidate "3"
  assert.deepEqual(counts(vote, alive), [2, 2, 2]);
  assert.deepEqual(resolveCandidateVote(vote, alive), {
    kind: "tie",
    candidates: ["1", "2", "3"],
  });
});

test("abstention goes to the last candidate called, by call order not player id", () => {
  const vote = candidateVote(["5", "2"], { "5": ["1"] });
  const tally = tallyCandidateVote(vote, aliveAll);
  assert.deepEqual(tally.candidates[0].abstentionVotes, []);
  assert.deepEqual(tally.candidates[1].abstentionVotes, ["2", "3", "4", "5", "6", "7", "8"]);
  assert.deepEqual(counts(vote), [1, 7]);
});

test("a voter who already voted gets no second vote: not counted again as an abstainer, and a repeated hand is rejected", () => {
  // "4" raised a hand for the first candidate, so the abstention rule must
  // not also hand their vote to the last one
  const tally = tallyCandidateVote(candidateVote(["1", "2"], { "1": ["4"] }), aliveAll);
  assert.ok(!tally.abstainers.includes("4"));
  assert.deepEqual(counts(candidateVote(["1", "2"], { "1": ["4"] })), [1, 7]);

  assert.throws(
    () => validateCandidateVote(candidateVote(["1", "2"], { "1": ["4", "4"] }), aliveAll),
    /"4" raised a hand more than once/
  );
});

test("the same voter appearing under two candidates is rejected", () => {
  const vote = candidateVote(["1", "2"], { "1": ["4"], "2": ["4"] });
  assert.throws(() => validateCandidateVote(vote, aliveAll), /"4" raised a hand more than once/);
  assert.throws(() => resolveCandidateVote(vote, aliveAll), /"4" raised a hand more than once/);
});

test("hands raised for someone who is not a listed candidate are rejected", () => {
  const vote = candidateVote(["1", "2"], { "1": ["4"], "7": ["5"] });
  assert.throws(() => validateCandidateVote(vote, aliveAll), /"7", who is not a candidate/);
});

test("a dead voter is rejected", () => {
  const alive = markDead(aliveAll, "5");
  const vote = candidateVote(["1", "2"], { "1": ["5"] });
  assert.throws(() => validateCandidateVote(vote, alive), /voter "5" is not a living player/);
});

test("a dead player is neither a voter nor an abstainer", () => {
  const alive = markDead(aliveAll, "7");
  const vote = candidateVote(["1", "2"], { "1": ["3", "4"] });
  const tally = tallyCandidateVote(vote, alive);

  assert.ok(!tally.abstainers.includes("7"));
  const total = tally.candidates.reduce((sum, c) => sum + c.count, 0);
  assert.equal(total, 7); // only the 7 living players' votes
});

test("candidates must be living and listed once", () => {
  assert.throws(
    () => validateCandidateVote(candidateVote(["1", "2"], {}), markDead(aliveAll, "2")),
    /candidate "2" is not a living player/
  );
  assert.throws(
    () => validateCandidateVote(candidateVote(["1", "1"], {}), aliveAll),
    /candidate "1" is listed more than once/
  );
});

test("a single candidate is voted on normally", () => {
  const vote = candidateVote(["3"], { "3": ["1", "2"] });
  const tally = tallyCandidateVote(vote, aliveAll);
  assert.deepEqual(tally.candidates[0].raisedHands, ["1", "2"]);
  assert.deepEqual(tally.candidates[0].abstentionVotes, ["3", "4", "5", "6", "7", "8"]);
  assert.deepEqual(resolveCandidateVote(vote, aliveAll), { kind: "winner", candidate: "3" });
});

test("initial vote and revote are distinguishable separate voting rounds", () => {
  const initial = candidateVote(["1", "2", "3"], { "1": ["4", "5", "6"], "2": ["7", "8", "1"], "3": ["2"] });
  const outcome = resolveCandidateVote(initial, aliveAll);
  assert.equal(outcome.kind, "tie");

  // revote among the tied candidates, in nomination order; players who voted
  // in the initial vote vote again, since it is a new voting round
  const revote = candidateVote(
    outcome.kind === "tie" ? outcome.candidates : [],
    { "1": ["4", "5", "6"], "2": ["7", "8"] },
    "revote"
  );
  assert.notEqual(initial.stage, revote.stage);
  // abstainers "1", "2", "3" go to "2", the last tied candidate in nomination order
  assert.deepEqual(counts(revote), [3, 5]);
  assert.deepEqual(resolveCandidateVote(revote, aliveAll), { kind: "winner", candidate: "2" });

  // a revote only follows a tie, so it needs at least two candidates
  assert.throws(
    () => validateCandidateVote(candidateVote(["1"], {}, "revote"), aliveAll),
    /at least 2 candidate/
  );
});

// --- KeepOrEliminateVote ---

test("eliminate has more votes -> eliminate all", () => {
  const vote = keepOrEliminate(["1", "2"], ["3", "4", "5", "6", "7"]);
  assert.deepEqual(tallyKeepOrEliminateVote(vote, aliveAll), {
    eliminate: ["3", "4", "5", "6", "7"],
    keep: ["1", "2", "8"],
  });
  assert.deepEqual(resolveKeepOrEliminateVote(vote, aliveAll), {
    kind: "eliminateAll",
    candidates: ["1", "2"],
  });
});

test("keep has more votes -> keep all", () => {
  const vote = keepOrEliminate(["1", "2"], ["3", "4"]);
  assert.equal(resolveKeepOrEliminateVote(vote, aliveAll).kind, "keepAll");
});

test("eliminate/keep tie -> keep all", () => {
  const vote = keepOrEliminate(["1", "2"], ["3", "4", "5", "6"]);
  const tally = tallyKeepOrEliminateVote(vote, aliveAll);
  assert.equal(tally.eliminate.length, tally.keep.length);
  assert.equal(resolveKeepOrEliminateVote(vote, aliveAll).kind, "keepAll");
});

test("keepOrEliminate: a dead voter is rejected, and dead players are not counted as keep", () => {
  const alive = markDead(aliveAll, "8");
  assert.throws(
    () => validateKeepOrEliminateVote(keepOrEliminate(["1", "2"], ["8"]), alive),
    /voter "8" is not a living player/
  );
  assert.throws(
    () => validateKeepOrEliminateVote(keepOrEliminate(["1", "2"], ["3", "3"]), alive),
    /"3" raised a hand more than once/
  );

  // 4 eliminate vs 3 keep among 7 living: would be a 4/4 keep-all tie if
  // dead "8" were counted as keep
  const vote = keepOrEliminate(["1", "2"], ["3", "4", "5", "6"]);
  assert.deepEqual(tallyKeepOrEliminateVote(vote, alive).keep, ["1", "2", "7"]);
  assert.equal(resolveKeepOrEliminateVote(vote, alive).kind, "eliminateAll");
});

test("keepOrEliminate: the tied candidate list is preserved", () => {
  const vote = keepOrEliminate(["6", "2", "4"], []);
  const outcome = resolveKeepOrEliminateVote(vote, aliveAll);
  assert.deepEqual(outcome.candidates, ["6", "2", "4"]);
  assert.notEqual(outcome.candidates, vote.candidates); // a copy, not the observation's own array
  assert.throws(
    () => validateKeepOrEliminateVote(keepOrEliminate(["6"], []), aliveAll),
    /at least 2 candidate/
  );
});

// --- architecture ---

const ROLE_IDS: RoleId[] = ["don", "mafia", "doctor", "commissioner", "citizen"];

test("raw vote observations hold only public facts - no role truth, no inferred abstention votes", () => {
  const cv = candidateVote(["1", "2"], { "1": ["3", "4"] });
  const kv = keepOrEliminate(["1", "2"], ["3"]);

  assert.deepEqual(Object.keys(cv).sort(), ["candidates", "handsRaised", "round", "stage", "type"]);
  assert.deepEqual(Object.keys(kv).sort(), ["candidates", "eliminateHands", "round", "type"]);

  const serialized = JSON.stringify([cv, kv, tallyCandidateVote(cv, aliveAll), tallyKeepOrEliminateVote(kv, aliveAll)]);
  ROLE_IDS.forEach((role) => assert.ok(!serialized.includes(`"${role}"`), `found role "${role}"`));
});

test("voting helpers never mutate the observation or the alive state", () => {
  const cv = candidateVote(["1", "2"], { "1": ["3", "4"] });
  const kv = keepOrEliminate(["1", "2"], ["3", "4", "5", "6", "7"]);
  const alive = markDead(aliveAll, "8");
  const snapshot = JSON.stringify([cv, kv, alive]);

  resolveCandidateVote(cv, alive);
  resolveKeepOrEliminateVote(kv, alive);

  assert.equal(JSON.stringify([cv, kv, alive]), snapshot);
  assert.equal(cv.handsRaised["2"], undefined); // abstentions were not written back
});

test("vote likelihoods stay uncalibrated in every world - no coefficient is returned", () => {
  const model = createLikelihoodModel(createHandlers({ truthful: 0.5, false: 0.5 }));
  const ctx: EvidenceContext = {
    config: game,
    roles: defaultRoleRegistry,
    groups: defaultGroupRegistry,
    alive: aliveAll,
    history: [],
  };
  const worlds: World[] = generateWorlds(game).slice(0, 50);
  const cv = candidateVote(["1", "2"], { "1": ["3", "4"] });
  const kv = keepOrEliminate(["1", "2"], ["3"]);

  worlds.forEach((world) => {
    assert.throws(() => model.likelihood(cv, world, ctx), /candidateVote likelihood not calibrated yet/);
    assert.throws(() => model.likelihood(kv, world, ctx), /keepOrEliminateVote likelihood not calibrated yet/);
  });
});
