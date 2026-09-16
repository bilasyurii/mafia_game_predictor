import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DefendAction,
  GameConfig,
  NominateAction,
  SuspectAction,
  World,
} from "./types";
import { generateWorlds } from "./generateWorlds";
import { getProbability } from "./probability";
import { updateProbabilities } from "./updateProbabilities";
import { initAliveState } from "./facts";
import { createLikelihoodModel, EvidenceContext } from "./evidence";
import { createHandlers } from "./likelihoodHandlers";
import { createTeamAlignmentHandler } from "./teamAlignmentLikelihood";
import { defaultRoleRegistry, RoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";

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

function makeCtx(overrides: Partial<EvidenceContext> = {}): EvidenceContext {
  return {
    config: game,
    roles: defaultRoleRegistry,
    groups: defaultGroupRegistry,
    alive: initAliveState(game),
    history: [],
    ...overrides,
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
    "6": "citizen",
    "7": "citizen",
    "8": "citizen",
  },
};

// Synthetic test data only - not a calibration claim about real players.
const params = { sameTeam: 0.6, differentTeam: 0.2 };

test("sameTeam branch: actor and target are both on the mafia team", () => {
  const handler = createTeamAlignmentHandler<SuspectAction>(params);
  const observation: SuspectAction = {
    type: "suspect",
    round: 1,
    actor: "1", // don
    target: "2", // mafia
  };
  assert.equal(handler(observation, world, makeCtx()), 0.6);
});

test("differentTeam branch: actor and target are on different teams", () => {
  const handler = createTeamAlignmentHandler<SuspectAction>(params);
  const observation: SuspectAction = {
    type: "suspect",
    round: 1,
    actor: "1", // don (mafia team)
    target: "5", // citizen (town team)
  };
  assert.equal(handler(observation, world, makeCtx()), 0.2);
});

test("function-valued params receive the full (observation, world, ctx) triple", () => {
  let seen: { observation?: SuspectAction; world?: World; ctx?: EvidenceContext } = {};

  const handler = createTeamAlignmentHandler<SuspectAction>({
    sameTeam: (observation, w, ctx) => {
      seen = { observation, world: w, ctx };
      return 0.42;
    },
    differentTeam: 0.1,
  });

  const observation: SuspectAction = {
    type: "suspect",
    round: 3,
    actor: "1",
    target: "2",
  };
  const ctx = makeCtx();
  const result = handler(observation, world, ctx);

  assert.equal(result, 0.42);
  assert.equal(seen.observation, observation);
  assert.equal(seen.world, world);
  assert.equal(seen.ctx, ctx);
});

test("the same factory works identically for suspect, defend, and nominate", () => {
  const suspectHandler = createTeamAlignmentHandler<SuspectAction>(params);
  const defendHandler = createTeamAlignmentHandler<DefendAction>(params);
  const nominateHandler = createTeamAlignmentHandler<NominateAction>(params);

  const suspect: SuspectAction = { type: "suspect", round: 1, actor: "1", target: "2" };
  const defend: DefendAction = { type: "defend", round: 1, actor: "1", target: "2" };
  const nominate: NominateAction = { type: "nominate", round: 1, actor: "1", target: "2" };

  const ctx = makeCtx();
  assert.equal(suspectHandler(suspect, world, ctx), 0.6);
  assert.equal(defendHandler(defend, world, ctx), 0.6);
  assert.equal(nominateHandler(nominate, world, ctx), 0.6);

  const differentTeamSuspect: SuspectAction = { ...suspect, target: "5" };
  const differentTeamDefend: DefendAction = { ...defend, target: "5" };
  const differentTeamNominate: NominateAction = { ...nominate, target: "5" };
  assert.equal(suspectHandler(differentTeamSuspect, world, ctx), 0.2);
  assert.equal(defendHandler(differentTeamDefend, world, ctx), 0.2);
  assert.equal(nominateHandler(differentTeamNominate, world, ctx), 0.2);
});

test("no role or team name is hardcoded: dispatch follows whatever the registry says, not real role identity", () => {
  // Reassign which team "citizen" and "mafia" belong to. If the handler (or
  // sameTeam) special-cased a literal role/team name, this would break;
  // instead it must follow the swapped registry exactly.
  const swappedRegistry: RoleRegistry = {
    ...defaultRoleRegistry,
    citizen: { ...defaultRoleRegistry.citizen, team: "mafia" },
    mafia: { ...defaultRoleRegistry.mafia, team: "town" },
  };
  const ctx = makeCtx({ roles: swappedRegistry });
  const handler = createTeamAlignmentHandler<SuspectAction>(params);

  // "1" (don, still mafia team) and "5" (citizen, now reassigned to mafia
  // team) are "same team" only under the swapped registry.
  const observation: SuspectAction = { type: "suspect", round: 1, actor: "1", target: "5" };
  assert.equal(handler(observation, world, ctx), 0.6);

  // "1" (don, mafia team) and "2" (mafia role, now reassigned to town team)
  // are "different team" only under the swapped registry.
  const flipped: SuspectAction = { type: "suspect", round: 1, actor: "1", target: "2" };
  assert.equal(handler(flipped, world, ctx), 0.2);
});

test("createHandlers only replaces suspect/defend/nominate when their params are given", () => {
  const model = createLikelihoodModel(createHandlers({ truthful: 0.9, false: 0.1 }));
  const ctx = makeCtx();
  const suspect: SuspectAction = { type: "suspect", round: 1, actor: "1", target: "2" };
  const defend: DefendAction = { type: "defend", round: 1, actor: "1", target: "2" };
  const nominate: NominateAction = { type: "nominate", round: 1, actor: "1", target: "2" };

  assert.throws(() => model.likelihood(suspect, world, ctx), /suspect likelihood not calibrated yet/);
  assert.throws(() => model.likelihood(defend, world, ctx), /defend likelihood not calibrated yet/);
  assert.throws(() => model.likelihood(nominate, world, ctx), /nominate likelihood not calibrated yet/);
});

test("end-to-end: a suspect observation drives a real, normalized Bayesian posterior", () => {
  const worlds = generateWorlds(game);
  const ctx = makeCtx();
  const model = createLikelihoodModel(
    createHandlers(
      { truthful: 0.9, false: 0.1 }, // selfRoleClaim - unused here
      undefined,
      undefined,
      { sameTeam: 0.7, differentTeam: 0.1 } // suspect
    )
  );

  // "1" publicly suspects "2" - if they're both mafia-team, that's a much
  // less "natural" (0.7 vs a 0.1-weighted mix of same-team outcomes across
  // town's many roles) event than town-vs-mafia suspicion, so this should
  // move mass toward worlds where "1" and "2" are on different teams.
  const observation: SuspectAction = { type: "suspect", round: 1, actor: "1", target: "2" };

  const priorSameTeam = getProbability(worlds, "2", "don") + getProbability(worlds, "2", "mafia");
  const posteriorWorlds = updateProbabilities(worlds, observation, model, ctx);
  const posteriorSameTeam =
    getProbability(posteriorWorlds, "2", "don") + getProbability(posteriorWorlds, "2", "mafia");

  assert.notEqual(posteriorSameTeam, priorSameTeam);

  const total = posteriorWorlds.reduce((sum, w) => sum + w.probability, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `total was ${total}`);
  assert.ok(posteriorWorlds.every((w) => w.probability >= 0));
});
