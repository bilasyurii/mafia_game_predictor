import { ObservationHandlerMap } from "./evidence";
import { hasMechanic } from "./roles";
import { satisfiedBy } from "./roleGroups";
import {
  createSelfRoleClaimHandler,
  SelfRoleClaimLikelihoodParams,
} from "./selfRoleClaimLikelihood";

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
   * roleAssertion: "A: B is <role>".
   *
   * Depends on world.roles[actor] AND world.roles[target] AND whether the
   * claim matches world.roles[target] - a mafia player accusing a fellow
   * mafia member is a structurally different situation from a citizen
   * making the same accusation, even though both are "an assertion about
   * someone else". The eventual model keys off the (actorRole, targetRole,
   * correctness) tuple, not off any specific role name.
   */
  roleAssertion(observation, world, _ctx) {
    const actorRole = world.roles[observation.actor];
    const targetRole = world.roles[observation.target];
    const isCorrect = targetRole === observation.role;
    throw new Error(
      `roleAssertion likelihood not calibrated yet (actorRole=${actorRole}, isCorrect=${isCorrect})`
    );
  },

  /**
   * investigationReport: "A: I investigated B, result <role>".
   *
   * The key question is generic: does world.roles[actor] have EITHER
   * investigative mechanic ("checkIsCommissioner" - Don's, or
   * "checkIsMafia" - Commissioner's) *in this candidate world*? Two
   * branches:
   *  - true: the report could be a real result. Then compare the claimed
   *    role to world.roles[target] - matching implies a genuine, correct
   *    report; not matching implies either a deliberately false report or
   *    an imperfect investigation mechanic. Note a real check only ever
   *    yields a yes/no about a specific mechanic, never an exact role -
   *    a report naming a specific role is itself already a claim beyond
   *    what the mechanic could produce, a nuance the eventual model needs
   *    to account for.
   *  - false: actor's role in this world cannot produce a real
   *    investigation, so this observation can only be a bluff - collapsing
   *    to roughly the same likelihood shape as a plain roleAssertion.
   * Note the same raw observation, scored against two different worlds
   * (one where actor has a mechanic, one where they don't), naturally
   * takes two different code paths here - nothing is hardcoded to
   * "commissioner" or "don".
   */
  investigationReport(observation, world, ctx) {
    const actorRole = world.roles[observation.actor];
    const canInvestigate =
      hasMechanic(ctx.roles, actorRole, "checkIsCommissioner") ||
      hasMechanic(ctx.roles, actorRole, "checkIsMafia");
    const isCorrect = world.roles[observation.target] === observation.role;
    throw new Error(
      `investigationReport likelihood not calibrated yet (canInvestigate=${canInvestigate}, isCorrect=${isCorrect})`
    );
  },

  /**
   * vote / suspect: public behavioral signals.
   *
   * Conceptually similar - both are lightweight, non-mechanical, public
   * acts available to anyone. A future model would consult whether actor
   * and target are on the same team *in this world*
   * (ctx.roles[world.roles[actor]].team vs ...target...team) as a proxy
   * for "would this role want to vote/suspect this target", plus
   * ctx.history for pattern-based signals (e.g. repeated suspicion of the
   * same target carrying diminishing marginal evidence). Still no literal
   * role-name branching - only team/mechanic lookups through the registry.
   */
  vote(observation, world, ctx) {
    const actorTeam = ctx.roles[world.roles[observation.actor]].team;
    const targetTeam = ctx.roles[world.roles[observation.target]].team;
    throw new Error(
      `vote likelihood not calibrated yet (actorTeam=${actorTeam}, targetTeam=${targetTeam})`
    );
  },

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
   * Same shape/reasoning as vote/suspect - a lightweight public act,
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
 * implementation from selfRoleClaimLikelihood.ts. Every other type stays
 * an uncalibrated stub - this step covers selfRoleClaim only.
 */
export function createHandlers(
  selfRoleClaimParams: SelfRoleClaimLikelihoodParams
): ObservationHandlerMap {
  return {
    ...uncalibratedHandlers,
    selfRoleClaim: createSelfRoleClaimHandler(selfRoleClaimParams),
  };
}
