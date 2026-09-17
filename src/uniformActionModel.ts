import { FactoredActionModel } from "./actionModel";
import { enumerateHiddenNightActions } from "./night";
import { hasMechanic, RoleRegistry } from "./roles";
import { AliveState, PlayerId, World } from "./types";

interface Shape {
  livingCount: number;
  killerCount: number;
  doctorAlive: boolean;
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
 * each of Don/Commissioner picks uniformly among livingCount targets.
 *
 * The Doctor is the one block that DOES depend on `history`: when
 * `history.previousDoctorSaveTarget` names a player who is both currently
 * alive and was legally excludable (the Doctor was in fact alive to have
 * chosen it), that target is removed from tonight's domain and the
 * remaining livingCount-1 targets are renormalized to stay uniform over
 * exactly the legal choices - never an invented behavioral preference,
 * just the same "uniform over whatever's actually legal" rule applied to a
 * smaller domain. If the excluded target is no longer alive (or there is
 * no previous target at all), the domain is unaffected: excluding a
 * player who was never a legal choice tonight removes nothing.
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
      const doctorAlive = players.some(
        (p) => isAlive(p) && hasMechanic(registry, world.roles[p], "protect")
      );
      shape = { livingCount, killerCount, doctorAlive };
      byAlive.set(alive, shape);
    }
    return shape;
  }

  /**
   * Whether `history.previousDoctorSaveTarget` genuinely excludes a target
   * tonight: only when there is a Doctor alive to be constrained, and the
   * named player is actually a legal target tonight (still alive).
   */
  function excludedTarget(
    world: World,
    alive: AliveState,
    history: { previousDoctorSaveTarget?: PlayerId }
  ): PlayerId | undefined {
    const target = history.previousDoctorSaveTarget;
    if (target === undefined) return undefined;
    if (alive[target] !== true) return undefined;
    if (!shapeFor(world, alive).doctorAlive) return undefined;
    return target;
  }

  return {
    probability(actions, world, alive, history) {
      const excluded = excludedTarget(world, alive, history);
      const baseCount = hypothesisCount(world, alive);
      if (excluded === undefined) {
        return 1 / baseCount;
      }
      if (actions.doctorSaveTarget === excluded) {
        return 0;
      }
      const { livingCount } = shapeFor(world, alive);
      const adjustedCount = (baseCount * (livingCount - 1)) / livingCount;
      return adjustedCount === 0 ? 0 : 1 / adjustedCount;
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

    doctorSaveTargetProbability(target, world, alive, history) {
      const { livingCount } = shapeFor(world, alive);
      const excluded = excludedTarget(world, alive, history);
      if (excluded === undefined) {
        return 1 / livingCount;
      }
      if (target === excluded) {
        return 0;
      }
      return livingCount - 1 === 0 ? 0 : 1 / (livingCount - 1);
    },
  };
}
