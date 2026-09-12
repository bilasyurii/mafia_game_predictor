import { ObservationHandlerMap } from "./evidence";
import { hasMechanic } from "./roles";
import { satisfiedBy } from "./roleGroups";
import { getInvestigationResult } from "./investigation";
import {
  createSelfRoleClaimHandler,
  SelfRoleClaimLikelihoodParams,
} from "./selfRoleClaimLikelihood";
import {
  createRoleAssertionHandler,
  RoleAssertionLikelihoodParams,
} from "./roleAssertionLikelihood";

/**
 * Reference implementation of ObservationHandlerMap - the conceptual shape
 * of each handler, with the reasoning each one will eventually follow. No
 * numbers are chosen here yet; every branch throws until real likelihood
 * values are calibrated. None of this dispatches on a literal role id -
 * only on what a candidate world's role assignment implies (via
 * hasMechanic) or on structural facts (does claimed role match true role).
 */
export const uncalibratedHandlers: ObservationHandlerMap = {
  /**
   * selfRoleClaim: "A: I am <role or group>".
   *
   * Checks whether world.roles[actor] satisfies the claimed expression -
   * a "truthful" branch (it does, whether the claim was an exact role or
   * a group) vs a "lie" branch (it doesn't). This alone is what makes a
   * citizen claiming commissioner, a mafia claiming commissioner, and a
   * real commissioner claiming commissioner behave differently - not
   * because the handler special-cases any of those roles, but because
   * each is scored against a *different* candidate world. Whether lying
   * is uniform across roles/claim-specificity or team-dependent (e.g.
   * mafia bluff more) is a future refinement - it would key off
   * ctx.roles[...].team or the claim's kind generically, never off a
   * literal role/team name in a conditional.
   */
  selfRoleClaim(observation, world, ctx) {
    const isTruthful = satisfiedBy(
      observation.claim,
      world.roles[observation.actor],
      ctx.groups
    );
    throw new Error(
      `selfRoleClaim likelihood not calibrated yet (truthful=${isTruthful})`
    );
  },

  /**
   * roleAssertion: "A: B is <role or group>".
   *
   * Depends on world.roles[actor] AND world.roles[target] AND whether
   * world.roles[target] satisfies the claimed expression - a mafia player
   * accusing a fellow mafia member is a structurally different situation
   * from a citizen making the same accusation, even though both are "an
   * assertion about someone else". The eventual model keys off the
   * (actorRole, targetRole, correctness) tuple, not off any specific role
   * name.
   */
  roleAssertion(observation, world, ctx) {
    const actorRole = world.roles[observation.actor];
    const isCorrect = satisfiedBy(
      observation.claim,
      world.roles[observation.target],
      ctx.groups
    );
    throw new Error(
      `roleAssertion likelihood not calibrated yet (actorRole=${actorRole}, isCorrect=${isCorrect})`
    );
  },

  /**
   * investigationReport: "A: I used <mechanic> on B, result YES/NO".
   *
   * Two deterministic facts are available per candidate world, neither of
   * which names a role:
   *  - canPerform: does world.roles[actor] hold observation.mechanic?
   *  - matchesActual: does observation.result equal what the check would
   *    really return against world.roles[target] (getInvestigationResult,
   *    the same rule resolveNight uses)?
   * Neither is a hard constraint on its own. Anyone may publicly claim a
   * check, so a world where actor can't perform it is not impossible - the
   * report is simply not a genuine result there. How likely a bluff, a lie
   * about a real result, or a truthful report is remains behavioral and
   * uncalibrated, so no likelihood (including 0) is returned yet.
   */
  investigationReport(observation, world, ctx) {
    const canPerform = hasMechanic(
      ctx.roles,
      world.roles[observation.actor],
      observation.mechanic
    );
    const matchesActual =
      getInvestigationResult(
        ctx.roles,
        observation.mechanic,
        world.roles[observation.target]
      ) === observation.result;
    throw new Error(
      `investigationReport likelihood not calibrated yet (canPerform=${canPerform}, matchesActual=${matchesActual})`
    );
  },

  /**
   * candidateVote / keepOrEliminateVote: one whole public voting round.
   *
   * Scored as a single event, since every living player's choice is part of
   * the same observation (including abstentions, which only exist relative
   * to everyone else's hands). A future model may factor it per voter
   * against the candidate world's roles, but how any role tends to vote is
   * behavioral and uncalibrated. The deterministic rules - validation,
   * abstention, counting, outcome - live in voting.ts; they need the alive
   * state at the time of the vote, which ctx.alive is not guaranteed to be.
   */
  candidateVote(observation) {
    throw new Error(
      `candidateVote likelihood not calibrated yet (round=${observation.round}, stage=${observation.stage})`
    );
  },

  keepOrEliminateVote(observation) {
    throw new Error(
      `keepOrEliminateVote likelihood not calibrated yet (round=${observation.round})`
    );
  },

  /**
   * suspect: a public behavioral signal - a lightweight, non-mechanical act
   * available to anyone. A future model would consult whether actor and
   * target are on the same team *in this world*
   * (ctx.roles[world.roles[actor]].team vs ...target...team) as a proxy for
   * "would this role want to suspect this target", plus ctx.history for
   * pattern-based signals (e.g. repeated suspicion of the same target
   * carrying diminishing marginal evidence). Still no literal role-name
   * branching - only team/mechanic lookups through the registry.
   */
  suspect(observation, world, ctx) {
    const actorTeam = ctx.roles[world.roles[observation.actor]].team;
    const targetTeam = ctx.roles[world.roles[observation.target]].team;
    throw new Error(
      `suspect likelihood not calibrated yet (actorTeam=${actorTeam}, targetTeam=${targetTeam})`
    );
  },

  /**
   * defend: "A publicly defended B".
   *
   * Same observation shape regardless of whether actor is a doctor or a
   * citizen (see the layering discussion - defend is not gated by any
   * mechanic). Its likelihood should still depend on the candidate roles
   * of BOTH actor and target in this world (team alignment), and can later
   * draw on ctx.history/ctx.alive for contextual corroboration (e.g. did
   * the target survive a night where they were plausibly attacked, which
   * might weakly correlate with a real doctor's private protect action -
   * itself never directly observed).
   */
  defend(observation, world, ctx) {
    const actorTeam = ctx.roles[world.roles[observation.actor]].team;
    const targetTeam = ctx.roles[world.roles[observation.target]].team;
    throw new Error(
      `defend likelihood not calibrated yet (actorTeam=${actorTeam}, targetTeam=${targetTeam})`
    );
  },

  /**
   * nominate: "A nominated B for the elimination vote".
   *
   * Same shape/reasoning as suspect - a lightweight public act,
   * available to anyone, whose eventual likelihood would consult team
   * alignment in this world plus context (e.g. ctx.history for whether
   * this nomination follows a suspicious pattern).
   */
  nominate(observation, world, ctx) {
    const actorTeam = ctx.roles[world.roles[observation.actor]].team;
    const targetTeam = ctx.roles[world.roles[observation.target]].team;
    throw new Error(
      `nominate likelihood not calibrated yet (actorTeam=${actorTeam}, targetTeam=${targetTeam})`
    );
  },
};

/**
 * All handlers, with `selfRoleClaim` replaced by the real, configurable
 * implementation from selfRoleClaimLikelihood.ts, and `roleAssertion`
 * likewise replaced when `roleAssertionParams` is given. Every other type
 * stays an uncalibrated stub.
 */
export function createHandlers(
  selfRoleClaimParams: SelfRoleClaimLikelihoodParams,
  roleAssertionParams?: RoleAssertionLikelihoodParams
): ObservationHandlerMap {
  return {
    ...uncalibratedHandlers,
    selfRoleClaim: createSelfRoleClaimHandler(selfRoleClaimParams),
    ...(roleAssertionParams && {
      roleAssertion: createRoleAssertionHandler(roleAssertionParams),
    }),
  };
}
