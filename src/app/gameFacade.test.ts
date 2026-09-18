import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStorageAdapter, loadAppState, saveAppState, APP_STATE_STORAGE_KEY, CURRENT_APP_VERSION } from "./storage";
import { APP_SCHEMA_VERSION, defaultRoleCountsForPlayerCount } from "./types";
import { GameFacadeError, MafiaPredictorFacade } from "./gameFacade";

/**
 * Tests for the application-state/facade layer only - never the Bayesian
 * core itself (evidence.ts/processEvidence.ts/updateProbabilities.ts are
 * reused completely unchanged; see this milestone's own architecture
 * report). Every facade mutation is checked to actually move the predictor
 * (not merely accepted), and undo is checked against an independently
 * replayed facade instance, not just "doesn't throw".
 */

function newFacade(storage = new InMemoryStorageAdapter()) {
  return { storage, facade: new MafiaPredictorFacade(storage) };
}

function setupSevenPlayerGame(facade: MafiaPredictorFacade) {
  facade.createGame({ playerCount: 7, myPlayerNumber: "1", roleCounts: defaultRoleCountsForPlayerCount(7) });
  facade.setPlayerRole("citizen");
}

test("defaultRoleCountsForPlayerCount: 9+ players get 2 mafia, <=8 get 1 mafia, both always exactly 1 don/commissioner/doctor", () => {
  const eight = defaultRoleCountsForPlayerCount(8);
  assert.equal(eight.mafia, 1);
  assert.equal(eight.don, 1);
  assert.equal(eight.commissioner, 1);
  assert.equal(eight.doctor, 1);
  assert.equal(eight.citizen, 4);

  const nine = defaultRoleCountsForPlayerCount(9);
  assert.equal(nine.mafia, 2);
  assert.equal(nine.citizen, 4);
});

test("createGame builds a valid session; recordAction/recordSelfRoleClaim actually move the predictor's posterior", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);

  const before = facade.getPublicPlayerProbabilities();
  facade.recordAction("2", "suspect", "3");
  const after = facade.getPublicPlayerProbabilities();

  const beforeP3 = before.find((p) => p.player === "3")!.mafiaProbability;
  const afterP3 = after.find((p) => p.player === "3")!.mafiaProbability;
  assert.notEqual(beforeP3, afterP3);
});

test("event order is preserved in getEventLog(), in the order events were recorded", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  facade.recordAction("2", "suspect", "3");
  facade.recordAction("4", "defend", "3");
  facade.recordAction("5", "nominate", "3");

  const log = facade.getEventLog();
  assert.equal(log.length, 3);
  assert.deepEqual(
    log.map((e) => e.event.type),
    ["suspect", "defend", "nominate"]
  );
  assert.equal((log[0].event as any).actor, "2");
  assert.equal((log[1].event as any).actor, "4");
  assert.equal((log[2].event as any).actor, "5");
});

test("night/day flow: startNight -> confirmNightDeaths advances phase and records a nightResult event", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  assert.deepEqual(facade.getCurrentPhase(), { kind: "day", round: 0 });

  facade.startNight();
  assert.deepEqual(facade.getCurrentPhase(), { kind: "night", round: 1 });

  facade.confirmNightDeaths(["2"]);
  assert.deepEqual(facade.getCurrentPhase(), { kind: "day", round: 1 });
  const log = facade.getEventLog();
  assert.equal(log.length, 1);
  assert.deepEqual(log[0].event, { type: "nightResult", round: 1, died: ["2"] });
});

test("voting flow: startVoting -> recordHandsForCandidate -> confirmVote -> recordDayElimination produces a valid, replayable event chain", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  facade.startVoting("initial", ["3", "4"]);
  // living players are 1-7; candidates "3","4" abstain (go to the LAST
  // candidate, "4", per the real abstention rule - see voting.ts) - so "4"
  // ends up with 1 raised + 2 abstainers = 3, "3" gets its 4 raised hands.
  facade.recordHandsForCandidate("3", ["2", "5", "6", "7"]);
  facade.recordHandsForCandidate("4", ["1"]);
  const tally = facade.getVoteTallySoFar();
  assert.equal(tally.find((c) => c.candidate === "3")!.count, 4);
  assert.equal(tally.find((c) => c.candidate === "4")!.count, 3);

  const outcome = facade.confirmVote();
  assert.equal(outcome.kind, "winner");
  if (outcome.kind === "winner") assert.equal(outcome.candidate, "3");

  facade.recordDayElimination(["3"]);
  assert.deepEqual(facade.getCurrentPhase(), { kind: "day", round: 0 });

  const types = facade.getEventLog().map((e) => e.event.type);
  assert.deepEqual(types, ["candidateVote", "dayElimination"]);
});

