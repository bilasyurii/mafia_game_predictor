import { test } from "node:test";
import assert from "node:assert/strict";
import { generateWorlds } from "./generateWorlds";
import { GameSetting, processEvidence } from "./processEvidence";
import { createLikelihoodModel } from "./evidence";
import { createHandlers } from "./likelihoodHandlers";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { createNightResultHandler } from "./nightResultLikelihood";
import { createUniformActionModel } from "./uniformActionModel";
import { summarizeReplay, evaluateAgainstGroundTruth } from "./replay";
import { game1Config, game1Evidence, game1GroundTruth, game1Players } from "./game1";

/**
 * Integration test for the first real recorded game: proves the full,
 * un-invented Evidence[] log (see game1.ts) replays end to end through the
 * real inference pipeline, and specifically that the observer's (player 2)
 * death after Night 1 does not stop or skip any later evidence. This does
 * NOT calibrate or tune anything from this game - the likelihood params
 * below are the same kind of plain, non-extreme, test-only values used
 * throughout this project, not a fit to this game's outcome, and nothing
 * here asserts an exact posterior value (that would make this a golden-file
 * test pinned to arbitrary parameters, not a real property).
 */
/**
 * Computed once at module scope, not per-test: this is a pure, deterministic
 * ~30k-world/21-step replay (~10s), and every test below only READS its
 * result - re-running it per test would just repeat the same expensive,
 * side-effect-free computation for no benefit.
 */
const worlds = generateWorlds(game1Config);
const setting: GameSetting = { config: game1Config, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
const model = createLikelihoodModel(
  createHandlers(
    { truthful: 0.8, false: 0.2 },
    undefined,
    { truthful: 0.8, falseResult: 0.15, bluff: 0.25 },
    { sameTeam: 0.5, differentTeam: 0.5 },
    { sameTeam: 0.5, differentTeam: 0.5 },
    undefined,
    { sameTeamVote: 0.5, differentTeamVote: 0.5, abstain: 0.3 }
  ),
  createNightResultHandler(createUniformActionModel(defaultRoleRegistry))
);
const steps = processEvidence(worlds, game1Evidence, model, setting);
const views = summarizeReplay(steps);

test("game1's full evidence log replays through processEvidence without error, as a well-formed distribution at every step", () => {
  assert.equal(steps.length, game1Evidence.length);
  steps.forEach((s) => {
    const total = s.posterior.reduce((sum, w) => sum + w.probability, 0);
    assert.ok(Math.abs(total - 1) < 1e-6, `step ${s.index} (${s.evidence.type}) total=${total}`);
    assert.ok(s.posterior.every((w) => Number.isFinite(w.probability) && w.probability >= 0));
  });
});

test("player 2's death at Night 1 does not stop inference - every later step still updates the posterior, and player 2 is correctly excluded from `alive`", () => {
  // step 0 is Night 1's own NightResultFact - scored against the alive
  // state BEFORE its own deaths, so "2" is still listed alive there
  assert.ok(views[0].alive.includes("2"));

  // every step from index 1 onward (all of Day 2 through Night 3) excludes
  // player 2 - this covers 20 further evidence items across 2 more days
  // and 2 more nights, all after the observer died
  for (let i = 1; i < views.length; i++) {
    assert.ok(!views[i].alive.includes("2"), `step ${i} (${views[i].evidence.type}) still lists "2" as alive`);
  }

  // the posterior keeps genuinely changing after the death, all the way to
  // the last (Night 3) step - inference never silently freezes
  const secondToLast = steps[steps.length - 2].posterior.map((w) => w.probability);
  const last = steps[steps.length - 1].posterior.map((w) => w.probability);
  assert.notDeepEqual(secondToLast, last);

  // the last step IS Night 3's own NightResultFact (died: ["8"]) - like
  // step 0, it's scored against the alive state BEFORE its own death, so
  // "8" is still listed alive here: 10 players - {2,4} (Night 1) - {10}
  // (Day 2 vote) - {1} (Night 2) = {3,5,6,7,8,9}
  assert.deepEqual([...views[views.length - 1].alive].sort(), ["3", "5", "6", "7", "8", "9"]);
});

test("evaluateAgainstGroundTruth runs against the final posterior without altering it - evaluation only, never fed back into inference", () => {
  const finalPosterior = steps[steps.length - 1].posterior;

  const before = finalPosterior.map((w) => w.probability);
  const evaluation = evaluateAgainstGroundTruth(finalPosterior, game1GroundTruth);
  const after = finalPosterior.map((w) => w.probability);
  assert.deepEqual(before, after);

  // exactly the 4 confirmed ground-truth players are evaluated - Doctor/
  // Commissioner are deliberately unconfirmed and correctly absent
  assert.equal(evaluation.length, 4);
  assert.deepEqual(
    evaluation.map((e) => e.player).sort(),
    ["10", "2", "4", "8"]
  );
  evaluation.forEach((e) => {
    assert.ok(e.posteriorProbabilityOfActualRole >= 0 && e.posteriorProbabilityOfActualRole <= 1);
  });
});

test("game1Config's role multiset matches the confirmed composition and every player is accounted for", () => {
  assert.equal(game1Config.players.length, 10);
  assert.equal(game1Config.roles.length, 10);
  assert.deepEqual(game1Config.players, game1Players);
  const counts = game1Config.roles.reduce<Record<string, number>>((acc, r) => {
    acc[r] = (acc[r] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(counts, { don: 1, mafia: 2, doctor: 1, commissioner: 1, citizen: 5 });
});
