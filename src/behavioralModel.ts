import { PlayerId, RoleExpression, SuspectAction, DefendAction, NominateAction, World } from "./types";
import { Team, RoleRegistry, defaultRoleRegistry } from "./roles";
import { GroupRegistry } from "./roleGroups";
import { Evidence, EvidenceContext, LikelihoodModel, ObservationHandlerMap, createLikelihoodModel } from "./evidence";
import { createHandlers } from "./likelihoodHandlers";
import { SelfRoleClaimLikelihoodParams } from "./selfRoleClaimLikelihood";
import { RoleAssertionLikelihoodParams } from "./roleAssertionLikelihood";
import { InvestigationReportLikelihoodParams } from "./investigationReportLikelihood";
import { TeamAlignmentLikelihoodParams, TeamAlignmentObservation } from "./teamAlignmentLikelihood";
import { CandidateVoteLikelihoodParams } from "./candidateVoteLikelihood";
import { KeepOrEliminateVoteLikelihoodParams } from "./keepOrEliminateVoteLikelihood";
import { ActionModel } from "./actionModel";
import { createNightResultHandler } from "./nightResultLikelihood";
import { createUniformActionModel } from "./uniformActionModel";

/**
 * Behavioral Model v1: a single, explicit, general (not per-player) way to
 * turn "who could this actor be, given how public Mafia behavior tends to
 * play out" into concrete likelihood numbers for every existing evidence
 * type. This file introduces NO new inference machinery - every function
 * here only builds ordinary, already-supported PARAMETER values (mostly
 * closures) for the existing handler factories in selfRoleClaimLikelihood.ts
 * / roleAssertionLikelihood.ts / investigationReportLikelihood.ts /
 * teamAlignmentLikelihood.ts / candidateVoteLikelihood.ts /
 * keepOrEliminateVoteLikelihood.ts, then hands them to the existing
 * createHandlers()/createLikelihoodModel(). Deterministic mechanics
 * (roles.ts, night.ts, voting.ts, facts.ts) are never touched or
 * reimplemented here - a claim's TRUTH (does world.roles[x] satisfy it) and
 * a vote's VALIDITY stay exactly as mechanically determined as before; only
 * the PLAUSIBILITY of the observed public behavior, given a candidate
 * world, is configured below.
 *
 * "General" is a hard boundary: every parameter here is keyed by ROLE/TEAM
 * only (via world.roles[...] and ctx.roles[...].team, both already
 * per-candidate-world facts), never by a specific PlayerId or by anything
 * from the two held-out real games. Two players with the same role, the
 * same team, and the same relevant public history are always scored
 * identically - see behavioralModel.test.ts's symmetry test.
 */

// ============================================================
// Role-claim family: SelfRoleClaim and RoleAssertion
// ============================================================

/**
 * P(a role/group claim), split by whether it's true of its subject and, if
 * false, whether the claimant's own team matches the team the claim would
 * imply. This is what lets "Commissioner claiming Commissioner" differ from
 * "Citizen claiming Commissioner" (falseSameTeam - Citizen is Town, same
 * team as Commissioner) and from "Mafia claiming Commissioner"
 * (falseDifferentTeam) - three genuinely distinct configured numbers, not a
 * single flat "false" rate. Used identically for SelfRoleClaim (subject =
 * the actor) and RoleAssertion (subject = the target; "claimant's team"
 * still means the ACTOR's team - the accuser, not the accused).
 */
export interface RoleClaimBehaviorParams {
  /** P(claim | the claim is true of its subject) */
  truthful: number;
  /** P(false claim | the claimant's team matches the team the claim implies) */
  falseSameTeam: number;
  /** P(false claim | the claimant's team differs from the team the claim implies) */
  falseDifferentTeam: number;
}

/**
 * The team a RoleExpression "points at": a role claim's own team, or - for a
 * group claim - the team every member of that group shares. Never compares
 * a literal role/group name; walks the registry/GroupRegistry generically.
 * Returns undefined only for a (currently unreachable, since every group in
 * buildGroupRegistry is single-team by construction) group whose members
 * span more than one team, in which case "same team as the claim" is not a
 * well-defined behavioral axis and the false-claim factor conservatively
 * falls back to falseDifferentTeam (see roleClaimFalseFactor below).
 */
function expressionTeam(
  expr: RoleExpression,
  roles: RoleRegistry,
  groups: GroupRegistry | undefined
): Team | undefined {
  if (expr.kind === "role") return roles[expr.role].team;
  if (!groups) return undefined;
  const members = groups[expr.group];
  if (members.length === 0) return undefined;
  const firstTeam = roles[members[0]].team;
  return members.every((r) => roles[r].team === firstTeam) ? firstTeam : undefined;
}