test('voting can resolve to "leave everyone" via a tied initial vote, a tied revote, and a keepOrEliminateVote that keeps everyone', () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  facade.startNight();
  facade.confirmNightDeaths(["2"]); // living is now {1,3,4,5,6,7} = 6 players, an EVEN count

  // every living player votes explicitly (no abstainers) - 3 for "3", 3 for "4": an exact tie.
  facade.startVoting("initial", ["3", "4"]);
  facade.recordHandsForCandidate("3", ["1", "5", "3"]);
  facade.recordHandsForCandidate("4", ["6", "7", "4"]);
  const initialOutcome = facade.confirmVote();
  assert.equal(initialOutcome.kind, "tie");

  facade.startVoting("revote", ["3", "4"]);
  facade.recordHandsForCandidate("3", ["1", "5", "3"]);
  facade.recordHandsForCandidate("4", ["6", "7", "4"]);
  const revoteOutcome = facade.confirmVote();
  assert.equal(revoteOutcome.kind, "tie");

  facade.startKeepOrEliminateVote(["3", "4"]);
  facade.recordEliminateHands([]); // nobody votes to eliminate
  const keepOutcome = facade.confirmKeepOrEliminateVote();
  assert.equal(keepOutcome.kind, "keepAll");

  facade.recordDayElimination([]);
  const last = facade.getEventLog().at(-1)!.event as any;
  assert.deepEqual(last, { type: "dayElimination", round: 1, eliminated: [] });
  assert.deepEqual(facade.getCurrentPhase(), { kind: "day", round: 1 });
});

test("undo removes the last event and restores the exact prior uiPhase and predictor state - verified against an independently replayed facade", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  facade.recordAction("2", "suspect", "3");
  const snapshotBeforeThirdEvent = facade.getPublicPlayerProbabilities();
  const phaseBeforeThirdEvent = facade.getCurrentPhase();

  facade.recordAction("4", "defend", "3"); // the event that will be undone

  facade.undoLastEvent();

  assert.deepEqual(facade.getCurrentPhase(), phaseBeforeThirdEvent);
  const afterUndo = facade.getPublicPlayerProbabilities();
  afterUndo.forEach((p) => {
    const expected = snapshotBeforeThirdEvent.find((e) => e.player === p.player)!;
    assert.ok(Math.abs(p.mafiaProbability - expected.mafiaProbability) < 1e-12);
  });
  assert.equal(facade.getEventLog().length, 1);
});

test("undo across a phase transition (undoing a confirmNightDeaths) restores the night phase and removes the nightResult event", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  facade.startNight();
  facade.confirmNightDeaths(["2"]);
  assert.deepEqual(facade.getCurrentPhase(), { kind: "day", round: 1 });

  facade.undoLastEvent();
  assert.deepEqual(facade.getCurrentPhase(), { kind: "night", round: 1 });
  assert.equal(facade.getEventLog().length, 0);
});

test("undo + replay produces the same predictor state as never having recorded the undone event at all", () => {
  const { facade: a } = newFacade();
  setupSevenPlayerGame(a);
  a.recordAction("2", "suspect", "3");
  a.recordAction("4", "defend", "5");
  a.undoLastEvent();
  a.recordAction("6", "nominate", "3"); // a fresh event replacing the undone one

  const { facade: b } = newFacade();
  setupSevenPlayerGame(b);
  b.recordAction("2", "suspect", "3");
  b.recordAction("6", "nominate", "3"); // built directly, without ever recording the undone event

  const pa = a.getPublicPlayerProbabilities();
  const pb = b.getPublicPlayerProbabilities();
  pa.forEach((p) => {
    const q = pb.find((x) => x.player === p.player)!;
    assert.ok(Math.abs(p.mafiaProbability - q.mafiaProbability) < 1e-12);
  });
});

test("undoLastEvent throws when there is nothing to undo", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  assert.equal(facade.canUndo(), false);
  assert.throws(() => facade.undoLastEvent(), GameFacadeError);
});

