import { test } from "node:test";
import assert from "node:assert/strict";
import { GameEvent } from "../types";
import { defaultRoleRegistry } from "../roles";
import { deriveConfirmedTeams } from "./confirmedFacts";

test("checkIsMafia: true means confirmed mafia, false means confirmed town", () => {
  const events: GameEvent[] = [
    { type: "investigationReport", round: 1, actor: "1", target: "2", mechanic: "checkIsMafia", result: true },
    { type: "investigationReport", round: 1, actor: "1", target: "3", mechanic: "checkIsMafia", result: false },
  ];
  const confirmed = deriveConfirmedTeams(events, "1", "commissioner", defaultRoleRegistry);
  assert.equal(confirmed["2"], "mafia");
  assert.equal(confirmed["3"], "town");
});

test("checkIsCommissioner: true means confirmed town (they ARE the commissioner), false is inconclusive (no entry)", () => {
  const events: GameEvent[] = [
    { type: "investigationReport", round: 1, actor: "1", target: "2", mechanic: "checkIsCommissioner", result: true },
    { type: "investigationReport", round: 1, actor: "1", target: "3", mechanic: "checkIsCommissioner", result: false },
  ];
  const confirmed = deriveConfirmedTeams(events, "1", "don", defaultRoleRegistry);
  assert.equal(confirmed["2"], "town");
  assert.equal("3" in confirmed, false);
});

test("only the CURRENT USER's own reports are trusted - another player's self-claimed report is ignored", () => {
  const events: GameEvent[] = [
    { type: "investigationReport", round: 1, actor: "5", target: "2", mechanic: "checkIsMafia", result: true },
  ];
  const confirmed = deriveConfirmedTeams(events, "1", "commissioner", defaultRoleRegistry);
  assert.equal("2" in confirmed, false);
});

test("a report is ignored if my actual role could not have performed that mechanic (defensive - the UI should never let this happen)", () => {
  const events: GameEvent[] = [
    { type: "investigationReport", round: 1, actor: "1", target: "2", mechanic: "checkIsMafia", result: true },
  ];
  const confirmed = deriveConfirmedTeams(events, "1", "citizen", defaultRoleRegistry);
  assert.equal("2" in confirmed, false);
});

test("no role set yet -> no confirmed facts at all", () => {
  const events: GameEvent[] = [
    { type: "investigationReport", round: 1, actor: "1", target: "2", mechanic: "checkIsMafia", result: true },
  ];
  const confirmed = deriveConfirmedTeams(events, "1", null, defaultRoleRegistry);
  assert.deepEqual(confirmed, {});
});

test("a later report about the same target overrides an earlier one (most recent check wins)", () => {
  const events: GameEvent[] = [
    { type: "investigationReport", round: 1, actor: "1", target: "2", mechanic: "checkIsMafia", result: true },
    { type: "investigationReport", round: 3, actor: "1", target: "2", mechanic: "checkIsMafia", result: false },
  ];
  const confirmed = deriveConfirmedTeams(events, "1", "commissioner", defaultRoleRegistry);
  assert.equal(confirmed["2"], "town");
});
