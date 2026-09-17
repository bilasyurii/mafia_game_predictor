import { PlayerId } from "../types";
import {
  AgentResponse,
  DayActionDecision,
  KeepOrEliminateDecision,
  SimulationAgent,
  SimulationDecisionRequest,
  TargetChoiceDecision,
  VoteDecision,
} from "./types";

/**
 * Deterministic, non-LLM test doubles for the simulation harness - NOT a
 * real provider, never imported by driver.ts, and never used to make claims
 * about actual model behavior. They exist purely so this milestone's tests
 * can drive a full synthetic game to completion (or exercise the validation/
 * retry boundary) without any network or API dependency, per this
 * milestone's explicit "do not call any external LLM API" instruction.
 */

/** Never suspects/defends/nominates/claims; abstains on every vote and every keep/eliminate decision. */
export const passiveAgent: SimulationAgent = {
  async decide(request: SimulationDecisionRequest): Promise<AgentResponse> {
    if (request.kind === "dayAction") {
      const decision: DayActionDecision = { type: "dayAction" };
      return { decision };
    }
    if (request.kind === "vote") {
      const decision: VoteDecision = { type: "vote", candidate: null };
      return { decision };
    }
    if (request.kind === "keepOrEliminateVote") {
      const decision: KeepOrEliminateDecision = { type: "keepOrEliminate", eliminate: false };
      return { decision };
    }
    throw new Error(`passiveAgent has no target opinion for request kind "${request.kind}"`);
  },
};

/**
 * Delegates day/vote/keepOrEliminate behavior to passiveAgent. For any
 * "pick a target" night request, chooses the first living player - in
 * `view.players` order - who is not the requesting player and not on the
 * requesting player's own team, so every Mafia-team member independently
 * computes the SAME target (real unanimous consensus falls out of shared
 * private knowledge, not hardcoded coordination). For a doctorSave request
 * specifically, also excludes whatever the doctor saved last night
 * (`view.private.saves`), so the no-consecutive-repeat rule is never
 * violated. Deterministic and reproducible: no randomness, no network calls.
 */
export const firstNonTeammateTargetAgent: SimulationAgent = {
  async decide(request: SimulationDecisionRequest): Promise<AgentResponse> {
    if (request.kind === "dayAction" || request.kind === "vote" || request.kind === "keepOrEliminateVote") {
      return passiveAgent.decide(request);
    }

    const { view } = request;
    const excluded = new Set<PlayerId>([view.self, ...(view.private.teammates ?? [])]);
    const lastSave = view.private.saves?.[view.private.saves.length - 1]?.target;
    const target = view.players.find((p) => view.alive.includes(p) && !excluded.has(p) && p !== lastSave);
    if (target === undefined) {
      throw new Error(`firstNonTeammateTargetAgent found no legal target for "${request.kind}"`);
    }
    const decision: TargetChoiceDecision = { type: "targetChoice", target };
    return { decision };
  },
};
