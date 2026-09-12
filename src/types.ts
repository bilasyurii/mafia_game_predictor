import type { InvestigationMechanic } from "./investigation";

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
//
// Every Observation happens during a day - nobody speaks or votes at night -
// so each carries `round`: the day it happened on, where day N follows
// night N and day 0 is the first day, before any night. Order within a day
// is not stored on the observation; it is the observation's position in the
// public history (see getHistoryBefore in facts.ts).

/** A player states that they themselves hold a specific role or group. */
export interface SelfRoleClaim {
  type: "selfRoleClaim";
  /** The day this was said on. */
  round: number;
  actor: PlayerId;
  claim: RoleExpression;
}

/**
 * A player states that another player holds a specific role or group, with
 * no claimed evidentiary basis beyond their own say-so (e.g. "B is mafia"
 * from a hunch or a lie). Distinct from InvestigationReport, whose
 * reliability instead hinges on the actor holding an investigative role.
 */
export interface RoleAssertion {
  type: "roleAssertion";
  /** The day this was said on. */
  round: number;
  actor: PlayerId;
  target: PlayerId;
  claim: RoleExpression;
}

/**
 * A player states that they used a specific investigation mechanic on
 * target and received a YES/NO result. Carries exactly what a real check
 * produces - never a role or group, since no check reveals one (see
 * getInvestigationResult). Kept separate from RoleAssertion because its
 * reliability depends on whether actor actually holds that mechanic.
 *
 * This is only the report itself: it does not imply a SelfRoleClaim, and
 * anyone may make one regardless of their true role. A speech reporting
 * several checks is several InvestigationReports.
 */
export interface InvestigationReport {
  type: "investigationReport";
  /** The day the report was said on - not the night of the check. */
  round: number;
  actor: PlayerId;
  target: PlayerId;
  mechanic: InvestigationMechanic;
  result: boolean;
  /**
   * The night the speaker explicitly said the check happened on
   * (1 <= night <= round). Omitted when they didn't say - the night is then
   * unknown, never assumed to be the previous one.
   */
  night?: number;
}

// --- Behavioral observations: raw actions, not interpretations ---

/**
 * One candidate voting round, as publicly seen: the moderator calls each
 * candidate in nomination order and living players raise a hand for at most
 * one of them. Records only the raised hands - a living player who raised
 * no hand is an abstainer, and the abstention rule (their vote goes to the
 * last candidate called) is applied by voting.ts, never stored here.
 *
 * A revote is its own CandidateVote with stage "revote", listing only the
 * tied candidates, still in nomination order.
 */
export interface CandidateVote {
  type: "candidateVote";
  /** Same numbering as NightResultFact.round: day vote N follows night N. */
  round: number;
  stage: "initial" | "revote";
  /** In the order the moderator called them. */
  candidates: PlayerId[];
  /** candidate -> players who raised a hand for them. Missing = no hands. */
  handsRaised: Partial<Record<PlayerId, PlayerId[]>>;
}

/**
 * The final vote after a revote still ties: every living player either
 * raises a hand to eliminate all tied candidates, or doesn't (= keep all).
 * Only the raised hands are recorded; see voting.ts for the decision.
 */
export interface KeepOrEliminateVote {
  type: "keepOrEliminateVote";
  /** Same numbering as CandidateVote.round. */
  round: number;
  /** The tied candidates being decided on, in nomination order. */
  candidates: PlayerId[];
  eliminateHands: PlayerId[];
}

export interface SuspectAction {
  type: "suspect";
  /** The day this happened on. */
  round: number;
  actor: PlayerId;
  target: PlayerId;
}

export interface DefendAction {
  type: "defend";
  /** The day this happened on. */
  round: number;
  actor: PlayerId;
  target: PlayerId;
}

export interface NominateAction {
  type: "nominate";
  /** The day this happened on. */
  round: number;
  actor: PlayerId;
  target: PlayerId;
}

/**
 * A player-produced statement or public behavioral act. Attribution is
 * always certain here - these are things said or done openly. Most have a
 * single `actor`; a voting round (CandidateVote, KeepOrEliminateVote) is one
 * public event with many participants, each listed explicitly by who raised
 * a hand. Truthfulness/informativeness is never encoded in the shape
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
  | CandidateVote
  | KeepOrEliminateVote
  | SuspectAction
  | DefendAction
  | NominateAction;

/** Alive/dead is the only 100%-certain fact during the game (no reveal()). */
export type AliveState = Record<PlayerId, boolean>;
