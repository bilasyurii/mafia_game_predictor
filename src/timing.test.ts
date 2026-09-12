import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CandidateVote,
  DefendAction,
  GameConfig,
  InvestigationReport,
  NominateAction,
  RoleAssertion,
  SelfRoleClaim,
  SuspectAction,
} from "./types";
import { NightResultFact } from "./night";
import { Evidence } from "./evidence";
import {
  DayEliminationFact,
  getAliveStateAt,
  getAliveStateForEvidence,
  getHistoryBefore,
  getPhaseOf,
} from "./facts";

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

const claim = (round: number, actor: string): SelfRoleClaim => ({
  type: "selfRoleClaim",
  round,
  actor,
  claim: { kind: "group", group: "town" },
});

const report = (round: number, night?: number): InvestigationReport => ({
  type: "investigationReport",
  round,
  actor: "4",
  target: "2",
  mechanic: "checkIsMafia",
  result: true,
  ...(night === undefined ? {} : { night }),
});

const night = (round: number, died: string[]): NightResultFact => ({
  type: "nightResult",
  round,
  died,
});

const day = (round: number, eliminated: string[]): DayEliminationFact => ({
  type: "dayElimination",
  round,
  eliminated,
});

/** One sample per evidence type - the mapped type makes a missing one a compile error. */
const samples: { [T in Evidence["type"]]: Extract<Evidence, { type: T }> } = {
  selfRoleClaim: claim(1, "1"),
  roleAssertion: { type: "roleAssertion", round: 1, actor: "1", target: "2", claim: { kind: "role", role: "doctor" } },
  investigationReport: report(1),
  candidateVote: { type: "candidateVote", round: 1, stage: "initial", candidates: ["3"], handsRaised: {} },
  keepOrEliminateVote: { type: "keepOrEliminateVote", round: 1, candidates: ["3", "4"], eliminateHands: [] },
  suspect: { type: "suspect", round: 1, actor: "1", target: "2" },
  defend: { type: "defend", round: 1, actor: "1", target: "2" },
  nominate: { type: "nominate", round: 1, actor: "1", target: "2" },
  nightResult: night(1, []),
  dayElimination: day(1, []),
};

/**
 * A recorded public log, in the order the observer saw it:
 * day 0 speech, night 1, day 1 speeches + vote + elimination + last words,
 * night 2, day 2 report.
 */
const vote: CandidateVote = {
  type: "candidateVote",
  round: 1,
  stage: "initial",
  candidates: ["3"],
  handsRaised: { "3": ["2", "5"] },
};
const suspect: SuspectAction = { type: "suspect", round: 1, actor: "2", target: "3" };
const nominate: NominateAction = { type: "nominate", round: 1, actor: "2", target: "3" };
const defend: DefendAction = { type: "defend", round: 1, actor: "4", target: "3" };
const lastWords = claim(1, "3");
const dayTwoReport = report(2, 1);
const assertion: RoleAssertion = { type: "roleAssertion", round: 2, actor: "6", target: "2", claim: { kind: "group", group: "mafia" } };

const log: Evidence[] = [
  claim(0, "1"), //    0  day 0
  night(1, ["8"]), //  1  night 1
  suspect, //          2  day 1
  nominate, //         3  day 1
  defend, //           4  day 1
  vote, //             5  day 1
  day(1, ["3"]), //    6  end of day 1
  lastWords, //        7  day 1, after the elimination
  night(2, ["5"]), //  8  night 2
  dayTwoReport, //     9  day 2, about night 1
  assertion, //       10  day 2
];

function dead(state: Record<string, boolean>): string[] {
  return Object.keys(state).filter((p) => !state[p]);
}

// --- round validation ---

test("day 0 speech is valid - it happens before the first night", () => {
  assert.deepEqual(getPhaseOf(claim(0, "1")), { phase: "day", round: 0 });
});

