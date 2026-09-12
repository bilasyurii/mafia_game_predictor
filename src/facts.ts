import { AliveState, GameConfig, PlayerId } from "./types";

export function initAliveState(config: GameConfig): AliveState {
  const state: AliveState = {};
  config.players.forEach((player) => {
    state[player] = true;
  });
  return state;
}

/**
 * Records a death. This never touches world probabilities directly - dying
 * doesn't reveal a role in this game. It exists so callers can (a) block
 * further observations from a dead player and (b) later plug in
 * role-specific death rules (e.g. a role that can't be killed at night),
 * which would then filter worlds - not implemented yet since no such role
 * exists in the current game config.
 */
export function markDead(state: AliveState, player: PlayerId): AliveState {
  return { ...state, [player]: false };
}

export function isAlive(state: AliveState, player: PlayerId): boolean {
  return state[player];
}

export function assertAlive(state: AliveState, player: PlayerId): void {
  if (!isAlive(state, player)) {
    throw new Error(`${player} is dead and cannot produce new observations`);
  }
}
