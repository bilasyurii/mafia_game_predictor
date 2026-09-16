import { ActionModel } from "./actionModel";
import { enumerateHiddenNightActions } from "./night";
import { AliveState, World } from "./types";
import { RoleRegistry } from "./roles";

/**
 * The maximum-entropy default: every hypothesis enumerateHiddenNightActions
 * produces for a given (world, alive) is equally likely. Not a behavioral
 * claim about how mafia/don/commissioner/doctor actually choose targets -
 * the structural "we have no data, so treat every legal choice as equally
 * likely" null hypothesis, the same spirit as generateWorlds's uniform
 * prior over role assignments.
 *
 * ActionModel.probability() is stateless per the existing interface
 * (actions, world, alive, history only - no registry, unchanged here) and
 * is called once per enumerated hypothesis, so a uniform model needs the
 * same hypothesis count on every one of those calls for a given
 * (world, alive) pair. The cache below avoids re-enumerating the full
 * hypothesis space on every single call - this only avoids redundant
 * identical recomputation of the same count; it is not an optimization of
 * the marginalization's combinatorial structure, which is left untouched.
 */
export function createUniformActionModel(registry: RoleRegistry): ActionModel {
  const cache = new WeakMap<World, WeakMap<AliveState, number>>();

  function hypothesisCount(world: World, alive: AliveState): number {
    let byAlive = cache.get(world);
    if (!byAlive) {
      byAlive = new WeakMap();
      cache.set(world, byAlive);
    }
    let count = byAlive.get(alive);
    if (count === undefined) {
      count = enumerateHiddenNightActions(world, alive, registry).length;
      byAlive.set(alive, count);
    }
    return count;
  }

  return {
    probability(_actions, world, alive) {
      return 1 / hypothesisCount(world, alive);
    },
  };
}
