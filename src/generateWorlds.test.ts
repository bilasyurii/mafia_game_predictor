import { test } from "node:test";
import assert from "node:assert/strict";
import { GameConfig } from "./types";
import { generateWorlds } from "./generateWorlds";
import { defaultRoleRegistry } from "./roles";

const validGame: GameConfig = {
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

test("a valid config still generates exactly the same worlds as before validation was added", () => {
  const worlds = generateWorlds(validGame);
  const expectedPermutationCount = 8 * 7 * 6 * 5; // choose distinct seats for don, mafia, doctor, commissioner; remaining 4 seats are identical citizens
  assert.equal(worlds.length, expectedPermutationCount);
  worlds.forEach((w) => {
    assert.ok(Math.abs(w.probability - 1 / expectedPermutationCount) < 1e-12);
  });

  // every world assigns exactly the multiset of roles config.roles specifies
  worlds.forEach((w) => {
    const assigned = validGame.players.map((p) => w.roles[p]).sort();
    assert.deepEqual(assigned, [...validGame.roles].sort());
  });
});

test("generateWorlds rejects a config with a duplicated unique role", () => {
  const invalidGame: GameConfig = {
    players: ["1", "2", "3", "4"],
    roles: ["doctor", "doctor", "mafia", "citizen"],
  };

  assert.throws(
    () => generateWorlds(invalidGame),
    /Role "doctor" is unique but appears 2 times/
  );
});

test("generateWorlds propagates a validateGameConfig failure using a custom registry", () => {
  const invalidGame: GameConfig = {
    players: ["1", "2", "3"],
    roles: ["commissioner", "commissioner", "citizen"],
  };

  assert.throws(
    () => generateWorlds(invalidGame, defaultRoleRegistry),
    /Role "commissioner" is unique but appears 2 times/
  );
});

test("generateWorlds still throws its own error for a players/roles length mismatch after validation passes", () => {
  const mismatched: GameConfig = {
    players: ["1", "2", "3"],
    roles: ["mafia", "citizen"],
  };

  assert.throws(
    () => generateWorlds(mismatched),
    /players\.length \(3\) must equal roles\.length \(2\)/
  );
});
