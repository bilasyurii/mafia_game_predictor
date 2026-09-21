import {
  AliveState,
  CandidateVote,
  GameConfig,
  GameEvent,
  KeepOrEliminateVote,
  PlayerId,
} from "./types";

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

/**
 * One night or one day of the game: night N, then day N, then night N+1.
 * { phase: "day", round: 0 } is the first day, before any night.
 *
 * Deaths only ever happen at the end of a night (all at once) or at the end
 * of a day's voting, so everything that happens within one phase - including
 * every vote of a day - sees the same alive state: the one at the start of
 * that phase.
 */
export interface GamePhase {
  phase: "night" | "day";
  round: number;
}

/** Chronological position: night N < day N < night N+1. */
function phaseIndex({ phase, round }: GamePhase): number {
  return phase === "night" ? 2 * round - 1 : 2 * round;
}

/** Day rounds are integers >= 0, night rounds integers >= 1. */
function assertValidPhase({ phase, round }: GamePhase): void {
  if (!Number.isInteger(round) || round < (phase === "night" ? 1 : 0)) {
    throw new Error(`invalid ${phase} round ${round}`);
  }
}

/**
 * The phase an evidence item belongs to, from its own round:
 *  - NightResultFact round N -> night N (the outcome of that night)
 *  - every Observation and DayEliminationFact round N -> day N
 *
 * Throws on an invalid round, or on an InvestigationReport whose explicit
 * `night` is not an integer between 1 and the day it was reported on.
 */
export function getPhaseOf(evidence: GameEvent): GamePhase {
  const phase: GamePhase =
    evidence.type === "nightResult"
      ? { phase: "night", round: evidence.round }
      : { phase: "day", round: evidence.round };
  assertValidPhase(phase);

  if (evidence.type === "investigationReport" && evidence.night !== undefined) {
    const { night, round } = evidence;
    if (!Number.isInteger(night) || night < 1 || night > round) {
      throw new Error(
        `invalid investigationReport night ${night} for a report on day ${round}`
      );
    }
  }
  return phase;
}

/**
 * Replays public death facts to the alive state at the start of `at`:
 * initial players, minus every NightResultFact death and DayEliminationFact
 * elimination from an earlier phase. Uses each fact's round rather than its
 * position in `history`, so history need not be sorted. Everything else in
 * history is ignored. Pure: no roles, no probabilities, no mutation.
 *
 * Throws on an inconsistent history: two facts for the same phase, a death
 * of an unknown player, or a death of a player who was already dead.
 */
export function getAliveStateAt(
  config: GameConfig,
  history: readonly GameEvent[],
  at: GamePhase
): AliveState {
  assertValidPhase(at);
  const target = phaseIndex(at);

  const deathsByPhase = new Map<number, PlayerId[]>();
  history.forEach((event) => {
    if (event.type !== "nightResult" && event.type !== "dayElimination") {
      return;
    }
    const index = phaseIndex(getPhaseOf(event));
    if (deathsByPhase.has(index)) {
      throw new Error(`more than one ${event.type} fact for round ${event.round}`);
    }
    deathsByPhase.set(
      index,
      event.type === "nightResult" ? event.died : event.eliminated
    );
  });

  let alive = initAliveState(config);
  [...deathsByPhase.keys()]
    .filter((index) => index < target)
    .sort((a, b) => a - b)
    .forEach((index) => {
      deathsByPhase.get(index)!.forEach((player) => {
        if (alive[player] === undefined) {
          throw new Error(`unknown player "${player}" in a death fact`);
        }
        if (!alive[player]) {
          throw new Error(`player "${player}" died but was already dead`);
        }
        alive = markDead(alive, player);
      });
    });
  return alive;
}

/** The alive state every vote of day `vote.round` was cast under. */
export function getAliveStateForVote(
  config: GameConfig,
  history: readonly GameEvent[],
  vote: CandidateVote | KeepOrEliminateVote
): AliveState {
  return getAliveStateAt(config, history, { phase: "day", round: vote.round });
}

/**
 * The alive state `evidence` happened under: the start of its own phase.
 * Day N evidence sees night N's deaths but not day N's elimination, which
 * only happens after that day's votes; a NightResultFact sees the state
 * before its own deaths. Facts from its own or any later phase never
 * change the result, so this is safe to call with a history that extends
 * past `evidence`.
 */
export function getAliveStateForGameEvent(
  config: GameConfig,
  history: readonly GameEvent[],
  evidence: GameEvent
): AliveState {
  return getAliveStateAt(config, history, getPhaseOf(evidence));
}

/**
 * The public evidence recorded before history[index] - the only context
 * history[index] may be scored against. Recorded order is authoritative
 * within a day, so an earlier claim never sees a later vote, while last words
 * see the vote and elimination recorded before them.
 *
 * Takes a position rather than an evidence object: two items can be equal
 * in value (or even the same object recorded twice), so looking one up with
 * indexOf would be ambiguous.
 *
 * Throws if index is out of range, or if anything before history[index]
 * belongs to a later phase than it does - recorded order must never put a
 * later day or night before an earlier one.
 */
export function getHistoryBefore(
  history: readonly GameEvent[],
  index: number
): GameEvent[] {
  if (!Number.isInteger(index) || index < 0 || index >= history.length) {
    throw new Error(`history index ${index} is out of range`);
  }
  const current = getPhaseOf(history[index]);
  const before = history.slice(0, index);
  before.forEach((event, i) => {
    const phase = getPhaseOf(event);
    if (phaseIndex(phase) > phaseIndex(current)) {
      throw new Error(
        `history[${i}] (${event.type}, ${phase.phase} ${phase.round}) is recorded before history[${index}] (${history[index].type}, ${current.phase} ${current.round}) but belongs to a later phase`
      );
    }
  });
  return before;
}
