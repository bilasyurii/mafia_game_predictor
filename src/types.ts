import type { InvestigationMechanic } from "./investigation";

export type RoleId = "don" | "mafia" | "citizen" | "doctor" | "commissioner";

export type PlayerId = string;

export interface GameConfig {
  players: PlayerId[];
  roles: RoleId[];
}

/**
 * Named role groups a claim can refer to instead of one exact role.
 * See roleGroups.ts for what each group actually contains - this file only
 * needs the identifier, not the membership (which depends on RoleRegistry).
 */
export type GroupId = "mafia" | "town" | "activeTown";

/**
 * What a role-related statement claims: either one exact role, or a named
 * group of roles (e.g. "Town", "active Town"). Kept as plain data so it's
 * fully inspectable/serializable.
 */
export type RoleExpression =
  | { kind: "role"; role: RoleId }
  | { kind: "group"; group: GroupId };

// --- Statements: raw speech acts a player makes ---
//
// Every action below happens during a day - nobody speaks or acts publicly
// at night - so each carries `round`: the day it happened on, where day N
// follows night N and day 0 is the first day, before any night.

/** A player states that they themselves hold a specific role or group. */
export interface SelfRoleClaim {
  type: "selfRoleClaim";
  round: number;
  actor: PlayerId;
  claim: RoleExpression;
}

/**
 * A player states that another player holds a specific role or group, with
 * no claimed evidentiary basis beyond their own say-so.
 */
export interface RoleAssertion {
  type: "roleAssertion";
  round: number;
  actor: PlayerId;
  target: PlayerId;
  claim: RoleExpression;
}

/**
 * A player states that they used a specific investigation mechanic on
 * target and received a YES/NO result. This is only the report itself: it
 * does not imply a SelfRoleClaim, and anyone may make one regardless of
 * their true role - see gameFacade.ts's derivation of which reports (if
 * any) are actually certain, rather than just a claim.
 */
export interface InvestigationReport {
  type: "investigationReport";
  round: number;
  actor: PlayerId;
  target: PlayerId;
  mechanic: InvestigationMechanic;
  result: boolean;
  /** The night the speaker explicitly said the check happened on (1 <= night <= round). Omitted when they didn't say. */
  night?: number;
}

/**
 * One candidate voting round, as publicly seen: the moderator calls each
 * candidate in nomination order and living players raise a hand for at most
 * one of them. A living player who raised no hand is an abstainer, and the
 * abstention rule (their vote goes to the last candidate called) is applied
 * by voting.ts, never stored here.
 */
export interface CandidateVote {
  type: "candidateVote";
  round: number;
  stage: "initial" | "revote";
  candidates: PlayerId[];
  handsRaised: Partial<Record<PlayerId, PlayerId[]>>;
}

/**
 * The final vote after a revote still ties: every living player either
 * raises a hand to eliminate all tied candidates, or doesn't (= keep all).
 */
export interface KeepOrEliminateVote {
  type: "keepOrEliminateVote";
  round: number;
  candidates: PlayerId[];
  eliminateHands: PlayerId[];
}

/**
 * How strongly the actor means a suspect/defend/nominate action, on a 1-5
 * star scale (3 = a normal/default-strength claim). Lets "I have a slight
 * feeling about them" and "I'm certain" both be recorded as the same kind
 * of action without moving the relationship graph by the same amount - see
 * relations/affinity.ts's own use of it. Optional so events recorded before
 * this existed (or replayed from an older save) are treated as the default,
 * 3-star strength.
 */
export type ActionIntensity = 1 | 2 | 3 | 4 | 5;

export interface SuspectAction {
  type: "suspect";
  round: number;
  actor: PlayerId;
  target: PlayerId;
  intensity?: ActionIntensity;
}

export interface DefendAction {
  type: "defend";
  round: number;
  actor: PlayerId;
  target: PlayerId;
  intensity?: ActionIntensity;
}

export interface NominateAction {
  type: "nominate";
  round: number;
  actor: PlayerId;
  target: PlayerId;
  intensity?: ActionIntensity;
}

/**
 * A player-produced statement or public behavioral act. Attribution is
 * always certain here - these are things said or done openly. Most have a
 * single `actor`; a voting round (CandidateVote, KeepOrEliminateVote) is one
 * public event with many participants, each listed explicitly by who raised
 * a hand.
 *
 * Notably absent: an "attack" observation. Under this ruleset the night
 * killer's identity is never known to anyone but the moderator - not even
 * other mafia members - so a public observer can never attribute a kill to
 * a specific actor. The publicly known fact is only that some player(s)
 * died; see NightResultFact below.
 */
export type Observation =
  | SelfRoleClaim
  | RoleAssertion
  | InvestigationReport
  | CandidateVote
  | KeepOrEliminateVote
  | SuspectAction
  | DefendAction
  | NominateAction;

/** The moderator's public announcement of who died overnight - identity only, never a cause or killer. */
export interface NightResultFact {
  type: "nightResult";
  /** Same numbering as day rounds: night N precedes day N. */
  round: number;
  died: PlayerId[];
}

/** The moderator's public announcement of who left the table at the end of day `round` - identity only, never role. Empty when nobody was eliminated. */
export interface DayEliminationFact {
  type: "dayElimination";
  round: number;
  eliminated: PlayerId[];
}

/**
 * Everything that can happen in a game and be recorded: a player statement/
 * behavior, a publicly-announced night outcome, or a publicly-announced day
 * elimination. This is the ONE authoritative event vocabulary the whole app
 * is built on (see src/app/types.ts's GameSession.eventLog) - nothing here
 * carries any notion of likelihood, probability, or hidden role inference;
 * that entire layer was removed in this app's relationship-based redesign
 * (see src/relations/).
 */
export type GameEvent = Observation | NightResultFact | DayEliminationFact;

/** Alive/dead is the only 100%-certain fact during the game (no reveal()). */
export type AliveState = Record<PlayerId, boolean>;
