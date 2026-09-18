import { PlayerId, World } from "../types";
import { RoleRegistry, sameTeam } from "../roles";

/**
 * P(player and other are on the SAME team), for every other living player -
 * a small, READ-ONLY aggregation directly over the CURRENT posterior
 * (`worlds`), reusing sameTeam (roles.ts, unchanged). This is NOT a new
 * inference feature: it derives no new information the model doesn't
 * already have baked into `worlds`' probabilities - it only re-slices the
 * existing posterior along a "same team as X" question instead of "is X
 * role Y", exactly the kind of small API adaptation this milestone's app
 * layer is allowed to add without touching evidence.ts/behavioralModel.ts/
 * any likelihood implementation.
 */
export function getTeammateProbabilities(
  worlds: World[],
  player: PlayerId,
  otherPlayers: PlayerId[],
  registry: RoleRegistry
): Record<PlayerId, number> {
  const result: Record<PlayerId, number> = {};
  otherPlayers
    .filter((p) => p !== player)
    .forEach((other) => {
      result[other] = worlds
        .filter((w) => sameTeam(registry, w.roles[player], w.roles[other]))
        .reduce((sum, w) => sum + w.probability, 0);
    });
  return result;
}
