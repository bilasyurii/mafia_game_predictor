import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AliveState,
  GameConfig,
  InvestigationReport,
  RoleId,
  World,
} from "./types";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { getInvestigationResult, InvestigationMechanic } from "./investigation";
import { HiddenNightActions, resolveNight } from "./night";
import { createLikelihoodModel, EvidenceContext } from "./evidence";
import { createHandlers } from "./likelihoodHandlers";
import { initAliveState } from "./facts";

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

// --- resolveNight uses the same semantics ---

const nightWorld: World = {
  probability: 1,
  roles: {
    "1": "don",
    "2": "mafia",
    "3": "doctor",
    "4": "commissioner",
    "5": "citizen",
  },
};
const aliveAll: AliveState = { "1": true, "2": true, "3": true, "4": true, "5": true };

function resolveChecks(target: string) {
  const actions: HiddenNightActions = {
    mafiaTargetChoices: { "1": "5", "2": "3" }, // disagreement: no mafia kill
    donCheckTarget: target,
    commissionerCheckTarget: target,
  };
  return resolveNight(nightWorld, actions, aliveAll, {}, defaultRoleRegistry);
}

test("resolveNight produces the unchanged Don/Commissioner check results for every target role", () => {
  Object.keys(nightWorld.roles).forEach((target) => {
    const role = nightWorld.roles[target];
    const resolution = resolveChecks(target);

    assert.equal(
      resolution.donCheckResult,
      EXPECTED.checkIsCommissioner[role],
      `don check on ${role}`
    );
    assert.equal(
      resolution.commissionerCheckResult,
      EXPECTED.checkIsMafia[role],
      `commissioner check on ${role}`
    );

    // and it is the shared helper's result, not a separate rule
    assert.equal(
      resolution.donCheckResult,
      getInvestigationResult(defaultRoleRegistry, "checkIsCommissioner", role)
    );
    assert.equal(
      resolution.commissionerCheckResult,
      getInvestigationResult(defaultRoleRegistry, "checkIsMafia", role)
    );
  });
});

// --- InvestigationReport shape ---

const game: GameConfig = {
  players: ["1", "2", "3", "4", "5"],
  roles: ["don", "mafia", "doctor", "commissioner", "citizen"],
};

function makeCtx(): EvidenceContext {
  return {
    config: game,
    roles: defaultRoleRegistry,
    groups: defaultGroupRegistry,
    alive: initAliveState(game),
    history: [],
  };
}

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

test("investigationReport likelihood stays uncalibrated in every world - no value, not even 0, is returned", () => {
  const model = createLikelihoodModel(createHandlers({ truthful: 0.5, false: 0.5 }));
  const ctx = makeCtx();

  // The reporting actors ("1", "4") hold their claimed mechanic in the first
  // world, but are the doctor in the second/third - who can perform neither
  // check. A public report must not be scored as impossible in those worlds.
  const worlds: World[] = [
    nightWorld,
    { probability: 1, roles: { ...nightWorld.roles, "1": "doctor", "3": "don" } },
    { probability: 1, roles: { ...nightWorld.roles, "4": "doctor", "3": "commissioner" } },
  ];

  reports.forEach((report) => {
    worlds.forEach((world) => {
      assert.throws(
        () => model.likelihood(report, world, ctx),
        /investigationReport likelihood not calibrated yet/
      );
    });
  });
});
