import { GroupId, RoleExpression, RoleId } from "./types";
import { defaultRoleRegistry, RoleRegistry, Team } from "./roles";

export type GroupRegistry = Record<GroupId, RoleId[]>;

/**
 * The one generic question this layer is allowed to ask: "is this actual
 * role a member of what was claimed" - never a literal role/group name
 * comparison. Works identically whether the expression is an exact role
 * or a group, and needs no RoleRegistry at all for the exact-role case.
 */
export function satisfiedBy(
  expr: RoleExpression,
  actualRole: RoleId,
  groups?: GroupRegistry
): boolean {
  if (expr.kind === "role") {
    return actualRole === expr.role;
  }
  if (!groups) {
    throw new Error(
      `Cannot evaluate group expression "${expr.group}" without a GroupRegistry`
    );
  }
  return groups[expr.group].includes(actualRole);
}

/**
 * Derives team-aligned groups ("mafia", "town") directly from the
 * RoleRegistry's `team` field, so they can never drift out of sync with
 * it and never need to name a specific role (e.g. "don") to define who's
 * in "mafia" - that falls out of whatever roles happen to have
 * team: "mafia". Merges in hand-authored groups that don't correspond to
 * a team, like "activeTown".
 */
export function buildGroupRegistry(
  roles: RoleRegistry,
  customGroups: { activeTown: RoleId[] }
): GroupRegistry {
  const byTeam: Partial<Record<Team, RoleId[]>> = {};
  (Object.keys(roles) as RoleId[]).forEach((roleId) => {
    const team = roles[roleId].team;
    byTeam[team] = [...(byTeam[team] ?? []), roleId];
  });

  return {
    mafia: byTeam.mafia ?? [],
    town: byTeam.town ?? [],
    ...customGroups,
  };
}

export const defaultGroupRegistry: GroupRegistry = buildGroupRegistry(
  defaultRoleRegistry,
  { activeTown: ["doctor", "commissioner"] }
);
