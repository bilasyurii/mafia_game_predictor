import { test } from "node:test";
import assert from "node:assert/strict";
import { InvestigationReport, RoleId } from "./types";
import { defaultRoleRegistry } from "./roles";
import { getInvestigationResult, InvestigationMechanic } from "./investigation";

const ALL_ROLES: RoleId[] = ["don", "mafia", "doctor", "commissioner", "citizen"];

// --- getInvestigationResult: actual mechanics ---

const EXPECTED: Record<InvestigationMechanic, Record<RoleId, boolean>> = {
  checkIsCommissioner: {
    commissioner: true,
    don: false,
    mafia: false,
    doctor: false,
    citizen: false,
  },
  checkIsMafia: {
    don: true,
    mafia: true,
    commissioner: false,
    doctor: false,
    citizen: false,
  },
};

(Object.keys(EXPECTED) as InvestigationMechanic[]).forEach((mechanic) => {
  ALL_ROLES.forEach((targetRole) => {
    const expected = EXPECTED[mechanic][targetRole];
    test(`${mechanic}: target ${targetRole} -> ${expected}`, () => {
      assert.equal(
        getInvestigationResult(defaultRoleRegistry, mechanic, targetRole),
        expected
      );
    });
  });
});

// --- InvestigationReport shape ---

const reports: InvestigationReport[] = [
  { type: "investigationReport", round: 1, actor: "1", target: "4", mechanic: "checkIsCommissioner", result: true },
  { type: "investigationReport", round: 1, actor: "1", target: "5", mechanic: "checkIsCommissioner", result: false },
  { type: "investigationReport", round: 1, actor: "4", target: "2", mechanic: "checkIsMafia", result: true },
  { type: "investigationReport", round: 1, actor: "4", target: "3", mechanic: "checkIsMafia", result: false },
];

reports.forEach((report) => {
  test(`InvestigationReport shape: ${report.mechanic} + result ${report.result}`, () => {
    assert.deepEqual(Object.keys(report).sort(), [
      "actor",
      "mechanic",
      "result",
      "round",
      "target",
      "type",
    ]);
    assert.equal(typeof report.result, "boolean");
  });
});

test("InvestigationReport carries no role or RoleExpression result", () => {
  const withRole: InvestigationReport = {
    type: "investigationReport",
    round: 1,
    actor: "4",
    target: "2",
    mechanic: "checkIsMafia",
    result: true,
    // @ts-expect-error - a check never reveals an exact role
    role: "mafia",
  };
  const withClaim: InvestigationReport = {
    type: "investigationReport",
    round: 1,
    actor: "4",
    target: "2",
    mechanic: "checkIsMafia",
    result: true,
    // @ts-expect-error - a check never reveals a role group either
    claim: { kind: "group", group: "mafia" },
  };
  const badMechanic: InvestigationReport = {
    type: "investigationReport",
    round: 1,
    actor: "3",
    target: "2",
    // @ts-expect-error - only investigation mechanics can be reported
    mechanic: "protect",
    result: true,
  };
  assert.ok(withRole && withClaim && badMechanic);
});
