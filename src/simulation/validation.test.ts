import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SimulationValidationError,
  validateDayActionDecision,
  validateKeepOrEliminateDecision,
  validateTargetChoiceDecision,
  validateVoteDecision,
} from "./validation";

test("validateDayActionDecision accepts a fully legal combined decision", () => {
  assert.doesNotThrow(() =>
    validateDayActionDecision(
      {
        type: "dayAction",
        suspect: ["2", "3"],
        defend: ["4"],
        nominate: "2",
        roleClaim: { kind: "role", role: "citizen" },
        investigationClaim: { target: "2", mechanic: "checkIsMafia", result: true },
      },
      ["1", "2", "3", "4", "5"],
      ["1", "2", "3", "4", "5"]
    )
  );
});

test("validateDayActionDecision rejects a suspect/defend/nominate target who is not currently alive", () => {
  assert.throws(
    () => validateDayActionDecision({ type: "dayAction", suspect: ["3"] }, ["1", "2", "3"], ["1", "2"]),
    SimulationValidationError
  );
  assert.throws(
    () => validateDayActionDecision({ type: "dayAction", nominate: "3" }, ["1", "2", "3"], ["1", "2"]),
    SimulationValidationError
  );
});

test("validateDayActionDecision allows an investigationClaim target who has since died", () => {
  assert.doesNotThrow(() =>
    validateDayActionDecision(
      { type: "dayAction", investigationClaim: { target: "3", mechanic: "checkIsMafia", result: false } },
      ["1", "2", "3"],
      ["1", "2"]
    )
  );
});

test("validateDayActionDecision rejects an unknown role claim, group claim, or investigation mechanic", () => {
  assert.throws(
    () =>
      validateDayActionDecision(
        { type: "dayAction", roleClaim: { kind: "role", role: "wizard" as any } },
        ["1"],
        ["1"]
      ),
    SimulationValidationError
  );
  assert.throws(
    () =>
      validateDayActionDecision(
        { type: "dayAction", roleClaim: { kind: "group", group: "neutral" as any } },
        ["1"],
        ["1"]
      ),
    SimulationValidationError
  );
  assert.throws(
    () =>
      validateDayActionDecision(
        { type: "dayAction", investigationClaim: { target: "1", mechanic: "readMind" as any, result: true } },
        ["1"],
        ["1"]
      ),
    SimulationValidationError
  );
});

test("validateVoteDecision: null (abstain) is always legal; a non-candidate is not", () => {
  assert.doesNotThrow(() => validateVoteDecision({ type: "vote", candidate: null }, ["2", "3"]));
  assert.doesNotThrow(() => validateVoteDecision({ type: "vote", candidate: "2" }, ["2", "3"]));
  assert.throws(() => validateVoteDecision({ type: "vote", candidate: "9" }, ["2", "3"]), SimulationValidationError);
});

test("validateTargetChoiceDecision: rejects a dead target, and rejects repeating a forbidden (doctor) previous target", () => {
  assert.doesNotThrow(() => validateTargetChoiceDecision({ type: "targetChoice", target: "2" }, ["1", "2", "3"]));
  assert.throws(
    () => validateTargetChoiceDecision({ type: "targetChoice", target: "9" }, ["1", "2", "3"]),
    SimulationValidationError
  );
  assert.throws(
    () => validateTargetChoiceDecision({ type: "targetChoice", target: "2" }, ["1", "2", "3"], "2"),
    SimulationValidationError
  );
  assert.doesNotThrow(() => validateTargetChoiceDecision({ type: "targetChoice", target: "2" }, ["1", "2", "3"], "1"));
});

test("validateKeepOrEliminateDecision requires a boolean `eliminate`", () => {
  assert.doesNotThrow(() => validateKeepOrEliminateDecision({ type: "keepOrEliminate", eliminate: true }));
  assert.throws(
    () => validateKeepOrEliminateDecision({ type: "keepOrEliminate", eliminate: "yes" as any }),
    SimulationValidationError
  );
});
