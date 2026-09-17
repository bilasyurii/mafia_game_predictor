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

// this scenario also exercises the voting-chain validation below: the
// revote's candidates ([3,4]) match the initial tie, and the
// keepOrEliminateVote's candidates ([3,4]) match the revote's own tie
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
  // per rules.md, a KeepOrEliminateVote must be preceded by a tied revote,
  // not directly by the initial tie - see the voting-chain tests below
  const initialVote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "initial",
    candidates: ["3", "4"],
    handsRaised: { "3": ["1", "2"], "4": ["3", "4"] }, // tie
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
    eliminateHands: ["1"], // 1 eliminate vs 3 keep -> keepAll
  };
  const ctx = makeCtx({ history: [initialVote, revote, keepOrEliminate] });

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

// --- voting-chain consistency: a revote or KeepOrEliminateVote must
// legitimately follow the vote immediately before it in the same round ---

const initialTie: CandidateVote = {
  type: "candidateVote",
  round: 1,
  stage: "initial",
  candidates: ["3", "4"],
  handsRaised: { "3": ["1", "2"], "4": ["3", "4"] }, // 2 vs 2 -> tie
};

test("revote: a valid initial tie followed by a matching revote is accepted", () => {
  const revote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "revote",
    candidates: ["3", "4"],
    handsRaised: { "3": ["1", "2", "3"], "4": [] }, // "3" wins 3-1, unique
  };
  const ctx = makeCtx({ history: [initialTie, revote] });
  assert.equal(resolveDayElimination(day(1, ["3"]), someWorld, ctx), 1);
});

test("revote: a revote after an initial vote that had a unique winner is rejected", () => {
  const revote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "revote",
    candidates: ["3", "4"],
    handsRaised: { "3": ["1"], "4": ["2"] },
  };
  const ctx = makeCtx({ history: [uniqueWinnerVote, revote] });
  assert.throws(
    () => resolveDayElimination(day(1, ["3"]), someWorld, ctx),
    /must follow a tie, but its preceding initial vote had a unique winner/
  );
});

test("revote: a revote with a candidate set unrelated to the tie is rejected", () => {
  const revote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "revote",
    candidates: ["1", "2"],
    handsRaised: { "1": ["3"], "2": ["4"] },
  };
  const ctx = makeCtx({ history: [initialTie, revote] });
  assert.throws(
    () => resolveDayElimination(day(1, ["1"]), someWorld, ctx),
    /do not match the preceding tie/
  );
});

test("revote: a revote covering only a subset of a three-way tie is rejected", () => {
  // 4 living players can never split evenly 3 ways (4 is not divisible by
  // 3), so this test uses a 6-player alive state for a genuine 1-1-1-style
  // (here 2-2-2) three-way tie.
  const sixPlayerAlive: AliveState = {
    "1": true, "2": true, "3": true, "4": true, "5": true, "6": true,
  };
  const threeWayTie: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "initial",
    candidates: ["2", "3", "4"],
    // voted = {1,6,2,5,3}; abstainer "4" (itself) -> last candidate "4"
    // "2"=2 (1,6), "3"=2 (2,5), "4"=1(3)+1(abstain)=2 -> three-way tie
    handsRaised: { "2": ["1", "6"], "3": ["2", "5"], "4": ["3"] },
  };
  const revote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "revote",
    candidates: ["3", "4"], // missing "2"
    handsRaised: { "3": ["1"], "4": ["2"] },
  };
  const ctx = makeCtx({ history: [threeWayTie, revote], alive: sixPlayerAlive });
  assert.throws(
    () => resolveDayElimination(day(1, ["3"]), someWorld, ctx),
    /do not match the preceding tie/
  );
});

test("revote: a revote with an extra candidate beyond the tied set is rejected", () => {
  const revote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "revote",
    candidates: ["3", "4", "2"], // "2" was never tied
    handsRaised: { "3": ["1"], "4": ["2"], "2": ["3"] },
  };
  const ctx = makeCtx({ history: [initialTie, revote] });
  assert.throws(
    () => resolveDayElimination(day(1, ["3"]), someWorld, ctx),
    /do not match the preceding tie/
  );
});

test("revote: candidate ordering differs from the tie but the set is identical - accepted", () => {
  const revote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "revote",
    candidates: ["4", "3"], // reversed order from the tie's ["3","4"]
    handsRaised: { "3": ["1", "2", "3"], "4": [] },
  };
  const ctx = makeCtx({ history: [initialTie, revote] });
  assert.equal(resolveDayElimination(day(1, ["3"]), someWorld, ctx), 1);
});

// --- a round has exactly one voting chain: rules.md narrates the whole
// day's vote (initial, its optional revote, its optional final
// keep-or-eliminate) as a single event, with the next round beginning at
// night right after it - never a second, independent voting cycle ---

test("a second initial vote for the same round, with no preceding vote at all, is rejected", () => {
  const secondInitial: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "initial",
    candidates: ["1", "2"],
    handsRaised: { "1": ["3"], "2": ["4"] },
  };
  const ctx = makeCtx({ history: [initialTie, secondInitial] });
  assert.throws(
    () => resolveDayElimination(day(1, ["1"]), someWorld, ctx),
    /must be the first vote of its round/
  );
});

