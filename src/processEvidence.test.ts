import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CandidateVote,
  GameConfig,
  RoleAssertion,
  SelfRoleClaim,
  World,
} from "./types";
import { NightResultFact } from "./night";
import { createLikelihoodModel, Evidence, EvidenceContext, LikelihoodModel } from "./evidence";
import { DayEliminationFact } from "./facts";
import { generateWorlds } from "./generateWorlds";
import { getProbability } from "./probability";
import { updateProbabilities } from "./updateProbabilities";
import { createHandlers } from "./likelihoodHandlers";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { GameSetting, processEvidence } from "./processEvidence";

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

const setting: GameSetting = {
  config: game,
  roles: defaultRoleRegistry,
  groups: defaultGroupRegistry,
};

const claim = (round: number, actor: string): SelfRoleClaim => ({
  type: "selfRoleClaim",
  round,
  actor,
  claim: { kind: "role", role: "commissioner" },
});
const night = (round: number, died: string[]): NightResultFact => ({ type: "nightResult", round, died });
const day = (round: number, eliminated: string[]): DayEliminationFact => ({
  type: "dayElimination",
  round,
  eliminated,
});
const vote = (round: number, candidate: string, voters: string[]): CandidateVote => ({
  type: "candidateVote",
  round,
  stage: "initial",
  candidates: [candidate],
  handsRaised: { [candidate]: voters },
});

/**
 * By the end of this log "2", "3", "5" and "8" are dead. An earlier item
 * given today's alive state, or the full log, fails the assertions below.
 */
const log: Evidence[] = [
  claim(0, "1"), //                 0  day 0
  night(1, ["8"]), //               1  night 1
  claim(1, "2"), //                 2  day 1 speech
  vote(1, "3", ["2", "5"]), //      3  day 1 vote
  day(1, ["3"]), //                 4  end of day 1
  claim(1, "3"), //                 5  day 1 last words
  night(2, ["5"]), //               6  night 2
  { type: "roleAssertion", round: 2, actor: "4", target: "2", claim: { kind: "group", group: "mafia" } }, // 7 day 2 speech
  vote(2, "2", ["4", "6"]), //      8  day 2 vote
  day(2, ["2"]), //                 9  end of day 2
];

/** Expected dead players at each item's phase start. */
const EXPECTED_DEAD: string[][] = [
  [], //             0  day 0
  [], //             1  start of night 1
  ["8"], //          2  day 1
  ["8"], //          3
  ["8"], //          4  day 1 elimination sees day 1's state, not its own
  ["8"], //          5
  ["3", "8"], //     6  start of night 2
  ["3", "5", "8"], // 7  day 2
  ["3", "5", "8"], // 8
  ["3", "5", "8"], // 9
];

/**
 * Test double, not a behavioral model: records the context each item was
 * scored with and returns the same likelihood (1) for every world, so the
 * posterior is unchanged. It exists only so facts and votes - whose real
 * handlers are intentionally not implemented - can pass through the loop.
 */
function recordingModel(): { model: LikelihoodModel; calls: { evidence: Evidence; ctx: EvidenceContext }[] } {
  const calls: { evidence: Evidence; ctx: EvidenceContext }[] = [];
  const model: LikelihoodModel = {
    likelihood(evidence, _world, ctx) {
      if (calls.length === 0 || calls[calls.length - 1].evidence !== evidence) {
        calls.push({ evidence, ctx });
      }
      return 1;
    },
  };
  return { model, calls };
}

function dead(alive: Record<string, boolean>): string[] {
  return Object.keys(alive).filter((p) => !alive[p]);
}

function runRecorded() {
  const { model, calls } = recordingModel();
  const steps = processEvidence(generateWorlds(game), log, model, setting);
  return { steps, calls };
}

// --- no future information in ctx.history ---

test("each item is scored with exactly the evidence recorded before it", () => {
  const { steps, calls } = runRecorded();
  assert.equal(calls.length, log.length);
  log.forEach((evidence, i) => {
    assert.equal(calls[i].evidence, evidence);
    assert.equal(calls[i].ctx, steps[i].context); // the step reports the context the model actually saw
    assert.equal(calls[i].ctx.history.length, i);
    calls[i].ctx.history.forEach((item, j) => assert.equal(item, log[j]));
  });
});

test("a day-1 claim sees only earlier evidence - not itself or anything after", () => {
  const { history } = runRecorded().calls[2].ctx;
  assert.deepEqual(history, [log[0], log[1]]);
  assert.ok(!history.includes(log[2]));
});

test("a day-1 claim cannot see the later same-day vote or elimination", () => {
  const { history } = runRecorded().calls[2].ctx;
  assert.ok(!history.includes(log[3]));
  assert.ok(!history.includes(log[4]));
});

test("last words can see the earlier vote and the day elimination", () => {
  const { history } = runRecorded().calls[5].ctx;
  assert.ok(history.includes(log[3]));
  assert.ok(history.includes(log[4]));
  assert.ok(!history.includes(log[6]));
});

test("a day-2 observation cannot see day-2 events recorded after it", () => {
  const { history } = runRecorded().calls[7].ctx;
  assert.ok(!history.includes(log[8]));
  assert.ok(!history.includes(log[9]));
});

