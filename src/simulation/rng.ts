import { GameConfig, PlayerId, RoleId } from "../types";

/**
 * A small, deterministic, dependency-free PRNG (mulberry32) - for
 * reproducibility of synthetic games, not cryptographic use.
 */
export function createSeededRng(seed: number): () => number {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic Fisher-Yates shuffle driven by the given RNG. */
export function seededShuffle<T>(items: T[], rng: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * A fresh, random-but-reproducible role assignment for `config`: shuffles
 * config.roles with a seeded RNG and zips it to config.players in order. Two
 * calls with the same config and seed always produce the identical
 * assignment - see rng.test.ts. Deliberately does not reuse generateWorlds
 * (which enumerates every possible assignment for Bayesian inference) - this
 * needs exactly one concrete assignment, chosen at random, not the full
 * space of hypotheses.
 */
export function assignRolesWithSeed(config: GameConfig, seed: number): Record<PlayerId, RoleId> {
  const rng = createSeededRng(seed);
  const shuffledRoles = seededShuffle(config.roles, rng);
  const roles: Record<PlayerId, RoleId> = {};
  config.players.forEach((player, i) => {
    roles[player] = shuffledRoles[i];
  });
  return roles;
}
