import { test } from "node:test";
import assert from "node:assert/strict";
import { GameEvent } from "../types";
import { AFFINITY_WEIGHTS, ROUND_DECAY, affinityBetween, computeAffinityMatrix } from "./affinity";

const players = ["1", "2", "3", "4", "5"];

test("defend is a direct, symmetric cooperation signal", () => {
  const events: GameEvent[] = [{ type: "defend", round: 0, actor: "1", target: "2" }];
  const matrix = computeAffinityMatrix(players, events);
  assert.equal(affinityBetween(matrix, "1", "2"), AFFINITY_WEIGHTS.defend);
  assert.equal(affinityBetween(matrix, "2", "1"), AFFINITY_WEIGHTS.defend);
  assert.equal(affinityBetween(matrix, "1", "3"), 0);
});

test("suspect and nominate are direct, symmetric opposition signals", () => {
  const events: GameEvent[] = [
    { type: "suspect", round: 0, actor: "1", target: "2" },
    { type: "nominate", round: 0, actor: "3", target: "4" },
  ];
  const matrix = computeAffinityMatrix(players, events);
  assert.equal(affinityBetween(matrix, "1", "2"), AFFINITY_WEIGHTS.directOpposition);
  assert.equal(affinityBetween(matrix, "2", "1"), AFFINITY_WEIGHTS.directOpposition);
  assert.equal(affinityBetween(matrix, "3", "4"), AFFINITY_WEIGHTS.directOpposition);
});

test("raising a hand for a candidate is an opposition signal toward that candidate", () => {
  const events: GameEvent[] = [
    { type: "candidateVote", round: 0, stage: "initial", candidates: ["3"], handsRaised: { "3": ["1"] } },
  ];
  const matrix = computeAffinityMatrix(players, events);
  assert.equal(affinityBetween(matrix, "1", "3"), AFFINITY_WEIGHTS.directOpposition);
});

test("two players voting for the SAME candidate get a cooperation bonus with each other, not with the candidate beyond the direct opposition", () => {
  const events: GameEvent[] = [
    { type: "candidateVote", round: 0, stage: "initial", candidates: ["3"], handsRaised: { "3": ["1", "2"] } },
  ];
  const matrix = computeAffinityMatrix(players, events);
  assert.equal(affinityBetween(matrix, "1", "2"), AFFINITY_WEIGHTS.sharedTarget);
  assert.equal(affinityBetween(matrix, "1", "3"), AFFINITY_WEIGHTS.directOpposition);
  assert.equal(affinityBetween(matrix, "2", "3"), AFFINITY_WEIGHTS.directOpposition);
});

test("two players suspecting the SAME third player get a cooperation bonus, even across different action types (suspect + vote)", () => {
  const events: GameEvent[] = [
    { type: "suspect", round: 0, actor: "1", target: "5" },
    { type: "candidateVote", round: 0, stage: "initial", candidates: ["5"], handsRaised: { "5": ["2"] } },
  ];
  const matrix = computeAffinityMatrix(players, events);
  assert.equal(affinityBetween(matrix, "1", "2"), AFFINITY_WEIGHTS.sharedTarget);
});

test("keepOrEliminateVote eliminate-hands are opposition signals toward every listed candidate", () => {
  const events: GameEvent[] = [
    { type: "keepOrEliminateVote", round: 0, candidates: ["3", "4"], eliminateHands: ["1"] },
  ];
  const matrix = computeAffinityMatrix(players, events);
  assert.equal(affinityBetween(matrix, "1", "3"), AFFINITY_WEIGHTS.directOpposition);
  assert.equal(affinityBetween(matrix, "1", "4"), AFFINITY_WEIGHTS.directOpposition);
});

test("claims and death facts never move the score", () => {
  const events: GameEvent[] = [
    { type: "selfRoleClaim", round: 0, actor: "1", claim: { kind: "role", role: "citizen" } },
    { type: "roleAssertion", round: 0, actor: "1", target: "2", claim: { kind: "role", role: "mafia" } },
    { type: "investigationReport", round: 0, actor: "1", target: "2", mechanic: "checkIsMafia", result: true },
    { type: "nightResult", round: 1, died: ["2"] },
    { type: "dayElimination", round: 0, eliminated: ["3"] },
  ];
  const matrix = computeAffinityMatrix(players, events);
  players.forEach((a) => players.forEach((b) => assert.equal(affinityBetween(matrix, a, b), 0)));
});

