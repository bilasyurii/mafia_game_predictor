import { test } from "node:test";
import assert from "node:assert/strict";
import { CandidateVote, GameConfig, RoleId } from "./types";
import { NightResultFact } from "./night";
import { createLikelihoodModel, Evidence, EvidenceContext } from "./evidence";
import {
  DayEliminationFact,
  getAliveStateAt,
  getAliveStateForVote,
  initAliveState,
} from "./facts";
import { resolveCandidateVote, tallyCandidateVote, validateCandidateVote } from "./voting";
import { generateWorlds } from "./generateWorlds";
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

function deadPlayers(history: Evidence[], at: Parameters<typeof getAliveStateAt>[2]): string[] {
  const alive = getAliveStateAt(game, history, at);
  return Object.keys(alive).filter((p) => !alive[p]);
}

test("before any night, everyone is alive", () => {
  assert.deepEqual(getAliveStateAt(game, [night(1, ["3"])], { phase: "day", round: 0 }), initAliveState(game));
  assert.deepEqual(getAliveStateAt(game, [night(1, ["3"])], { phase: "night", round: 1 }), initAliveState(game));
});

test("a night death changes the alive state for the following day's vote", () => {
  const history: Evidence[] = [night(1, ["5"])];
  assert.deepEqual(deadPlayers(history, { phase: "night", round: 1 }), []);
  assert.deepEqual(deadPlayers(history, { phase: "day", round: 1 }), ["5"]);
});

test("a day elimination changes the alive state for the following night, not for its own day", () => {
  const history: Evidence[] = [night(1, []), day(1, ["2"])];
  assert.deepEqual(deadPlayers(history, { phase: "day", round: 1 }), []);
  assert.deepEqual(deadPlayers(history, { phase: "night", round: 2 }), ["2"]);
});

test("multiple night deaths in one night and across nights are all applied", () => {
  const history: Evidence[] = [night(1, ["4", "7"]), day(1, []), night(2, ["1"])];
  assert.deepEqual(deadPlayers(history, { phase: "day", round: 1 }), ["4", "7"]);
  assert.deepEqual(deadPlayers(history, { phase: "day", round: 2 }), ["1", "4", "7"]);
});

test("multiple day eliminations - all tied candidates in one day, and across days - are all applied", () => {
  const history: Evidence[] = [
    night(1, []),
    day(1, ["2", "6"]), // keep/eliminate vote eliminated both tied candidates
    night(2, []),
    day(2, ["3"]),
  ];
  assert.deepEqual(deadPlayers(history, { phase: "night", round: 2 }), ["2", "6"]);
  assert.deepEqual(deadPlayers(history, { phase: "night", round: 3 }), ["2", "3", "6"]);
});

test("replay uses each fact's round, not its position in history", () => {
  const ordered: Evidence[] = [night(1, ["4"]), day(1, ["2"]), night(2, ["7"])];
  const shuffled: Evidence[] = [night(2, ["7"]), day(1, ["2"]), night(1, ["4"])];
  assert.deepEqual(
    getAliveStateAt(game, shuffled, { phase: "day", round: 2 }),
    getAliveStateAt(game, ordered, { phase: "day", round: 2 })
  );
});

test("a historical vote is interpreted with the alive state of its own day, not the current one", () => {
  const vote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "initial",
    candidates: ["3", "6"],
    handsRaised: { "3": ["5", "1"] },
  };
  // "5" voted on day 1, then died on night 2; "8" died on night 1
  const history: Evidence[] = [night(1, ["8"]), vote, day(1, ["3"]), night(2, ["5"])];

  // today, both candidate "3" and voter "5" are dead, so the old vote would
  // be rejected as impossible
  const current = getAliveStateAt(game, history, { phase: "day", round: 2 });
  assert.equal(current["3"], false);
  assert.equal(current["5"], false);
  assert.throws(() => validateCandidateVote(vote, current), /is not a living player/);

  const thatDay = getAliveStateForVote(game, history, vote);
  assert.equal(thatDay["5"], true);
  assert.equal(thatDay["3"], true); // eliminated only at the end of that day
  assert.equal(thatDay["8"], false);

  const tally = tallyCandidateVote(vote, thatDay);
  assert.deepEqual(tally.abstainers, ["2", "3", "4", "6", "7"]);
  assert.deepEqual(resolveCandidateVote(vote, thatDay), { kind: "winner", candidate: "6" });
});

