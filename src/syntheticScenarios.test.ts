import { test } from "node:test";
import assert from "node:assert/strict";
import { CandidateVote, GameConfig, RoleExpression, World } from "./types";
import { generateWorlds } from "./generateWorlds";
import { updateProbabilities } from "./updateProbabilities";
import { GameSetting, processEvidence } from "./processEvidence";
import {
  createLikelihoodModel,
  Evidence,
  EvidenceContext,
  LikelihoodModel,
  ObservationHandlerMap,
} from "./evidence";
import { createHandlers } from "./likelihoodHandlers";
import { getExpressionProbability, getProbability } from "./probability";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { initAliveState } from "./facts";
import {
  createBruteForceNightResultHandler,
  createNightResultHandler,
  createOptimizedNightResultHandler,
} from "./nightResultLikelihood";
import { createUniformActionModel } from "./uniformActionModel";
import { createCandidateVoteHandler } from "./candidateVoteLikelihood";
import { createTeamAlignmentHandler } from "./teamAlignmentLikelihood";

/**
 * Controlled, hand-derived synthetic scenarios validating the END-TO-END
 * behavior of the real inference pipeline (generateWorlds, updateProbabilities,
 * processEvidence, createLikelihoodModel/createHandlers, real handlers,
 * real UniformActionModel/NightResult handler, real voting handlers). This
 * does NOT calibrate the model - every non-default likelihood parameter
 * used below is local to its own test, chosen only to make the arithmetic
 * exact and easy to hand-verify. Every expected number in this file was
 * cross-checked against the real project functions in a throwaway script
 * before being hardcoded here (this project's established practice).
 */

function oddsOf(p: number): number {
  return p / (1 - p);
}

// ============================================================
// Area 1: prior sanity (standard 8-player config)
// ============================================================

const standardGame: GameConfig = {
  players: ["1", "2", "3", "4", "5", "6", "7", "8"],
  roles: ["don", "mafia", "doctor", "commissioner", "citizen", "citizen", "citizen", "citizen"],
};

test("area 1: the standard config has 1680 worlds, a normalized prior, and symmetric exact-role marginals", () => {
  const worlds = generateWorlds(standardGame);
  assert.equal(worlds.length, 1680);

  const total = worlds.reduce((s, w) => s + w.probability, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);

  // every singleton role: 1/8 for any given player; citizen (x4): 4/8
  standardGame.players.forEach((p) => {
    assert.ok(Math.abs(getProbability(worlds, p, "don") - 0.125) < 1e-9, p);
    assert.ok(Math.abs(getProbability(worlds, p, "mafia") - 0.125) < 1e-9, p);
    assert.ok(Math.abs(getProbability(worlds, p, "doctor") - 0.125) < 1e-9, p);
    assert.ok(Math.abs(getProbability(worlds, p, "commissioner") - 0.125) < 1e-9, p);
    assert.ok(Math.abs(getProbability(worlds, p, "citizen") - 0.5) < 1e-9, p);
  });
});

test("area 1: Mafia-group and Town-group prior probabilities are complementary and symmetric across players", () => {
  const worlds = generateWorlds(standardGame);
  const mafiaGroup: RoleExpression = { kind: "group", group: "mafia" };
  const townGroup: RoleExpression = { kind: "group", group: "town" };

  standardGame.players.forEach((p) => {
    const mafiaP = getExpressionProbability(worlds, p, mafiaGroup, defaultGroupRegistry);
    const townP = getExpressionProbability(worlds, p, townGroup, defaultGroupRegistry);
    assert.ok(Math.abs(mafiaP - 0.25) < 1e-9, p); // (don+mafia)/8
    assert.ok(Math.abs(townP - 0.75) < 1e-9, p); // (doctor+commissioner+4 citizen)/8
    assert.ok(Math.abs(mafiaP + townP - 1) < 1e-9, p);
  });
});

// ============================================================
// Area 2: posterior normalization
// ============================================================

test("area 2: a hard 0/1 split zeroes excluded worlds exactly and leaves the rest correctly normalized", () => {
  const worlds = generateWorlds(standardGame);
  const ctx = makeCtx(standardGame);
  const hardSplit: ObservationHandlerMap = {
    selfRoleClaim: (o, w) =>
      o.claim.kind === "role" && w.roles[o.actor] === o.claim.role ? 1 : 0,
    roleAssertion: notExercised,
    investigationReport: notExercised,
    candidateVote: notExercised,
    keepOrEliminateVote: notExercised,
    suspect: notExercised,
    defend: notExercised,
    nominate: notExercised,
  };
  const model = createLikelihoodModel(hardSplit);
  const posterior = updateProbabilities(
    worlds,
    { type: "selfRoleClaim", round: 1, actor: "1", claim: { kind: "role", role: "don" } },
    model,
    ctx
  );

  posterior.forEach((w) => {
    assert.ok(Number.isFinite(w.probability));
    assert.ok(w.probability >= 0);
    if (w.roles["1"] === "don") {
      assert.ok(w.probability > 0);
    } else {
      assert.equal(w.probability, 0); // exactly 0, not floating-point dust
    }
  });
  const total = posterior.reduce((s, w) => s + w.probability, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);

  // unrelated structure (which of players 2..8 holds which OTHER role) stays
  // internally symmetric among themselves - nothing was "accidentally"
  // removed beyond the worlds the evidence actually excludes
  const citizens = ["5", "6", "7", "8"];
  const p5 = getProbability(posterior, "5", "citizen");
  citizens.slice(1).forEach((p) => {
    assert.ok(Math.abs(getProbability(posterior, p, "citizen") - p5) < 1e-9, p);
  });
});

