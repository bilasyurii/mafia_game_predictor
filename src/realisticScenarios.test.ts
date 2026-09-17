import { test } from "node:test";
import assert from "node:assert/strict";
import { CandidateVote, GameConfig, RoleExpression, World } from "./types";
import { generateWorlds } from "./generateWorlds";
import { updateProbabilities } from "./updateProbabilities";
import { GameSetting, processEvidence } from "./processEvidence";
import { createLikelihoodModel, Evidence, EvidenceContext } from "./evidence";
import { createHandlers } from "./likelihoodHandlers";
import { getExpressionProbability, getProbability } from "./probability";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { initAliveState } from "./facts";
import {
  createBruteForceNightResultHandler,
  createOptimizedNightResultHandler,
} from "./nightResultLikelihood";
import { createUniformActionModel } from "./uniformActionModel";
import { createCandidateVoteHandler } from "./candidateVoteLikelihood";

/**
 * Realistic, small, controlled sequences of Mafia evidence, run through the
 * real inference pipeline (generateWorlds, processEvidence/updateProbabilities,
 * createLikelihoodModel/createHandlers, the real NightResult handlers and
 * UniformActionModel), asking one question throughout: given EXPLICIT test-
 * only behavioral likelihoods and a realistic public evidence log, does the
 * posterior evolve in the mathematically expected direction, without
 * inventing information or leaking the hidden test world? This is a
 * behavioral-composition audit, not a re-proof of the mechanics already
 * covered in updateProbabilities.test.ts / syntheticScenarios.test.ts.
 *
 * Every non-default likelihood parameter below is local to its own test and
 * chosen only to make the scenario's effect clearly measurable - never a
 * claim about how real Mafia players behave. Every non-trivial expected
 * number here was independently computed against the real project code in a
 * throwaway script before being hardcoded (this project's established
 * practice), the same way updateProbabilities.test.ts's 56.25%/81/88/etc.
 * were.
 */

const standardGame: GameConfig = {
  players: ["1", "2", "3", "4", "5", "6", "7", "8"],
  roles: ["don", "mafia", "doctor", "commissioner", "citizen", "citizen", "citizen", "citizen"],
};
const setting: GameSetting = {
  config: standardGame,
  roles: defaultRoleRegistry,
  groups: defaultGroupRegistry,
};
const mafiaGroup: RoleExpression = { kind: "group", group: "mafia" };
const townGroup: RoleExpression = { kind: "group", group: "town" };

function makeCtx(config: GameConfig): EvidenceContext {
  return {
    config,
    roles: defaultRoleRegistry,
    groups: defaultGroupRegistry,
    alive: initAliveState(config),
    history: [],
  };
}

// ============================================================
// Scenario A: strong Commissioner claim + investigation report
// ============================================================

