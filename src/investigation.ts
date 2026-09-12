import { RoleId } from "./types";
import { hasMechanic, MechanicId, RoleRegistry } from "./roles";

/** The mechanics whose use yields a private YES/NO result about a target. */
export type InvestigationMechanic = Extract<
  MechanicId,
  "checkIsCommissioner" | "checkIsMafia"
>;

/**
 * What each investigation mechanic actually detects, expressed as another
 * mechanic the target's role may hold - never as a role id or team:
 *  - checkIsCommissioner (Don): YES iff target can checkIsMafia
 *  - checkIsMafia (Commissioner): YES iff target takes part in the
 *    unanimous night kill
 */
const DETECTED_MECHANIC: Record<InvestigationMechanic, MechanicId> = {
  checkIsCommissioner: "checkIsMafia",
  checkIsMafia: "unanimousNightKill",
};

/**
 * The single source of truth for the actual result of an investigation:
 * given the mechanic used and the target's true role, what YES/NO would the
 * moderator give. Purely deterministic game rules - used by resolveNight
 * for real night resolution and available to the evidence layer for
 * comparing a public report against a candidate world. Says nothing about
 * whether anyone actually used the mechanic, or reports its result
 * truthfully.
 */
export function getInvestigationResult(
  registry: RoleRegistry,
  mechanic: InvestigationMechanic,
  targetRole: RoleId
): boolean {
  return hasMechanic(registry, targetRole, DETECTED_MECHANIC[mechanic]);
}