// ============================================================
// Area 3: symmetry invariants
// ============================================================

test("area 3: players untouched by evidence remain fully symmetric with each other", () => {
  const worlds = generateWorlds(standardGame);
  const ctx = makeCtx(standardGame);
  const model = createLikelihoodModel(createHandlers({ truthful: 0.8, false: 0.2 }));
  const posterior = updateProbabilities(
    worlds,
    { type: "selfRoleClaim", round: 1, actor: "1", claim: { kind: "role", role: "commissioner" } },
    model,
    ctx
  );

  // players 2..8 are all equally untouched by evidence about player "1" -
  // every one of them must have the identical marginal for every role
  const others = ["2", "3", "4", "5", "6", "7", "8"];
  (["don", "mafia", "doctor", "commissioner", "citizen"] as const).forEach((role) => {
    const p2 = getProbability(posterior, "2", role);
    others.slice(1).forEach((p) => {
      assert.ok(Math.abs(getProbability(posterior, p, role) - p2) < 1e-9, `${p}=${role}`);
    });
  });
});

test("area 3: relabeling the actor in otherwise-identical evidence produces the correspondingly relabeled posterior", () => {
  const model = createLikelihoodModel(createHandlers({ truthful: 0.8, false: 0.2 }));

  const worldsA = generateWorlds(standardGame);
  const posteriorA = updateProbabilities(
    worldsA,
    { type: "selfRoleClaim", round: 1, actor: "1", claim: { kind: "role", role: "commissioner" } },
    model,
    makeCtx(standardGame)
  );

  const worldsB = generateWorlds(standardGame);
  const posteriorB = updateProbabilities(
    worldsB,
    { type: "selfRoleClaim", round: 1, actor: "2", claim: { kind: "role", role: "commissioner" } },
    model,
    makeCtx(standardGame)
  );

  assert.ok(
    Math.abs(
      getProbability(posteriorA, "1", "commissioner") -
        getProbability(posteriorB, "2", "commissioner")
    ) < 1e-9
  );
});

test("area 3: don and mafia stay symmetric under evidence that only distinguishes team, never the specific mafia-team role", () => {
  const worlds = generateWorlds(standardGame);
  const ctx = makeCtx(standardGame);
  const model = createLikelihoodModel(
    createHandlers(
      { truthful: 0.9, false: 0.1 },
      undefined,
      undefined,
      { sameTeam: 9, differentTeam: 1 }
    )
  );
  const posterior = updateProbabilities(
    worlds,
    { type: "suspect", round: 1, actor: "1", target: "2" },
    model,
    ctx
  );

  // team-alignment evidence never distinguishes don from ordinary mafia -
  // every player's P(=don) must still equal their own P(=mafia)
  standardGame.players.forEach((p) => {
    assert.ok(
      Math.abs(getProbability(posterior, p, "don") - getProbability(posterior, p, "mafia")) < 1e-9,
      p
    );
  });
});

// ============================================================
// Area 4: controlled exact-role SelfRoleClaim evidence
// ============================================================

const fivePlayerGame: GameConfig = {
  players: ["1", "2", "3", "4", "5"],
  roles: ["don", "mafia", "doctor", "commissioner", "citizen"],
};

test("area 4: a self-claim moves the odds of the claimed exact role by exactly the configured likelihood ratio, for every role", () => {
  const roles = ["don", "mafia", "doctor", "commissioner", "citizen"] as const;
  roles.forEach((role) => {
    const worlds = generateWorlds(fivePlayerGame);
    const ctx = makeCtx(fivePlayerGame);
    const model = createLikelihoodModel(createHandlers({ truthful: 0.8, false: 0.2 }));
    const posterior = updateProbabilities(
      worlds,
      { type: "selfRoleClaim", round: 1, actor: "1", claim: { kind: "role", role } },
      model,
      ctx
    );

    const priorP = 1 / 5;
    const posteriorP = getProbability(posterior, "1", role);
    const ratio = oddsOf(posteriorP) / oddsOf(priorP);
    assert.ok(Math.abs(ratio - 4) < 1e-9, `${role}: ratio=${ratio}`); // 0.8/0.2
    assert.ok(Math.abs(posteriorP - 0.5) < 1e-9, role); // odds 1/4*4=1 -> p=0.5

    // worlds where "1" truly holds the claimed role got the truthful factor;
    // every other world got the false factor - confirmed by the exact ratio
    // above already discriminating them into exactly two groups.
  });
});

// ============================================================
// Area 5: group evidence (RoleAssertion) aggregates exact-role probabilities
// ============================================================

