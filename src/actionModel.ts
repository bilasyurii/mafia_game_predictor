import { AliveState, PlayerId, World } from "./types";
import { HiddenNightActions, NightHistoryContext } from "./night";

/**
 * Answers: how plausible is this specific hidden-action hypothesis, given
 * the candidate world, who's alive, and everything currently public
 * (including - via `history` - the belief-relevant part of the prior
 * night's own hidden actions)? createUniformActionModel is the current
 * default implementation: a maximum-entropy "every legal choice is equally
 * likely" null hypothesis, not a behavioral claim about how any role
 * actually chooses targets - a genuine calibrated/behavioral ActionModel
 * remains future work. This interface is deliberately separate from
 * resolveNight (which only computes deterministic consequences, never
 * plausibility) and from LikelihoodModel (which scores public observations,
 * not private choices).
 */
export interface ActionModel {
  probability(
    actions: HiddenNightActions,
    world: World,
    alive: AliveState,
    history: NightHistoryContext
  ): number;
}

/**
 * An ActionModel that additionally commits to a specific mathematical
 * structure: the four hidden night-action blocks - the mafia-team's joint
 * kill choice, the Don's check target, the Commissioner's check target, and
 * the Doctor's save target - are INDEPENDENT of one another given the world
 * and alive state. Concretely, for any full `actions`:
 *
 *   probability(actions, world, alive, history)
 *     === (killers present
 *           ? P(every living killer unanimously targets
 *               actions.mafiaTargetChoices' common value)
 *           : 1)
 *       × (Don alive ? donCheckTargetProbability(actions.donCheckTarget, ...) : 1)
 *       × (Commissioner alive ? commissionerCheckTargetProbability(actions.commissionerCheckTarget, ...) : 1)
 *       × (Doctor alive ? doctorSaveTargetProbability(actions.doctorSaveTarget, ...) : 1)
 *
 * This is a genuine simplifying assumption about how the model's
 * probability mass is structured - never something nightResultLikelihood.ts
 * (or anything else) may assume of a plain ActionModel. Only a model that
 * explicitly implements this interface may be scored by the optimized
 * marginalization path; every other model is scored by the unchanged
 * brute-force path, which makes no such assumption.
 *
 * Each method below exposes exactly the marginal query the optimized path
 * needs - never the full per-killer joint choice, since only whether the
 * mafia-team reaches consensus (and on whom) is ever relevant to a
 * NightResultFact's `died` set; see night.ts's enumerateHiddenNightActions
 * and nightResultLikelihood.ts for why.
 */
export interface FactoredActionModel extends ActionModel {
  /**
   * P(every currently-alive killer - i.e. every living holder of the
   * unanimousNightKill mechanic - independently targets `target`). Only
   * ever queried when at least one killer is alive; with zero killers there
   * is no mafia block at all, mirroring enumerateHiddenNightActions leaving
   * `mafiaTargetChoices` empty in that case.
   */
  mafiaConsensusProbability(
    target: PlayerId,
    world: World,
    alive: AliveState,
    history: NightHistoryContext
  ): number;

  /** P(the Don targets `target`). Only ever queried while the Don is alive. */
  donCheckTargetProbability(
    target: PlayerId,
    world: World,
    alive: AliveState,
    history: NightHistoryContext
  ): number;

  /** P(the Commissioner targets `target`). Only ever queried while alive. */
  commissionerCheckTargetProbability(
    target: PlayerId,
    world: World,
    alive: AliveState,
    history: NightHistoryContext
  ): number;

  /** P(the Doctor targets `target`). Only ever queried while alive. */
  doctorSaveTargetProbability(
    target: PlayerId,
    world: World,
    alive: AliveState,
    history: NightHistoryContext
  ): number;
}
