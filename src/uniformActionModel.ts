import { FactoredActionModel } from "./actionModel";
import { enumerateHiddenNightActions } from "./night";
import { hasMechanic, RoleRegistry } from "./roles";
import { AliveState, PlayerId, World } from "./types";

interface Shape {
  livingCount: number;
  killerCount: number;
}

/**
 * The maximum-entropy default: every hypothesis enumerateHiddenNightActions
 * produces for a given (world, alive) is equally likely. Not a behavioral
 * claim about how mafia/don/commissioner/doctor actually choose targets -
 * the structural "we have no data, so treat every legal choice as equally
 * likely" null hypothesis, the same spirit as generateWorlds's uniform
 * prior over role assignments.
 *
 * Implements FactoredActionModel because a uniform distribution over a
 * Cartesian product IS, exactly (not approximately), the product of
 * independent uniform distributions over each factor: each living killer
 * independently and uniformly picks among livingCount targets, so a
 * specific consensus target has probability (1/livingCount)^killerCount;
 * each of Don/Commissioner/Doctor independently and uniformly picks among
 * livingCount targets. probability()'s existing flat-uniform semantics are
 * unchanged below - these are two equivalent expressions of the same
 * distribution, not a different one.
 */
export function createUniformActionModel(registry: RoleRegistry): FactoredActionModel {
  const hypothesisCountCache = new WeakMap<World, WeakMap<AliveState, number>>();
  const shapeCache = new WeakMap<World, WeakMap<AliveState, Shape>>();

  function hypothesisCount(world: World, alive: AliveState): number {
    let byAlive = hypothesisCountCache.get(world);
    if (!byAlive) {
      byAlive = new WeakMap();
      hypothesisCountCache.set(world, byAlive);
    }
    let count = byAlive.get(alive);
    if (count === undefined) {
      count = enumerateHiddenNightActions(world, alive, registry).length;
      byAlive.set(alive, count);
    }
    return count;
  }

  function shapeFor(world: World, alive: AliveState): Shape {
    let byAlive = shapeCache.get(world);
    if (!byAlive) {
      byAlive = new WeakMap();
      shapeCache.set(world, byAlive);
    }
    let shape = byAlive.get(alive);
    if (shape === undefined) {
      const players = Object.keys(world.roles);
      const isAlive = (p: PlayerId) => alive[p] === true;
      const livingCount = players.filter(isAlive).length;
      const killerCount = players.filter(
        (p) => isAlive(p) && hasMechanic(registry, world.roles[p], "unanimousNightKill")
      ).length;
      shape = { livingCount, killerCount };
      byAlive.set(alive, shape);
    }
    return shape;
  }

  return {
    probability(_actions, world, alive) {
      return 1 / hypothesisCount(world, alive);
    },

    mafiaConsensusProbability(_target, world, alive) {
      const { livingCount, killerCount } = shapeFor(world, alive);
      return 1 / Math.pow(livingCount, killerCount);
    },

    donCheckTargetProbability(_target, world, alive) {
      return 1 / shapeFor(world, alive).livingCount;
    },

    commissionerCheckTargetProbability(_target, world, alive) {
      return 1 / shapeFor(world, alive).livingCount;
    },

    doctorSaveTargetProbability(_target, world, alive) {
      return 1 / shapeFor(world, alive).livingCount;
    },
  };
}