test("area 5: a Mafia-group RoleAssertion treats Don and ordinary Mafia as the same claimed group, and group probability equals the sum of exact-role probabilities", () => {
  const worlds = generateWorlds(fivePlayerGame);
  const ctx = makeCtx(fivePlayerGame);
  const model = createLikelihoodModel(
    createHandlers({ truthful: 0.9, false: 0.1 }, { truthful: 0.8, false: 0.2 })
  );
  const mafiaGroup: RoleExpression = { kind: "group", group: "mafia" };
  const posterior = updateProbabilities(
    worlds,
    { type: "roleAssertion", round: 1, actor: "1", target: "2", claim: mafiaGroup },
    model,
    ctx
  );

  const groupP = getExpressionProbability(posterior, "2", mafiaGroup, defaultGroupRegistry);
  assert.ok(Math.abs(groupP - 8 / 11) < 1e-9, `groupP=${groupP}`);

  const donP = getProbability(posterior, "2", "don");
  const mafiaP = getProbability(posterior, "2", "mafia");
  assert.ok(Math.abs(donP + mafiaP - groupP) < 1e-9);
  // the claim never distinguished don from mafia, so they stay equal
  assert.ok(Math.abs(donP - mafiaP) < 1e-9);
});

test("area 5: Town-group and ActiveTown-group RoleAssertions aggregate correctly", () => {
  const model = createHandlers({ truthful: 0.9, false: 0.1 }, { truthful: 0.8, false: 0.2 });

  const townWorlds = generateWorlds(fivePlayerGame);
  const townGroup: RoleExpression = { kind: "group", group: "town" };
  const townPosterior = updateProbabilities(
    townWorlds,
    { type: "roleAssertion", round: 1, actor: "1", target: "2", claim: townGroup },
    createLikelihoodModel(model),
    makeCtx(fivePlayerGame)
  );
  assert.ok(
    Math.abs(getExpressionProbability(townPosterior, "2", townGroup, defaultGroupRegistry) - 6 / 7) <
      1e-9
  );

  const activeWorlds = generateWorlds(fivePlayerGame);
  const activeTownGroup: RoleExpression = { kind: "group", group: "activeTown" };
  const activePosterior = updateProbabilities(
    activeWorlds,
    { type: "roleAssertion", round: 1, actor: "1", target: "2", claim: activeTownGroup },
    createLikelihoodModel(model),
    makeCtx(fivePlayerGame)
  );
  assert.ok(
    Math.abs(
      getExpressionProbability(activePosterior, "2", activeTownGroup, defaultGroupRegistry) - 8 / 11
    ) < 1e-9
  );
});

// ============================================================
// Area 6: InvestigationReport semantic partition (truthful/falseResult/bluff)
// ============================================================

test("area 6: checkIsMafia report partitions worlds into truthful/falseResult/bluff exactly as derived by hand", () => {
  const worlds = generateWorlds(fivePlayerGame);
  const ctx = makeCtx(fivePlayerGame);
  const model = createLikelihoodModel(
    createHandlers(
      { truthful: 0.9, false: 0.1 },
      undefined,
      { truthful: 0.8, falseResult: 0.1, bluff: 0.3 }
    )
  );
  const posterior = updateProbabilities(
    worlds,
    {
      type: "investigationReport",
      round: 1,
      actor: "1",
      target: "2",
      mechanic: "checkIsMafia",
      result: true,
    },
    model,
    ctx
  );

  // P(1=commissioner) = truthful-bucket + falseResult-bucket mass, by hand:
  // P(canPerform)=1/5, split 50/50 by whether "2" is mafia-team given "1"=commissioner
  // truthful mass=1/10*0.8, falseResult mass=1/10*0.1, bluff mass=4/5*0.3
  // total=0.33; P(commissioner)=(0.08+0.01)/0.33=9/33=3/11
  const pCommissioner = getProbability(posterior, "1", "commissioner");
  assert.ok(Math.abs(pCommissioner - 3 / 11) < 1e-9, `pCommissioner=${pCommissioner}`);
  // anyone who can't perform checkIsMafia (i.e. isn't commissioner) bluffed -
  // that's the complementary mass, unaffected by whether the bluff happens
  // to match reality
  assert.ok(Math.abs(1 - pCommissioner - 8 / 11) < 1e-9);
});

test("area 6: checkIsCommissioner report is gated on Don, not Commissioner, and detects only the Commissioner role", () => {
  const worlds = generateWorlds(fivePlayerGame);
  const ctx = makeCtx(fivePlayerGame);
  const model = createLikelihoodModel(
    createHandlers(
      { truthful: 0.9, false: 0.1 },
      undefined,
      { truthful: 0.8, falseResult: 0.1, bluff: 0.3 }
    )
  );
  const posterior = updateProbabilities(
    worlds,
    {
      type: "investigationReport",
      round: 1,
      actor: "1",
      target: "2",
      mechanic: "checkIsCommissioner",
      result: true,
    },
    model,
    ctx
  );

  // P(canPerform)=P(1=don)=1/5; given that, P(2=commissioner)=1/4
  // truthful mass=1/20*0.8, falseResult mass=3/20*0.1, bluff mass=16/20*0.3
  // total=0.04+0.015+0.24=0.295; P(1=don)=(0.04+0.015)/0.295=11/59
  const pDon = getProbability(posterior, "1", "don");
  assert.ok(Math.abs(pDon - 11 / 59) < 1e-9, `pDon=${pDon}`);
});

