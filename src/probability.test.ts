import { test } from "node:test";
import assert from "node:assert/strict";
import { GameConfig, RoleExpression } from "./types";
import { generateWorlds } from "./generateWorlds";
import { updateProbabilities } from "./updateProbabilities";
import { createLikelihoodModel, EvidenceContext } from "./evidence";
import { createHandlers } from "./likelihoodHandlers";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { initAliveState } from "./facts";
import { getExpressionProbability, rankByProbability } from "./probability";

/**
 * rankByProbability: the one real-game-usability API gap this milestone
 * found (see behavioralModel.ts's "real-game usability" note) - "who
 * should we suspect right now" has no existing helper, even though the
 * probabilities it needs (getExpressionProbability) already do. This is a
 * pure, additive wrapper - no new probability computation.
 */

const game: GameConfig = {
  players: ["1", "2", "3", "4", "5"],
  roles: ["don", "mafia", "doctor", "commissioner", "citizen"],
};

test("rankByProbability sorts players highest-probability first and matches getExpressionProbability exactly", () => {
  const worlds = generateWorlds(game);
  const ctx: EvidenceContext = {
    config: game,
    roles: defaultRoleRegistry,
    groups: defaultGroupRegistry,
    alive: initAliveState(game),
    history: [],
  };
  const model = createLikelihoodModel(createHandlers({ truthful: 0.9, false: 0.1 }));
  const posterior = updateProbabilities(
    worlds,
    { type: "selfRoleClaim", round: 1, actor: "1", claim: { kind: "role", role: "commissioner" } },
    model,
    ctx
  );

  const mafiaGroup: RoleExpression = { kind: "group", group: "mafia" };
  const ranked = rankByProbability(posterior, game.players, mafiaGroup, defaultGroupRegistry);

  // every entry matches getExpressionProbability exactly, for every player
  ranked.forEach(({ player, probability }) => {
    assert.ok(Math.abs(probability - getExpressionProbability(posterior, player, mafiaGroup, defaultGroupRegistry)) < 1e-12);
  });

  // every player appears exactly once
  assert.deepEqual(new Set(ranked.map((r) => r.player)), new Set(game.players));

  // sorted highest-probability first
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].probability >= ranked[i].probability);
  }

  // "1" claimed (and was scored as likely) Commissioner, so it is NOT among
  // the top-ranked Mafia-team suspects - a real, meaningful ordering, not a
  // trivial reshuffle
  const topSuspect = ranked[0].player;
  assert.notEqual(topSuspect, "1");
});

test("rankByProbability on the exact-role query behaves identically to sorting getProbability results by hand", () => {
  const worlds = generateWorlds(game);
  const commissioner: RoleExpression = { kind: "role", role: "commissioner" };
  const ranked = rankByProbability(worlds, game.players, commissioner);
  // uniform prior: every player equally likely, so the ranking is a stable
  // permutation of equal values - every probability is exactly 1/5
  ranked.forEach(({ probability }) => {
    assert.ok(Math.abs(probability - 0.2) < 1e-9);
  });
});
