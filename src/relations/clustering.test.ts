import { test } from "node:test";
import assert from "node:assert/strict";
import { GameEvent } from "../types";
import { computeAffinityMatrix } from "./affinity";
import { detectTeams } from "./clustering";

function sortedSet(clusters: string[][]): string[][] {
  return clusters.map((c) => [...c].sort());
}

test("no signal at all: every player is their own singleton cluster", () => {
  const players = ["1", "2", "3", "4"];
  const matrix = computeAffinityMatrix(players, []);
  const teams = detectTeams(players, matrix);
  assert.equal(teams.length, 4);
  teams.forEach((t) => assert.equal(t.length, 1));
});

test("two clearly cooperating pairs, with no cross-pair signal, form two clusters of 2", () => {
  const players = ["1", "2", "3", "4"];
  const events: GameEvent[] = [
    { type: "defend", round: 0, actor: "1", target: "2" },
    { type: "defend", round: 0, actor: "3", target: "4" },
  ];
  const matrix = computeAffinityMatrix(players, events);
  const teams = sortedSet(detectTeams(players, matrix));
  assert.deepEqual(teams.sort((a, b) => a[0].localeCompare(b[0]))[0], ["1", "2"]);
  assert.deepEqual(teams.sort((a, b) => a[0].localeCompare(b[0]))[1], ["3", "4"]);
  assert.equal(teams.length, 2);
});

test("a chain of mutual defends merges into a single larger cluster", () => {
  const players = ["1", "2", "3"];
  const events: GameEvent[] = [
    { type: "defend", round: 0, actor: "1", target: "2" },
    { type: "defend", round: 0, actor: "2", target: "3" },
    { type: "defend", round: 0, actor: "1", target: "3" },
  ];
  const matrix = computeAffinityMatrix(players, events);
  const teams = detectTeams(players, matrix);
  assert.equal(teams.length, 1);
  assert.deepEqual([...teams[0]].sort(), ["1", "2", "3"]);
});

test("pure opposition (never positive) never merges - stays as singletons", () => {
  const players = ["1", "2"];
  const events: GameEvent[] = [{ type: "suspect", round: 0, actor: "1", target: "2" }];
  const matrix = computeAffinityMatrix(players, events);
  const teams = detectTeams(players, matrix);
  assert.equal(teams.length, 2);
});

test("results are sorted largest cluster first", () => {
  const players = ["1", "2", "3", "4", "5"];
  const events: GameEvent[] = [
    { type: "defend", round: 0, actor: "1", target: "2" },
    { type: "defend", round: 0, actor: "2", target: "3" },
  ];
  const matrix = computeAffinityMatrix(players, events);
  const teams = detectTeams(players, matrix);
  assert.equal(teams[0].length, 3);
  assert.ok(teams[0].length >= teams[1].length);
});