// ============================================================
// Area 7: TeamAlignment (Suspect/Defend/Nominate) exact-ratio and
// role-invariance-within-team behavior; also area 14 (monotonicity)
// ============================================================

test("area 7/14: a suspect action moves the odds of same-team vs different-team worlds by exactly the configured ratio", () => {
  const game3: GameConfig = { players: ["1", "2", "3"], roles: ["mafia", "citizen", "citizen"] };
  const worlds = generateWorlds(game3);
  const ctx = makeCtx(game3);
  const handler = createTeamAlignmentHandler<{
    type: "suspect";
    round: number;
    actor: string;
    target: string;
  }>({ sameTeam: 9, differentTeam: 1 });
  const observation = { type: "suspect" as const, round: 1, actor: "1", target: "2" };

  const likelihoods = worlds.map((w) => handler(observation, w, ctx));
  // exactly one world has "1" and "2" on the same team (mafia="3"); the
  // other two have them on different teams
  const sameTeamCount = likelihoods.filter((l) => l === 9).length;
  const differentTeamCount = likelihoods.filter((l) => l === 1).length;
  assert.equal(sameTeamCount, 1);
  assert.equal(differentTeamCount, 2);

  const posterior = updateProbabilities(worlds, observation, createLikelihoodModel(
    createHandlers({ truthful: 0.9, false: 0.1 }, undefined, undefined, { sameTeam: 9, differentTeam: 1 })
  ), ctx);
  // "3" holds mafia iff "1"/"2" are same team; prior odds for that were
  // 1/2 (1 same-team world vs 2 different-team worlds) - the observation's
  // exact 9:1 likelihood ratio must move those odds to exactly 1/2*9=4.5,
  // i.e. p=4.5/5.5=9/11 - not merely "up", but by precisely that factor
  const sameTeamWorldP = getProbability(posterior, "3", "mafia");
  const priorOdds = oddsOf(1 / 3);
  const posteriorOdds = oddsOf(sameTeamWorldP);
  assert.ok(Math.abs(posteriorOdds / priorOdds - 9) < 1e-9, `ratio=${posteriorOdds / priorOdds}`);
  assert.ok(Math.abs(sameTeamWorldP - 9 / 11) < 1e-9, `sameTeamWorldP=${sameTeamWorldP}`);
});

test("area 7: team-alignment evidence never distinguishes roles within the same team (doctor vs commissioner vs citizen)", () => {
  const game4: GameConfig = { players: ["1", "2", "3", "4"], roles: ["mafia", "doctor", "commissioner", "citizen"] };
  const worlds = generateWorlds(game4);
  const ctx = makeCtx(game4);
  const model = createLikelihoodModel(
    createHandlers({ truthful: 0.9, false: 0.1 }, undefined, undefined, undefined, { sameTeam: 9, differentTeam: 1 })
  );
  const posterior = updateProbabilities(
    worlds,
    { type: "defend", round: 1, actor: "1", target: "2" },
    model,
    ctx
  );

  // "1" and "2" are on the same (town) team in every world where "1" isn't
  // mafia - and within that set, doctor/commissioner/citizen are entirely
  // interchangeable labels as far as this evidence is concerned, so "1"'s
  // marginal must be flat across all three town roles
  assert.ok(
    Math.abs(getProbability(posterior, "1", "doctor") - getProbability(posterior, "1", "commissioner")) <
      1e-9
  );
  assert.ok(
    Math.abs(
      getProbability(posterior, "1", "commissioner") - getProbability(posterior, "1", "citizen")
    ) < 1e-9
  );
});

// ============================================================
// Area 8: CandidateVote scenarios
// ============================================================

test("area 8: every living voter contributes exactly once, team-aligned raised hands and abstentions are scored with the configured factors, and candidate order/deterministic outcome never affect the likelihood", () => {
  const game4: GameConfig = { players: ["1", "2", "3", "4"], roles: ["mafia", "citizen", "citizen", "citizen"] };
  const worlds = generateWorlds(game4);
  const ctx = makeCtx(game4);
  const handler = createCandidateVoteHandler({ sameTeamVote: 9, differentTeamVote: 1, abstain: 2 });
  const vote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "initial",
    candidates: ["2"],
    handsRaised: { "2": ["1"] }, // "1" raises a hand for "2"; "2","3","4" abstain
  };

  // hand-derived: likelihood = (sameTeamVote|differentTeamVote for "1"->"2") * abstain^3
  const expected: Record<string, number> = { "1": 8, "2": 8, "3": 72, "4": 72 }; // keyed by which seat holds "mafia"
  worlds.forEach((w) => {
    const mafiaSeat = Object.keys(w.roles).find((p) => w.roles[p] === "mafia")!;
    assert.ok(
      Math.abs(handler(vote, w, ctx) - expected[mafiaSeat]) < 1e-9,
      `mafia@${mafiaSeat}: got ${handler(vote, w, ctx)}, expected ${expected[mafiaSeat]}`
    );
  });

  // candidate ordering doesn't change the likelihood (only handsRaised does)
  const vote2: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "initial",
    candidates: ["2", "3"],
    handsRaised: { "2": ["1"] },
  };
  const vote2Reordered: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "initial",
    candidates: ["3", "2"],
    handsRaised: { "2": ["1"] },
  };
  worlds.forEach((w) => {
    assert.ok(Math.abs(handler(vote2, w, ctx) - handler(vote2Reordered, w, ctx)) < 1e-12);
  });

  // the handler never consults the deterministic outcome: verify it doesn't
  // change even when paired, in a real log, with a DayEliminationFact
  const setting: GameSetting = { config: game4, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const realModel = createLikelihoodModel(
    createHandlers(
      { truthful: 0.9, false: 0.1 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { sameTeamVote: 9, differentTeamVote: 1, abstain: 2 }
    )
  );
  const log: Evidence[] = [
    vote,
    { type: "dayElimination", round: 1, eliminated: ["2"] }, // consistent with vote's unique winner "2"
  ];
  const steps = processEvidence(worlds, log, realModel, setting);
  // the day-elimination step is world-independent (likelihood 1) so the
  // vote step's posterior must be untouched by it
  steps[1].posterior.forEach((w, i) => {
    assert.ok(Math.abs(w.probability - steps[0].posterior[i].probability) < 1e-12);
  });
});

