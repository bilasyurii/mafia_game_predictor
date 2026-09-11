import { PlayerId, RoleId, World } from "./types";

/** P(player = role), summed over all worlds where that holds. */
export function getProbability(
  worlds: World[],
  player: PlayerId,
  role: RoleId
): number {
  return worlds
    .filter((world) => world.roles[player] === role)
    .reduce((sum, world) => sum + world.probability, 0);
}
