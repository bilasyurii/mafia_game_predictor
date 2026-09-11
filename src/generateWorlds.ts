import { GameConfig, PlayerId, RoleId, World } from "./types";

/**
 * Generates every distinct way to assign config.roles to config.players.
 * Duplicate roles (e.g. two "mafia") do not produce duplicate worlds -
 * swapping which player holds which of two identical roles is the same world.
 */
export function generateWorlds(config: GameConfig): World[] {
  const { players, roles } = config;

  if (players.length !== roles.length) {
    throw new Error(
      `players.length (${players.length}) must equal roles.length (${roles.length})`
    );
  }

  const roleAssignments = distinctPermutations(roles);
  const probability = 1 / roleAssignments.length;

  return roleAssignments.map((assignment) => {
    const worldRoles: Record<PlayerId, RoleId> = {};
    players.forEach((player, i) => {
      worldRoles[player] = assignment[i];
    });
    return { roles: worldRoles, probability };
  });
}

/**
 * All distinct permutations of a multiset, via backtracking that skips
 * repeated values already used at the current recursion depth.
 */
function distinctPermutations(items: RoleId[]): RoleId[][] {
  const sorted = [...items].sort();
  const results: RoleId[][] = [];
  const used = new Array(sorted.length).fill(false);
  const current: RoleId[] = [];

  function backtrack() {
    if (current.length === sorted.length) {
      results.push([...current]);
      return;
    }

    for (let i = 0; i < sorted.length; i++) {
      if (used[i]) continue;
      if (i > 0 && sorted[i] === sorted[i - 1] && !used[i - 1]) continue;

      used[i] = true;
      current.push(sorted[i]);
      backtrack();
      current.pop();
      used[i] = false;
    }
  }

  backtrack();
  return results;
}
