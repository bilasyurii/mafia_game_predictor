import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AliveState,
  CandidateVote,
  DefendAction,
  GameConfig,
  InvestigationReport,
  NominateAction,
  RoleAssertion,
  SelfRoleClaim,
  SuspectAction,
  World,
} from "./types";
import { createLikelihoodModel, Evidence, EvidenceContext, LikelihoodModel } from "./evidence";
import { createHandlers } from "./likelihoodHandlers";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { NightResultFact } from "./night";
import { DayEliminationFact } from "./facts";
import { generateWorlds } from "./generateWorlds";
import { GameSetting, processEvidence } from "./processEvidence";
import { createNightResultHandler } from "./nightResultLikelihood";
import { createUniformActionModel } from "./uniformActionModel";

/**
 * Coverage for createLikelihoodModel's centralized dead-actor check: every
 * speech-act Observation (selfRoleClaim, roleAssertion, investigationReport,
 * suspect, defend, nominate) is rejected via assertAlive before reaching its
 * handler when ctx.alive marks its actor dead - see evidence.ts's own docs
 * for why this lives in the dispatcher rather than duplicated per handler.
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

const someWorld: World = {
  probability: 1,
  roles: {
    "1": "don",
    "2": "mafia",
    "3": "doctor",
    "4": "commissioner",
    "5": "citizen",
    "6": "citizen",
    "7": "citizen",
    "8": "citizen",
  },
};

const aliveAll: AliveState = {
  "1": true, "2": true, "3": true, "4": true,
  "5": true, "6": true, "7": true, "8": true,
};

function ctx(alive: AliveState): EvidenceContext {
  return {
    config: game,
    roles: defaultRoleRegistry,
    groups: defaultGroupRegistry,
    alive,
    history: [],
  };
}

function realModel(): LikelihoodModel {
  return createLikelihoodModel(
    createHandlers(
      { truthful: 0.9, false: 0.1 },
      { truthful: 0.8, false: 0.2 },
      { truthful: 0.9, falseResult: 0.1, bluff: 0.3 },
      { sameTeam: 0.6, differentTeam: 0.3 },
      { sameTeam: 0.6, differentTeam: 0.3 },
      { sameTeam: 0.6, differentTeam: 0.3 },
      { sameTeamVote: 0.5, differentTeamVote: 0.5, abstain: 0.5 }
    )
  );
}

const selfRoleClaim = (actor: string): SelfRoleClaim => ({
  type: "selfRoleClaim",
  round: 1,
  actor,
  claim: { kind: "role", role: "commissioner" },
});
const roleAssertion = (actor: string, target: string): RoleAssertion => ({
  type: "roleAssertion",
  round: 1,
  actor,
  target,
  claim: { kind: "group", group: "mafia" },
});
const investigationReport = (actor: string, target: string): InvestigationReport => ({
  type: "investigationReport",
  round: 1,
  actor,
  target,
  mechanic: "checkIsMafia",
  result: true,
});
const suspect = (actor: string, target: string): SuspectAction => ({
  type: "suspect", round: 1, actor, target,
});
const defend = (actor: string, target: string): DefendAction => ({
  type: "defend", round: 1, actor, target,
});
const nominate = (actor: string, target: string): NominateAction => ({
  type: "nominate", round: 1, actor, target,
});

/** Every speech-act evidence builder, keyed by type, actor always "1", target always "2". */
const SPEECH_ACTS: Record<string, (actor: string) => Evidence> = {
  selfRoleClaim: (actor) => selfRoleClaim(actor),
  roleAssertion: (actor) => roleAssertion(actor, "2"),
  investigationReport: (actor) => investigationReport(actor, "2"),
  suspect: (actor) => suspect(actor, "2"),
  defend: (actor) => defend(actor, "2"),
  nominate: (actor) => nominate(actor, "2"),
};

test("each of the six speech-act types is rejected when its actor is dead, via the normal model dispatch", () => {
  const model = realModel();
  const aliveWithout1: AliveState = { ...aliveAll, "1": false };

  Object.entries(SPEECH_ACTS).forEach(([type, build]) => {
    assert.throws(
      () => model.likelihood(build("1"), someWorld, ctx(aliveWithout1)),
      /"?1"? is dead and cannot produce new observations/,
      `expected ${type} to reject a dead actor`
    );
  });
});