interface RoleClaimLike {
  actor: PlayerId;
  claim: RoleExpression;
}

function roleClaimFalseFactor(
  params: RoleClaimBehaviorParams
): (observation: RoleClaimLike, world: World, ctx: EvidenceContext) => number {
  return (observation, world, ctx) => {
    const claimTeam = expressionTeam(observation.claim, ctx.roles, ctx.groups);
    const actorTeam = ctx.roles[world.roles[observation.actor]].team;
    return claimTeam !== undefined && actorTeam === claimTeam
      ? params.falseSameTeam
      : params.falseDifferentTeam;
  };
}

function selfRoleClaimParamsFrom(params: RoleClaimBehaviorParams): SelfRoleClaimLikelihoodParams {
  return { truthful: params.truthful, false: roleClaimFalseFactor(params) };
}

function roleAssertionParamsFrom(params: RoleClaimBehaviorParams): RoleAssertionLikelihoodParams {
  return { truthful: params.truthful, false: roleClaimFalseFactor(params) };
}

// ============================================================
// Team-alignment family: Suspect, Defend, Nominate, and CandidateVote's
// per-voter raised-hand factor
// ============================================================

/**
 * P(a team-aligned public act), from the ACTOR's own team's perspective:
 * `ownTeam` when actor and target share a team, `otherTeam` when they don't.
 * Keyed by Team (never a hardcoded "mafia"/"town" comparison in the scoring
 * logic itself - only in this object's own field values, which are plain
 * configuration), so "P(Mafia targets Mafia)" and "P(Town targets Mafia)"
 * are genuinely different, independently configurable numbers even though
 * both observe a "different/same team" act. Partial: a team missing from
 * the map falls back to NEUTRAL_TEAM_ALIGNMENT (a non-degenerate 50/50).
 */
export type TeamAlignmentBehaviorParams = Partial<
  Record<Team, { ownTeam: number; otherTeam: number }>
>;

const NEUTRAL_TEAM_ALIGNMENT = { ownTeam: 0.5, otherTeam: 0.5 };

function lookupTeamAlignment(
  params: TeamAlignmentBehaviorParams,
  team: Team
): { ownTeam: number; otherTeam: number } {
  return params[team] ?? NEUTRAL_TEAM_ALIGNMENT;
}

/**
 * History-sensitive behavior (the one small, concrete case this v1 model
 * implements - see this file's top-of-file doc and the milestone's "don't
 * build a general actor-memory framework" boundary): has this exact actor
 * already made the same kind of public claim about the same target earlier
 * in the game? Reads only ctx.history, which processEvidence already scopes
 * to "everything recorded before this item" - no new state, no per-player
 * profile, nothing beyond what's already public.
 */
function repeatedPosition(
  observationType: "suspect" | "defend" | "nominate",
  actor: PlayerId,
  target: PlayerId,
  history: Evidence[]
): boolean {
  return history.some(
    (event) =>
      event.type === observationType && event.actor === actor && event.target === target
  );
}

function teamAlignmentParamsFrom<O extends TeamAlignmentObservation>(
  behavior: TeamAlignmentBehaviorParams,
  observationType: "suspect" | "defend" | "nominate",
  repeatFactor: number
): TeamAlignmentLikelihoodParams<O> {
  const factor = (own: boolean) => (observation: O, world: World, ctx: EvidenceContext): number => {
    const actorTeam = ctx.roles[world.roles[observation.actor]].team;
    const { ownTeam, otherTeam } = lookupTeamAlignment(behavior, actorTeam);
    const base = own ? ownTeam : otherTeam;
    const repeated = repeatedPosition(observationType, observation.actor, observation.target, ctx.history);
    return repeated ? base * repeatFactor : base;
  };
  return { sameTeam: factor(true), differentTeam: factor(false) };
}

// ============================================================
// CandidateVote
// ============================================================

export interface CandidateVoteBehaviorParams {
  /** Per-voter raised-hand factor, keyed by the VOTER's own team. */
  vote: TeamAlignmentBehaviorParams;
  /** Per-voter abstention rate, keyed by the voter's own team. */
  abstain: Partial<Record<Team, number>>;
}

const DEFAULT_ABSTAIN_RATE = 0.2;

/**
 * Relies on CandidateVoteLikelihood's `voter` parameter (added alongside
 * this model) to condition each factor on the SPECIFIC living voter being
 * scored - without it, a function-valued sameTeamVote/differentTeamVote/
 * abstain could never tell which of many voters in one CandidateVote it was
 * being asked about, making per-actor-role voting behavior structurally
 * impossible to express. Candidate order and the deterministic
 * winner/tie/elimination outcome remain untouched - only the raised-hand
 * pattern itself is ever scored, exactly as candidateVoteLikelihood.ts
 * already guarantees.
 */