test("day 1 speech of every daytime observation type is valid", () => {
  const daytime: Evidence[] = [
    samples.selfRoleClaim,
    samples.roleAssertion,
    samples.investigationReport,
    samples.suspect,
    samples.defend,
    samples.nominate,
  ];
  daytime.forEach((evidence) => {
    assert.deepEqual(getPhaseOf(evidence), { phase: "day", round: 1 }, evidence.type);
  });
});

test("negative or non-integer rounds are rejected, and a night round must be at least 1", () => {
  [-1, 1.5, Number.NaN].forEach((round) => {
    Object.values(samples)
      .filter((evidence) => evidence.type !== "nightResult")
      .forEach((evidence) => {
        assert.throws(() => getPhaseOf({ ...evidence, round } as Evidence), /invalid day round/, evidence.type);
      });
  });
  assert.throws(() => getPhaseOf(night(0, [])), /invalid night round 0/);
  assert.throws(() => getPhaseOf(night(-2, [])), /invalid night round -2/);
});

// --- InvestigationReport night ---

test("an InvestigationReport can refer to an earlier night than the day it was said on", () => {
  const r = report(4, 2);
  assert.deepEqual(getPhaseOf(r), { phase: "day", round: 4 }); // when it was said
  assert.equal(r.night, 2); // which check it is about
});

test("an InvestigationReport without a night is valid and the night stays unknown", () => {
  const r = report(3);
  assert.deepEqual(getPhaseOf(r), { phase: "day", round: 3 });
  assert.equal("night" in r, false);
  assert.equal(r.night, undefined);
});

test("an explicit investigation night of 0 is rejected", () => {
  assert.throws(() => getPhaseOf(report(2, 0)), /invalid investigationReport night 0 for a report on day 2/);
});

test("an explicit investigation night later than the report day is rejected", () => {
  assert.throws(() => getPhaseOf(report(2, 3)), /invalid investigationReport night 3 for a report on day 2/);
  assert.throws(() => getPhaseOf(report(0, 1)), /invalid investigationReport night 1 for a report on day 0/);
  assert.throws(() => getPhaseOf(report(3, 1.5)), /invalid investigationReport night 1.5/);
  assert.deepEqual(getPhaseOf(report(2, 2)), { phase: "day", round: 2 }); // last night is allowed when stated
});

// --- getPhaseOf ---

test("getPhaseOf classifies every evidence type, and no evidence type is untimed", () => {
  const expected: { [T in Evidence["type"]]: "night" | "day" } = {
    selfRoleClaim: "day",
    roleAssertion: "day",
    investigationReport: "day",
    candidateVote: "day",
    keepOrEliminateVote: "day",
    suspect: "day",
    defend: "day",
    nominate: "day",
    nightResult: "night",
    dayElimination: "day",
  };
  (Object.keys(samples) as Evidence["type"][]).forEach((type) => {
    assert.equal(typeof samples[type].round, "number", type);
    assert.deepEqual(getPhaseOf(samples[type]), { phase: expected[type], round: 1 }, type);
  });
});

// --- getAliveStateForEvidence ---

test("daytime evidence gets the start-of-day state: that night's deaths, not that day's elimination", () => {
  const state = getAliveStateForEvidence(game, log, suspect);
  assert.deepEqual(dead(state), ["8"]);
  assert.deepEqual(state, getAliveStateAt(game, log, { phase: "day", round: 1 }));
});

test("a NightResultFact gets the start-of-night state", () => {
  const state = getAliveStateForEvidence(game, log, log[8]);
  assert.deepEqual(dead(state), ["3", "8"]); // night 1 death and day 1 elimination, not its own "5"
  assert.deepEqual(state, getAliveStateAt(game, log, { phase: "night", round: 2 }));
});

