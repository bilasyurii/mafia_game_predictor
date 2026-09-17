import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AliveState,
  CandidateVote,
  GameConfig,
  KeepOrEliminateVote,
  World,
} from "./types";
import { DayEliminationFact } from "./facts";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { EvidenceContext, createLikelihoodModel } from "./evidence";
import { createHandlers } from "./likelihoodHandlers";
import { resolveDayElimination } from "./dayEliminationLikelihood";
import { NightResultFact } from "./night";
import { GameSetting, processEvidence } from "./processEvidence";
import { generateWorlds } from "./generateWorlds";
import { createNightResultHandler } from "./nightResultLikelihood";
import { createUniformActionModel } from "./uniformActionModel";

const fourPlayerConfig: GameConfig = {
  players: ["1", "2", "3", "4"],
  roles: ["mafia", "doctor", "commissioner", "citizen"],
};
const fourPlayerAlive: AliveState = { "1": true, "2": true, "3": true, "4": true };
const someWorld: World = {
  probability: 1,
  roles: { "1": "mafia", "2": "doctor", "3": "commissioner", "4": "citizen" },
};

function makeCtx(overrides: Partial<EvidenceContext> = {}): EvidenceContext {
  return {
    config: fourPlayerConfig,
    roles: defaultRoleRegistry,
    groups: defaultGroupRegistry,
    alive: fourPlayerAlive,
    history: [],
    ...overrides,
  };
}

function day(round: number, eliminated: string[]): DayEliminationFact {
  return { type: "dayElimination", round, eliminated };
}

/**
 * candidates ["3","4"]: "1","2","3" raise hands for "3" (voted = {1,2,3});
 * the only non-voter is "4" itself, whose abstention goes to the last
 * candidate ("4") per voting.ts's rule - "3" ends with 3, "4" with 1, a
 * clean unique winner (not a tie).
 */
const uniqueWinnerVote: CandidateVote = {
  type: "candidateVote",
  round: 1,
  stage: "initial",
  candidates: ["3", "4"],
  handsRaised: { "3": ["1", "2", "3"], "4": [] },
};

// --- unique winner ---

test("a CandidateVote with a unique winner validates a matching DayEliminationFact with likelihood 1", () => {
  const ctx = makeCtx({ history: [uniqueWinnerVote] });

  const result = resolveDayElimination(day(1, ["3"]), someWorld, ctx);
  assert.equal(result, 1);
});

// --- tie -> revote -> tie again -> final KeepOrEliminateVote ---

test("a tie, revote tie, then a decisive KeepOrEliminateVote validates the full eliminate-all outcome", () => {
  const initialVote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "initial",
    candidates: ["3", "4"],
    handsRaised: { "3": ["1", "2"], "4": ["3", "4"] }, // 2 vs 2, no abstainers -> tie
  };
  const revote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "revote",
    candidates: ["3", "4"],
    handsRaised: { "3": ["1", "3"], "4": ["2", "4"] }, // 2 vs 2 again -> tie
  };
  const keepOrEliminate: KeepOrEliminateVote = {
    type: "keepOrEliminateVote",
    round: 1,
    candidates: ["3", "4"],
    eliminateHands: ["1", "2", "3"], // 3 eliminate vs 1 keep -> eliminateAll
  };
  const ctx = makeCtx({ history: [initialVote, revote, keepOrEliminate] });

  const result = resolveDayElimination(day(1, ["3", "4"]), someWorld, ctx);
  assert.equal(result, 1);

  // order-independent
  const reordered = resolveDayElimination(day(1, ["4", "3"]), someWorld, ctx);
  assert.equal(reordered, 1);
});

// --- kept-all outcome -> empty eliminated list ---

test("a KeepOrEliminateVote resolving to keepAll validates an empty eliminated list", () => {
  const initialVote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "initial",
    candidates: ["3", "4"],
    handsRaised: { "3": ["1", "2"], "4": ["3", "4"] }, // tie
  };
  const keepOrEliminate: KeepOrEliminateVote = {
    type: "keepOrEliminateVote",
    round: 1,
    candidates: ["3", "4"],
    eliminateHands: ["1"], // 1 eliminate vs 3 keep -> keepAll
  };
  const ctx = makeCtx({ history: [initialVote, keepOrEliminate] });

  const result = resolveDayElimination(day(1, []), someWorld, ctx);
  assert.equal(result, 1);
});

