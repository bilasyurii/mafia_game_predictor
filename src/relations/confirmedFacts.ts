import { GameEvent, PlayerId, RoleId } from "../types";
import { RoleRegistry, hasMechanic } from "../roles";

export type ConfirmedTeam = "mafia" | "town";

/**
 * Team facts that are 100% CERTAIN, not fuzzy pattern-detection - derived
 * only from the CURRENT USER's own investigationReport events (never
 * another player's self-claimed investigation results, which could be
 * lies - see this app's design notes). Only possible at all when the
 * user's own secret role actually has the claimed mechanic, checked here
 * defensively even though the UI should only ever offer recording a check
 * the user's real role can perform.
 *
 * checkIsMafia is a direct team check: true -> target is mafia-team,
 * false -> target is town-team (exhaustive; there are only two teams).
 * checkIsCommissioner only reveals whether the target IS the Commissioner:
 * true -> town-team (certain), false -> no team information at all (a
 * non-Commissioner town role and any mafia-team role both answer false).
 */
export function deriveConfirmedTeams(
  events: GameEvent[],
  myPlayerNumber: PlayerId,
  myRole: RoleId | null,
  registry: RoleRegistry
): Partial<Record<PlayerId, ConfirmedTeam>> {
  const result: Partial<Record<PlayerId, ConfirmedTeam>> = {};
  if (myRole === null) return result;

  events.forEach((event) => {
    if (event.type !== "investigationReport") return;
    if (event.actor !== myPlayerNumber) return;
    if (!hasMechanic(registry, myRole, event.mechanic)) return;

    if (event.mechanic === "checkIsMafia") {
      result[event.target] = event.result ? "mafia" : "town";
    } else if (event.mechanic === "checkIsCommissioner" && event.result) {
      result[event.target] = "town";
    }
  });

  return result;
}
