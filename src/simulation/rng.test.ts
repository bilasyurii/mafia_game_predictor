import { test } from "node:test";
import assert from "node:assert/strict";
import { GameConfig } from "../types";
import { assignRolesWithSeed, createSeededRng, seededShuffle } from "./rng";

test("createSeededRng: same seed produces the identical sequence of numbers in [0,1)", () => {
  const a = createSeededRng(42);
  const b = createSeededRng(42);
  const seqA = Array.from({ length: 5 }, () => a());
  const seqB = Array.from({ length: 5 }, () => b());
  assert.deepEqual(seqA, seqB);
  seqA.forEach((n) => assert.ok(n >= 0 && n < 1));
});

test("seededShuffle: deterministic for a given seed, and a genuine permutation of the input", () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const shuffled = seededShuffle(items, createSeededRng(7));
  assert.deepEqual(
    [...shuffled].sort((a, b) => a - b),
    items
  );
  assert.deepEqual(seededShuffle(items, createSeededRng(7)), shuffled);
});

const nineConfig: GameConfig = {
  players: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
  roles: ["don", "mafia", "mafia", "commissioner", "doctor", "citizen", "citizen", "citizen", "citizen"],
};

test("assignRolesWithSeed: same config+seed produces the identical role assignment", () => {
  const a = assignRolesWithSeed(nineConfig, 123);
  const b = assignRolesWithSeed(nineConfig, 123);
  assert.deepEqual(a, b);

  assert.deepEqual(Object.keys(a).sort(), [...nineConfig.players].sort());
  const counts = Object.values(a).reduce<Record<string, number>>((acc, r) => {
    acc[r] = (acc[r] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(counts, { don: 1, mafia: 2, commissioner: 1, doctor: 1, citizen: 4 });
});

test("assignRolesWithSeed: different seeds are actually consulted (not forced to collide)", () => {
  const config: GameConfig = { players: ["1", "2", "3"], roles: ["mafia", "citizen", "citizen"] };
  const results = new Set<string>();
  for (let seed = 0; seed < 20; seed++) {
    results.add(JSON.stringify(assignRolesWithSeed(config, seed)));
  }
  assert.ok(results.size > 1);
});
