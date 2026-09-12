export type RoleId = "don" | "mafia" | "citizen" | "doctor" | "commissioner";

export type PlayerId = string;

export interface GameConfig {
  players: PlayerId[];
  roles: RoleId[];
}

export interface World {
  roles: Record<PlayerId, RoleId>;
  probability: number;
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
 * fully inspectable/serializable, and so a future specificity-aware model
 * can distinguish "claimed an exact role" from "claimed a group" without
 * re-deriving it from the claim's content.
 */
export type RoleExpression =
  | { kind: "role"; role: RoleId }
  | { kind: "group"; group: GroupId };

// --- Statements: raw speech acts a player makes ---

/** A player states that they themselves hold a specific role or group. */
export interface SelfRoleClaim {
  type: "selfRoleClaim";
  actor: PlayerId;
  claim: RoleExpression;
}

/**
 * A player states that another player holds a role, with no claimed
 * evidentiary basis beyond their own say-so (e.g. "B is mafia" from a
 * hunch or a lie). Distinct from InvestigationReport, whose reliability
 * instead hinges on the actor holding an investigative role.
 */
export interface RoleAssertion {
  type: "roleAssertion";
  actor: PlayerId;
  target: PlayerId;
  role: RoleId;
}

/**
 * A player states that an in-game investigative action of theirs
 * (checking, scanning, etc.) revealed target's role. Kept separate from
 * RoleAssertion because its reliability depends on whether actor actually
 * holds a role with that ability and on the game's rules for it - which
 * roles qualify and how reliable they are is resolved later against
 * GameConfig, not hardcoded into this type.
 */
export interface InvestigationReport {
  type: "investigationReport";
  actor: PlayerId;
  target: PlayerId;
  role: RoleId;
}

// --- Behavioral observations: raw actions, not interpretations ---

export interface VoteAction {
  type: "vote";
  actor: PlayerId;
  target: PlayerId;
}

export interface SuspectAction {
  type: "suspect";
  actor: PlayerId;
  target: PlayerId;
}

export interface DefendAction {
  type: "defend";
  actor: PlayerId;
  target: PlayerId;
}

export interface NominateAction {
  type: "nominate";
  actor: PlayerId;
  target: PlayerId;
}

/**
 * A player-produced statement or public behavioral act. Attribution
 * (the `actor`) is always certain here - these are things said or done
 * openly. Truthfulness/informativeness is never encoded in the shape
 * itself, only decided later by the evidence layer.
 *
 * Notably absent: an "attack" observation. Under this ruleset the night
 * killer's identity is never known to anyone but the moderator - not even
 * other mafia members - so a public observer can never attribute a kill to
 * a specific actor. The publicly known fact is only that some player(s)
 * died; see NightResultFact in night.ts.
 */
export type Observation =
  | SelfRoleClaim
  | RoleAssertion
  | InvestigationReport
  | VoteAction
  | SuspectAction
  | DefendAction
  | NominateAction;

/** Alive/dead is the only 100%-certain fact during the game (no reveal()). */
export type AliveState = Record<PlayerId, boolean>;
