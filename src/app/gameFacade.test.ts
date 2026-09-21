import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStorageAdapter, loadAppState, saveAppState, APP_STATE_STORAGE_KEY, CURRENT_APP_VERSION } from "./storage";
import { APP_SCHEMA_VERSION, defaultRoleCountsForPlayerCount } from "./types";
import { GameFacadeError, MafiaPredictorFacade } from "./gameFacade";

/**
 * Tests for the application-state/facade layer over the relationship-based
 * engine (src/relations/) - see this redesign's own notes for why the old
 * Bayesian probability engine was replaced entirely. Every facade mutation
 * is checked to actually affect what it should (the relationship graph,
 * the event log, the phase), and undo is checked against an independently
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

test("createGame rejects role counts that don't sum to the player count, BEFORE persisting a session", () => {
  const { facade } = newFacade();
  assert.throws(
    () => facade.createGame({ playerCount: 7, myPlayerNumber: "1", roleCounts: { ...defaultRoleCountsForPlayerCount(7), citizen: 10 } }),
    GameFacadeError
  );
  assert.equal(facade.getAppScreen(), "MENU", "a rejected createGame() must not leave a broken session behind");
});

test("createGame builds a valid session; recordAction moves the relationship graph (getPlayerInfo's relationships)", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);

  const before = facade.getPlayerInfo("3").relationships;
  facade.recordAction("2", "suspect", "3");
  const after = facade.getPlayerInfo("3").relationships;

  assert.deepEqual(before, []);
  const rel = after.find((r) => r.other === "2");
  assert.ok(rel, "player 3's relationship with player 2 should now be nonzero");
  assert.ok(rel!.score < 0, "a suspect is an opposition signal - negative score");
});

test("recordAction accepts an optional intensity that scales the relationship impact and shows up in the event log's description", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);

  facade.recordAction("5", "suspect", "3", 1); // "just a slight feeling"
  const weakScore = facade.getPlayerInfo("3").relationships.find((r) => r.other === "5")!.score;

  facade.discardGame();
  setupSevenPlayerGame(facade);
  facade.recordAction("5", "suspect", "3"); // default/omitted intensity
  const normalScore = facade.getPlayerInfo("3").relationships.find((r) => r.other === "5")!.score;

  assert.ok(weakScore > normalScore, "a 1-star suspicion should be far less negative than an unqualified one");

  const log = facade.getEventLog();
  assert.ok(!/★/.test(log[0].description), "a default/omitted intensity isn't called out in the description");

  facade.recordAction("5", "defend", "3", 5);
  const withStars = facade.getEventLog().at(-1)!.description;
  assert.match(withStars, /★★★★★/, "a non-default intensity shows up as stars in the description");
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

test("a dead player cannot produce a new action", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  facade.startNight();
  facade.confirmNightDeaths(["2"]);
  assert.throws(() => facade.recordAction("2", "suspect", "3"), /is dead and cannot produce a new action/);
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

test("cancelCurrentSubPhase: an accidentally-started night can be canceled back to the day it came from, with no event recorded", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  assert.equal(facade.canCancelCurrentPhase(), false); // nothing to cancel from "day"

  facade.startNight();
  assert.equal(facade.canCancelCurrentPhase(), true);
  facade.cancelCurrentSubPhase();
  assert.deepEqual(facade.getCurrentPhase(), { kind: "day", round: 0 });
  assert.equal(facade.getEventLog().length, 0, "canceling a never-confirmed night must not leave any event behind");

  // the game must still be fully usable afterward (start night for real this time)
  facade.startNight();
  facade.confirmNightDeaths(["2"]);
  assert.deepEqual(facade.getCurrentPhase(), { kind: "day", round: 1 });
});

test("cancelCurrentSubPhase: an accidentally-started initial vote cancels back to Day with no event recorded", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  facade.startVoting("initial", ["3", "4"]);
  facade.recordHandsForCandidate("3", ["2"]); // a partial, never-confirmed draft
  facade.cancelCurrentSubPhase();
  assert.deepEqual(facade.getCurrentPhase(), { kind: "day", round: 0 });
  assert.equal(facade.getEventLog().length, 0);
  assert.equal(facade.getPublicSessionView().votingDraft, null);
});

test("cancelCurrentSubPhase: an accidentally-started revote cancels back to the tied initial vote (getVoteRecoveryState reports it as tied again)", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  facade.startNight();
  facade.confirmNightDeaths(["2"]); // 6 living players
  facade.startVoting("initial", ["3", "4"]);
  facade.recordHandsForCandidate("3", ["1", "5", "3"]);
  facade.recordHandsForCandidate("4", ["6", "7", "4"]);
  assert.equal(facade.confirmVote().kind, "tie");

  facade.startVoting("revote", ["3", "4"]);
  facade.cancelCurrentSubPhase();
  assert.deepEqual(facade.getCurrentPhase(), { kind: "voting", round: 1, stage: "initial", candidates: ["3", "4"] });
  assert.deepEqual(facade.getVoteRecoveryState(), { kind: "tied" });
  assert.deepEqual(
    facade.getEventLog().map((e) => e.event.type),
    ["nightResult", "candidateVote"] // the never-confirmed revote left no event
  );
});

test("cancelCurrentSubPhase: an accidentally-started keep-or-eliminate vote cancels back to the tied revote", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  facade.startNight();
  facade.confirmNightDeaths(["2"]);
  facade.startVoting("initial", ["3", "4"]);
  facade.recordHandsForCandidate("3", ["1", "5", "3"]);
  facade.recordHandsForCandidate("4", ["6", "7", "4"]);
  facade.confirmVote();
  facade.startVoting("revote", ["3", "4"]);
  facade.recordHandsForCandidate("3", ["1", "5", "3"]);
  facade.recordHandsForCandidate("4", ["6", "7", "4"]);
  assert.equal(facade.confirmVote().kind, "tie");

  facade.startKeepOrEliminateVote(["3", "4"]);
  facade.cancelCurrentSubPhase();
  assert.deepEqual(facade.getCurrentPhase(), { kind: "voting", round: 1, stage: "revote", candidates: ["3", "4"] });
  assert.deepEqual(facade.getVoteRecoveryState(), { kind: "tied" });
});

test("cancelCurrentSubPhase throws from the day phase (nothing to cancel) and from the finished phase (use resumeGame instead)", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  assert.throws(() => facade.cancelCurrentSubPhase(), GameFacadeError);
  facade.finishGame("unknown");
  assert.throws(() => facade.cancelCurrentSubPhase(), GameFacadeError);
});

test("voting flow: startVoting -> recordHandsForCandidate -> confirmVote -> recordDayElimination produces a valid, replayable event chain", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  facade.startVoting("initial", ["3", "4"]);
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
  facade.recordEliminateHands([]);
  const keepOutcome = facade.confirmKeepOrEliminateVote();
  assert.equal(keepOutcome.kind, "keepAll");

  facade.recordDayElimination([]);
  const last = facade.getEventLog().at(-1)!.event as any;
  assert.deepEqual(last, { type: "dayElimination", round: 1, eliminated: [] });
  assert.deepEqual(facade.getCurrentPhase(), { kind: "day", round: 1 });
});

test("voting can resolve to eliminating BOTH tied candidates via keepOrEliminateVote's eliminateAll", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  facade.startNight();
  facade.confirmNightDeaths(["2"]); // living: 1,3,4,5,6,7

  facade.startVoting("initial", ["3", "4"]);
  facade.recordHandsForCandidate("3", ["1", "5", "3"]);
  facade.recordHandsForCandidate("4", ["6", "7", "4"]);
  assert.equal(facade.confirmVote().kind, "tie");

  facade.startVoting("revote", ["3", "4"]);
  facade.recordHandsForCandidate("3", ["1", "5", "3"]);
  facade.recordHandsForCandidate("4", ["6", "7", "4"]);
  assert.equal(facade.confirmVote().kind, "tie");

  facade.startKeepOrEliminateVote(["3", "4"]);
  facade.recordEliminateHands(["1", "3", "4", "5", "6", "7"]); // everyone votes to eliminate
  const outcome = facade.confirmKeepOrEliminateVote();
  assert.equal(outcome.kind, "eliminateAll");
  assert.deepEqual([...outcome.candidates].sort(), ["3", "4"]);

  facade.recordDayElimination(outcome.candidates);
  assert.equal(facade.getPlayerInfo("3").alive, false);
  assert.equal(facade.getPlayerInfo("4").alive, false);
});

test("getVoteRecoveryState: a fresh voting phase with no recorded vote reports noRecordedVote (safe to start a vote)", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  facade.startVoting("initial", ["3", "4"]);
  assert.deepEqual(facade.getVoteRecoveryState(), { kind: "noRecordedVote" });
});

test("getVoteRecoveryState: a just-confirmed tie reports tied", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  facade.startNight();
  facade.confirmNightDeaths(["2"]); // 6 living players
  facade.startVoting("initial", ["3", "4"]);
  facade.recordHandsForCandidate("3", ["1", "5", "3"]);
  facade.recordHandsForCandidate("4", ["6", "7", "4"]);
  facade.confirmVote();
  assert.deepEqual(facade.getVoteRecoveryState(), { kind: "tied" });
});

test("getVoteRecoveryState: undoing a dayElimination that followed a clean candidateVote win reports decisive with the recoverable elimination - and REGRESSION: restarting instead of recovering would corrupt the vote chain", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  facade.startVoting("initial", ["3", "4"]);
  facade.recordHandsForCandidate("3", ["2", "5", "6", "7"]);
  facade.recordHandsForCandidate("4", ["1"]);
  const outcome = facade.confirmVote();
  assert.equal(outcome.kind, "winner");
  facade.recordDayElimination(["3"]);

  facade.undoLastEvent(); // removes only the dayElimination - the candidateVote itself is untouched
  assert.deepEqual(facade.getVoteRecoveryState(), { kind: "decisive", eliminated: ["3"] });

  // the correct recovery - just re-record the same elimination, no new vote event
  facade.recordDayElimination(["3"]);
  assert.equal(facade.getPlayerInfo("3").alive, false);
  assert.deepEqual(
    facade.getEventLog().map((e) => e.event.type),
    ["candidateVote", "dayElimination"]
  );
});

test("getVoteRecoveryState: undoing a dayElimination that followed a keepOrEliminateVote's eliminateAll reports decisive with both candidates", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  facade.startNight();
  facade.confirmNightDeaths(["2"]); // living: 1,3,4,5,6,7

  facade.startVoting("initial", ["3", "4"]);
  facade.recordHandsForCandidate("3", ["1", "5", "3"]);
  facade.recordHandsForCandidate("4", ["6", "7", "4"]);
  facade.confirmVote();
  facade.startVoting("revote", ["3", "4"]);
  facade.recordHandsForCandidate("3", ["1", "5", "3"]);
  facade.recordHandsForCandidate("4", ["6", "7", "4"]);
  facade.confirmVote();
  facade.startKeepOrEliminateVote(["3", "4"]);
  facade.recordEliminateHands(["1", "3", "4", "5", "6", "7"]);
  const outcome = facade.confirmKeepOrEliminateVote();
  facade.recordDayElimination(outcome.candidates);

  facade.undoLastEvent(); // removes only the dayElimination
  const recovery = facade.getVoteRecoveryState();
  assert.equal(recovery.kind, "decisive");
  if (recovery.kind === "decisive") assert.deepEqual([...recovery.eliminated].sort(), ["3", "4"]);
});

test("undo removes the last event and restores the exact prior uiPhase and event log", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  facade.recordAction("2", "suspect", "3");
  const phaseBeforeThirdEvent = facade.getCurrentPhase();

  facade.recordAction("4", "defend", "3");
  facade.undoLastEvent();

  assert.deepEqual(facade.getCurrentPhase(), phaseBeforeThirdEvent);
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

test("undo + replay produces the same relationship graph as never having recorded the undone event at all", () => {
  const { facade: a } = newFacade();
  setupSevenPlayerGame(a);
  a.recordAction("2", "suspect", "3");
  a.recordAction("4", "defend", "5");
  a.undoLastEvent();
  a.recordAction("6", "nominate", "3");

  const { facade: b } = newFacade();
  setupSevenPlayerGame(b);
  b.recordAction("2", "suspect", "3");
  b.recordAction("6", "nominate", "3");

  assert.deepEqual(a.getPlayerInfo("3").relationships, b.getPlayerInfo("3").relationships);
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

  const facade2 = new MafiaPredictorFacade(storage);
  assert.deepEqual(facade2.getCurrentPhase(), { kind: "voting", round: 0, stage: "initial", candidates: ["3", "4"] });
  assert.equal(facade2.getEventLog().length, 1);
  const tally = facade2.getVoteTallySoFar();
  assert.equal(tally.find((c) => c.candidate === "3")!.raisedHands.length, 1);
});

test("version information (engine/schema) persists with the session", () => {
  const storage = new InMemoryStorageAdapter();
  const facade = new MafiaPredictorFacade(storage);
  setupSevenPlayerGame(facade);
  const state = loadAppState(storage);
  assert.ok(state.currentGame);
  assert.equal(typeof state.currentGame!.engineVersion, "string");
  assert.equal(state.currentGame!.schemaVersion, APP_SCHEMA_VERSION);
});

test("finishGame is manual (no auto-suggestion), and resumeGame returns to a live game - Finish Game is never a dead end", () => {
  const { facade, storage } = newFacade();
  setupSevenPlayerGame(facade);
  facade.recordAction("2", "suspect", "3");
  const phaseBeforeFinish = facade.getCurrentPhase();

  facade.finishGame("unknown");
  assert.deepEqual(facade.getCurrentPhase(), { kind: "finished" });

  facade.resumeGame();
  assert.deepEqual(facade.getCurrentPhase(), phaseBeforeFinish);
  assert.throws(() => facade.resumeGame(), GameFacadeError); // not finished anymore - nothing to resume

  facade.finishGame("mafiaWon"); // can be called again to override a previous outcome
  assert.equal(facade.getPublicSessionView().confirmedOutcome, "mafiaWon");

  facade.setFinalRole("1", "citizen");
  facade.setFinalRole("2", "mafia");
  const state = loadAppState(storage);
  assert.equal(state.currentGame!.finalRoles!["1"], "citizen");
  assert.equal(state.currentGame!.finalRoles!["2"], "mafia");
  assert.equal(state.currentGame!.confirmedOutcome, "mafiaWon");
});

test("finishGame defaults every player's final role to citizen (the viewer's own seat to their actual known role) instead of leaving it unset, but never overwrites roles already entered on an earlier finish", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade); // myPlayerNumber "1", myRole "citizen"

  facade.finishGame("unknown");
  const view = facade.getPublicSessionView();
  view.config.players.forEach((p) => assert.equal(view.finalRoles![p], "citizen"));

  facade.resumeGame();
  facade.setFinalRole("2", "mafia"); // the user corrects one player's actual role
  facade.finishGame("mafiaWon"); // finishing again must not wipe that correction back to citizen
  const view2 = facade.getPublicSessionView();
  assert.equal(view2.finalRoles!["1"], "citizen");
  assert.equal(view2.finalRoles!["2"], "mafia");
  assert.equal(view2.finalRoles!["3"], "citizen");
});

test("getRelationshipView: arrows are recorded one per suspect/nominate/defend action, never for votes or claims", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  facade.recordAction("2", "suspect", "3");
  facade.recordAction("4", "defend", "5");
  facade.recordAction("6", "nominate", "3");
  facade.recordSelfRoleClaim("7", { kind: "role", role: "citizen" });

  const view = facade.getRelationshipView();
  assert.equal(view.arrows.length, 3);
  assert.deepEqual(
    view.arrows.map((a) => a.type),
    ["attack", "support", "attack"]
  );
  assert.deepEqual(
    view.arrows.map((a) => a.eventType),
    ["suspect", "defend", "nominate"]
  );
});

test("getRelationshipView: detected teams reflect accumulated cooperation, dynamically (not forced to exactly 2)", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  assert.equal(facade.getRelationshipView().teams.length, 7, "no signal yet -> every player is their own cluster");

  facade.recordAction("2", "defend", "3");
  facade.recordAction("3", "defend", "2");
  const withSignal = facade.getRelationshipView();
  const merged = withSignal.teams.find((t) => t.members.includes("2") && t.members.includes("3"));
  assert.ok(merged, "players 2 and 3 should now be in the same detected team");
});

test("getRelationshipView: confirmedTeams comes ONLY from the current user's own investigation reports, never another player's claim", () => {
  const { facade } = newFacade();
  facade.createGame({ playerCount: 7, myPlayerNumber: "1", roleCounts: defaultRoleCountsForPlayerCount(7) });
  facade.setPlayerRole("commissioner");

  facade.recordInvestigationReport("1", "3", "checkIsMafia", true);
  facade.recordInvestigationReport("5", "4", "checkIsMafia", true); // someone ELSE'S claim - must not be trusted

  const view = facade.getRelationshipView();
  assert.equal(view.confirmedTeams["3"], "mafia");
  assert.equal("4" in view.confirmedTeams, false);
});

test("getPlayerInfo throws for myPlayerNumber, but works for any other player and includes relationships + event history", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  facade.recordAction("2", "suspect", "3");
  assert.throws(() => facade.getPlayerInfo("1"), GameFacadeError);

  const info = facade.getPlayerInfo("3");
  assert.equal(info.player, "3");
  assert.equal(info.events.length, 1);
  assert.equal(info.events[0].description.includes("suspects"), true);
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

test("a schema-1 (pre-redesign, Bayesian-era) save has no migration path and safely resets to a fresh empty state", () => {
  const storage = new InMemoryStorageAdapter();
  storage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, appVersion: "0.1.0", currentGame: { predictorVersion: "default-flat-v1" }, history: [] }));
  const state = loadAppState(storage);
  assert.equal(state.currentGame, null);
  assert.equal(state.schemaVersion, APP_SCHEMA_VERSION);
});

test("the player's own info is never exposed through getPlayerInfo", () => {
  const { facade } = newFacade();
  setupSevenPlayerGame(facade);
  assert.throws(() => facade.getPlayerInfo("1"), GameFacadeError);
  const info = facade.getPlayerInfo("3"); // any OTHER player is fine
  assert.equal(info.player, "3");
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
