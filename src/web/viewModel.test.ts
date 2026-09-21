import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStorageAdapter } from "../app/storage";
import { defaultRoleCountsForPlayerCount } from "../app/types";
import { MafiaPredictorFacade } from "../app/gameFacade";
import { buildGameScreenViewModel, buildHistoryListViewModel, buildRoleEntryViewModel } from "./viewModel";

/**
 * Tests for the DOM-free view-model layer only, over the relationship-based
 * engine (no probability anywhere - see this app's redesign notes).
 */

function setup(): MafiaPredictorFacade {
  const facade = new MafiaPredictorFacade(new InMemoryStorageAdapter());
  facade.createGame({ playerCount: 7, myPlayerNumber: "1", roleCounts: defaultRoleCountsForPlayerCount(7) });
  facade.setPlayerRole("citizen");
  return facade;
}

test("buildGameScreenViewModel: includes every player (including the viewer), and no serialized form ever contains the viewer's own role", () => {
  const facade = setup(); // myRole = "citizen"
  facade.recordAction("2", "suspect", "3");
  const vm = buildGameScreenViewModel(facade);

  assert.equal(vm.players.length, 7);
  const me = vm.players.find((p) => p.isMe)!;
  assert.equal(me.player, "1");

  const json = JSON.stringify(vm);
  assert.equal(json.includes("citizen"), false);
});

test("buildGameScreenViewModel: phase label reflects day/night/voting/finished correctly", () => {
  const facade = setup();
  assert.equal(buildGameScreenViewModel(facade).phaseLabel, "Day 1");
  facade.startNight();
  assert.equal(buildGameScreenViewModel(facade).phaseLabel, "Night 1");
  facade.confirmNightDeaths([]);
  assert.equal(buildGameScreenViewModel(facade).phaseLabel, "Day 2");
});

test("buildGameScreenViewModel: canUndo reflects facade.canUndo() exactly", () => {
  const facade = setup();
  assert.equal(buildGameScreenViewModel(facade).canUndo, false);
  facade.recordAction("2", "suspect", "3");
  assert.equal(buildGameScreenViewModel(facade).canUndo, true);
});

test("buildGameScreenViewModel: arrows and teams pass through from getRelationshipView() unchanged", () => {
  const facade = setup();
  facade.recordAction("2", "defend", "3");
  const vm = buildGameScreenViewModel(facade);
  assert.equal(vm.arrows.length, 1);
  assert.equal(vm.arrows[0].type, "support");
  assert.ok(vm.teams.length > 0);
});

test("buildGameScreenViewModel: a dead player's alive flag is false", () => {
  const facade = setup();
  facade.startNight();
  facade.confirmNightDeaths(["3"]);
  const vm = buildGameScreenViewModel(facade);
  assert.equal(vm.players.find((p) => p.player === "3")!.alive, false);
  assert.equal(vm.players.find((p) => p.player === "4")!.alive, true);
});

test("buildRoleEntryViewModel: needsRole is true before setPlayerRole, false after, and offers every distinct configured role", () => {
  const facade = new MafiaPredictorFacade(new InMemoryStorageAdapter());
  facade.createGame({ playerCount: 7, myPlayerNumber: "1", roleCounts: defaultRoleCountsForPlayerCount(7) });
  const before = buildRoleEntryViewModel(facade);
  assert.equal(before.needsRole, true);
  assert.deepEqual(before.roleOptions.sort(), ["citizen", "commissioner", "doctor", "don", "mafia"]);

  facade.setPlayerRole("doctor");
  assert.equal(buildRoleEntryViewModel(facade).needsRole, false);
});

test("buildHistoryListViewModel: summarizes saved games without exposing full event logs or per-player secret roles", () => {
  const facade = setup();
  facade.recordAction("2", "suspect", "3");
  facade.finishGame("townWon");
  facade.saveGameToHistory();

  const list = buildHistoryListViewModel(facade);
  assert.equal(list.length, 1);
  assert.equal(list[0].playerCount, 7);
  assert.equal(list[0].result, "townWon");
  assert.equal(typeof list[0].savedAt, "string");
});
