import { test } from "node:test";
import assert from "node:assert/strict";
import { CandidateVote, GameConfig, PlayerId, RoleId, World } from "./types";
import { NightResultFact } from "./night";
import {
  createLikelihoodModel,
  Evidence,
  EvidenceContext,
  LikelihoodModel,
} from "./evidence";
import { DayEliminationFact } from "./facts";
import { generateWorlds } from "./generateWorlds";
import { createHandlers } from "./likelihoodHandlers";
import { createNightResultHandler } from "./nightResultLikelihood";
import { createUniformActionModel } from "./uniformActionModel";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { GameSetting, processEvidence } from "./processEvidence";

/**
 * Integration coverage for a realistic multi-night/multi-day game replayed
 * through processEvidence end to end, using the real (calibrated) handlers -
 * not a hand-rolled reproduction of processEvidence's/the handlers' own
 * logic. Exact Bayesian values are already covered by the unit and
 * differential tests elsewhere (nightResultLikelihood.test.ts,
 * dayEliminationLikelihood.test.ts, uniformActionModel.test.ts); this file
 * focuses on sequencing, alive-state correctness, normalization, impossible
 * worlds, and cross-type compatibility.
 */

const game: GameConfig = {
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

const setting: GameSetting = {
  config: game,
  roles: defaultRoleRegistry,
  groups: defaultGroupRegistry,
};

function night(round: number, died: PlayerId[]): NightResultFact {
  return { type: "nightResult", round, died };
}

function day(round: number, eliminated: PlayerId[]): DayEliminationFact {
  return { type: "dayElimination", round, eliminated };
}

function vote(
  round: number,
  candidates: PlayerId[],
  handsRaised: Partial<Record<PlayerId, PlayerId[]>>
): CandidateVote {
  return { type: "candidateVote", round, stage: "initial", candidates, handsRaised };
}

/**
 * A realistic 8-player replay: night 1 kills "8"; day 1's vote (candidates
 * "2"/"5", abstention going to the last-called "5") gives "5" a clean 4-3
 * win over "2", eliminating "5"; night 2 is quiet; day 2's vote (candidates
 * "2"/"4") gives "4" a clean 4-2 win over "2", eliminating "4"; night 3
 * kills "7". Each vote is a genuine unique winner (no revote/keepOrEliminate
 * needed), so DayEliminationFact's consistency check has exactly one
 * decisive vote to validate against, as voting.ts's resolveCandidateVote
 * would compute it.
 */
const log: Evidence[] = [
  night(1, ["8"]), //                                             0  night 1
  vote(1, ["2", "5"], { "2": ["1", "3", "4"], "5": ["6", "7"] }), // 1  day 1 vote
  day(1, ["5"]), //                                                2  day 1 elimination
  night(2, []), //                                                 3  night 2
  vote(2, ["2", "4"], { "2": ["1", "3"], "4": ["6", "7"] }), //     4  day 2 vote
  day(2, ["4"]), //                                                5  day 2 elimination
  night(3, ["7"]), //                                              6  night 3
];

/** Dead players at the start of each item's own phase, in log order. */
const EXPECTED_DEAD: PlayerId[][] = [
  [], //             0  start of night 1 (before its own death)
  ["8"], //          1  day 1 vote
  ["8"], //          2  day 1 elimination (before its own result)
  ["8", "5"], //     3  start of night 2 (after day 1's elimination)
  ["8", "5"], //     4  day 2 vote (night 2 killed nobody)
  ["8", "5"], //     5  day 2 elimination (before its own result)
  ["8", "5", "4"], // 6  start of night 3 (after day 2's elimination)
];

function dead(alive: Record<string, boolean>): PlayerId[] {
  return Object.keys(alive).filter((p) => !alive[p]);
}

function sortedDead(alive: Record<string, boolean>): PlayerId[] {
  return dead(alive).sort();
}

function realModel(): LikelihoodModel {
  return createLikelihoodModel(
    createHandlers(
      { truthful: 0.9, false: 0.1 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { sameTeamVote: 0.5, differentTeamVote: 0.5, abstain: 0.5 }
    ),
    createNightResultHandler(createUniformActionModel(defaultRoleRegistry))
  );
}

function recordingModel(): {
  model: LikelihoodModel;
  calls: { evidence: Evidence; ctx: EvidenceContext }[];
} {
  const calls: { evidence: Evidence; ctx: EvidenceContext }[] = [];
  const model: LikelihoodModel = {
    likelihood(evidence, _world, ctx) {
      if (calls.length === 0 || calls[calls.length - 1].evidence !== evidence) {
        calls.push({ evidence, ctx });
      }
      return 1;
    },
  };
  return { model, calls };
}

// --- sequencing and alive state, decoupled from calibration ---

test("each item is scored with exactly the evidence recorded before it, in order", () => {
  const { model, calls } = recordingModel();
  const steps = processEvidence(generateWorlds(game), log, model, setting);

  assert.equal(steps.length, log.length);
  log.forEach((evidence, i) => {
    assert.equal(calls[i].evidence, evidence);
    assert.equal(calls[i].ctx, steps[i].context);
    assert.equal(calls[i].ctx.history.length, i);
    calls[i].ctx.history.forEach((item, j) => assert.equal(item, log[j]));
    assert.ok(!calls[i].ctx.history.includes(evidence));
  });
});

test("the alive state at each step matches the game state before that step's own event", () => {
  const { model } = recordingModel();
  const steps = processEvidence(generateWorlds(game), log, model, setting);

  steps.forEach((step, i) => {
    assert.deepEqual(
      sortedDead(step.context.alive),
      [...EXPECTED_DEAD[i]].sort(),
      `step ${i} (${log[i].type})`
    );
  });
});

test("each step's posterior is the next step's prior", () => {
  const { model } = recordingModel();
  const steps = processEvidence(generateWorlds(game), log, model, setting);
  for (let i = 0; i + 1 < steps.length; i++) {
    assert.equal(steps[i + 1].prior, steps[i].posterior);
  }
});

// --- the real pipeline: nightResult, candidateVote and dayElimination together ---

test("the full log runs end to end through the real handlers with every step normalized", () => {
  const steps = processEvidence(generateWorlds(game), log, realModel(), setting);

  assert.equal(steps.length, log.length);
  steps.forEach((step, i) => {
    const total = step.posterior.reduce((sum, w) => sum + w.probability, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `step ${i} total was ${total}`);
    step.posterior.forEach((w) => assert.ok(w.probability >= 0));
  });
});

/**
 * Whether, in `world`, night 2's observed "nobody died" is mechanically
 * impossible: "5" and "8" (dead by the start of night 2) between them hold
 * exactly one of the two kill-mechanic roles (don, mafia) and also hold
 * doctor. With no living doctor, the one surviving killer's kill always
 * succeeds (a single killer's choice is trivially "unanimous"), so `died`
 * can never be empty - the world's likelihood at this step must be exactly
 * 0. This is pure game-mechanics reasoning (mirrors how other tests in this
 * suite hand-compute an expected vote winner), not a reproduction of
 * nightResultLikelihood.ts's own marginalization.
 */
function night2DeathImpossible(world: World): boolean {
  const deadRoles: RoleId[] = [world.roles["5"], world.roles["8"]];
  const killersAlive = 2 - (deadRoles.includes("don") ? 1 : 0) - (deadRoles.includes("mafia") ? 1 : 0);
  const doctorDead = deadRoles.includes("doctor");
  return killersAlive === 1 && doctorDead;
}

test("night 2's quiet result drives exactly the mechanically-impossible worlds to probability 0, through the real cross-night belief chain", () => {
  const steps = processEvidence(generateWorlds(game), log, realModel(), setting);
  const afterNight2 = steps[3].posterior; // index 3 = night(2, [])
  assert.equal(steps[3].evidence, log[3]);

  const impossible = afterNight2.filter(night2DeathImpossible);
  const possible = afterNight2.filter((w) => !night2DeathImpossible(w));

  // sanity: the scenario actually exercises both branches
  assert.ok(impossible.length > 0);
  assert.ok(possible.length > 0);

  // Exact 0 in exact arithmetic; compared with a tolerance because floating-
  // point summation of livingCount copies of 1/livingCount (mafiaOutcomes'
  // consensus mass, with killersAlive === 1 trivially always unanimous)
  // doesn't land on exactly 1, leaving a residual on the order of 1e-16 or
  // smaller - the same class of floating noise this codebase already
  // tolerates elsewhere (e.g. dayEliminationLikelihood.test.ts), not a
  // production bug.
  impossible.forEach((w) => assert.ok(w.probability < 1e-9, `expected ~0, got ${w.probability}`));
  possible.forEach((w) => assert.ok(w.probability > 1e-9));

  const total = afterNight2.reduce((sum, w) => sum + w.probability, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

// --- dead players cannot vote or die again later ---

test("a CandidateVote raising a hand for an already-eliminated player is rejected", () => {
  const badLog: Evidence[] = [
    night(1, ["8"]),
    vote(1, ["2", "5"], { "2": ["1", "3", "4"], "5": ["6", "7"] }),
    day(1, ["5"]),
    vote(2, ["2", "4"], { "2": ["1", "5"], "4": ["6", "7"] }), // "5" already eliminated
  ];
  assert.throws(
    () => processEvidence(generateWorlds(game), badLog, realModel(), setting),
    /voter "5" is not a living player/
  );
});

test("a CandidateVote naming an already-eliminated player as a candidate is rejected", () => {
  const badLog: Evidence[] = [
    night(1, ["8"]),
    vote(1, ["2", "5"], { "2": ["1", "3", "4"], "5": ["6", "7"] }),
    day(1, ["5"]),
    vote(2, ["2", "5"], { "2": ["1", "3"] }), // "5" already eliminated
  ];
  assert.throws(
    () => processEvidence(generateWorlds(game), badLog, realModel(), setting),
    /candidate "5" is not a living player/
  );
});

test("a NightResultFact re-reporting an already-dead player's death is rejected once a later event needs that history", () => {
  const { model } = recordingModel();
  const badLog: Evidence[] = [
    night(1, ["8"]),
    night(2, ["8"]), // "8" already died night 1
    night(3, []), // needs the cumulative alive state, exposing the duplicate
  ];
  assert.throws(
    () => processEvidence(generateWorlds(game), badLog, model, setting),
    /player "8" died but was already dead/
  );
});

// --- no mutation, even with the real (stateful) handlers ---

test("the real pipeline does not mutate the log, the worlds, or earlier steps' contexts", () => {
  const worlds = generateWorlds(game);
  const snapshot = JSON.stringify({ log, worlds });

  const steps = processEvidence(worlds, log, realModel(), setting);

  assert.equal(JSON.stringify({ log, worlds }), snapshot);
  assert.equal(steps[0].prior, worlds);
  assert.notEqual(steps[3].context.history, log);

  steps[3].context.history.push(log[6]);
  steps[3].context.alive["1"] = false;
  assert.equal(log.length, 7);
  assert.equal(steps[4].context.history.length, 4);
  assert.equal(steps[4].context.alive["1"], true);
});