// ============================================================
// Area 9: NightResult scenarios, hand-derived and cross-checked against
// both brute-force and optimized (never just against each other)
// ============================================================

test("area 9: one living Mafia, no doctor/commissioner - kill always succeeds, target uniform over living players", () => {
  const game2: GameConfig = { players: ["1", "2"], roles: ["mafia", "citizen"] };
  const worlds = generateWorlds(game2);
  const ctx = makeCtx(game2);
  const uam = createUniformActionModel(defaultRoleRegistry);
  const bf = createBruteForceNightResultHandler(uam);
  const opt = createOptimizedNightResultHandler(uam);
  const fact = { type: "nightResult" as const, round: 1, died: ["2"] };

  worlds.forEach((w) => {
    // by hand: whichever player is mafia, their kill always succeeds
    // (single killer = trivial unanimity), uniformly targeting either
    // living player including self - died=["2"] iff the kill landed on
    // "2", probability 1/2 regardless of which world
    assert.ok(Math.abs(bf(fact, w, ctx) - 0.5) < 1e-9);
    assert.ok(Math.abs(opt(fact, w, ctx) - 0.5) < 1e-9);
  });

  // died=[] is mechanically impossible with a lone living killer and no
  // doctor - both paths must agree it's exactly 0
  const quiet = { type: "nightResult" as const, round: 1, died: [] as string[] };
  worlds.forEach((w) => {
    assert.equal(bf(quiet, w, ctx), 0);
    assert.equal(opt(quiet, w, ctx), 0);
  });
});

test("area 9: two living Mafia require consensus - no-death probability is 2/3 in every world, independent of who specifically holds Mafia", () => {
  const game3: GameConfig = { players: ["1", "2", "3"], roles: ["mafia", "mafia", "citizen"] };
  const worlds = generateWorlds(game3);
  const ctx = makeCtx(game3);
  const uam = createUniformActionModel(defaultRoleRegistry);
  const bf = createBruteForceNightResultHandler(uam);
  const opt = createOptimizedNightResultHandler(uam);
  const quiet = { type: "nightResult" as const, round: 1, died: [] as string[] };

  worlds.forEach((w) => {
    // consensus mass on any one target = 1/3^2 = 1/9, times 3 targets =
    // 1/3; no-consensus (=no kill, since no doctor/commissioner either) =
    // 2/3, for every world regardless of which two seats hold mafia
    assert.ok(Math.abs(bf(quiet, w, ctx) - 2 / 3) < 1e-9);
    assert.ok(Math.abs(opt(quiet, w, ctx) - 2 / 3) < 1e-9);
  });
});

test("area 9: with zero living Mafia (mafia-holder dead), the night is certainly quiet and any death is impossible", () => {
  const game2: GameConfig = { players: ["1", "2"], roles: ["mafia", "citizen"] };
  const worlds = generateWorlds(game2);
  const deadMafiaWorld = worlds.find((w) => w.roles["1"] === "mafia")!;
  const alive = { "1": false, "2": true }; // the mafia-holder is dead
  const ctx: EvidenceContext = { config: game2, roles: defaultRoleRegistry, groups: defaultGroupRegistry, alive, history: [] };
  const uam = createUniformActionModel(defaultRoleRegistry);
  const bf = createBruteForceNightResultHandler(uam);
  const opt = createOptimizedNightResultHandler(uam);

  assert.equal(bf({ type: "nightResult", round: 1, died: [] }, deadMafiaWorld, ctx), 1);
  assert.equal(opt({ type: "nightResult", round: 1, died: [] }, deadMafiaWorld, ctx), 1);
  assert.equal(bf({ type: "nightResult", round: 1, died: ["2"] }, deadMafiaWorld, ctx), 0);
  assert.equal(opt({ type: "nightResult", round: 1, died: ["2"] }, deadMafiaWorld, ctx), 0);
});

