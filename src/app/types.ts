import { GameConfig, GameEvent, PlayerId, RoleExpression, RoleId } from "../types";

/**
 * Application-state shapes for the UI/facade layer (see gameFacade.ts).
 * Nothing here performs inference: these are plain, serializable records the
 * facade reads/writes.
 *
 * `eventLog: GameEvent[]` is the ONE authoritative source of truth for
 * everything this app knows about an in-progress game - the relationship
 * graph (src/relations/) is always recomputed from it, never persisted
 * directly, exactly like undo already relies on for the event log itself.
 */

/** Bumped whenever THIS file's shapes change in a way that requires migration (see storage.ts). Bumped to 2 for the relationship-based redesign - a schema-1 (Bayesian-era) save is a different, incompatible shape and is not migrated. */
export const APP_SCHEMA_VERSION = 2;

/** Identifies the core engine's own logic (types.ts/roles.ts/relations/*) - bumped on any change that could change how an old game's events replay or how the relationship graph is computed. */
export type EngineVersion = string;
export const CURRENT_ENGINE_VERSION: EngineVersion = "2.0.0";

export interface RoleCounts {
  don: number;
  mafia: number;
  commissioner: number;
  doctor: number;
  citizen: number;
}

/**
 * The app's own default role-count POLICY (9+ players -> 2 Mafia; <=8 -> 1
 * Mafia; Commissioner/Doctor/Don always exactly 1; remainder Citizens) -
 * deliberately kept as plain, versionable data/logic here rather than
 * hardcoded in a UI component.
 */
export function defaultRoleCountsForPlayerCount(playerCount: number): RoleCounts {
  return {
    don: 1,
    commissioner: 1,
    doctor: 1,
    mafia: playerCount >= 9 ? 2 : 1,
    citizen: playerCount - (1 + 1 + 1 + (playerCount >= 9 ? 2 : 1)),
  };
}

/** Expands RoleCounts + a player count into an actual GameConfig - player ids are "1".."N" in order. */
export function buildGameConfig(playerCount: number, counts: RoleCounts): GameConfig {
  const roles: RoleId[] = [
    ...Array(counts.don).fill("don"),
    ...Array(counts.mafia).fill("mafia"),
    ...Array(counts.commissioner).fill("commissioner"),
    ...Array(counts.doctor).fill("doctor"),
    ...Array(counts.citizen).fill("citizen"),
  ];
  const players: PlayerId[] = Array.from({ length: playerCount }, (_, i) => String(i + 1));
  return { players, roles };
}

export interface GameSetupInput {
  playerCount: number;
  myPlayerNumber: PlayerId;
  roleCounts: RoleCounts;
}

/**
 * The UI's current workflow position within a game - NOT fully derivable
 * from `eventLog` alone (e.g. "night has started but deaths aren't
 * recorded yet" has no corresponding GameEvent), so tracked explicitly
 * alongside the event log rather than re-inferred from it.
 */
export type UiPhase =
  | { kind: "day"; round: number }
  | { kind: "night"; round: number }
  | { kind: "voting"; round: number; stage: "initial" | "revote"; candidates: PlayerId[] }
  | { kind: "keepOrEliminateVoting"; round: number; candidates: PlayerId[] }
  | { kind: "finished" };

/** In-progress, UNCONFIRMED voting selections - never fed to the engine until confirmVote()/confirmKeepOrEliminateVote() builds the real GameEvent. Persisted so a mid-vote refresh doesn't lose progress. */
export interface CandidateVoteDraft {
  kind: "candidateVote";
  candidates: PlayerId[];
  handsRaised: Partial<Record<PlayerId, PlayerId[]>>;
}
export interface KeepOrEliminateDraft {
  kind: "keepOrEliminateVote";
  candidates: PlayerId[];
  eliminateHands: PlayerId[];
}
export type VotingDraft = CandidateVoteDraft | KeepOrEliminateDraft;

/** One entry in the authoritative event log: the GameEvent itself, plus the UiPhase that was active immediately BEFORE it - lets undoLastEvent() restore uiPhase exactly, without re-deriving a reverse transition from the event's type. */
export interface EventLogEntry {
  event: GameEvent;
  uiPhaseBefore: UiPhase;
}

export interface GameSession {
  schemaVersion: number;
  engineVersion: EngineVersion;
  createdAt: string;
  updatedAt: string;

  config: GameConfig;
  myPlayerNumber: PlayerId;
  /** Set once after setup via setPlayerRole(); never surfaced on the normal game screen. */
  myRole: RoleId | null;

  eventLog: EventLogEntry[];
  uiPhase: UiPhase;
  votingDraft: VotingDraft | null;
  /**
   * The UiPhase active immediately before finishGame() was called - lets
   * resumeGame() return to a genuinely live game instead of being a dead
   * end (see this redesign's "Finish Game must always be resumable" goal).
   * Meaningless while uiPhase.kind !== "finished".
   */
  phaseBeforeFinish: UiPhase | null;

  finalRoles: Partial<Record<PlayerId, RoleId>> | null;
  confirmedOutcome: "townWon" | "mafiaWon" | "unknown" | null;
}

export interface HistoryGameEntry {
  id: string;
  savedAt: string;
  session: GameSession;
}

export interface AppState {
  schemaVersion: number;
  appVersion: string;
  currentGame: GameSession | null;
  history: HistoryGameEntry[];
}

/** MENU vs GAME is derived, never stored redundantly. */
export function getAppScreen(state: AppState): "MENU" | "GAME" {
  return state.currentGame ? "GAME" : "MENU";
}

export const ROLE_EXPRESSION_GROUPS: RoleExpression["kind"][] = ["role", "group"];