test("a day-2 observation sees the completed day-1 and night-2 facts before it", () => {
  const { history } = runRecorded().calls[7].ctx;
  assert.ok(history.includes(log[4])); // day 1 elimination
  assert.ok(history.includes(log[6])); // night 2 result
});

// --- ctx.alive at each item's own phase ---

test("the alive state passed with each item is the state at that item's phase, never the final one", () => {
  const { calls } = runRecorded();
  calls.forEach(({ ctx }, i) => {
    assert.deepEqual(dead(ctx.alive), EXPECTED_DEAD[i], `item ${i} (${log[i].type})`);
  });
});

test("a night result is scored with the alive state at the start of that night", () => {
  const { calls } = runRecorded();
  assert.deepEqual(dead(calls[1].ctx.alive), []); // night 1 excludes its own "8"
  assert.deepEqual(dead(calls[6].ctx.alive), ["3", "8"]); // night 2 excludes its own "5"
  assert.equal(calls[6].ctx.alive["5"], true);
});

test("a day elimination is scored with the alive state before that day's elimination", () => {
  const { calls } = runRecorded();
  assert.equal(calls[4].ctx.alive["3"], true);
  assert.equal(calls[9].ctx.alive["2"], true);
});

test("alive state comes from the prefix, so a malformed later fact cannot affect earlier items", () => {
  const { model, calls } = recordingModel();
  const malformed: Evidence[] = [
    night(1, ["8"]), //  0
    claim(1, "2"), //    1  replaying the full log from here would already throw
    day(1, []), //       2
    day(1, ["4"]), //    3  a second day-1 elimination: invalid
    claim(1, "5"), //    4  the first item whose prefix contains both
  ];
  assert.throws(
    () => processEvidence(generateWorlds(game), malformed, model, setting),
    /more than one dayElimination fact for round 1/
  );
  // items 0-3 were scored normally; item 1 saw only night 1's real death
  assert.equal(calls.length, 4);
  assert.deepEqual(dead(calls[1].ctx.alive), ["8"]);
});

// --- Bayesian chaining with the implemented handlers ---

const assertion: RoleAssertion = {
  type: "roleAssertion",
  round: 1,
  actor: "4",
  target: "2",
  claim: { kind: "group", group: "mafia" },
};
const speechLog: Evidence[] = [claim(0, "1"), claim(1, "2"), assertion];

function realModel(): LikelihoodModel {
  // the existing deterministic truthful/false parameter form
  return createLikelihoodModel(
    createHandlers({ truthful: 0.9, false: 0.1 }, { truthful: 0.8, false: 0.2 })
  );
}

test("each item's posterior is the next item's prior", () => {
  const steps = processEvidence(generateWorlds(game), speechLog, realModel(), setting);
  assert.equal(steps.length, speechLog.length);
  for (let i = 0; i + 1 < steps.length; i++) {
    assert.equal(steps[i + 1].prior, steps[i].posterior);
  }
  // and the first update really moved the posterior
  assert.ok(Math.abs(getProbability(steps[0].posterior, "1", "commissioner") - 0.5625) < 1e-9);
});

test("the processor gives the same posteriors as calling updateProbabilities by hand", () => {
  const worlds = generateWorlds(game);
  const model = realModel();
  const steps = processEvidence(worlds, speechLog, model, setting);

  let expected: World[] = worlds;
  speechLog.forEach((evidence, i) => {
    const ctx: EvidenceContext = {
      ...setting,
      alive: steps[i].context.alive,
      history: speechLog.slice(0, i),
    };
    expected = updateProbabilities(expected, evidence, model, ctx);
    assert.deepEqual(steps[i].posterior, expected, `step ${i}`);
    const total = steps[i].posterior.reduce((sum, w) => sum + w.probability, 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
  });
});

test("a handler that is not implemented yet throws through the processor instead of being skipped", () => {
  const worlds = generateWorlds(game);
  assert.throws(
    () => processEvidence(worlds, [claim(0, "1"), night(1, ["8"])], realModel(), setting),
    /nightResult likelihood not implemented yet/
  );
  assert.throws(
    () => processEvidence(worlds, [claim(1, "1"), day(1, [])], realModel(), setting),
    /dayElimination likelihood not implemented yet/
  );
  assert.throws(
    () => processEvidence(worlds, [vote(1, "3", ["2"])], realModel(), setting),
    /candidateVote likelihood not calibrated yet/
  );
});

test("an empty log produces no steps", () => {
  assert.deepEqual(processEvidence(generateWorlds(game), [], realModel(), setting), []);
});

// --- no mutation ---

test("the input history, prior worlds, setting and earlier contexts are not mutated", () => {
  const worlds = generateWorlds(game);
  const snapshot = JSON.stringify({ log, worlds, setting });
  const { model } = recordingModel();

  const steps = processEvidence(worlds, log, model, setting);

  assert.equal(JSON.stringify({ log, worlds, setting }), snapshot);
  assert.equal(steps[0].prior, worlds);
  assert.notEqual(steps[3].context.history, log); // a prefix copy, never the log itself

  // changing one step's context doesn't reach the log or other steps
  steps[3].context.history.push(log[9]);
  steps[3].context.alive["1"] = false;
  assert.equal(log.length, 10);
  assert.equal(steps[4].context.history.length, 4);
  assert.equal(steps[4].context.alive["1"], true);
});