test("area 9: Doctor protection - no-death probability is 1/2, symmetric regardless of which player holds which role", () => {
  const game2: GameConfig = { players: ["1", "2"], roles: ["mafia", "doctor"] };
  const worlds = generateWorlds(game2);
  const ctx = makeCtx(game2);
  const uam = createUniformActionModel(defaultRoleRegistry);
  const bf = createBruteForceNightResultHandler(uam);
  const opt = createOptimizedNightResultHandler(uam);
  const quiet = { type: "nightResult" as const, round: 1, died: [] as string[] };

  // by hand: died=[] iff doctor's target = killer's target; 2 matching
  // pairs out of 4 combinations = 1/2, for either assignment of the roles
  worlds.forEach((w) => {
    assert.ok(Math.abs(bf(quiet, w, ctx) - 0.5) < 1e-9);
    assert.ok(Math.abs(opt(quiet, w, ctx) - 0.5) < 1e-9);
  });
});

test("area 9: Commissioner-caused death produces a directional (asymmetric) likelihood that distinguishes which player holds which role - a genuine, non-trivial observation", () => {
  const game2: GameConfig = { players: ["1", "2"], roles: ["mafia", "commissioner"] };
  const worlds = generateWorlds(game2);
  const ctx = makeCtx(game2);
  const uam = createUniformActionModel(defaultRoleRegistry);
  const bf = createBruteForceNightResultHandler(uam);
  const opt = createOptimizedNightResultHandler(uam);
  const fact = { type: "nightResult" as const, round: 1, died: ["1"] };

  const world1 = worlds.find((w) => w.roles["1"] === "mafia")!; // "1"=mafia, "2"=commissioner
  const world2 = worlds.find((w) => w.roles["1"] === "commissioner")!; // "1"=commissioner, "2"=mafia

  // hand-derived (see this milestone's report): P(died=["1"] | world1) = 1/2
  // (mafia's kill lands on "1", commissioner's check is inert either way
  // since checking "2" - itself - is never positive); P(died=["1"] | world2)
  // = 1/4 (only the single combination where mafia kills "1" AND the
  // commissioner's own self-check also happens to name "1" - which is
  // negative and adds nothing - matches; the other kt'=1 combination where
  // the commissioner checks "2"=mafia instead ALSO kills "2", so died
  // becomes {1,2}, not {1} alone)
  assert.ok(Math.abs(bf(fact, world1, ctx) - 0.5) < 1e-9);
  assert.ok(Math.abs(opt(fact, world1, ctx) - 0.5) < 1e-9);
  assert.ok(Math.abs(bf(fact, world2, ctx) - 0.25) < 1e-9);
  assert.ok(Math.abs(opt(fact, world2, ctx) - 0.25) < 1e-9);

  // so this single NightResultFact genuinely discriminates between the two
  // worlds - a real, directional Bayesian update, unlike DayEliminationFact
  assert.notEqual(bf(fact, world1, ctx), bf(fact, world2, ctx));
});

// ============================================================
// Area 10: Doctor cross-night belief propagation
// ============================================================