test("signals accumulate across multiple events in the SAME round between the same pair", () => {
  const events: GameEvent[] = [
    { type: "defend", round: 0, actor: "1", target: "2" },
    { type: "defend", round: 0, actor: "2", target: "1" },
  ];
  const matrix = computeAffinityMatrix(players, events);
  assert.equal(affinityBetween(matrix, "1", "2"), AFFINITY_WEIGHTS.defend * 2);
});

test("a near-unanimous shared target dilutes the per-pair cooperation bonus instead of handing every pair the full weight", () => {
  // 6 players all vote for the same candidate in one round - a real
  // near-unanimous elimination vote, which is weak evidence of
  // coordination (everyone does this regardless of team) and must not
  // bump every pair by the FULL sharedTarget weight.
  const events: GameEvent[] = [
    { type: "candidateVote", round: 0, stage: "initial", candidates: ["6"], handsRaised: { "6": ["1", "2", "3", "4", "5"] } },
  ];
  const matrix = computeAffinityMatrix([...players, "6"], events);
  const bonus = affinityBetween(matrix, "1", "2");
  assert.ok(bonus > 0, "still a positive signal");
  assert.ok(bonus < AFFINITY_WEIGHTS.sharedTarget, "but far less than the full per-pair weight a 2-person coincidence would get");
  // the total credit handed out for this one target+round group is fixed,
  // however many pairs it gets split across (5 voters -> 10 pairs).
  assert.equal(bonus, AFFINITY_WEIGHTS.sharedTarget / 10);
});

test("REGRESSION: a single late-game near-unanimous vote must not erase earlier, more selective cooperation signals between two specific players", () => {
  // Rounds 0-1: players 1 and 2 repeatedly, selectively suspect/nominate
  // the same targets together while nobody else does - strong, genuine
  // signal they are coordinating. Round 2: EVERYONE (including 1, 2, 3, 4)
  // piles onto one obviously-losing candidate in a near-unanimous vote.
  const events: GameEvent[] = [
    { type: "suspect", round: 0, actor: "1", target: "6" },
    { type: "suspect", round: 0, actor: "2", target: "6" },
    { type: "nominate", round: 1, actor: "1", target: "7" },
    { type: "nominate", round: 1, actor: "2", target: "7" },
    { type: "candidateVote", round: 2, stage: "initial", candidates: ["6"], handsRaised: { "6": ["1", "2", "3", "4", "5"] } },
  ];
  const allPlayers = [...players, "6", "7"];
  const matrix = computeAffinityMatrix(allPlayers, events);

  const coordinatedPair = affinityBetween(matrix, "1", "2"); // real prior history AND the unanimous vote
  const coincidentalPair = affinityBetween(matrix, "3", "4"); // ONLY the unanimous vote, no prior history

  assert.ok(coordinatedPair > 0);
  assert.ok(
    coordinatedPair > coincidentalPair,
    "a pair with genuine prior coordination must still clearly outrank a pair that only coincided in the closing unanimous vote - the vote must not flatten everyone to the same score"
  );
});

test("two players who targeted the same eventual player in UNRELATED rounds do not get pooled into one coordinated group", () => {
  const events: GameEvent[] = [
    { type: "suspect", round: 0, actor: "1", target: "5" },
    { type: "suspect", round: 3, actor: "2", target: "5" }, // same target, much later round - unrelated
  ];
  const matrix = computeAffinityMatrix(players, events);
  assert.equal(affinityBetween(matrix, "1", "2"), 0, "different rounds targeting the same eventual player is not itself a cooperation signal");
});

test("a relationship decays as later rounds pass, even when the later events don't involve the same pair", () => {
  const freshOnly: GameEvent[] = [{ type: "defend", round: 0, actor: "1", target: "2" }];
  const sameDefendButFiveRoundsOld: GameEvent[] = [
    { type: "defend", round: 0, actor: "1", target: "2" },
    { type: "suspect", round: 5, actor: "3", target: "4" }, // unrelated pair, just advances "now"
  ];
  const freshScore = affinityBetween(computeAffinityMatrix(players, freshOnly), "1", "2");
  const decayedScore = affinityBetween(computeAffinityMatrix(players, sameDefendButFiveRoundsOld), "1", "2");

  assert.equal(freshScore, AFFINITY_WEIGHTS.defend, "no decay when it's still the most recent round");
  assert.ok(decayedScore > 0, "an old signal is weakened, not erased");
  assert.ok(decayedScore < freshScore, "5 rounds later, the same defend counts for less");
  assert.equal(decayedScore, AFFINITY_WEIGHTS.defend * Math.pow(ROUND_DECAY, 5));
});