test("a second initial vote after a completed initial -> revote -> keepOrEliminate chain is rejected", () => {
  const revote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "revote",
    candidates: ["3", "4"],
    handsRaised: { "3": ["1", "2", "3"], "4": [] }, // "3" wins 3-1, unique
  };
  const secondInitial: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "initial",
    candidates: ["1", "2"],
    handsRaised: { "1": ["3"], "2": ["4"] },
  };
  const ctx = makeCtx({ history: [initialTie, revote, secondInitial] });
  assert.throws(
    () => resolveDayElimination(day(1, ["1"]), someWorld, ctx),
    /must be the first vote of its round/
  );
});

test("a second revote directly after the first revote (no keepOrEliminate in between) is rejected", () => {
  const firstRevote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "revote",
    candidates: ["3", "4"],
    handsRaised: { "3": ["1", "3"], "4": ["2", "4"] }, // 2 vs 2 -> tie again
  };
  const secondRevote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "revote",
    candidates: ["3", "4"],
    handsRaised: { "3": ["1", "2", "3"], "4": [] },
  };
  const ctx = makeCtx({ history: [initialTie, firstRevote, secondRevote] });
  assert.throws(
    () => resolveDayElimination(day(1, ["3"]), someWorld, ctx),
    /must immediately follow a initial candidateVote of the same round/
  );
});

test("a revote directly after a KeepOrEliminateVote is rejected", () => {
  const revote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "revote",
    candidates: ["3", "4"],
    handsRaised: { "3": ["1", "3"], "4": ["2", "4"] }, // 2 vs 2 -> tie
  };
  const keepOrEliminate: KeepOrEliminateVote = {
    type: "keepOrEliminateVote",
    round: 1,
    candidates: ["3", "4"],
    eliminateHands: ["1", "2", "3"],
  };
  const trailingRevote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "revote",
    candidates: ["3", "4"],
    handsRaised: { "3": ["1", "2", "3"], "4": [] },
  };
  const ctx = makeCtx({ history: [initialTie, revote, keepOrEliminate, trailingRevote] });
  assert.throws(
    () => resolveDayElimination(day(1, ["3", "4"]), someWorld, ctx),
    /must immediately follow a initial candidateVote of the same round/
  );
});

const revoteTie: CandidateVote = {
  type: "candidateVote",
  round: 1,
  stage: "revote",
  candidates: ["3", "4"],
  handsRaised: { "3": ["1", "3"], "4": ["2", "4"] }, // 2 vs 2 -> tie again
};

test("keepOrEliminateVote: directly following an initial tie without a revote is rejected", () => {
  const keepOrEliminate: KeepOrEliminateVote = {
    type: "keepOrEliminateVote",
    round: 1,
    candidates: ["3", "4"],
    eliminateHands: ["1"],
  };
  const ctx = makeCtx({ history: [initialTie, keepOrEliminate] });
  assert.throws(
    () => resolveDayElimination(day(1, []), someWorld, ctx),
    /must immediately follow a revote candidateVote/
  );
});

test("keepOrEliminateVote: following a revote that had a unique winner is rejected", () => {
  const revote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "revote",
    candidates: ["3", "4"],
    handsRaised: { "3": ["1", "2", "3"], "4": [] }, // "3" wins 3-1, unique
  };
  const keepOrEliminate: KeepOrEliminateVote = {
    type: "keepOrEliminateVote",
    round: 1,
    candidates: ["3", "4"],
    eliminateHands: ["1"],
  };
  const ctx = makeCtx({ history: [initialTie, revote, keepOrEliminate] });
  assert.throws(
    () => resolveDayElimination(day(1, []), someWorld, ctx),
    /must follow a tie, but its preceding revote vote had a unique winner/
  );
});

test("keepOrEliminateVote: a candidate set unrelated to the revote's tie is rejected", () => {
  const keepOrEliminate: KeepOrEliminateVote = {
    type: "keepOrEliminateVote",
    round: 1,
    candidates: ["1", "2"],
    eliminateHands: ["3"],
  };
  const ctx = makeCtx({ history: [initialTie, revoteTie, keepOrEliminate] });
  assert.throws(
    () => resolveDayElimination(day(1, []), someWorld, ctx),
    /do not match the preceding tie/
  );
});

test("keepOrEliminateVote: candidate ordering differs from the revote's tie but the set is identical - accepted", () => {
  const keepOrEliminate: KeepOrEliminateVote = {
    type: "keepOrEliminateVote",
    round: 1,
    candidates: ["4", "3"], // reversed order from the revote tie's ["3","4"]
    eliminateHands: ["1", "2", "3"], // 3 eliminate vs 1 keep -> eliminateAll
  };
  const ctx = makeCtx({ history: [initialTie, revoteTie, keepOrEliminate] });
  assert.equal(resolveDayElimination(day(1, ["3", "4"]), someWorld, ctx), 1);
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

test("a malformed voting sequence (KeepOrEliminateVote skipping the required revote) is rejected through the real processEvidence pipeline", () => {
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
      { sameTeamVote: 0.5, differentTeamVote: 0.5, abstain: 0.5 },
      {
        eliminateSharedTeam: 0.5,
        keepSharedTeam: 0.5,
        eliminateNoSharedTeam: 0.5,
        keepNoSharedTeam: 0.5,
      }
    )
  );

  const keepOrEliminate: KeepOrEliminateVote = {
    type: "keepOrEliminateVote",
    round: 1,
    candidates: ["3", "4"],
    eliminateHands: ["1"],
  };
  const log = [initialTie, keepOrEliminate, day(1, [])];

  assert.throws(
    () => processEvidence(generateWorlds(fourPlayerConfig), log, model, setting),
    /must immediately follow a revote candidateVote/
  );
});
