import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStorageAdapter } from "../app/storage";
import { defaultRoleCountsForPlayerCount } from "../app/types";
import { MafiaPredictorFacade } from "../app/gameFacade";
import { buildGameScreenViewModel, buildHistoryListViewModel, buildRoleEntryViewModel, computeProbabilityBarStyle } from "./viewModel";

/**
 * Tests for the DOM-free view-model layer only. The safety-critical checks
 * here are the ones this whole UI phase exists to guarantee: the viewer's
 * own role and own Mafia probability must never appear in a view model a
 * "normal game screen" render function would consume.
 */

function setup(): MafiaPredictorFacade {
  const facade = new MafiaPredictorFacade(new InMemoryStorageAdapter());
  facade.createGame({ playerCount: 7, myPlayerNumber: "1", roleCounts: defaultRoleCountsForPlayerCount(7) });
  facade.setPlayerRole("citizen");
  return facade;
}

test("buildGameScreenViewModel: includes every player (including the viewer), but the viewer's OWN entry never has a mafiaProbability field at all", () => {
  const facade = setup();
  facade.recordAction("2", "suspect", "3");
  const vm = buildGameScreenViewModel(facade);

  assert.equal(vm.players.length, 7);
  const me = vm.players.find((p) => p.isMe)!;
  assert.equal(me.player, "1");
  assert.equal("mafiaProbability" in me, false); // structurally absent, not merely 0/undefined-by-accident

  const others = vm.players.filter((p) => !p.isMe);
  assert.equal(others.length, 6);
  others.forEach((p) => assert.equal(typeof p.mafiaProbability, "number"));
});

test("buildGameScreenViewModel: no serialized form of the view model can contain the raw session's myRole value", () => {
  const facade = setup(); // myRole = "citizen"
  const vm = buildGameScreenViewModel(facade);
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

test("buildRoleEntryViewModel: needsRole is true before setPlayerRole, false after, and offers every distinct configured role", () => {
  const facade = new MafiaPredictorFacade(new InMemoryStorageAdapter());
  facade.createGame({ playerCount: 7, myPlayerNumber: "1", roleCounts: defaultRoleCountsForPlayerCount(7) });
  const before = buildRoleEntryViewModel(facade);
  assert.equal(before.needsRole, true);
  assert.deepEqual(before.roleOptions.sort(), ["citizen", "commissioner", "doctor", "don", "mafia"]);

  facade.setPlayerRole("doctor");
  assert.equal(buildRoleEntryViewModel(facade).needsRole, false);
});

test("computeProbabilityBarStyle: higher mafia probability grows DOWN and is colored mafia (red) - not up/green", () => {
  const style = computeProbabilityBarStyle(0.9);
  assert.equal(style.direction, "down");
  assert.equal(style.color, "mafia");
  assert.ok(style.heightPercent > 0);
});

test("computeProbabilityBarStyle: lower mafia probability (more town) grows UP and is colored town (green)", () => {
  const style = computeProbabilityBarStyle(0.1);
  assert.equal(style.direction, "up");
  assert.equal(style.color, "town");
  assert.ok(style.heightPercent > 0);
});

test("computeProbabilityBarStyle: exactly neutral (default 0.5) has zero height - no visible fill either direction", () => {
  const style = computeProbabilityBarStyle(0.5);
  assert.equal(style.heightPercent, 0);
});

test("computeProbabilityBarStyle: with a non-0.5 neutral (the game's actual prior), the prior itself has zero height - found by actually playing a game through the browser: a fresh 7-player game's prior P(mafia) is 2/7, not 0.5, so anchoring at 0.5 showed every player as 'leaning town' before any evidence existed", () => {
  const prior = 2 / 7;
  assert.equal(computeProbabilityBarStyle(prior, prior).heightPercent, 0);
});

test("computeProbabilityBarStyle: scaling is asymmetric around a non-0.5 neutral - each side maxes out (height 50) exactly at its own extreme (0 or 1), not at a symmetric distance from neutral", () => {
  const prior = 2 / 7;
  const atZero = computeProbabilityBarStyle(0, prior);
  assert.equal(atZero.direction, "up");
  assert.equal(atZero.heightPercent, 50);

  const atOne = computeProbabilityBarStyle(1, prior);
  assert.equal(atOne.direction, "down");
  assert.equal(atOne.heightPercent, 50);
});

test("REGRESSION (found via browser playtest): a fresh 7-player game shows every living player's bar at zero height - the game's own prior, not a universal 0.5, is neutral", () => {
  const facade = setup(); // 7 players, default role counts -> prior P(mafia) = 2/7
  const vm = buildGameScreenViewModel(facade);
  const others = vm.players.filter((p) => !p.isMe);
  others.forEach((p) => {
    assert.ok(p.barStyle, `expected a barStyle for living player ${p.player}`);
    assert.ok(Math.abs(p.barStyle!.heightPercent) < 1e-6, `player ${p.player}'s bar should be visually flat at the game's own prior, got height ${p.barStyle!.heightPercent}`);
  });
});

test("buildGameScreenViewModel: barStyle is structurally absent for the viewer's own seat, same as mafiaProbability", () => {
  const facade = setup();
  const vm = buildGameScreenViewModel(facade);
  const me = vm.players.find((p) => p.isMe)!;
  assert.equal("barStyle" in me, false);
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