test("each of the six speech-act types is accepted when its actor is alive", () => {
  const model = realModel();

  Object.entries(SPEECH_ACTS).forEach(([type, build]) => {
    const result = model.likelihood(build("1"), someWorld, ctx(aliveAll));
    assert.equal(typeof result, "number", `expected ${type} to return a number`);
    assert.ok(Number.isFinite(result) && result > 0, `expected ${type} to return a positive likelihood`);
  });
});

test("a RoleAssertion or InvestigationReport with a dead target but a living actor is not rejected", () => {
  const model = realModel();
  const aliveWithoutTarget: AliveState = { ...aliveAll, "2": false }; // target "2" dead, actor "1" alive

  assert.doesNotThrow(() =>
    model.likelihood(roleAssertion("1", "2"), someWorld, ctx(aliveWithoutTarget))
  );
  assert.doesNotThrow(() =>
    model.likelihood(investigationReport("1", "2"), someWorld, ctx(aliveWithoutTarget))
  );
});

test("candidateVote and keepOrEliminateVote are unaffected by the actor-aliveness dispatch check", () => {
  const model = realModel();
  const vote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "initial",
    candidates: ["2", "3"],
    handsRaised: { "2": ["1"] },
  };
  // rejected by voting.ts's own per-voter validation (a dead voter), not by
  // this dispatch-level check (which never looks at these two types at all)
  const aliveWithoutVoter: AliveState = { ...aliveAll, "1": false };
  assert.throws(
    () => model.likelihood(vote, someWorld, ctx(aliveWithoutVoter)),
    /voter "1" is not a living player/
  );
});

// --- through the full processEvidence pipeline, not just the model directly ---

const setting: GameSetting = {
  config: game,
  roles: defaultRoleRegistry,
  groups: defaultGroupRegistry,
};

function realModelWithNightResult(): LikelihoodModel {
  return createLikelihoodModel(
    createHandlers(
      { truthful: 0.9, false: 0.1 },
      { truthful: 0.8, false: 0.2 },
      { truthful: 0.9, falseResult: 0.1, bluff: 0.3 },
      { sameTeam: 0.6, differentTeam: 0.3 },
      { sameTeam: 0.6, differentTeam: 0.3 },
      { sameTeam: 0.6, differentTeam: 0.3 },
      { sameTeamVote: 0.5, differentTeamVote: 0.5, abstain: 0.5 }
    ),
    createNightResultHandler(createUniformActionModel(defaultRoleRegistry))
  );
}

test("a dead actor's speech is rejected through the full processEvidence pipeline", () => {
  const night: NightResultFact = { type: "nightResult", round: 1, died: ["8"] };
  const log: Evidence[] = [night, selfRoleClaim("8")]; // "8" just died night 1

  assert.throws(
    () => processEvidence(generateWorlds(game), log, realModelWithNightResult(), setting),
    /"?8"? is dead and cannot produce new observations/
  );
});

test('"last words": speech from a player still alive in ctx.alive is accepted, including immediately before their own day elimination', () => {
  const night: NightResultFact = { type: "nightResult", round: 1, died: [] };
  // 8 living players: "3" gets 5 raised hands, "4" gets the 3 abstainers
  // (living minus voted, going to the last-called candidate) -> "3" wins 5-3
  const vote: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "initial",
    candidates: ["3", "4"],
    handsRaised: { "3": ["1", "2", "4", "5", "6"], "4": [] },
  };
  const elimination: DayEliminationFact = { type: "dayElimination", round: 1, eliminated: ["3"] };
  const lastWords = selfRoleClaim("3"); // "3" speaks right after their own elimination

  const log: Evidence[] = [night, vote, elimination, lastWords];
  const steps = processEvidence(
    generateWorlds(game),
    log,
    realModelWithNightResult(),
    setting
  );

  assert.equal(steps.length, log.length);
  assert.equal(steps[3].context.alive["3"], true); // still alive per this phase's alive state
  const total = steps[3].posterior.reduce((sum, w) => sum + w.probability, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});