test("scenario A: a Commissioner self-claim, followed by an investigation report naming a Mafia suspect, moves both posteriors in the expected direction without collapsing to certainty", () => {
  const worlds = generateWorlds(standardGame);
  const log: Evidence[] = [
    { type: "selfRoleClaim", round: 1, actor: "1", claim: { kind: "role", role: "commissioner" } },
    { type: "investigationReport", round: 1, actor: "1", target: "2", mechanic: "checkIsMafia", result: true },
    // a genuinely neutral observation (equal params) - narratively "weak",
    // mathematically a documented no-op, folded in right here so the rest
    // of the chain composes across it without effect
    { type: "suspect", round: 1, actor: "3", target: "4" },
    { type: "nightResult", round: 2, died: [] },
  ];
  const neutralModel = createLikelihoodModel(
    createHandlers(
      { truthful: 0.9, false: 0.1 },
      undefined,
      { truthful: 0.9, falseResult: 0.05, bluff: 0.3 },
      { sameTeam: 1, differentTeam: 1 }
    ),
    createOptimizedNightResultHandler(createUniformActionModel(defaultRoleRegistry))
  );
  const steps = processEvidence(worlds, log, neutralModel, setting);

  // A's Commissioner probability increases after the self-claim - exact
  // odds-ratio move, established in updateProbabilities.test.ts's 0.9/0.1
  // case (9/16 from a 1/8 prior)
  assert.ok(Math.abs(getProbability(steps[0].posterior, "1", "commissioner") - 0.5625) < 1e-9);

  // B's Mafia-team probability increases after the investigation report -
  // exact value, independently derived and confirmed against the real code
  const pBMafiaAfterReport = getExpressionProbability(
    steps[1].posterior,
    "2",
    mafiaGroup,
    defaultGroupRegistry
  );
  assert.ok(Math.abs(pBMafiaAfterReport - 132 / 221) < 1e-9, `pBMafiaAfterReport=${pBMafiaAfterReport}`);
  assert.ok(pBMafiaAfterReport > 0.25); // strictly above the 0.25 prior

  // neither probability is pinned to 0 or 1 - the configured likelihoods
  // are strong but never a hard 0/1 split, so certainty is never implied
  assert.ok(pBMafiaAfterReport > 0 && pBMafiaAfterReport < 1);
  const pACommissionerAfterReport = getProbability(steps[1].posterior, "1", "commissioner");
  assert.ok(Math.abs(pACommissionerAfterReport - 123 / 221) < 1e-9, `pACommissionerAfterReport=${pACommissionerAfterReport}`);
  assert.ok(pACommissionerAfterReport > 0 && pACommissionerAfterReport < 1);

  // players untouched by any of this (5 and 6; 3 and 4, who only appear in
  // the neutral suspicion) remain pairwise symmetric among themselves
  ["5", "6", "7", "8"].slice(1).forEach((p) => {
    assert.ok(
      Math.abs(getProbability(steps[1].posterior, "5", "citizen") - getProbability(steps[1].posterior, p, "citizen")) < 1e-9,
      p
    );
  });
  assert.ok(
    Math.abs(getProbability(steps[1].posterior, "3", "don") - getProbability(steps[1].posterior, "4", "don")) < 1e-9
  );

  // the neutral suspicion step is provably a no-op (equal params)
  steps[2].posterior.forEach((w, i) => {
    assert.ok(Math.abs(w.probability - steps[1].posterior[i].probability) < 1e-9);
  });

  // the whole sequence, including the trailing NightResultFact, stays a
  // well-formed probability distribution throughout - composition never
  // produces NaN, a negative mass, or a total that drifts from 1
  steps.forEach((s) => {
    const total = s.posterior.reduce((sum, w) => sum + w.probability, 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
    assert.ok(s.posterior.every((w) => Number.isFinite(w.probability) && w.probability >= 0));
  });
});

// ============================================================
// Scenario B: contradictory Commissioner claims
// ============================================================

test("scenario B: two players claiming Commissioner with conflicting reports about the same target both move, stay mutually symmetric in their OWN role odds, and never produce an impossible/zero-total posterior", () => {
  const worlds = generateWorlds(standardGame);
  const model = createLikelihoodModel(
    createHandlers({ truthful: 0.9, false: 0.1 }, { truthful: 0.9, false: 0.1 })
  );
  const log: Evidence[] = [
    { type: "selfRoleClaim", round: 1, actor: "1", claim: { kind: "role", role: "commissioner" } },
    { type: "roleAssertion", round: 1, actor: "1", target: "2", claim: { kind: "role", role: "mafia" } },
    { type: "selfRoleClaim", round: 1, actor: "3", claim: { kind: "role", role: "commissioner" } },
    { type: "roleAssertion", round: 1, actor: "3", target: "2", claim: { kind: "group", group: "town" } },
  ];
  const steps = processEvidence(worlds, log, model, setting);

  // both claimants moved from the flat 1/8 prior
  assert.ok(Math.abs(getProbability(steps[0].posterior, "1", "commissioner") - 0.5625) < 1e-9);

  // the claim being contested pulls BOTH claimants' Commissioner odds down
  // from the uncontested 0.5625 (there is only one Commissioner - a second
  // strong claim is real evidence against the first, and vice versa) - but,
  // because RoleAssertion's likelihood here depends only on the target's
  // role (never the actor's own role - see roleAssertionLikelihood.ts), and
  // both actors used the identical self-claim parameters, the two remain
  // EXACTLY symmetric in their own marginal the whole way through: this is
  // a genuine, provable property of the current (actor-independent
  // RoleAssertion) model, not an approximation.
  const p1After3 = getProbability(steps[2].posterior, "1", "commissioner");
  const p3After3 = getProbability(steps[2].posterior, "3", "commissioner");
  assert.ok(Math.abs(p1After3 - p3After3) < 1e-9);
  assert.ok(p1After3 < 0.5625 && p1After3 > 0.125, `p1After3=${p1After3}`);

  const p1Final = getProbability(steps[3].posterior, "1", "commissioner");
  const p3Final = getProbability(steps[3].posterior, "3", "commissioner");
  assert.ok(Math.abs(p1Final - p3Final) < 1e-9);
  assert.ok(Math.abs(p1Final - 0.37274096385543193) < 1e-6, `p1Final=${p1Final}`);

  // B's Mafia-team probability is affected by both reports combined (moved
  // from the 0.25 prior; the two conflicting reports don't simply cancel)
  const pBMafia = getExpressionProbability(steps[3].posterior, "2", mafiaGroup, defaultGroupRegistry);
  const pBTown = getExpressionProbability(steps[3].posterior, "2", townGroup, defaultGroupRegistry);
  assert.ok(Math.abs(pBMafia - 0.1731927710843412) < 1e-6, `pBMafia=${pBMafia}`);
  assert.ok(Math.abs(pBMafia + pBTown - 1) < 1e-9); // mafia/town are complementary in this game

  // no impossible role assignment is created merely by the conflicting
  // claims - the posterior is still a complete, normalized distribution
  const total = steps[3].posterior.reduce((s, w) => s + w.probability, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.ok(steps[3].posterior.every((w) => Number.isFinite(w.probability) && w.probability >= 0));

  // the two claimants ARE treated differently once their claims differ -
  // just not through their raw own-role marginal (shown symmetric above).
  // The asymmetry shows up in a query tied to each one's OWN specific
  // claim: "1 is Commissioner AND 1's own claim (2=mafia exactly) is true"
  // vs "3 is Commissioner AND 3's own claim (2 is in the town group) is
  // true". 3's claim is about a much larger, easier-to-satisfy group, so
  // this compound mass is very different between them, even though the
  // SAME predicate (2=mafia-team) applied to both would stay symmetric.
  const claim1True = steps[3].posterior
    .filter((w) => w.roles["1"] === "commissioner" && w.roles["2"] === "mafia")
    .reduce((s, w) => s + w.probability, 0);
  const claim3True = steps[3].posterior
    .filter(
      (w) =>
        w.roles["3"] === "commissioner" &&
        (w.roles["2"] === "doctor" || w.roles["2"] === "commissioner" || w.roles["2"] === "citizen")
    )
    .reduce((s, w) => s + w.probability, 0);
  assert.ok(Math.abs(claim1True - 0.06099397590361594) < 1e-6, `claim1True=${claim1True}`);
  assert.ok(Math.abs(claim3True - 0.30496987951808) < 1e-6, `claim3True=${claim3True}`);
  assert.ok(claim3True > claim1True * 4); // a large, unambiguous asymmetry
});

// ============================================================
// Scenario C: Mafia-team voting pattern
// ============================================================

test("scenario C: a coordinated voting bloc's likelihood is exactly the configured per-voter product, moves the posterior accordingly, and neither candidate order nor the deterministic outcome adds extra information", () => {
  const worlds = generateWorlds(standardGame);
  const ctx = makeCtx(standardGame);
  const params = { sameTeamVote: 6, differentTeamVote: 1, abstain: 2 };
  const handler = createCandidateVoteHandler(params);
  // 5, 6, 7 vote together for "2"; 8 votes against them for "3"; 1, 2, 3, 4 abstain
  const vote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "initial",
    candidates: ["2", "3"],
    handsRaised: { "2": ["5", "6", "7"], "3": ["8"] },
  };

  // raw likelihood, hand-derived per world: sameTeamVote^k * differentTeamVote^(3-k) * abstain^4
  const wA = worlds.find(
    (w) =>
      w.roles["2"] === "citizen" &&
      w.roles["3"] === "citizen" &&
      w.roles["5"] === "doctor" &&
      w.roles["6"] === "commissioner" &&
      w.roles["7"] === "citizen" &&
      w.roles["8"] === "citizen"
  )!; // 5,6,7 (all town) vote for 2 (town) = same team x3; 8 (town) votes for 3 (town) = same team
  assert.equal(handler(vote, wA, ctx), 6 ** 4 * 16);

  const wB = worlds.find(
    (w) =>
      w.roles["2"] === "citizen" &&
      w.roles["3"] === "citizen" &&
      w.roles["5"] === "mafia" &&
      w.roles["6"] === "commissioner" &&
      w.roles["7"] === "doctor" &&
      w.roles["8"] === "citizen"
  )!; // 5 (mafia) votes for 2 (town) = different team; the rest same as wA
  assert.equal(handler(vote, wB, ctx), 1 * 6 * 6 * 6 * 16);

  const model = createLikelihoodModel(
    createHandlers({ truthful: 0.9, false: 0.1 }, undefined, undefined, undefined, undefined, undefined, params)
  );
  const posterior = updateProbabilities(worlds, vote, model, ctx);

  // the posterior moves in the expected direction for the two flagged
  // players: 5 (who voted WITH the town-looking bloc) becomes less likely
  // Mafia-team; 8 (who voted AGAINST that bloc) becomes more likely
  const priorMafia5 = getExpressionProbability(worlds, "5", mafiaGroup, defaultGroupRegistry);
  const posteriorMafia5 = getExpressionProbability(posterior, "5", mafiaGroup, defaultGroupRegistry);
  const priorMafia8 = getExpressionProbability(worlds, "8", mafiaGroup, defaultGroupRegistry);
  const posteriorMafia8 = getExpressionProbability(posterior, "8", mafiaGroup, defaultGroupRegistry);
  assert.ok(Math.abs(priorMafia5 - 0.25) < 1e-9 && Math.abs(priorMafia8 - 0.25) < 1e-9);
  assert.ok(posteriorMafia5 < priorMafia5, `posteriorMafia5=${posteriorMafia5}`);
  assert.ok(posteriorMafia8 > priorMafia8, `posteriorMafia8=${posteriorMafia8}`);
  assert.ok(Math.abs(posteriorMafia5 - 0.11773759138129798) < 1e-6);
  assert.ok(Math.abs(posteriorMafia8 - 0.35340515582915893) < 1e-6);

  // candidate ordering doesn't matter
  const reordered: CandidateVote = { ...vote, candidates: ["3", "2"] };
  const posteriorReordered = updateProbabilities(worlds, reordered, model, ctx);
  posterior.forEach((w, i) => {
    assert.ok(Math.abs(w.probability - posteriorReordered[i].probability) < 1e-12);
  });

  // the deterministic elimination result itself adds no further role
  // information beyond the raised hands already scored: abstainers' votes
  // go to the last-called candidate ("3"), so "3" (1 direct + 4 abstain = 5)
  // beats "2" (3 direct) and is eliminated - that fact, reported
  // consistently, is a pure world-independent consistency check
  const log: Evidence[] = [vote, { type: "dayElimination", round: 1, eliminated: ["3"] }];
  const steps = processEvidence(worlds, log, model, setting);
  steps[1].posterior.forEach((w, i) => {
    assert.ok(Math.abs(w.probability - steps[0].posterior[i].probability) < 1e-12);
  });
});

// ============================================================
// Scenario D: night result + public evidence, composed
// ============================================================

test("scenario D: a night result, a day vote, a role claim, and a second night result all compose without any step double-counting another", () => {
  const game4: GameConfig = {
    players: ["1", "2", "3", "4"],
    roles: ["mafia", "doctor", "commissioner", "citizen"],
  };
  const worlds4 = generateWorlds(game4);
  const setting4: GameSetting = { config: game4, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const uam = createUniformActionModel(defaultRoleRegistry);
  const handlers = createHandlers(
    { truthful: 0.9, false: 0.1 },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { sameTeamVote: 6, differentTeamVote: 1, abstain: 2 }
  );
  const model = createLikelihoodModel(handlers, createOptimizedNightResultHandler(uam));
  const log: Evidence[] = [
    { type: "nightResult", round: 1, died: [] },
    { type: "candidateVote", round: 1, stage: "initial", candidates: ["2"], handsRaised: { "2": ["1", "3"] } },
    { type: "selfRoleClaim", round: 1, actor: "4", claim: { kind: "role", role: "commissioner" } },
    { type: "nightResult", round: 2, died: ["2"] },
  ];
  const steps = processEvidence(worlds4, log, model, setting4);

  // each layer moves player 4's Commissioner probability in a real,
  // independently-derived way (never resetting to the prior mid-chain)
  const prior = getProbability(worlds4, "4", "commissioner");
  assert.ok(Math.abs(prior - 0.25) < 1e-9);
  assert.ok(Math.abs(getProbability(steps[0].posterior, "4", "commissioner") - 0.25) < 1e-9); // a quiet first night is uninformative for this player in this config
  assert.ok(Math.abs(getProbability(steps[1].posterior, "4", "commissioner") - 0.08843537414965989) < 1e-6);
  assert.ok(Math.abs(getProbability(steps[2].posterior, "4", "commissioner") - 0.46613545816733076) < 1e-6);
  assert.ok(Math.abs(getProbability(steps[3].posterior, "4", "commissioner") - 0.4746051032806805) < 1e-6);

  // no double counting: the chained result must equal, for every world,
  // that world's prior probability times the DIRECT PRODUCT of each
  // evidence item's own likelihood factor (each scored against its own
  // correct context, exactly once) - not e.g. the night result silently
  // reusing or duplicating the vote's contribution
  const combined = worlds4.map((w) => {
    let p = w.probability;
    log.forEach((ev, i) => {
      p *= model.likelihood(ev, w, steps[i].context);
    });
    return p;
  });
  const total = combined.reduce((s, x) => s + x, 0);
  const finalPosterior = steps[3].posterior;
  combined.forEach((raw, i) => {
    assert.ok(Math.abs(raw / total - finalPosterior[i].probability) < 1e-9);
  });

  steps.forEach((s) => {
    const stepTotal = s.posterior.reduce((sum, w) => sum + w.probability, 0);
    assert.ok(Math.abs(stepTotal - 1) < 1e-9);
  });
});

// ============================================================
// Scenario E: Doctor ambiguity across nights, marginalized by hand
// ============================================================

test("scenario E: an ambiguous previous Doctor target is correctly marginalized into the next night's likelihood, matching a hand-derived value (not just brute-force vs optimized agreement)", () => {
  // 3 players: 1=mafia, 2=doctor, 3=citizen. Night 1: died=["3"] - this only
  // happens if the mafia killed 3 (prob 1/3) AND the doctor did NOT save 3
  // (prob 2/3, independently) - so the doctor's real night-1 target is
  // ambiguous between "1" and "3"... no: between the two players who are
  // NOT "3" (the doctor could have saved 1 or 2, each equally likely given
  // died=["3"]): P(target=1 | died=[3]) = P(target=2 | died=[3]) = 1/2 by
  // symmetry of the doctor's independent uniform choice.
  //
  // Night 2 (only "1","2" alive - "3" died): fact died=["1"] requires the
  // mafia (player "1", the only living killer) to target itself (prob 1/2)
  // and the doctor to NOT have saved "1" that night.
  //  - if the excluded (night-1) target was "1": the doctor is FORCED onto
  //    "2" tonight (only 1 legal target left) - so "1" is never saved,
  //    giving P(died=[1] | excluded=1) = P(mafia targets 1) = 1/2.
  //  - if the excluded target was "2": the doctor is FORCED onto "1" -
  //    always saving the mafia's only possible self-target, so death is
  //    impossible: P(died=[1] | excluded=2) = 0.
  // Marginal = 1/2 * 1/2 + 1/2 * 0 = 1/4 - a genuine belief-weighted
  // average, not just picking one assumed previous target.
  const game3: GameConfig = { players: ["1", "2", "3"], roles: ["mafia", "doctor", "citizen"] };
  const world: World = { probability: 1, roles: { "1": "mafia", "2": "doctor", "3": "citizen" } };
  const uam = createUniformActionModel(defaultRoleRegistry);
  const bf = createBruteForceNightResultHandler(uam);
  const opt = createOptimizedNightResultHandler(uam);

  const history: Evidence[] = [{ type: "nightResult", round: 1, died: ["3"] }];
  const ctx: EvidenceContext = {
    config: game3,
    roles: defaultRoleRegistry,
    groups: defaultGroupRegistry,
    alive: { "1": true, "2": true, "3": false },
    history,
  };
  const fact = { type: "nightResult" as const, round: 2, died: ["1"] };

  assert.ok(Math.abs(bf(fact, world, ctx) - 0.25) < 1e-9);
  assert.ok(Math.abs(opt(fact, world, ctx) - 0.25) < 1e-9);

  // sanity-check the night-1 premise itself against the same hand derivation
  const ctx1: EvidenceContext = {
    config: game3,
    roles: defaultRoleRegistry,
    groups: defaultGroupRegistry,
    alive: { "1": true, "2": true, "3": true },
    history: [],
  };
  const fact1 = { type: "nightResult" as const, round: 1, died: ["3"] };
  assert.ok(Math.abs(bf(fact1, world, ctx1) - 2 / 9) < 1e-9);
  assert.ok(Math.abs(opt(fact1, world, ctx1) - 2 / 9) < 1e-9);

  // once the excluded target is dead, the constraint vanishes: a night 3
  // (hypothetically, if both were still alive) would see no exclusion -
  // here we confirm the SAME night-2 likelihood is what a naive, unweighted
  // "average over both possible exclusions is impossible, so use the
  // unconstrained formula" WOULD give only by coincidence of this belief
  // being 50/50 - the true mechanism is the belief-weighted sum above, not
  // a shortcut; changing the night-1 fact changes the belief and would
  // change this number (see the "died=[3]" premise's role above).
});

// ============================================================
// Scenario F: evidence accumulation on a single suspect
// ============================================================

test("scenario F: evidence against one player accumulates step by step, matches direct multiplication, keeps earlier evidence incorporated, and never disturbs unrelated players", () => {
  const worlds = generateWorlds(standardGame);
  const handlers = createHandlers(
    { truthful: 0.9, false: 0.1 },
    undefined,
    { truthful: 0.85, falseResult: 0.05, bluff: 0.3 },
    { sameTeam: 1, differentTeam: 1.5 },
    undefined,
    undefined,
    { sameTeamVote: 1, differentTeamVote: 4, abstain: 2 }
  );
  const model = createLikelihoodModel(handlers);
  const log: Evidence[] = [
    { type: "suspect", round: 1, actor: "1", target: "5" },
    { type: "suspect", round: 1, actor: "3", target: "5" },
    { type: "candidateVote", round: 1, stage: "initial", candidates: ["5", "6"], handsRaised: { "5": ["1", "3"] } },
    { type: "candidateVote", round: 1, stage: "revote", candidates: ["5", "6"], handsRaised: { "5": ["1", "3", "4"] } },
    { type: "investigationReport", round: 1, actor: "2", target: "5", mechanic: "checkIsMafia", result: true },
  ];
  const steps = processEvidence(worlds, log, model, setting);

  const expected = [0.29411764705882054, 0.3433734939759033, 0.644295302013436, 0.9104504833120405, 0.935280992623588];
  let previous = 0.25; // prior
  steps.forEach((s, i) => {
    const p = getExpressionProbability(s.posterior, "5", mafiaGroup, defaultGroupRegistry);
    assert.ok(Math.abs(p - expected[i]) < 1e-6, `step${i}: ${p}`);
    assert.ok(p > previous, `step${i} did not increase: ${previous} -> ${p}`); // strictly monotonic for this exact evidence chain
    previous = p;
  });

  // matches direct multiplication of each step's own factor - no evidence
  // silently replaces or double-applies another's contribution
  const combined = worlds.map((w) => {
    let p = w.probability;
    log.forEach((ev, i) => {
      p *= model.likelihood(ev, w, steps[i].context);
    });
    return p;
  });
  const total = combined.reduce((s, x) => s + x, 0);
  combined.forEach((raw, i) => {
    assert.ok(Math.abs(raw / total - steps[4].posterior[i].probability) < 1e-9);
  });

  // earlier evidence remains incorporated: scoring the final report ALONE
  // (against the flat prior) gives a much smaller shift than the full,
  // accumulated chain - the earlier suspicion/votes are not thrown away
  const reportOnly = updateProbabilities(
    worlds,
    { type: "investigationReport", round: 1, actor: "2", target: "5", mechanic: "checkIsMafia", result: true },
    model,
    steps[4].context
  );
  const pReportOnly = getExpressionProbability(reportOnly, "5", mafiaGroup, defaultGroupRegistry);
  assert.ok(Math.abs(pReportOnly - 0.3183183183183318) < 1e-6);
  assert.ok(pReportOnly < getExpressionProbability(steps[4].posterior, "5", mafiaGroup, defaultGroupRegistry));

  // evidence from unrelated players doesn't accidentally disappear: 7 and 8
  // were never mentioned and remain exactly symmetric with each other
  assert.ok(
    Math.abs(
      getProbability(steps[4].posterior, "7", "citizen") - getProbability(steps[4].posterior, "8", "citizen")
    ) < 1e-9
  );
});

// ============================================================
// Scenario G: misleading evidence, with a hidden (test-only) true world
// ============================================================

test("scenario G: a plausible but false Commissioner claim moves the posterior in the misleading direction, and later contradicting evidence pulls it back - Bayesian inference never had access to the hidden truth", () => {
  // Hidden ground truth, for the test author's benefit only - NEVER passed
  // to generateWorlds, the likelihood model, or any evidence/context: "1"
  // is actually a Citizen who bluffs Commissioner; "6" is actually the Don
  // and later (truthfully, since Don holds checkIsCommissioner) reports
  // that "1" fails a checkIsCommissioner check.
  const worlds = generateWorlds(standardGame);
  const model = createLikelihoodModel(
    createHandlers({ truthful: 0.9, false: 0.1 }, undefined, { truthful: 0.85, falseResult: 0.05, bluff: 0.3 })
  );
  const log: Evidence[] = [
    { type: "selfRoleClaim", round: 1, actor: "1", claim: { kind: "role", role: "commissioner" } },
    { type: "investigationReport", round: 1, actor: "6", target: "1", mechanic: "checkIsCommissioner", result: false },
  ];
  const steps = processEvidence(worlds, log, model, setting);

  const prior = getProbability(worlds, "1", "commissioner");
  const afterBluff = getProbability(steps[0].posterior, "1", "commissioner");
  const afterReport = getProbability(steps[1].posterior, "1", "commissioner");

  assert.ok(Math.abs(prior - 0.125) < 1e-9);
  assert.ok(Math.abs(afterBluff - 0.5625) < 1e-9);
  // the misleading claim moved the posterior UP, away from the truth
  assert.ok(afterBluff > prior);
  // the later, contradicting report pulls it back down again
  assert.ok(afterReport < afterBluff, `afterReport=${afterReport} should be < afterBluff=${afterBluff}`);
  assert.ok(Math.abs(afterReport - 0.4805194805194595) < 1e-6);
  // the model is not required to (and does not) fully recover the flat
  // prior or the true value from just this much evidence - it only reacts
  // to what was actually observed
  assert.ok(afterReport > prior);
});

// ============================================================
// Scenario H: symmetric alternative worlds stay symmetric
// ============================================================

test("scenario H: swapping which of two players holds Don vs plain Mafia leaves a NightResultFact's likelihood exactly unchanged - the mechanic they share is identical, and the mechanic that differs never affects who dies", () => {
  const worlds = generateWorlds(standardGame);
  const w1 = worlds.find(
    (w) =>
      w.roles["1"] === "don" &&
      w.roles["4"] === "mafia" &&
      w.roles["2"] === "doctor" &&
      w.roles["3"] === "commissioner" &&
      w.roles["5"] === "citizen" &&
      w.roles["6"] === "citizen" &&
      w.roles["7"] === "citizen" &&
      w.roles["8"] === "citizen"
  )!;
  const w2 = worlds.find(
    (w) =>
      w.roles["1"] === "mafia" &&
      w.roles["4"] === "don" &&
      w.roles["2"] === "doctor" &&
      w.roles["3"] === "commissioner" &&
      w.roles["5"] === "citizen" &&
      w.roles["6"] === "citizen" &&
      w.roles["7"] === "citizen" &&
      w.roles["8"] === "citizen"
  )!;
  const ctx = makeCtx(standardGame);
  const uam = createUniformActionModel(defaultRoleRegistry);
  const bf = createBruteForceNightResultHandler(uam);
  const opt = createOptimizedNightResultHandler(uam);
  const fact = { type: "nightResult" as const, round: 1, died: ["6"] };

  assert.equal(bf(fact, w1, ctx), bf(fact, w2, ctx));
  assert.equal(opt(fact, w1, ctx), opt(fact, w2, ctx));
  assert.ok(Math.abs(bf(fact, w1, ctx) - 0.0107421875) < 1e-9);
});

test("scenario H: two untouched Citizens and two untouched Town players remain exactly equal after a realistic evidence sequence about other players", () => {
  const worlds = generateWorlds(standardGame);
  const model = createLikelihoodModel(
    createHandlers({ truthful: 0.9, false: 0.1 }, undefined, undefined, { sameTeam: 4, differentTeam: 1 })
  );
  const log: Evidence[] = [
    { type: "selfRoleClaim", round: 1, actor: "1", claim: { kind: "role", role: "commissioner" } },
    { type: "suspect", round: 1, actor: "2", target: "3" },
  ];
  const steps = processEvidence(worlds, log, model, setting);
  const posterior = steps[1].posterior;

  // 5,6,7,8 are all untouched citizens: pairwise equal
  ["6", "7", "8"].forEach((p) => {
    assert.ok(Math.abs(getProbability(posterior, "5", "citizen") - getProbability(posterior, p, "citizen")) < 1e-9, p);
  });
  // Doctor vs Commissioner-holding probability for an untouched player (4)
  // and the town-team probability of two untouched players stay tied
  assert.ok(
    Math.abs(
      getExpressionProbability(posterior, "5", townGroup, defaultGroupRegistry) -
        getExpressionProbability(posterior, "6", townGroup, defaultGroupRegistry)
    ) < 1e-9
  );
});

// ============================================================
// Scenario I: evidence with no information
// ============================================================

test("scenario I: a realistic-looking but entirely uninformative evidence sequence (every relevant likelihood equal) leaves the posterior exactly equal to the prior", () => {
  const worlds = generateWorlds(standardGame);
  const model = createLikelihoodModel(
    createHandlers(
      { truthful: 0.5, false: 0.5 },
      undefined,
      undefined,
      { sameTeam: 3, differentTeam: 3 },
      undefined,
      undefined,
      { sameTeamVote: 2, differentTeamVote: 2, abstain: 5 }
    )
  );
  const log: Evidence[] = [
    { type: "suspect", round: 1, actor: "1", target: "5" },
    { type: "candidateVote", round: 1, stage: "initial", candidates: ["5", "6"], handsRaised: { "5": ["1", "3"] } },
    { type: "selfRoleClaim", round: 1, actor: "2", claim: { kind: "role", role: "commissioner" } },
  ];
  const steps = processEvidence(worlds, log, model, setting);

  steps[2].posterior.forEach((w, i) => {
    assert.ok(Math.abs(w.probability - worlds[i].probability) < 1e-9);
  });
});
