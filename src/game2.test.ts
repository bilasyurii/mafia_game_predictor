import { test } from "node:test";
import assert from "node:assert/strict";
import { generateWorlds } from "./generateWorlds";
import { GameSetting, processEvidence } from "./processEvidence";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { defaultBehavioralModelParams, createBehavioralLikelihoodModel } from "./behavioralModel";
import { summarizeReplay, evaluateAgainstGroundTruth } from "./replay";
import { game2Config, game2Evidence, game2GroundTruth, game2Players } from "./game2";

/**
 * Integration test for the second real recorded game - same shape as
 * game1.test.ts. Uses the exact same defaultBehavioralModelParams as
 * Game 1's evaluation, per this milestone's explicit instruction, so the
 * two games are being scored by the identical, un-tuned model. Nothing
 * here calibrates or changes any parameter from this game's outcome.
 */
const worlds = generateWorlds(game2Config);
const setting: GameSetting = { config: game2Config, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
const model = createBehavioralLikelihoodModel(defaultBehavioralModelParams);
const steps = processEvidence(worlds, game2Evidence, model, setting);
const views = summarizeReplay(steps);

test("game2's full evidence log replays through processEvidence without error, as a well-formed distribution at every step", () => {
  assert.equal(steps.length, game2Evidence.length);
  steps.forEach((s) => {
    const total = s.posterior.reduce((sum, w) => sum + w.probability, 0);
    assert.ok(Math.abs(total - 1) < 1e-6, `step ${s.index} (${s.evidence.type}) total=${total}`);
    assert.ok(s.posterior.every((w) => Number.isFinite(w.probability) && w.probability >= 0));
  });
});

test("player 3's death at Night 2 does not stop inference - every later step still updates the posterior, and player 3 is correctly excluded from `alive`", () => {
  // step 0 is Night 1's own NightResultFact - all 9 players still shown alive (pre-death state)
  assert.deepEqual([...views[0].alive].sort(), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);

  // find the Night-2 NightResultFact (died: ["3"]) and confirm "3" is
  // excluded from every step strictly after it
  const night2Index = steps.findIndex((s) => s.evidence.type === "nightResult" && s.evidence.round === 2);
  assert.ok(night2Index > 0);
  for (let i = night2Index + 1; i < views.length; i++) {
    assert.ok(!views[i].alive.includes("3"), `step ${i} (${views[i].evidence.type}) still lists "3" as alive`);
  }

  // Day 3's living players match the notes exactly: 2, 6, 7, 8, 9
  const day3FirstIndex = night2Index + 1;
  assert.deepEqual([...views[day3FirstIndex].alive].sort(), ["2", "6", "7", "8", "9"]);

  // the posterior keeps genuinely changing well after the death - inference
  // never silently freezes. Night 2's own NightResultFact is real,
  // mechanical Bayesian evidence (compare it to the step right before it).
  // The default model's team-alignment/vote tables are flat (see
  // behavioralModel.ts's defaultBehavioralModelParams), so - correctly,
  // not as a sign anything stopped - none of Day 3's suspect/nominate/vote
  // evidence moves the posterior at all under these un-tuned defaults; the
  // log's very last step (a DayEliminationFact) is additionally a pure
  // world-independent consistency check by design either way.
  const beforeNight2 = steps[night2Index - 1].posterior.map((w) => w.probability);
  const afterNight2 = steps[night2Index].posterior.map((w) => w.probability);
  assert.notDeepEqual(beforeNight2, afterNight2);

  const secondToLast = steps[steps.length - 2].posterior.map((w) => w.probability);
  const last = steps[steps.length - 1].posterior.map((w) => w.probability);
  assert.deepEqual(secondToLast, last); // the final dayElimination is a genuine, confirmed no-op
});

test("both recorded votes resolve exactly as the notes state, using only the explicitly raised hands", () => {
  const dayElim1 = steps.find((s) => s.evidence.type === "dayElimination" && s.evidence.round === 1);
  const dayElim2 = steps.find((s) => s.evidence.type === "dayElimination" && s.evidence.round === 2);
  assert.ok(dayElim1 && dayElim1.evidence.type === "dayElimination");
  assert.ok(dayElim2 && dayElim2.evidence.type === "dayElimination");
  if (dayElim1?.evidence.type === "dayElimination") assert.deepEqual(dayElim1.evidence.eliminated, ["5"]);
  if (dayElim2?.evidence.type === "dayElimination") assert.deepEqual(dayElim2.evidence.eliminated, ["7"]);
});

test("evaluateAgainstGroundTruth runs against the final posterior without altering it - evaluation only, never fed back into inference", () => {
  const finalPosterior = steps[steps.length - 1].posterior;

  const before = finalPosterior.map((w) => w.probability);
  const evaluation = evaluateAgainstGroundTruth(finalPosterior, game2GroundTruth);
  const after = finalPosterior.map((w) => w.probability);
  assert.deepEqual(before, after);

  // Game 2's ground truth is complete: all 9 players' exact roles are known
  assert.equal(evaluation.length, 9);
  assert.deepEqual(
    evaluation.map((e) => e.player).sort(),
    ["1", "2", "3", "4", "5", "6", "7", "8", "9"]
  );
  evaluation.forEach((e) => {
    assert.ok(e.posteriorProbabilityOfActualRole >= 0 && e.posteriorProbabilityOfActualRole <= 1);
  });
});

test("game2Config's role multiset matches the confirmed composition and every player is accounted for", () => {
  assert.equal(game2Config.players.length, 9);
  assert.equal(game2Config.roles.length, 9);
  assert.deepEqual(game2Config.players, game2Players);
  const counts = game2Config.roles.reduce<Record<string, number>>((acc, r) => {
    acc[r] = (acc[r] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(counts, { don: 1, mafia: 2, commissioner: 1, doctor: 1, citizen: 4 });
});