function candidateVoteParamsFrom(params: CandidateVoteBehaviorParams): CandidateVoteLikelihoodParams {
  return {
    sameTeamVote: (_observation, world, ctx, voter) =>
      lookupTeamAlignment(params.vote, ctx.roles[world.roles[voter]].team).ownTeam,
    differentTeamVote: (_observation, world, ctx, voter) =>
      lookupTeamAlignment(params.vote, ctx.roles[world.roles[voter]].team).otherTeam,
    abstain: (_observation, world, ctx, voter) =>
      params.abstain[ctx.roles[world.roles[voter]].team] ?? DEFAULT_ABSTAIN_RATE,
  };
}

// ============================================================
// KeepOrEliminateVote
// ============================================================

export interface KeepOrEliminateBehaviorEntry {
  eliminateSharedTeam: number;
  keepSharedTeam: number;
  eliminateNoSharedTeam: number;
  keepNoSharedTeam: number;
}

/** Keyed by the VOTER's own team - see keepOrEliminateVoteLikelihood.ts. */
export type KeepOrEliminateBehaviorParams = Partial<Record<Team, KeepOrEliminateBehaviorEntry>>;

const NEUTRAL_KEEP_OR_ELIMINATE: KeepOrEliminateBehaviorEntry = {
  eliminateSharedTeam: 0.5,
  keepSharedTeam: 0.5,
  eliminateNoSharedTeam: 0.5,
  keepNoSharedTeam: 0.5,
};

function keepOrEliminateParamsFrom(
  params: KeepOrEliminateBehaviorParams
): KeepOrEliminateVoteLikelihoodParams {
  const entryFor = (world: World, ctx: EvidenceContext, voter: PlayerId) =>
    params[ctx.roles[world.roles[voter]].team] ?? NEUTRAL_KEEP_OR_ELIMINATE;
  return {
    eliminateSharedTeam: (_o, world, ctx, voter) => entryFor(world, ctx, voter).eliminateSharedTeam,
    keepSharedTeam: (_o, world, ctx, voter) => entryFor(world, ctx, voter).keepSharedTeam,
    eliminateNoSharedTeam: (_o, world, ctx, voter) => entryFor(world, ctx, voter).eliminateNoSharedTeam,
    keepNoSharedTeam: (_o, world, ctx, voter) => entryFor(world, ctx, voter).keepNoSharedTeam,
  };
}

// ============================================================
// The coherent parameter object, and building the model from it
// ============================================================

/**
 * Everything Behavioral Model v1 lets a caller configure. Every field is a
 * plain, small, documented number or a small per-Team map of them - no
 * function values are exposed at this level (those are an implementation
 * detail of the adapters above); a caller who needs full generality can
 * still build an ObservationHandlerMap by hand via likelihoodHandlers.ts,
 * exactly as before this file existed.
 */
export interface BehavioralModelParams {
  selfRoleClaim: RoleClaimBehaviorParams;
  roleAssertion: RoleClaimBehaviorParams;
  investigationReport: InvestigationReportLikelihoodParams;
  suspect: TeamAlignmentBehaviorParams;
  defend: TeamAlignmentBehaviorParams;
  nominate: TeamAlignmentBehaviorParams;
  /**
   * Multiplicative adjustment applied to suspect/defend/nominate when the
   * actor already took the same public position (same type, same target)
   * earlier in the game - see repeatedPosition above. 1 means "no
   * adjustment"; this is the only history-sensitive parameter in v1.
   */
  repeatFactor: number;
  candidateVote: CandidateVoteBehaviorParams;
  keepOrEliminateVote: KeepOrEliminateBehaviorParams;
}

/**
 * Genuinely flat: 0.5 regardless of team or same/different-team target.
 * Used for every team-keyed default below. This is a deliberate choice, not
 * a placeholder - see defaultBehavioralModelParams's doc for why the
 * DEFAULTS specifically must not encode any team-directional tendency
 * (e.g. "Mafia protects teammates", "accusers target the other team more"),
 * even though the PARAMETER SHAPE fully supports configuring exactly that
 * asymmetry once there is a real basis for it (a test, or future
 * calibration - never the two held-out real games in this milestone).
 */
const NEUTRAL_ALIGNMENT_TABLE: TeamAlignmentBehaviorParams = {
  mafia: { ownTeam: 0.5, otherTeam: 0.5 },
  town: { ownTeam: 0.5, otherTeam: 0.5 },
};

const NEUTRAL_KEEP_OR_ELIMINATE_TABLE: KeepOrEliminateBehaviorParams = {
  mafia: { ...NEUTRAL_KEEP_OR_ELIMINATE },
  town: { ...NEUTRAL_KEEP_OR_ELIMINATE },
};

