import { test } from "node:test";
import assert from "node:assert/strict";
import { GameConfig, PlayerId, RoleId } from "../types";
import { GamePhase } from "../facts";
import { defaultRoleRegistry } from "../roles";
import { buildPlayerView, formatPromptText } from "./playerView";

const config: GameConfig = {
  players: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
  roles: ["don", "mafia", "mafia", "commissioner", "doctor", "citizen", "citizen", "citizen", "citizen"],
};
const groundTruthRoles: Record<PlayerId, RoleId> = {
  "1": "don",
  "2": "mafia",
  "3": "mafia",
  "4": "commissioner",
  "5": "doctor",
  "6": "citizen",
  "7": "citizen",
  "8": "citizen",
  "9": "citizen",
};
const alive = [...config.players];
const phase: GamePhase = { phase: "day", round: 1 };

test("a citizen's view exposes only their own role - no teammates/investigations/saves, and no other player's role anywhere in the serialized view", () => {
  const view = buildPlayerView("9", phase, config, [], alive, groundTruthRoles, defaultRoleRegistry, [], []);
  assert.equal(view.private.role, "citizen");
  assert.equal(view.private.teammates, undefined);
  assert.equal(view.private.investigations, undefined);
  assert.equal(view.private.saves, undefined);

  const serialized = formatPromptText(view);
  assert.ok(!serialized.includes('"don"'));
  assert.ok(!serialized.includes('"mafia"'));
  assert.ok(!serialized.includes('"commissioner"'));
  assert.ok(!serialized.includes('"doctor"'));
});

test("a Mafia player's view includes the full Mafia-team roster, and no Town player's role", () => {
  const view = buildPlayerView("2", phase, config, [], alive, groundTruthRoles, defaultRoleRegistry, [], []);
  assert.equal(view.private.role, "mafia");
  assert.deepEqual([...view.private.teammates!].sort(), ["1", "3"]); // the Don + the other Mafia, never self

  const serialized = formatPromptText(view);
  assert.ok(!serialized.includes('"commissioner"'));
  assert.ok(!serialized.includes('"doctor"'));
});

test("the Don's teammates include the other Mafia, even though the Don's own role id differs from 'mafia'", () => {
  const view = buildPlayerView("1", phase, config, [], alive, groundTruthRoles, defaultRoleRegistry, [], []);
  assert.equal(view.private.role, "don");
  assert.deepEqual([...view.private.teammates!].sort(), ["2", "3"]);
});

test("a dead Mafia teammate stays in the roster - a real player never un-learns a dead teammate's identity", () => {
  const aliveMinus3 = alive.filter((p) => p !== "3");
  const view = buildPlayerView("2", phase, config, [], aliveMinus3, groundTruthRoles, defaultRoleRegistry, [], []);
  assert.ok(view.private.teammates!.includes("3"));
});

test("the Commissioner never automatically learns the Doctor's identity - only their own investigations are attached, and only when non-empty", () => {
  const investigations = [{ night: 1, target: "2", mechanic: "checkIsMafia" as const, result: true }];
  const view = buildPlayerView("4", phase, config, [], alive, groundTruthRoles, defaultRoleRegistry, investigations, []);
  assert.equal(view.private.teammates, undefined);
  assert.deepEqual(view.private.investigations, investigations);
  assert.equal(view.private.saves, undefined);

  const serialized = formatPromptText(view);
  assert.ok(!serialized.includes('"doctor"'));
  assert.ok(!serialized.includes('"don"'));
});

test("the Doctor's own save history is attached only to the Doctor's own view", () => {
  const saves = [{ night: 1, target: "6" }];
  const view = buildPlayerView("5", phase, config, [], alive, groundTruthRoles, defaultRoleRegistry, [], saves);
  assert.equal(view.private.role, "doctor");
  assert.deepEqual(view.private.saves, saves);
  assert.equal(view.private.investigations, undefined);
});

test("formatPromptText is a deterministic, compact JSON rendering of the same view", () => {
  const view = buildPlayerView("6", phase, config, [], alive, groundTruthRoles, defaultRoleRegistry, [], []);
  assert.equal(formatPromptText(view), formatPromptText(view));
  assert.equal(JSON.parse(formatPromptText(view)).self, "6");
});
