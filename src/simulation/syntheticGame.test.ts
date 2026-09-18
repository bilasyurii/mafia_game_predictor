import { test } from "node:test";
import assert from "node:assert/strict";
import { GameConfig, PlayerId, RoleId } from "../types";
import { GamePhase } from "../facts";
import { defaultRoleRegistry } from "../roles";
import { buildPlayerView } from "./playerView";
import { checkInformationBoundary } from "./syntheticGame";
import { PublicGameStateView } from "./types";

/**
 * Tests for checkInformationBoundary - the post-hoc sanity net over requests
 * a synthetic run actually sent. See its own doc comment in syntheticGame.ts
 * for why it scans only `view.private`: an earlier version scanned the whole
 * serialized view and produced a false positive every time any player made
 * a public role claim (confirmed against the 10-game synthetic experiment -
 * 9/10 games "failed" purely from legitimate public bluffing).
 */

const config: GameConfig = {
  players: ["1", "2", "3", "4"],
  roles: ["mafia", "citizen", "commissioner", "citizen"],
};
const groundTruthRoles: Record<PlayerId, RoleId> = {
  "1": "mafia",
  "2": "citizen",
  "3": "commissioner",
  "4": "citizen",
};
const alive = [...config.players];
const phase: GamePhase = { phase: "day", round: 1 };

test("a public selfRoleClaim in publicHistory does not trigger a false-positive violation", () => {
  const publicHistory = [
    { type: "selfRoleClaim" as const, round: 0, actor: "1", claim: { kind: "role" as const, role: "commissioner" as RoleId } },
  ];
  // Player 2 (citizen) sees this claim in their public history, exactly like every other player would.
  const view = buildPlayerView("2", phase, config, publicHistory, alive, groundTruthRoles, defaultRoleRegistry, [], []);

  const violations = checkInformationBoundary(config, groundTruthRoles, [view]);
  assert.deepEqual(violations, []);
});

test("genuine private-role leakage (a bug that puts another player's true role into `private`) is detected", () => {
  // Simulates the class of bug this check exists to catch: buildPlayerView somehow
  // put player 3's true role ("commissioner") into player 2's own private knowledge,
  // even though player 2 is actually a citizen and not on the Mafia team.
  const leakyView: PublicGameStateView = {
    self: "2",
    phase,
    players: config.players,
    alive,
    publicHistory: [],
    private: { role: "commissioner" as RoleId }, // wrong: player 2's true role is "citizen"
  };

  const violations = checkInformationBoundary(config, groundTruthRoles, [leakyView]);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /self=2.*commissioner.*"3"/);
});

test("legitimate own-role information is allowed", () => {
  const view = buildPlayerView("2", phase, config, [], alive, groundTruthRoles, defaultRoleRegistry, [], []);
  const violations = checkInformationBoundary(config, groundTruthRoles, [view]);
  assert.deepEqual(violations, []);
});

test("legitimate Mafia teammate information is allowed", () => {
  const config5: GameConfig = { players: ["1", "2", "3", "4", "5"], roles: ["don", "mafia", "commissioner", "doctor", "citizen"] };
  const roles5: Record<PlayerId, RoleId> = { "1": "don", "2": "mafia", "3": "commissioner", "4": "doctor", "5": "citizen" };
  const view = buildPlayerView("2", phase, config5, [], [...config5.players], roles5, defaultRoleRegistry, [], []);
  assert.deepEqual([...view.private.teammates!].sort(), ["1"]);

  const violations = checkInformationBoundary(config5, roles5, [view]);
  assert.deepEqual(violations, []);
});

test("a non-Mafia player given a teammates field is flagged", () => {
  const view: PublicGameStateView = {
    self: "2",
    phase,
    players: config.players,
    alive,
    publicHistory: [],
    private: { role: "citizen" as RoleId, teammates: ["1"] },
  };
  const violations = checkInformationBoundary(config, groundTruthRoles, [view]);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /teammates/);
});