test("dead players are never reconstructed as alive, and cannot die twice", () => {
  const history: Evidence[] = [night(1, ["5"]), day(1, []), night(2, []), day(2, [])];
  [
    { phase: "day", round: 1 },
    { phase: "night", round: 2 },
    { phase: "day", round: 2 },
    { phase: "night", round: 3 },
  ].forEach((at) => {
    assert.equal(getAliveStateAt(game, history, at as { phase: "night" | "day"; round: number })["5"], false);
  });

  assert.throws(
    () => getAliveStateAt(game, [night(1, ["5"]), day(1, ["5"])], { phase: "night", round: 2 }),
    /"5" died but was already dead/
  );
});

test("inconsistent histories and invalid points are rejected", () => {
  assert.throws(
    () => getAliveStateAt(game, [night(1, ["5"]), night(1, ["6"])], { phase: "day", round: 1 }),
    /more than one nightResult fact for round 1/
  );
  assert.throws(
    () => getAliveStateAt(game, [day(1, ["2"]), day(1, [])], { phase: "night", round: 2 }),
    /more than one dayElimination fact for round 1/
  );
  assert.throws(
    () => getAliveStateAt(game, [night(1, ["99"])], { phase: "day", round: 1 }),
    /unknown player "99"/
  );
  assert.throws(() => getAliveStateAt(game, [], { phase: "night", round: 0 }), /invalid night round 0/);
  assert.throws(() => getAliveStateAt(game, [], { phase: "day", round: 1.5 }), /invalid day round 1.5/);
});

test("state reconstruction does not mutate the history or its facts", () => {
  const history: Evidence[] = [night(1, ["4", "7"]), day(1, ["2"]), night(2, ["1"])];
  const snapshot = JSON.stringify(history);

  const first = getAliveStateAt(game, history, { phase: "day", round: 2 });
  first["4"] = true; // mutating a returned state must not leak into later replays
  const second = getAliveStateAt(game, history, { phase: "day", round: 2 });

  assert.equal(JSON.stringify(history), snapshot);
  assert.equal(second["4"], false);
});

const ROLE_IDS: RoleId[] = ["don", "mafia", "doctor", "commissioner", "citizen"];

test("a day elimination fact holds only the round and eliminated players - no role", () => {
  const fact = day(3, ["2", "6"]);
  assert.deepEqual(Object.keys(fact).sort(), ["eliminated", "round", "type"]);
  const serialized = JSON.stringify(fact);
  ROLE_IDS.forEach((role) => assert.ok(!serialized.includes(`"${role}"`)));

  const withRole: DayEliminationFact = {
    type: "dayElimination",
    round: 3,
    eliminated: ["2"],
    // @ts-expect-error - an elimination never reveals a role
    role: "mafia",
  };
  assert.ok(withRole);
});

test("a day elimination is validated against that day's votes, not scored as world-dependent evidence", () => {
  const model = createLikelihoodModel(createHandlers({ truthful: 0.5, false: 0.5 }));
  const ctx: EvidenceContext = {
    config: game,
    roles: defaultRoleRegistry,
    groups: defaultGroupRegistry,
    alive: initAliveState(game),
    history: [],
  };
  const [world] = generateWorlds(game);
  // no preceding vote evidence to validate against - an ungrounded
  // elimination fact throws rather than being silently accepted
  assert.throws(
    () => model.likelihood(day(1, ["2"]), world, ctx),
    /dayElimination for round 1 has no preceding candidateVote or keepOrEliminateVote/
  );
});
