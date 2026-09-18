import { GameConfig, PlayerId, RoleExpression, RoleId } from "../types";
import { Evidence } from "../evidence";
import { GamePhase } from "../facts";
import { InvestigationMechanic } from "../investigation";
import { HiddenNightActions, NightResolution } from "../night";
import { GameOutcome } from "../gameOutcome";

/**
 * The simulation layer generates a synthetic game's public Evidence[] log by
 * asking one LLM-backed SimulationAgent to make each behavioral decision,
 * then having ordinary TypeScript (resolveNight, voting.ts, facts.ts,
 * getGameOutcome - all unchanged) apply the resulting game rules. This file
 * only defines the small shapes the driver (driver.ts) and any
 * SimulationAgent implementation share - no inference/likelihood types from
 * evidence.ts/behavioralModel.ts are touched or reused here, and nothing
 * here is wired into processEvidence/updateProbabilities.
 */

// ============================================================
// What a simulated player legitimately knows
// ============================================================

export interface PrivateInvestigation {
  /** The night the check was actually made (not a day it might later be reported on). */
  night: number;
  target: PlayerId;
  mechanic: InvestigationMechanic;
  result: boolean;
}

export interface PrivateSave {
  night: number;
  target: PlayerId;
}

/**
 * Exactly the private knowledge a real player holding `role` would have -
 * nothing more. `teammates` is present only for a Mafia-team role (the full
 * roster, living or dead - a real player never un-learns a dead teammate's
 * identity). `investigations`/`saves` are this SPECIFIC player's own
 * mechanic-use history, populated only for a role that actually holds that
 * mechanic. playerView.ts's buildPlayerView is the only place that decides
 * what belongs here.
 */
export interface PrivateKnowledge {
  role: RoleId;
  teammates?: PlayerId[];
  investigations?: PrivateInvestigation[];
  saves?: PrivateSave[];
}

/**
 * The compact, structured state one player's decision is made from: no raw
 * transcript, no other player's role, no future events, no ground truth
 * beyond this player's own legitimate knowledge, and nothing from the
 * Bayesian predictor. `publicHistory` is literally the same kind of
 * Evidence[] the inference layer itself consumes (see evidence.ts's
 * EvidenceContext.history) - already compact structured tuples, not prose.
 */
export interface PublicGameStateView {
  self: PlayerId;
  phase: GamePhase;
  players: PlayerId[];
  alive: PlayerId[];
  publicHistory: Evidence[];
  private: PrivateKnowledge;
}

// ============================================================
// Decisions an agent can make
// ============================================================

export interface InvestigationClaimInput {
  target: PlayerId;
  mechanic: InvestigationMechanic;
  result: boolean;
  night?: number;
}

/**
 * One player's whole day turn in a single response: zero or more suspects,
 * zero or more defends, at most one nomination, and an optional role/
 * investigation claim. The driver splits this into the corresponding
 * individual Evidence items - see driver.ts's "ONE LLM DECISION != ONE
 * EVIDENCE ITEM" doc.
 */
export interface DayActionDecision {
  type: "dayAction";
  suspect?: PlayerId[];
  defend?: PlayerId[];
  nominate?: PlayerId;
  roleClaim?: RoleExpression;
  investigationClaim?: InvestigationClaimInput;
  /** Never required, never read by the simulator - for human/debug inspection only. */
  reason?: string;
}

/** A candidate-vote or revote decision: a candidate to raise a hand for, or null to abstain. */
export interface VoteDecision {
  type: "vote";
  candidate: PlayerId | null;
  reason?: string;
}

/** The final keep/eliminate decision after two consecutive ties. */
export interface KeepOrEliminateDecision {
  type: "keepOrEliminate";
  eliminate: boolean;
  reason?: string;
}

/**
 * Any night mechanic that reduces to "pick one living player": the Mafia
 * kill (one call per living killer - see driver.ts for how their choices are
 * combined into a HiddenNightActions), the Don's check, the Commissioner's
 * check, or the Doctor's save. Which mechanic is which is carried by the
 * REQUEST kind, not by this decision itself.
 */
export interface TargetChoiceDecision {
  type: "targetChoice";
  target: PlayerId;
  reason?: string;
}

export type SimulationDecision =
  | DayActionDecision
  | VoteDecision
  | KeepOrEliminateDecision
  | TargetChoiceDecision;

// ============================================================
// The request/agent boundary
// ============================================================

export type SimulationDecisionRequest =
  | { kind: "dayAction"; player: PlayerId; view: PublicGameStateView }
  | { kind: "vote"; player: PlayerId; view: PublicGameStateView; stage: "initial" | "revote"; candidates: PlayerId[] }
  | { kind: "keepOrEliminateVote"; player: PlayerId; view: PublicGameStateView; candidates: PlayerId[] }
  | { kind: "mafiaKill"; player: PlayerId; view: PublicGameStateView }
  | { kind: "donCheck"; player: PlayerId; view: PublicGameStateView }
  | { kind: "commissionerCheck"; player: PlayerId; view: PublicGameStateView }
  | { kind: "doctorSave"; player: PlayerId; view: PublicGameStateView };

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Only present when the provider actually reports prompt-cache usage - never invented. */
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /** Only present when the provider reports an actual measured dollar cost for this call (e.g. claude -p's total_cost_usd) - never recomputed/estimated here. */
  costUsd?: number;
}

export interface AgentResponse {
  decision: SimulationDecision;
  usage?: AgentUsage;
}

/**
 * The provider boundary: the driver depends only on this interface, never on
 * a specific LLM SDK. A real Haiku-backed implementation (connected in a
 * later milestone) and the deterministic fake agents in testAgents.ts (this
 * milestone's tests) are equally valid implementations of it.
 */
export interface SimulationAgent {
  decide(request: SimulationDecisionRequest): Promise<AgentResponse>;
}

// ============================================================
// Output: public trajectory + ground truth + cost instrumentation
// ============================================================

/** One night's real hidden actions and their deterministic resolution - ground truth only. */
export interface GroundTruthNight {
  round: number;
  actions: HiddenNightActions;
  resolution: NightResolution;
}

export interface SimulationGroundTruth {
  /** The true role of every player - NEVER passed into buildPlayerView except a player's own. */
  roles: Record<PlayerId, RoleId>;
  nights: GroundTruthNight[];
}

export interface SimulationStats {
  llmCalls: number;
  retries: number;
  decisionsByRequestKind: Partial<Record<SimulationDecisionRequest["kind"], number>>;
  /** Only summed from AgentResponse.usage when a call actually reported it - never invented. */
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheCreationInputTokens?: number;
  totalCacheReadInputTokens?: number;
  /** Sum of every AgentUsage.costUsd actually reported - never estimated from token counts here. */
  totalCostUsd?: number;
  callsWithReportedUsage: number;
}

export interface SimulationOutput {
  config: GameConfig;
  seed: number;
  publicEvidence: Evidence[];
  groundTruth: SimulationGroundTruth;
  outcome: GameOutcome;
  stats: SimulationStats;
  /** Number of day/night round-pairs actually played (the loop's own `round` counter at exit). */
  roundsPlayed: number;
  /** True only if the game hit `maxRounds` while still "ongoing" - an honest safety-cap exit, never a fabricated winner. */
  terminatedByRoundCap: boolean;
}
