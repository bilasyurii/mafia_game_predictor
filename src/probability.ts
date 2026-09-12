import { PlayerId, RoleExpression, RoleId, World } from "./types";
import { GroupRegistry, satisfiedBy } from "./roleGroups";

/** P(player = role), summed over all worlds where that holds. */
export function getProbability(
  worlds: World[],
  player: PlayerId,
  role: RoleId
): number {
  return getExpressionProbability(worlds, player, { kind: "role", role });
}

/**
 * P(player's role satisfies `expr`) - an exact role or a named group -
 * summed directly over the existing World posterior. There is no separate
 * "group probability" ever stored: this always recomputes the sum on
 * demand from whatever worlds/probabilities are passed in, the same way
 * getProbability does for a single role.
 */
export function getExpressionProbability(
  worlds: World[],
  player: PlayerId,
  expr: RoleExpression,
  groups?: GroupRegistry
): number {
  return worlds
    .filter((world) => satisfiedBy(expr, world.roles[player], groups))
    .reduce((sum, world) => sum + world.probability, 0);
}