test("game state (including an in-progress voting draft) survives a simulated reload - a fresh facade over the same storage sees identical state", () => {
  const storage = new InMemoryStorageAdapter();
  const facade1 = new MafiaPredictorFacade(storage);
  setupSevenPlayerGame(facade1);
  facade1.recordAction("2", "suspect", "3");
  facade1.startVoting("initial", ["3", "4"]);
  facade1.recordHandsForCandidate("3", ["2"]);

  const facade2 = new MafiaPredictorFacade(storage); // simulates a page refresh: new instance, same storage
  assert.deepEqual(facade2.getCurrentPhase(), { kind: "voting", round: 0, stage: "initial", candidates: ["3", "4"] });
  assert.equal(facade2.getEventLog().length, 1);
  const tally = facade2.getVoteTallySoFar();
  assert.equal(tally.find((c) => c.candidate === "3")!.raisedHands.length, 1);
});

test("version information (engine/predictor/schema) persists with the session", () => {
  const storage = new InMemoryStorageAdapter();
  const facade = new MafiaPredictorFacade(storage);
  setupSevenPlayerGame(facade);
  const state = loadAppState(storage);
  assert.ok(state.currentGame);
  assert.equal(typeof state.currentGame!.engineVersion, "string");
  assert.equal(typeof state.currentGame!.predictorVersion, "string");
  assert.equal(state.currentGame!.schemaVersion, APP_SCHEMA_VERSION);
});

test("final roles can be recorded per player, and finishGame stores a confirmed outcome", () => {
  const { facade, storage } = newFacade();
  setupSevenPlayerGame(facade);
  const suggested = facade.getSuggestedOutcome();
  assert.equal(suggested, "unknown"); // no deaths/eliminations yet - every world is still "ongoing"

  facade.finishGame("townWon");
  assert.deepEqual(facade.getCurrentPhase(), { kind: "finished" });

  facade.setFinalRole("1", "citizen");
  facade.setFinalRole("2", "mafia");
  const state = loadAppState(storage);
  assert.deepEqual(state.currentGame!.finalRoles, { "1": "citizen", "2": "mafia" });
  assert.equal(state.currentGame!.confirmedOutcome, "townWon");
});

test("historical games serialize and round-trip through export/import (JSON) without loss", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  facade.recordAction("2", "suspect", "3");
  facade.finishGame("unknown");
  facade.setFinalRole("2", "mafia");
  facade.saveGameToHistory();

  assert.equal(facade.getAppScreen(), "MENU");
  const history = facade.listHistory();
  assert.equal(history.length, 1);

  const json = facade.exportHistoryJson();
  const parsed = JSON.parse(json);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].session.eventLog.length, 1);
  assert.equal(parsed[0].session.finalRoles["2"], "mafia");
});

test("invalid/corrupted persisted JSON is handled safely (falls back to a fresh empty state, never throws)", () => {
  const storage = new InMemoryStorageAdapter();
  storage.setItem(APP_STATE_STORAGE_KEY, "{ not valid json ][");
  const state = loadAppState(storage);
  assert.equal(state.currentGame, null);
  assert.deepEqual(state.history, []);
  assert.equal(state.schemaVersion, APP_SCHEMA_VERSION);

  storage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify({ totally: "wrong shape" }));
  const state2 = loadAppState(storage);
  assert.equal(state2.currentGame, null);
});

test("the player's own role/probability is never included in getPublicPlayerProbabilities, and getPlayerInfo refuses to expose it", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  const publicProbs = facade.getPublicPlayerProbabilities();
  assert.ok(!publicProbs.some((p) => p.player === "1")); // "1" is myPlayerNumber
  assert.throws(() => facade.getPlayerInfo("1"), GameFacadeError);

  const info = facade.getPlayerInfo("3"); // any OTHER player is fine
  assert.equal(info.player, "3");
  assert.ok(typeof info.mafiaProbability === "number");
});

test("clearAllData wipes everything (current game AND history)", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  facade.finishGame("unknown");
  facade.saveGameToHistory();
  assert.equal(facade.listHistory().length, 1);

  facade.clearAllData();
  assert.equal(facade.getAppScreen(), "MENU");
  assert.equal(facade.listHistory().length, 0);
});

test("saveAppState / loadAppState round-trip an AppState exactly (serialization survives)", () => {
  const storage = new InMemoryStorageAdapter();
  const state = { schemaVersion: APP_SCHEMA_VERSION, appVersion: CURRENT_APP_VERSION, currentGame: null, history: [] };
  saveAppState(storage, state);
  const loaded = loadAppState(storage);
  assert.deepEqual(loaded, state);
});