test("a day elimination does not affect the alive state of evidence from earlier that day", () => {
  [defend, vote].forEach((evidence) => {
    assert.equal(getAliveStateForEvidence(game, log, evidence)["3"], true, evidence.type);
  });
  // even with the full log, which extends past the elimination and later deaths
  assert.deepEqual(
    getAliveStateForEvidence(game, log, vote),
    getAliveStateForEvidence(game, getHistoryBefore(log, 5), vote)
  );
  // last words come after the elimination but still within day 1
  assert.equal(getAliveStateForEvidence(game, log, lastWords)["3"], true);
});

test("a night result does not affect its own start-of-night state", () => {
  const state = getAliveStateForEvidence(game, log, log[1]);
  assert.equal(state["8"], true);
  assert.deepEqual(dead(state), []);
});

test("a day 2 report is scored with day 2's state, whatever night it refers to", () => {
  assert.deepEqual(dead(getAliveStateForEvidence(game, log, dayTwoReport)), ["3", "5", "8"]);
});

// --- getHistoryBefore ---

test("getHistoryBefore excludes the current evidence and everything after it", () => {
  const before = getHistoryBefore(log, 5);
  assert.deepEqual(before, log.slice(0, 5));
  assert.ok(!before.includes(log[5]));
  assert.ok(!before.includes(log[6]));
  assert.deepEqual(getHistoryBefore(log, 0), []);
  assert.throws(() => getHistoryBefore(log, log.length), /history index 11 is out of range/);
  assert.throws(() => getHistoryBefore(log, -1), /out of range/);
});

test("earlier same-day evidence cannot see that day's later votes or elimination", () => {
  [2, 3, 4].forEach((index) => {
    const types = getHistoryBefore(log, index).map((e) => e.type);
    assert.ok(!types.includes("candidateVote"), `index ${index}`);
    assert.ok(!types.includes("dayElimination"), `index ${index}`);
  });
  // the defense sees the nomination before it, but not the vote after it
  assert.ok(getHistoryBefore(log, 4).includes(nominate));
  assert.ok(!getHistoryBefore(log, 4).includes(vote));
});

test("later same-day evidence sees the earlier same-day events", () => {
  const beforeLastWords = getHistoryBefore(log, 7);
  assert.ok(beforeLastWords.includes(vote));
  assert.ok(beforeLastWords.includes(log[6])); // the elimination
  assert.ok(!beforeLastWords.includes(log[8])); // but not the following night
});

test("equal-valued or repeated evidence objects are told apart by position, not identity lookup", () => {
  const a: SuspectAction = { type: "suspect", round: 1, actor: "2", target: "3" };
  const b: SuspectAction = { type: "suspect", round: 1, actor: "2", target: "3" }; // same value as a
  const history: Evidence[] = [a, vote, b, a]; // a is also recorded twice

  assert.deepEqual(getHistoryBefore(history, 0), []);
  assert.equal(getHistoryBefore(history, 2).length, 2);
  assert.equal(getHistoryBefore(history, 3).length, 3);
  assert.equal(getHistoryBefore(history, 3)[2], b);
});

test("recorded order may not put a later phase before an earlier one", () => {
  assert.throws(
    () => getHistoryBefore([claim(2, "1"), night(1, [])], 1),
    /history\[0\] \(selfRoleClaim, day 2\) is recorded before history\[1\] \(nightResult, night 1\) but belongs to a later phase/
  );
  // day N evidence before night N's result would mean speaking before the night happened
  assert.throws(() => getHistoryBefore([claim(1, "1"), night(1, [])], 1), /belongs to a later phase/);
  // an invalid round anywhere in the prefix is rejected too
  assert.throws(() => getHistoryBefore([claim(-1, "1"), claim(0, "2")], 1), /invalid day round -1/);
});

test("getHistoryBefore and getAliveStateForEvidence do not mutate the history", () => {
  const snapshot = JSON.stringify(log);
  const before = getHistoryBefore(log, 7);
  before.push(night(9, []));
  getAliveStateForEvidence(game, log, lastWords);
  assert.equal(JSON.stringify(log), snapshot);
  assert.equal(log.length, 11);
});
