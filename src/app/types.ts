import { GameConfig, PlayerId, RoleExpression, RoleId } from "../types";
import { Evidence } from "../evidence";

/**
 * Application-state shapes for the UI/facade layer (see gameFacade.ts).
 * Nothing here performs inference: these are plain, serializable records the
 * facade reads/writes. The Bayesian core (types.ts/evidence.ts/roles.ts/
 * processEvidence.ts/etc.) is completely unaware this file exists.
 *
 * `events: Evidence[]` is the ONE authoritative source of truth for
 * everything the predictor knows about an in-progress game - see
 * gameFacade.ts's own top-of-file doc for why the posterior is always
 * recomputed from it (never persisted directly).
 */

/** Bumped whenever THIS file's shapes change in a way that requires migration (see storage.ts). */
export const APP_SCHEMA_VERSION = 1;

/** Identifies the exact BehavioralModelParams/ActionModel combination a game was (or is being) scored with - stored per game so a future engine change can detect it needs migration/re-scoring, without guessing. */
export type PredictorVersion = string;
export const CURRENT_PREDICTOR_VERSION: PredictorVersion = "default-flat-v1";

/** Identifies the core engine's own logic (types.ts/roles.ts/evidence shapes) - bumped on any change that could change how an old game's events replay. */
export type EngineVersion = string;
export const CURRENT_ENGINE_VERSION: EngineVersion = "1.0.0";

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
 * hardcoded in a UI component, so a future version can change the policy
 * (and record which policy an old saved game used) without touching the UI.
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

/** Expands RoleCounts + a player count into an actual GameConfig - player ids are "1".."N" in order, matching every existing example (game1.ts/game2.ts). */
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
 * from `events` alone (e.g. "night has started but deaths aren't recorded
 * yet" has no corresponding Evidence item), so tracked explicitly alongside
 * the event log rather than re-inferred from it.
 */
export type UiPhase =
  | { kind: "day"; round: number }
  | { kind: "night"; round: number }
  | { kind: "voting"; round: number; stage: "initial" | "revote"; candidates: PlayerId[] }
  | { kind: "keepOrEliminateVoting"; round: number; candidates: PlayerId[] }
  | { kind: "finished" };

/** In-progress, UNCONFIRMED voting selections - never fed to the engine until confirmVote()/confirmKeepOrEliminateVote() builds the real Evidence event. Persisted so a mid-vote refresh doesn't lose progress. */
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

/** One entry in the authoritative event log: the Evidence item itself, plus the UiPhase that was active immediately BEFORE it - lets undoLastEvent() restore uiPhase exactly, without re-deriving a reverse transition from the event's type. */
export interface EventLogEntry {
  event: Evidence;
  uiPhaseBefore: UiPhase;
}

export interface GameSession {
  schemaVersion: number;
  engineVersion: EngineVersion;
  predictorVersion: PredictorVersion;
  createdAt: string;
  updatedAt: string;

  config: GameConfig;
  myPlayerNumber: PlayerId;
  /** Set once after setup via setPlayerRole(); never surfaced on the normal game screen (see gameFacade.ts's getPublicPlayerProbabilities). */
  myRole: RoleId | null;

  eventLog: EventLogEntry[];
  uiPhase: UiPhase;
  votingDraft: VotingDraft | null;

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

/** MENU vs GAME is derived, never stored redundantly (see this milestone's own persistence guidance: one authoritative representation). */
export function getAppScreen(state: AppState): "MENU" | "GAME" {
  return state.currentGame ? "GAME" : "MENU";
}

export const ROLE_EXPRESSION_GROUPS: RoleExpression["kind"][] = ["role", "group"];
