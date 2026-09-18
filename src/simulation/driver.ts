import { AliveState, CandidateVote, GameConfig, KeepOrEliminateVote, PlayerId, World } from "../types";
import { Evidence } from "../evidence";
import { GamePhase, getAliveStateAt } from "../facts";
import { defaultRoleRegistry, hasMechanic, RoleRegistry } from "../roles";
import { HiddenNightActions, NightHistoryContext, resolveNight } from "../night";
import { resolveCandidateVote, resolveKeepOrEliminateVote } from "../voting";
import { getGameOutcome } from "../gameOutcome";
import { assignRolesWithSeed } from "./rng";
import { buildPlayerView } from "./playerView";
import {
  SimulationValidationError,
  validateDayActionDecision,
  validateKeepOrEliminateDecision,
  validateTargetChoiceDecision,
  validateVoteDecision,
} from "./validation";
import {
  DayActionDecision,
  GroundTruthNight,
  KeepOrEliminateDecision,
  PrivateInvestigation,
  PrivateSave,
  SimulationAgent,
  SimulationDecision,
  SimulationDecisionRequest,
  SimulationOutput,
  SimulationStats,
  TargetChoiceDecision,
  VoteDecision,
} from "./types";

/**
 * The simulation driver: TypeScript owns every deterministic game mechanic
 * (resolveNight, voting.ts's tally/resolve functions, facts.ts's alive-state
 * derivation, getGameOutcome's termination check) exactly as they already
 * exist elsewhere in this project - nothing here reimplements or bypasses
 * them. The only thing an LLM-backed SimulationAgent ever supplies is a
 * small structured behavioral decision (see types.ts); the driver validates
 * it (validation.ts), converts it into public Evidence and/or hidden night
 * actions, and hands the result straight to the existing rule functions.
 *
 * ONE LLM DECISION != ONE EVIDENCE ITEM: a single dayAction decision can
 * expand into several suspect/defend/nominate/selfRoleClaim/
 * investigationReport Evidence items, exactly mirroring how a real player's
 * one turn at the table produces several distinct observable acts.
 */
export interface RunSimulationOptions {
  seed: number;
  agent: SimulationAgent;
  registry?: RoleRegistry;
  /** Safety cap on day/night round-pairs, in case scripted/LLM play never converges. Default: players.length + 2. */
  maxRounds?: number;
  /** Extra attempts after the first, per decision, before giving up. Default: 2. */
  maxRetriesPerDecision?: number;
}

function assertDecisionKind<T extends SimulationDecision["type"]>(
  decision: SimulationDecision,
  expected: T
): asserts decision is Extract<SimulationDecision, { type: T }> {
  if (decision.type !== expected) {
    throw new SimulationValidationError(`expected a "${expected}" decision, got "${decision.type}"`);
  }
}

function validateDecisionForRequest(
  request: SimulationDecisionRequest,
  decision: SimulationDecision,
  aliveNow: PlayerId[],
  forbiddenDoctorTarget: PlayerId | undefined
): void {
  if (request.kind === "dayAction") {
    assertDecisionKind(decision, "dayAction");
    validateDayActionDecision(decision, request.view.players, aliveNow);
  } else if (request.kind === "vote") {
    assertDecisionKind(decision, "vote");
    validateVoteDecision(decision, request.candidates);
  } else if (request.kind === "keepOrEliminateVote") {
    assertDecisionKind(decision, "keepOrEliminate");
    validateKeepOrEliminateDecision(decision);
  } else {
    assertDecisionKind(decision, "targetChoice");
    validateTargetChoiceDecision(
      decision,
      aliveNow,
      request.kind === "doctorSave" ? forbiddenDoctorTarget : undefined
    );
  }
}

