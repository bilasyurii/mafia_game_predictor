import { test } from "node:test";
import assert from "node:assert/strict";
import { GameConfig, InvestigationReport, World } from "./types";
import { generateWorlds } from "./generateWorlds";
import { getProbability } from "./probability";
import { updateProbabilities } from "./updateProbabilities";
import { initAliveState } from "./facts";
import { createLikelihoodModel, EvidenceContext } from "./evidence";
import { createHandlers } from "./likelihoodHandlers";
import { createInvestigationReportHandler } from "./investigationReportLikelihood";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";

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

const world: World = {
  probability: 1,
  roles: {
    "1": "don",
    "2": "mafia",
    "3": "doctor",
    "4": "commissioner",
    "5": "citizen",
  },
};

// Synthetic test data only - not a calibration claim about real players.
const params = { truthful: 0.8, falseResult: 0.15, bluff: 0.05 };

test("truthful: actor holds the mechanic and the result is correct", () => {
  const handler = createInvestigationReportHandler(params);
  // "4" is commissioner (holds checkIsMafia); "2" is mafia -> real result true
  const report: InvestigationReport = {
    type: "investigationReport",
    round: 1,
    actor: "4",
    target: "2",
    mechanic: "checkIsMafia",
    result: true,
  };
  assert.equal(handler(report, world, makeCtx()), 0.8);
});

test("falseResult: actor holds the mechanic but reports the wrong result", () => {
  const handler = createInvestigationReportHandler(params);
  // same actor/target/mechanic, but claims the opposite of the real result
  const report: InvestigationReport = {
    type: "investigationReport",
    round: 1,
    actor: "4",
    target: "2",
    mechanic: "checkIsMafia",
    result: false,
  };
  assert.equal(handler(report, world, makeCtx()), 0.15);
});

test("bluff: actor lacks the mechanic, regardless of whether the claimed result happens to match reality", () => {
  const handler = createInvestigationReportHandler(params);
  // "5" is citizen - cannot perform checkIsMafia in this world at all
  const luckyBluff: InvestigationReport = {
    type: "investigationReport",
    round: 1,
    actor: "5",
    target: "2", // mafia -> real result true, and the bluff also claims true
    mechanic: "checkIsMafia",
    result: true,
  };
  const unluckyBluff: InvestigationReport = {
    type: "investigationReport",
    round: 1,
    actor: "5",
    target: "3", // doctor -> real result false, but the bluff claims true
    mechanic: "checkIsMafia",
    result: true,
  };

  const lucky = handler(luckyBluff, world, makeCtx());
  const unlucky = handler(unluckyBluff, world, makeCtx());

  // the critical modeling constraint: never 0 just for lacking the mechanic,
  // and matchesActual must not leak into the bluff branch
  assert.equal(lucky, 0.05);
  assert.equal(unlucky, 0.05);
  assert.equal(lucky, unlucky);
});

test("the claimed night does not affect the mechanical dispatch", () => {
  const handler = createInvestigationReportHandler(params);
  const withoutNight: InvestigationReport = {
    type: "investigationReport",
    round: 3,
    actor: "4",
    target: "2",
    mechanic: "checkIsMafia",
    result: true,
  };
  const withEarlierNight: InvestigationReport = {
    ...withoutNight,
    night: 1,
  };

  assert.equal(
    handler(withoutNight, world, makeCtx()),
    handler(withEarlierNight, world, makeCtx())
  );
});

test("function-based parameters can inspect observation/world/ctx in every branch", () => {
  const handler = createInvestigationReportHandler({
    truthful: (observation) => (observation.actor === "4" ? 0.7 : 0.6),
    falseResult: (_observation, w) => (w.roles["4"] === "commissioner" ? 0.2 : 0.1),
    bluff: (_observation, _world, ctx) => (ctx.history.length > 0 ? 0.09 : 0.05),
  });

  const truthfulReport: InvestigationReport = {
    type: "investigationReport",
    round: 1,
    actor: "4",
    target: "2",
    mechanic: "checkIsMafia",
    result: true,
  };
  assert.equal(handler(truthfulReport, world, makeCtx()), 0.7);

  const falseResultReport: InvestigationReport = {
    ...truthfulReport,
    result: false,
  };
  assert.equal(handler(falseResultReport, world, makeCtx()), 0.2);

  const bluffReport: InvestigationReport = {
    ...truthfulReport,
    actor: "5",
  };
  const withHistory: EvidenceContext = {
    ...makeCtx(),
    history: [
      { type: "suspect", round: 1, actor: "1", target: "2" },
    ],
  };
  assert.equal(handler(bluffReport, world, makeCtx()), 0.05);
  assert.equal(handler(bluffReport, world, withHistory), 0.09);
});

test("createHandlers wires investigationReportParams into the real Bayesian pipeline", () => {
  const worlds = generateWorlds(game);
  const ctx = makeCtx();
  const model = createLikelihoodModel(
    createHandlers(
      { truthful: 0.9, false: 0.1 }, // selfRoleClaim - unused here
      undefined,
      { truthful: 0.8, falseResult: 0.1, bluff: 0.2 }
    )
  );

  // "4" claims to have checked "2" as Mafia - true in every world where "4"
  // is commissioner and "2" is mafia-team; a bluff (still non-zero) elsewhere.
  const report: InvestigationReport = {
    type: "investigationReport",
    round: 1,
    actor: "4",
    target: "2",
    mechanic: "checkIsMafia",
    result: true,
  };

  const priorCommissioner = getProbability(worlds, "4", "commissioner");
  const posteriorWorlds = updateProbabilities(worlds, report, model, ctx);
  const posteriorCommissioner = getProbability(posteriorWorlds, "4", "commissioner");

  // the report is much more likely (0.8 vs a mostly-0.2 bluff-weighted mix)
  // when "4" really is commissioner, so this should raise P(4 = commissioner)
  assert.ok(posteriorCommissioner > priorCommissioner);

  const total = posteriorWorlds.reduce((sum, w) => sum + w.probability, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.ok(posteriorWorlds.every((w) => w.probability >= 0));
});