/**
 * A provisional, non-degenerate first parameter set - NOT a calibration
 * claim about real Mafia players, and NOT derived from the two held-out
 * real games (this milestone never inspects them). Every number is chosen
 * to be interpretable and away from the 0/1 extremes, but - just as
 * important - every TEAM-KEYED pair of buckets is kept EQUAL by default:
 *
 *  - selfRoleClaim/roleAssertion: a claim is somewhat more likely true than
 *    false (0.7/0.6 truthful) - a mild, team-INDEPENDENT base rate, not a
 *    claim about who lies more. Critically, falseSameTeam == falseDifferentTeam
 *    for both: the architecture can express "a false claim is more/less
 *    plausible depending on the claimant's team" (see the type's own doc and
 *    behavioralModel.test.ts), but the DEFAULT asserts no such direction -
 *    that would be exactly the "liars are Mafia" (or its mirror image) style
 *    of simplistic, unjustified rule this milestone explicitly avoids.
 *  - investigationReport: reuses the existing three-bucket shape
 *    (truthful/falseResult/bluff); truthful/falseResult only ever apply to
 *    whichever single role actually holds the mechanic, so there is no team
 *    axis to bias here in the first place.
 *  - suspect/defend/nominate/candidateVote's raised-hand factor/
 *    keepOrEliminateVote: every team-keyed bucket is exactly 0.5 by default
 *    (NEUTRAL_ALIGNMENT_TABLE / NEUTRAL_KEEP_OR_ELIMINATE_TABLE) - no
 *    default assumption that Mafia and Town vote/suspect/defend/nominate/
 *    eliminate any differently, or that a team recognizing its own teammates
 *    (Mafia does; Town doesn't) implies any particular voting behavior. A
 *    caller who wants that divergence configures it explicitly.
 *  - repeatFactor: 1 (no adjustment) - the only honest default until this
 *    is calibrated.
 */
export const defaultBehavioralModelParams: BehavioralModelParams = {
  selfRoleClaim: { truthful: 0.7, falseSameTeam: 0.2, falseDifferentTeam: 0.2 },
  roleAssertion: { truthful: 0.6, falseSameTeam: 0.2, falseDifferentTeam: 0.2 },
  investigationReport: { truthful: 0.7, falseResult: 0.15, bluff: 0.25 },
  suspect: NEUTRAL_ALIGNMENT_TABLE,
  defend: NEUTRAL_ALIGNMENT_TABLE,
  nominate: NEUTRAL_ALIGNMENT_TABLE,
  repeatFactor: 1,
  candidateVote: {
    vote: NEUTRAL_ALIGNMENT_TABLE,
    abstain: { mafia: 0.2, town: 0.2 },
  },
  keepOrEliminateVote: NEUTRAL_KEEP_OR_ELIMINATE_TABLE,
};

/**
 * Builds a full ObservationHandlerMap from a BehavioralModelParams - the
 * "smallest clean abstraction" this milestone adds: every entry is produced
 * by handing an ordinary (mostly closure-valued) params object to the
 * EXISTING per-type handler factory via createHandlers(), never a new
 * dispatch mechanism.
 */
export function createBehavioralHandlers(params: BehavioralModelParams): ObservationHandlerMap {
  return createHandlers(
    selfRoleClaimParamsFrom(params.selfRoleClaim),
    roleAssertionParamsFrom(params.roleAssertion),
    params.investigationReport,
    teamAlignmentParamsFrom<SuspectAction>(params.suspect, "suspect", params.repeatFactor),
    teamAlignmentParamsFrom<DefendAction>(params.defend, "defend", params.repeatFactor),
    teamAlignmentParamsFrom<NominateAction>(params.nominate, "nominate", params.repeatFactor),
    candidateVoteParamsFrom(params.candidateVote),
    keepOrEliminateParamsFrom(params.keepOrEliminateVote)
  );
}

/**
 * The full, ready-to-use LikelihoodModel: Behavioral Model v1's daytime
 * handlers, plus a NightResult handler built from `actionModel` (default:
 * createUniformActionModel - the existing, unmodified, uncalibrated
 * default; see this file's top-of-file doc for why NightResult is
 * deliberately untouched by this milestone). This is the one function a
 * caller replaying a real game needs to get a working end-to-end model.
 */
export function createBehavioralLikelihoodModel(
  params: BehavioralModelParams,
  actionModel: ActionModel = createUniformActionModel(defaultRoleRegistry)
): LikelihoodModel {
  return createLikelihoodModel(createBehavioralHandlers(params), createNightResultHandler(actionModel));
}