test("area 10: an ambiguous previous Doctor target is tracked as a genuine belief, and correctly averaged into the next night's likelihood", () => {
  const game2: GameConfig = { players: ["1", "2"], roles: ["mafia", "doctor"] };
  const worlds = generateWorlds(game2);
  const setting: GameSetting = { config: game2, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const model = createLikelihoodModel(
    createHandlers({ truthful: 0.9, false: 0.1 }),
    createNightResultHandler(createUniformActionModel(defaultRoleRegistry))
  );
  const log = [
    { type: "nightResult" as const, round: 1, died: [] as string[] },
    { type: "nightResult" as const, round: 2, died: [] as string[] },
  ];
  const steps = processEvidence(worlds, log, model, setting);

  // with only 2 living players, excluding whichever target night 1's
  // belief assigns just forces the doctor onto the other one with
  // certainty either way, so - hand-derived - the cross-night constraint
  // has no NET numeric effect here: both nights stay exactly 50/50,
  // confirming the belief-averaging doesn't introduce spurious asymmetry
  // when none is actually implied.
  steps.forEach((step) => {
    step.posterior.forEach((w) => assert.ok(Math.abs(w.probability - 0.5) < 1e-9));
  });
});

test("area 10: a Doctor with the only living target and a forced repeat gets zero probability for every hypothesis, via the real ActionModel", () => {
  const soleWorld: World = { probability: 1, roles: { "1": "doctor" } };
  const soleAlive = { "1": true };
  const uam = createUniformActionModel(defaultRoleRegistry);
  const history = { previousDoctorSaveTarget: "1" };

  assert.equal(uam.doctorSaveTargetProbability("1", soleWorld, soleAlive, history), 0);
  assert.equal(
    uam.probability({ mafiaTargetChoices: {}, doctorSaveTarget: "1" }, soleWorld, soleAlive, history),
    0
  );
});

test("area 10: the constraint disappears once the excluded target is no longer alive, and once the Doctor itself has died", () => {
  const world: World = { probability: 1, roles: { "1": "doctor", "2": "mafia", "3": "citizen" } };
  const uam = createUniformActionModel(defaultRoleRegistry);

  // "1" (the previously-saved target) is now dead - exclusion is a no-op
  const aliveWithout1 = { "1": false, "2": true, "3": true };
  const withHistory = uam.doctorSaveTargetProbability("2", world, aliveWithout1, {
    previousDoctorSaveTarget: "1",
  });
  const withoutHistory = uam.doctorSaveTargetProbability("2", world, aliveWithout1, {});
  assert.equal(withHistory, withoutHistory);

  // the doctor itself is now dead - no doctorSaveTarget dimension at all,
  // so the full joint probability is unaffected by any exclusion
  const aliveWithoutDoctor = { "1": false, "2": true, "3": true };
  const p1 = uam.probability(
    { mafiaTargetChoices: { "2": "3" } },
    world,
    aliveWithoutDoctor,
    { previousDoctorSaveTarget: "3" }
  );
  const p2 = uam.probability({ mafiaTargetChoices: { "2": "3" } }, world, aliveWithoutDoctor, {});
  assert.equal(p1, p2);
});

// ============================================================
// Area 11: evidence that should not change posterior
// ============================================================

test("area 11: any evidence assigning the same positive likelihood to every world leaves posterior odds exactly equal to prior odds", () => {
  const game2: GameConfig = { players: ["1", "2"], roles: ["mafia", "citizen"] };
  const worlds = generateWorlds(game2); // W1 (1=mafia), W2 (1=citizen), each prior 0.5
  const ctx = makeCtx(game2);
  const constantHandlers: ObservationHandlerMap = {
    selfRoleClaim: () => 5, // any positive constant, not just 1
    roleAssertion: notExercised,
    investigationReport: notExercised,
    candidateVote: notExercised,
    keepOrEliminateVote: notExercised,
    suspect: notExercised,
    defend: notExercised,
    nominate: notExercised,
  };
  const model = createLikelihoodModel(constantHandlers);
  const posterior = updateProbabilities(
    worlds,
    { type: "selfRoleClaim", round: 1, actor: "1", claim: { kind: "role", role: "mafia" } },
    model,
    ctx
  );

  const priorOdds = oddsOf(getProbability(worlds, "1", "mafia"));
  const posteriorOdds = oddsOf(getProbability(posterior, "1", "mafia"));
  assert.ok(Math.abs(priorOdds - posteriorOdds) < 1e-9);
});

test("area 11: a consistent DayEliminationFact leaves the posterior exactly unchanged", () => {
  const game3: GameConfig = { players: ["1", "2", "3"], roles: ["mafia", "citizen", "citizen"] };
  const setting: GameSetting = { config: game3, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const model = createLikelihoodModel(
    createHandlers(
      { truthful: 0.9, false: 0.1 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { sameTeamVote: 0.6, differentTeamVote: 0.3, abstain: 0.1 }
    )
  );
  const vote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "initial",
    candidates: ["2"],
    handsRaised: { "2": ["1", "3"] },
  };
  const log: Evidence[] = [vote, { type: "dayElimination", round: 1, eliminated: ["2"] }];
  const steps = processEvidence(generateWorlds(game3), log, model, setting);

  steps[1].posterior.forEach((w, i) => {
    assert.ok(Math.abs(w.probability - steps[0].posterior[i].probability) < 1e-12);
  });
});

// ============================================================
// Area 12: sequential composition
// ============================================================

test("area 12: a 3-step sequence matches direct multiplication of each step's own likelihood factor, with no double-application and no future leakage", () => {
  const worlds = generateWorlds(fivePlayerGame);
  const setting: GameSetting = { config: fivePlayerGame, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const model = createLikelihoodModel(createHandlers({ truthful: 0.8, false: 0.2 }));

  const claim1: Evidence = { type: "selfRoleClaim", round: 1, actor: "1", claim: { kind: "role", role: "commissioner" } };
  const day: Evidence = { type: "dayElimination", round: 1, eliminated: [] }; // world-independent, inserted mid-sequence
  const claim2: Evidence = { type: "selfRoleClaim", round: 2, actor: "1", claim: { kind: "role", role: "commissioner" } };

  // dayElimination with an empty vote history would throw, so use a
  // minimal valid predecessor: a trivial unanimous-abstention vote that
  // resolves to keeping everyone (candidates required though - use a
  // one-candidate vote no one raises a hand for, abstention elects them,
  // then report that same winner as eliminated for consistency)
  const vote: CandidateVote = { type: "candidateVote", round: 1, stage: "initial", candidates: ["5"], handsRaised: {} };
  const dayConsistent: Evidence = { type: "dayElimination", round: 1, eliminated: ["5"] };

  const fullModel = createLikelihoodModel(
    createHandlers(
      { truthful: 0.8, false: 0.2 },
      undefined, undefined, undefined, undefined, undefined,
      { sameTeamVote: 0.5, differentTeamVote: 0.5, abstain: 0.5 }
    ),
    undefined
  );

  const log: Evidence[] = [claim1, vote, dayConsistent, claim2];
  const steps = processEvidence(worlds, log, fullModel, setting);

  // step i's prior is step i-1's posterior, by reference
  for (let i = 0; i + 1 < steps.length; i++) {
    assert.equal(steps[i + 1].prior, steps[i].posterior);
  }

  // manually multiply the two selfRoleClaim factors (dayElimination and
  // the vote are either world-independent or, being about player "5",
  // orthogonal to "1"'s commissioner odds - both should contribute exactly
  // 1x to that specific odds ratio)
  const priorOdds = oddsOf(1 / 5);
  const afterClaim1 = oddsOf(getProbability(steps[0].posterior, "1", "commissioner"));
  assert.ok(Math.abs(afterClaim1 / priorOdds - 4) < 1e-9); // 0.8/0.2

  const afterVote = oddsOf(getProbability(steps[1].posterior, "1", "commissioner"));
  assert.ok(Math.abs(afterVote - afterClaim1) < 1e-9); // vote doesn't touch "1"'s odds at all... within tolerance of the actual sameTeamVote/differentTeamVote symmetry (0.5/0.5, world-independent)

  const afterDay = oddsOf(getProbability(steps[2].posterior, "1", "commissioner"));
  assert.ok(Math.abs(afterDay - afterVote) < 1e-9); // world-independent, no change

  const afterClaim2 = oddsOf(getProbability(steps[3].posterior, "1", "commissioner"));
  assert.ok(Math.abs(afterClaim2 / afterDay - 4) < 1e-9); // second identical-ratio factor applied again
});

// ============================================================
// Area 13: negative controls
// ============================================================

test("area 13: equal same-team/different-team parameters produce zero posterior change", () => {
  const game3: GameConfig = { players: ["1", "2", "3"], roles: ["mafia", "citizen", "citizen"] };
  const worlds = generateWorlds(game3);
  const ctx = makeCtx(game3);
  const model = createLikelihoodModel(
    createHandlers({ truthful: 0.9, false: 0.1 }, undefined, undefined, { sameTeam: 3, differentTeam: 3 })
  );
  const posterior = updateProbabilities(
    worlds,
    { type: "suspect", round: 1, actor: "1", target: "2" },
    model,
    ctx
  );
  worlds.forEach((prior, i) => {
    assert.ok(Math.abs(prior.probability - posterior[i].probability) < 1e-12);
  });
});

test("area 13: equal truthful/false parameters produce zero posterior change", () => {
  const worlds = generateWorlds(fivePlayerGame);
  const ctx = makeCtx(fivePlayerGame);
  const model = createLikelihoodModel(createHandlers({ truthful: 0.5, false: 0.5 }));
  const posterior = updateProbabilities(
    worlds,
    { type: "selfRoleClaim", round: 1, actor: "1", claim: { kind: "role", role: "commissioner" } },
    model,
    ctx
  );
  worlds.forEach((prior, i) => {
    assert.ok(Math.abs(prior.probability - posterior[i].probability) < 1e-12);
  });
});

test("area 13: permuting candidate order in an otherwise-identical vote produces an identical posterior", () => {
  const game3: GameConfig = { players: ["1", "2", "3"], roles: ["mafia", "citizen", "citizen"] };
  const worlds = generateWorlds(game3);
  const ctx = makeCtx(game3);
  const model = createLikelihoodModel(
    createHandlers({ truthful: 0.9, false: 0.1 }, undefined, undefined, undefined, undefined, undefined, {
      sameTeamVote: 0.6,
      differentTeamVote: 0.2,
      abstain: 0.1,
    })
  );
  const voteA: CandidateVote = { type: "candidateVote", round: 1, stage: "initial", candidates: ["2", "3"], handsRaised: { "2": ["1"] } };
  const voteB: CandidateVote = { type: "candidateVote", round: 1, stage: "initial", candidates: ["3", "2"], handsRaised: { "2": ["1"] } };

  const posteriorA = updateProbabilities(worlds, voteA, model, ctx);
  const posteriorB = updateProbabilities(worlds, voteB, model, ctx);
  posteriorA.forEach((w, i) => assert.ok(Math.abs(w.probability - posteriorB[i].probability) < 1e-12));
});

test("area 13: swapping two equivalent players' evidence swaps their posteriors correspondingly, not arbitrarily", () => {
  const model = createLikelihoodModel(createHandlers({ truthful: 0.8, false: 0.2 }));
  const claimFor = (actor: string) => ({
    type: "selfRoleClaim" as const,
    round: 1,
    actor,
    claim: { kind: "role" as const, role: "don" as const },
  });

  const postA = updateProbabilities(generateWorlds(fivePlayerGame), claimFor("3"), model, makeCtx(fivePlayerGame));
  const postB = updateProbabilities(generateWorlds(fivePlayerGame), claimFor("4"), model, makeCtx(fivePlayerGame));

  assert.ok(
    Math.abs(getProbability(postA, "3", "don") - getProbability(postB, "4", "don")) < 1e-9
  );
  // and the player who was NOT evidenced in each scenario keeps the
  // ordinary (unshifted) prior-equivalent marginal, not the shifted one
  assert.ok(
    Math.abs(getProbability(postA, "4", "don") - getProbability(postB, "3", "don")) < 1e-9
  );
});

// ============================================================
// helpers
// ============================================================

function makeCtx(config: GameConfig): EvidenceContext {
  return {
    config,
    roles: defaultRoleRegistry,
    groups: defaultGroupRegistry,
    alive: initAliveState(config),
    history: [],
  };
}

function notExercised(): never {
  throw new Error("handler not exercised in this synthetic test");
}