export async function runSimulation(config: GameConfig, options: RunSimulationOptions): Promise<SimulationOutput> {
  const registry = options.registry ?? defaultRoleRegistry;
  const maxRounds = options.maxRounds ?? config.players.length + 2;
  const maxRetries = options.maxRetriesPerDecision ?? 2;

  const groundTruthRoles = assignRolesWithSeed(config, options.seed);
  const groundTruthWorld: World = { roles: groundTruthRoles, probability: 1 };

  const publicHistory: Evidence[] = [];
  const nightsGroundTruth: GroundTruthNight[] = [];
  const stats: SimulationStats = {
    llmCalls: 0,
    retries: 0,
    decisionsByRequestKind: {},
    callsWithReportedUsage: 0,
  };

  const investigationsByPlayer: Record<PlayerId, PrivateInvestigation[]> = {};
  const savesByPlayer: Record<PlayerId, PrivateSave[]> = {};
  config.players.forEach((p) => {
    investigationsByPlayer[p] = [];
    savesByPlayer[p] = [];
  });

  let previousDoctorSaveTarget: PlayerId | undefined;

  function aliveStateAt(phase: GamePhase): AliveState {
    return getAliveStateAt(config, publicHistory, phase);
  }

  function livingPlayersAt(phase: GamePhase): PlayerId[] {
    const state = aliveStateAt(phase);
    return config.players.filter((p) => state[p] === true);
  }

  function outcomeAt(phase: GamePhase) {
    return getGameOutcome(groundTruthWorld, aliveStateAt(phase), registry);
  }

  function viewFor(player: PlayerId, phase: GamePhase, alive: PlayerId[]) {
    return buildPlayerView(
      player,
      phase,
      config,
      publicHistory,
      alive,
      groundTruthRoles,
      registry,
      investigationsByPlayer[player],
      savesByPlayer[player]
    );
  }

  async function ask(
    request: SimulationDecisionRequest,
    aliveNow: PlayerId[],
    forbiddenDoctorTarget: PlayerId | undefined
  ): Promise<SimulationDecision> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      stats.llmCalls += 1;
      stats.decisionsByRequestKind[request.kind] = (stats.decisionsByRequestKind[request.kind] ?? 0) + 1;
      try {
        // The agent call itself belongs inside this try: a real provider can fail by
        // throwing (network error, malformed JSON it couldn't parse into a decision at
        // all) just as easily as by returning a well-formed-but-illegal decision - both
        // are equally "an invalid response" and must go through the same bounded retry,
        // never crash the whole simulation on the first bad call.
        const response = await options.agent.decide(request);
        if (response.usage) {
          stats.callsWithReportedUsage += 1;
          if (response.usage.inputTokens !== undefined) {
            stats.totalInputTokens = (stats.totalInputTokens ?? 0) + response.usage.inputTokens;
          }
          if (response.usage.outputTokens !== undefined) {
            stats.totalOutputTokens = (stats.totalOutputTokens ?? 0) + response.usage.outputTokens;
          }
          if (response.usage.cacheCreationInputTokens !== undefined) {
            stats.totalCacheCreationInputTokens =
              (stats.totalCacheCreationInputTokens ?? 0) + response.usage.cacheCreationInputTokens;
          }
          if (response.usage.cacheReadInputTokens !== undefined) {
            stats.totalCacheReadInputTokens =
              (stats.totalCacheReadInputTokens ?? 0) + response.usage.cacheReadInputTokens;
          }
          if (response.usage.costUsd !== undefined) {
            stats.totalCostUsd = (stats.totalCostUsd ?? 0) + response.usage.costUsd;
          }
        }
        validateDecisionForRequest(request, response.decision, aliveNow, forbiddenDoctorTarget);
        return response.decision;
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries) stats.retries += 1;
      }
    }
    throw lastError instanceof SimulationValidationError
      ? lastError
      : new SimulationValidationError(
          `agent decision failed validation after ${maxRetries + 1} attempt(s): ${String(lastError)}`
        );
  }

  async function runDay(round: number): Promise<void> {
    const phase: GamePhase = { phase: "day", round };
    const alive = livingPlayersAt(phase);

    const decisions: Record<PlayerId, DayActionDecision> = {};
    for (const player of alive) {
      const view = viewFor(player, phase, alive);
      const decision = (await ask({ kind: "dayAction", player, view }, alive, undefined)) as DayActionDecision;
      decisions[player] = decision;
    }

    const nominees: PlayerId[] = [];
    for (const player of alive) {
      const d = decisions[player];
      (d.suspect ?? []).forEach((target) => publicHistory.push({ type: "suspect", round, actor: player, target }));
      (d.defend ?? []).forEach((target) => publicHistory.push({ type: "defend", round, actor: player, target }));
      if (d.nominate !== undefined) {
        publicHistory.push({ type: "nominate", round, actor: player, target: d.nominate });
        if (!nominees.includes(d.nominate)) nominees.push(d.nominate);
      }
      if (d.roleClaim !== undefined) {
        publicHistory.push({ type: "selfRoleClaim", round, actor: player, claim: d.roleClaim });
      }
      if (d.investigationClaim !== undefined) {
        const { target, mechanic, result, night } = d.investigationClaim;
        publicHistory.push({
          type: "investigationReport",
          round,
          actor: player,
          target,
          mechanic,
          result,
          ...(night !== undefined ? { night } : {}),
        });
      }
    }

    if (nominees.length === 0) return; // e.g. an opening day with no nominations - matches both real recorded games

    await runVote(round, "initial", nominees);
  }

  async function runVote(round: number, stage: "initial" | "revote", candidates: PlayerId[]): Promise<void> {
    const phase: GamePhase = { phase: "day", round };
    const alive = livingPlayersAt(phase);

    const handsRaised: Partial<Record<PlayerId, PlayerId[]>> = {};
    for (const voter of alive) {
      const view = viewFor(voter, phase, alive);
      const decision = (await ask(
        { kind: "vote", player: voter, view, stage, candidates },
        alive,
        undefined
      )) as VoteDecision;
      if (decision.candidate !== null) {
        handsRaised[decision.candidate] = [...(handsRaised[decision.candidate] ?? []), voter];
      }
    }

    const vote: CandidateVote = { type: "candidateVote", round, stage, candidates: [...candidates], handsRaised };
    publicHistory.push(vote);

    const outcome = resolveCandidateVote(vote, aliveStateAt(phase));
    if (outcome.kind === "winner") {
      publicHistory.push({ type: "dayElimination", round, eliminated: [outcome.candidate] });
      return;
    }

    if (stage === "initial") {
      await runVote(round, "revote", outcome.candidates);
      return;
    }

    await runKeepOrEliminate(round, outcome.candidates);
  }

  async function runKeepOrEliminate(round: number, candidates: PlayerId[]): Promise<void> {
    const phase: GamePhase = { phase: "day", round };
    const alive = livingPlayersAt(phase);

    const eliminateHands: PlayerId[] = [];
    for (const voter of alive) {
      const view = viewFor(voter, phase, alive);
      const decision = (await ask(
        { kind: "keepOrEliminateVote", player: voter, view, candidates },
        alive,
        undefined
      )) as KeepOrEliminateDecision;
      if (decision.eliminate) eliminateHands.push(voter);
    }

    const vote: KeepOrEliminateVote = { type: "keepOrEliminateVote", round, candidates: [...candidates], eliminateHands };
    publicHistory.push(vote);

    const outcome = resolveKeepOrEliminateVote(vote, aliveStateAt(phase));
    publicHistory.push({
      type: "dayElimination",
      round,
      eliminated: outcome.kind === "eliminateAll" ? [...candidates] : [],
    });
  }

  async function runNight(round: number): Promise<void> {
    const phase: GamePhase = { phase: "night", round };
    const alive = livingPlayersAt(phase);

    const killers = alive.filter((p) => hasMechanic(registry, groundTruthRoles[p], "unanimousNightKill"));
    const donAlive = alive.some((p) => hasMechanic(registry, groundTruthRoles[p], "checkIsCommissioner"));
    const commissionerAlive = alive.some((p) => hasMechanic(registry, groundTruthRoles[p], "checkIsMafia"));
    const doctorAlive = alive.some((p) => hasMechanic(registry, groundTruthRoles[p], "protect"));

    const mafiaTargetChoices: Record<PlayerId, PlayerId> = {};
    for (const killer of killers) {
      const view = viewFor(killer, phase, alive);
      const decision = (await ask({ kind: "mafiaKill", player: killer, view }, alive, undefined)) as TargetChoiceDecision;
      mafiaTargetChoices[killer] = decision.target;
    }

    let donCheckTarget: PlayerId | undefined;
    const don = donAlive ? alive.find((p) => hasMechanic(registry, groundTruthRoles[p], "checkIsCommissioner")) : undefined;
    if (don !== undefined) {
      const view = viewFor(don, phase, alive);
      const decision = (await ask({ kind: "donCheck", player: don, view }, alive, undefined)) as TargetChoiceDecision;
      donCheckTarget = decision.target;
    }

    let commissionerCheckTarget: PlayerId | undefined;
    const commissioner = commissionerAlive
      ? alive.find((p) => hasMechanic(registry, groundTruthRoles[p], "checkIsMafia"))
      : undefined;
    if (commissioner !== undefined) {
      const view = viewFor(commissioner, phase, alive);
      const decision = (await ask(
        { kind: "commissionerCheck", player: commissioner, view },
        alive,
        undefined
      )) as TargetChoiceDecision;
      commissionerCheckTarget = decision.target;
    }

    let doctorSaveTarget: PlayerId | undefined;
    const doctor = doctorAlive ? alive.find((p) => hasMechanic(registry, groundTruthRoles[p], "protect")) : undefined;
    if (doctor !== undefined) {
      const view = viewFor(doctor, phase, alive);
      const decision = (await ask(
        { kind: "doctorSave", player: doctor, view },
        alive,
        previousDoctorSaveTarget
      )) as TargetChoiceDecision;
      doctorSaveTarget = decision.target;
    }

    const actions: HiddenNightActions = { mafiaTargetChoices, donCheckTarget, commissionerCheckTarget, doctorSaveTarget };
    const historyCtx: NightHistoryContext = { previousDoctorSaveTarget };
    const resolution = resolveNight(groundTruthWorld, actions, aliveStateAt(phase), historyCtx, registry);

    publicHistory.push({ type: "nightResult", round, died: resolution.died });
    nightsGroundTruth.push({ round, actions, resolution });

    if (don !== undefined && donCheckTarget !== undefined && resolution.donCheckResult !== undefined) {
      investigationsByPlayer[don].push({
        night: round,
        target: donCheckTarget,
        mechanic: "checkIsCommissioner",
        result: resolution.donCheckResult,
      });
    }
    if (
      commissioner !== undefined &&
      commissionerCheckTarget !== undefined &&
      resolution.commissionerCheckResult !== undefined
    ) {
      investigationsByPlayer[commissioner].push({
        night: round,
        target: commissionerCheckTarget,
        mechanic: "checkIsMafia",
        result: resolution.commissionerCheckResult,
      });
    }
    if (doctor !== undefined && doctorSaveTarget !== undefined) {
      savesByPlayer[doctor].push({ night: round, target: doctorSaveTarget });
    }

    previousDoctorSaveTarget = doctorSaveTarget;
  }

  let round = 0;
  await runDay(round);
  let outcome = outcomeAt({ phase: "night", round: round + 1 });
  let terminatedByRoundCap = false;

  while (outcome === "ongoing") {
    if (round >= maxRounds) {
      terminatedByRoundCap = true;
      break;
    }
    round += 1;
    await runNight(round);
    outcome = outcomeAt({ phase: "day", round });
    if (outcome !== "ongoing") break;
    await runDay(round);
    outcome = outcomeAt({ phase: "night", round: round + 1 });
  }

  return {
    config,
    seed: options.seed,
    publicEvidence: publicHistory,
    groundTruth: { roles: groundTruthRoles, nights: nightsGroundTruth },
    outcome,
    stats,
    roundsPlayed: round,
    terminatedByRoundCap,
  };
}
