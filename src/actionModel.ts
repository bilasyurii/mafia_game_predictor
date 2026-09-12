import { AliveState, World } from "./types";
import { HiddenNightActions, NightHistoryContext } from "./night";

/**
 * Scaffold only - no behavioral model yet, no numbers, no heuristics.
 * Will eventually answer: how plausible is this specific hidden-action
 * hypothesis, given the candidate world and everything currently public?
 * This is deliberately separate from resolveNight (which only computes
 * deterministic consequences, never plausibility) and from LikelihoodModel
 * (which scores public observations, not private choices).
 */
export interface ActionModel {
  probability(
    actions: HiddenNightActions,
    world: World,
    alive: AliveState,
    history: NightHistoryContext
  ): number;
}
