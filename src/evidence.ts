import { AliveState, GameConfig, Observation, World } from "./types";
import { RoleRegistry } from "./roles";
import { GroupRegistry } from "./roleGroups";
import { NightResultFact } from "./night";
import { assertAlive } from "./facts";
import type { DayEliminationFact } from "./facts";
import { resolveDayElimination } from "./dayEliminationLikelihood";

/**
 * Everything a likelihood computation might need beyond the observation and
 * the candidate world themselves: game rules, role mechanics, role groups,
 * who's alive, and the history of prior public evidence (for
 * contextual/sequential evidence - e.g. weighing a defend differently if
 * it echoes an earlier investigationReport).
 */
export interface EvidenceContext {
  config: GameConfig;
  roles: RoleRegistry;
  groups: GroupRegistry;
  alive: AliveState;
  /**
   * Every public evidence item recorded before the one being scored, in
   * recorded order - observations and public facts alike. For history[i]
   * this should be exactly getHistoryBefore(history, i), so a handler can
   * never see anything that happened later.
   */
  history: Evidence[];
}

/**
 * Anything the public observer can learn and use as Bayesian evidence:
 * a player-produced statement/behavior (Observation), a publicly-announced
 * night outcome (NightResultFact), or a publicly-announced day elimination
 * (DayEliminationFact). All are scored the same way - see LikelihoodModel.
 */
export type Evidence = Observation | NightResultFact | DayEliminationFact;

/**
 * The ONLY place RoleRegistry and Evidence are allowed to meet.
 * Answers: how probable is it that `evidence` would have arisen, if
 * `world` were the true role assignment?
 */
export interface LikelihoodModel {
  likelihood(evidence: Evidence, world: World, ctx: EvidenceContext): number;
}

/** A handler for one specific Observation subtype. */
export type ObservationHandler<O extends Observation = Observation> = (
  observation: O,
  world: World,
  ctx: EvidenceContext
) => number;

/** One handler per Observation["type"], nothing more, nothing less. */
export type ObservationHandlerMap = {
  [T in Observation["type"]]: ObservationHandler<
    Extract<Observation, { type: T }>
  >;
};

/**
 * A NightResultFact's likelihood is not a simple per-type table lookup like
 * the Observation handlers above - it requires marginalizing over hidden
 * night actions via resolveNight() + an ActionModel. Kept as its own
 * handler shape rather than forced into ObservationHandlerMap.
 */
export type NightResultHandler = (
  fact: NightResultFact,
  world: World,
  ctx: EvidenceContext
) => number;

/**
 * Builds a LikelihoodModel that dispatches on evidence.type: player
 * statements/behavior go to `handlers`, a night outcome goes to
 * `nightResultHandler`, and a day elimination goes to resolveDayElimination
 * (a deterministic consistency check against already-public vote evidence,
 * not a per-world-varying likelihood - see dayEliminationLikelihood.ts).
 * This function - and updateProbabilities(), which calls it - never
 * branches on a role name or evidence type beyond this dispatch. Only the
 * injected handlers may consult RoleRegistry, and only ever generically
 * (e.g. hasMechanic(ctx.roles, role, "checkIsMafia")), never via a literal
 * comparison like role === "commissioner".
 *
 * Every Observation with a single `actor` (selfRoleClaim, roleAssertion,
 * investigationReport, suspect, defend, nominate - every Observation except
 * the two vote types, which have many participants and validate each one's
 * own aliveness themselves, in voting.ts) is checked with assertAlive
 * before reaching its handler: a dead player cannot produce a NEW
 * observation. This is a mechanical, world-independent precondition - not
 * role-specific logic - so it belongs here rather than duplicated across
 * six handler modules. ctx.alive is already the alive state at the start
 * of this evidence's own phase (see facts.ts's getAliveStateForEvidence),
 * so a player who is only eliminated later THIS SAME phase (e.g. "last
 * words" spoken right after one's own day elimination) is still correctly
 * alive here and unaffected by this check.
 */
export function createLikelihoodModel(
  handlers: ObservationHandlerMap,
  nightResultHandler: NightResultHandler = () => {
    throw new Error(
      "nightResult likelihood not implemented yet - requires a calibrated ActionModel"
    );
  }
): LikelihoodModel {
  return {
    likelihood(evidence, world, ctx) {
      if (evidence.type === "nightResult") {
        return nightResultHandler(evidence, world, ctx);
      }
      if (evidence.type === "dayElimination") {
        return resolveDayElimination(evidence, world, ctx);
      }
      if (evidence.type !== "candidateVote" && evidence.type !== "keepOrEliminateVote") {
        assertAlive(ctx.alive, evidence.actor);
      }
      const handler = handlers[evidence.type] as ObservationHandler;
      return handler(evidence, world, ctx);
    },
  };
}