test("changing one's mind (suspecting someone, then later defending them) blends the two signals, weighted toward the more recent one, instead of fully replacing or ignoring the earlier one", () => {
  const events: GameEvent[] = [
    { type: "suspect", round: 0, actor: "3", target: "5" },
    { type: "defend", round: 4, actor: "3", target: "5" },
  ];
  const score = affinityBetween(computeAffinityMatrix(players, events), "3", "5");

  const cleanDefendOnly = affinityBetween(computeAffinityMatrix(players, [{ type: "defend", round: 4, actor: "3", target: "5" }]), "3", "5");

  assert.ok(score > 0, "the more recent defend dominates the net relationship");
  assert.ok(score < cleanDefendOnly, "but the earlier suspicion still pulls it down somewhat, rather than being fully erased");
});

test("intensity scales a direct suspect/defend/nominate bump linearly around the 3-star default", () => {
  const normal = affinityBetween(computeAffinityMatrix(players, [{ type: "suspect", round: 0, actor: "1", target: "2" }]), "1", "2");
  const noIntensitySpecified = affinityBetween(
    computeAffinityMatrix(players, [{ type: "suspect", round: 0, actor: "1", target: "2", intensity: 3 }]),
    "1",
    "2"
  );
  const barelyThere = affinityBetween(
    computeAffinityMatrix(players, [{ type: "suspect", round: 0, actor: "1", target: "2", intensity: 1 }]),
    "1",
    "2"
  );
  const certain = affinityBetween(
    computeAffinityMatrix(players, [{ type: "suspect", round: 0, actor: "1", target: "2", intensity: 5 }]),
    "1",
    "2"
  );

  assert.equal(normal, AFFINITY_WEIGHTS.directOpposition, "omitted intensity behaves exactly like the 3-star default");
  assert.equal(noIntensitySpecified, AFFINITY_WEIGHTS.directOpposition);
  assert.equal(barelyThere, (AFFINITY_WEIGHTS.directOpposition * 1) / 3);
  assert.equal(certain, (AFFINITY_WEIGHTS.directOpposition * 5) / 3);
  assert.ok(Math.abs(barelyThere) < Math.abs(normal), "a 1-star suspicion moves the score far less than a normal one");
  assert.ok(Math.abs(certain) > Math.abs(normal), "a 5-star suspicion moves the score more than a normal one");
});

test("REGRESSION: a low-intensity suspicion no longer forces two players onto opposite sides the way a full-strength one would", () => {
  // The exact reported scenario: 5 suspects 3 but only says "a little bit"
  // (1 star) - the resulting opposition should be weak enough that a
  // separate, stronger cooperation signal elsewhere (e.g. shared defends)
  // can still keep them read as compatible, instead of the mere existence
  // of a suspicion action permanently splitting them.
  const fullStrength = affinityBetween(
    computeAffinityMatrix(players, [{ type: "suspect", round: 0, actor: "5", target: "3" }]),
    "5",
    "3"
  );
  const slightFeeling = affinityBetween(
    computeAffinityMatrix(players, [{ type: "suspect", round: 0, actor: "5", target: "3", intensity: 1 }]),
    "5",
    "3"
  );
  assert.ok(slightFeeling > fullStrength, "less negative (weaker opposition) than an unqualified suspicion");
  assert.ok(Math.abs(slightFeeling) < Math.abs(AFFINITY_WEIGHTS.defend), "weak enough to be outweighed by even a single normal-strength cooperation signal elsewhere");
});

test("self-affinity is always 0 and never computed", () => {
  const events: GameEvent[] = [{ type: "suspect", round: 0, actor: "1", target: "1" }];
  const matrix = computeAffinityMatrix(players, events);
  assert.equal(affinityBetween(matrix, "1", "1"), 0);
});
