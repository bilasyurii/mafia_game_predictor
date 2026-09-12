import { World } from "./types";
import { Evidence, EvidenceContext, LikelihoodModel } from "./evidence";
import { getAliveStateForEvidence, getHistoryBefore } from "./facts";
import { updateProbabilities } from "./updateProbabilities";

/** What stays the same for every evidence item in a game. */
export type GameSetting = Omit<EvidenceContext, "alive" | "history">;

/** One evidence item's Bayesian update, with the exact context it was scored against. */
export interface EvidenceStep {
  index: number;
  evidence: Evidence;
  context: EvidenceContext;
  prior: World[];
  posterior: World[];
}

/**
 * Scores an ordered public log one item at a time: each item's posterior is
 * the next item's prior. history[i] is scored with a context built only from
 * what was recorded before it - ctx.history is getHistoryBefore(history, i),
 * and ctx.alive is derived from that same prefix - so a handler can never see
 * the item itself or anything later, and a malformed later fact can't affect
 * an earlier item.
 *
 * Orchestration only: the Bayesian math is updateProbabilities, the scoring
 * is `model`. Any error from either (including a handler that isn't
 * implemented yet) propagates unchanged. Nothing is mutated.
 */
export function processEvidence(
  worlds: World[],
  history: readonly Evidence[],
  model: LikelihoodModel,
  setting: GameSetting
): EvidenceStep[] {
  const steps: EvidenceStep[] = [];
  let prior = worlds;

  history.forEach((evidence, index) => {
    const before = getHistoryBefore(history, index);
    const context: EvidenceContext = {
      ...setting,
      alive: getAliveStateForEvidence(setting.config, before, evidence),
      history: before,
    };
    const posterior = updateProbabilities(prior, evidence, model, context);
    steps.push({ index, evidence, context, prior, posterior });
    prior = posterior;
  });

  return steps;
}