// --- inconsistent elimination -> throw ---

test("an elimination that does not match the resolved vote throws", () => {
  const ctx = makeCtx({ history: [uniqueWinnerVote] });

  // the vote resolves to "3", not "4"
  assert.throws(
    () => resolveDayElimination(day(1, ["4"]), someWorld, ctx),
    /is inconsistent with its resolved vote/
  );
});

test("a tie with no revote or keep-or-eliminate vote to resolve it throws", () => {
  const vote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "initial",
    candidates: ["3", "4"],
    handsRaised: { "3": ["1", "2"], "4": ["3", "4"] },
  };
  const ctx = makeCtx({ history: [vote] });

  assert.throws(
    () => resolveDayElimination(day(1, ["3"]), someWorld, ctx),
    /ended in a tie/
  );
});

test("a DayEliminationFact with no preceding vote evidence for that round throws", () => {
  const ctx = makeCtx({ history: [] });
  assert.throws(
    () => resolveDayElimination(day(1, ["3"]), someWorld, ctx),
    /has no preceding candidateVote or keepOrEliminateVote/
  );
});

// --- likelihood is world-independent ---

test("a consistent DayEliminationFact contributes exactly 1 regardless of which world is passed", () => {
  const ctx = makeCtx({ history: [uniqueWinnerVote] });
  const fact = day(1, ["3"]);

  const worldA: World = { probability: 0.3, roles: { "1": "mafia", "2": "doctor", "3": "commissioner", "4": "citizen" } };
  const worldB: World = { probability: 0.7, roles: { "1": "citizen", "2": "mafia", "3": "doctor", "4": "commissioner" } };

  assert.equal(resolveDayElimination(fact, worldA, ctx), 1);
  assert.equal(resolveDayElimination(fact, worldB, ctx), 1);
});

// --- integration through processEvidence: night + day + night ---

test("a night + day (unique winner) + night sequence processes end to end with an unchanged posterior at the day-elimination step", () => {
  const setting: GameSetting = {
    config: fourPlayerConfig,
    roles: defaultRoleRegistry,
    groups: defaultGroupRegistry,
  };
  const model = createLikelihoodModel(
    createHandlers(
      { truthful: 0.9, false: 0.1 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { sameTeamVote: 0.5, differentTeamVote: 0.5, abstain: 0.5 }
    ),
    createNightResultHandler(createUniformActionModel(defaultRoleRegistry))
  );

  const nightOne: NightResultFact = { type: "nightResult", round: 1, died: [] };
  const elimination = day(1, ["3"]);
  const nightTwo: NightResultFact = { type: "nightResult", round: 2, died: [] };

  const worlds = generateWorlds(fourPlayerConfig);
  const log = [nightOne, uniqueWinnerVote, elimination, nightTwo];
  const steps = processEvidence(worlds, log, model, setting);

  assert.equal(steps.length, log.length);
  steps.forEach((step) => {
    const total = step.posterior.reduce((sum, w) => sum + w.probability, 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
    assert.ok(step.posterior.every((w) => w.probability >= 0));
  });

  // the elimination step (index 2) must leave the posterior unchanged from
  // the vote step (index 1) - likelihood 1 for every world. Compared with a
  // floating-point tolerance rather than strict deep-equality: multiplying
  // by 1 and renormalizing is a no-op mathematically, but not necessarily
  // bit-for-bit identical.
  assert.equal(steps[2].posterior.length, steps[1].posterior.length);
  steps[2].posterior.forEach((world, i) => {
    assert.deepEqual(world.roles, steps[1].posterior[i].roles);
    assert.ok(
      Math.abs(world.probability - steps[1].posterior[i].probability) < 1e-12,
      `world ${i}: ${world.probability} vs ${steps[1].posterior[i].probability}`
    );
  });
});
