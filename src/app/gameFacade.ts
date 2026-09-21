import { ActionIntensity, AliveState, GameConfig, GameEvent, PlayerId, RoleExpression, RoleId } from "../types";
import { InvestigationMechanic } from "../investigation";
import { defaultRoleRegistry, validateGameConfig } from "../roles";
import { initAliveState, markDead } from "../facts";
import {
  CandidateTally,
  CandidateVoteOutcome,
  KeepOrEliminateOutcome,
  resolveCandidateVote,
  resolveKeepOrEliminateVote,
  tallyCandidateVote,
} from "../voting";
import { validateDayElimination } from "../dayEliminationValidation";
import { describeGameEvent } from "../describeGameEvent";
import { AffinityMatrix, affinityBetween, computeAffinityMatrix } from "../relations/affinity";
import { detectTeams } from "../relations/clustering";
import { ConfirmedTeam, deriveConfirmedTeams } from "../relations/confirmedFacts";
import {
  APP_SCHEMA_VERSION,
  AppState,
  CandidateVoteDraft,
  CURRENT_ENGINE_VERSION,
  EventLogEntry,
  GameSession,
  GameSetupInput,
  HistoryGameEntry,
  KeepOrEliminateDraft,
  UiPhase,
  buildGameConfig,
  getAppScreen,
} from "./types";
import { StorageAdapter, loadAppState, saveAppState } from "./storage";

/**
 * The facade/application-state layer between the UI and the relationship
 * engine (see src/relations/ and this redesign's own notes). A UI built on
 * top of this file never imports relations/affinity.ts, relations/
 * clustering.ts, or relations/confirmedFacts.ts directly - every
 * relationship-facing question goes through a method here.
 *
 * `session.eventLog` (an ordered GameEvent[] plus, per entry, the UiPhase
 * active immediately before it) is the ONE authoritative source of truth.
 * The relationship graph is NEVER persisted - it is always recomputed from
 * `eventLog`, cheaply (see relations/affinity.ts's own complexity note),
 * every time it's asked for. This is what makes an engine upgrade
 * automatically apply to old saved games on next load, and what makes undo
 * exactly "drop the last event, recompute" (see undoLastEvent()).
 */

export class GameFacadeError extends Error {}

export interface PublicSessionView {
  config: GameConfig;
  myPlayerNumber: PlayerId;
  hasMyRole: boolean;
  uiPhase: UiPhase;
  votingDraft: GameSession["votingDraft"];
  finalRoles: GameSession["finalRoles"];
  confirmedOutcome: GameSession["confirmedOutcome"];
  eventCount: number;
  createdAt: string;
  updatedAt: string;
  engineVersion: string;
}

/** One suspect/nominate ("attack") or defend ("support") action, for the UI to draw as an arrow. Every individual action gets its own arrow - never aggregated (see this redesign's own notes on why). */
export interface RelationshipArrow {
  id: string;
  type: "attack" | "support";
  eventType: "suspect" | "nominate" | "defend";
  actor: PlayerId;
  target: PlayerId;
  round: number;
}

export interface DetectedTeam {
  members: PlayerId[];
}

export interface RelationshipView {
  arrows: RelationshipArrow[];
  teams: DetectedTeam[];
  confirmedTeams: Partial<Record<PlayerId, ConfirmedTeam>>;
}

export interface PlayerRelationshipScore {
  other: PlayerId;
  /** Positive = net cooperation signal, negative = net opposition, 0 = no signal yet. */
  score: number;
}

export interface PlayerInfo {
  player: PlayerId;
  alive: boolean;
  confirmedTeam?: ConfirmedTeam;
  /** Every other player with a nonzero score, strongest relationship (either direction) first. */
  relationships: PlayerRelationshipScore[];
  events: { event: GameEvent; description: string }[];
}

function eventInvolvesPlayer(event: GameEvent, player: PlayerId): boolean {
  switch (event.type) {
    case "selfRoleClaim":
      return event.actor === player;
    case "roleAssertion":
    case "investigationReport":
    case "suspect":
    case "defend":
    case "nominate":
      return event.actor === player || event.target === player;
    case "candidateVote":
      return event.candidates.includes(player) || Object.values(event.handsRaised).some((voters) => (voters ?? []).includes(player));
    case "keepOrEliminateVote":
      return event.candidates.includes(player) || event.eliminateHands.includes(player);
    case "nightResult":
      return event.died.includes(player);
    case "dayElimination":
      return event.eliminated.includes(player);
  }
}

export class MafiaPredictorFacade {
  private storage: StorageAdapter;
  private state: AppState;

  constructor(storage: StorageAdapter) {
    this.storage = storage;
    this.state = loadAppState(storage);
  }

  // ============================================================
  // Internal helpers
  // ============================================================

  private persist(): void {
    saveAppState(this.storage, this.state);
  }

  private requireGame(): GameSession {
    if (!this.state.currentGame) throw new GameFacadeError("no game in progress");
    return this.state.currentGame;
  }

  private updateSession(session: GameSession): void {
    this.state = { ...this.state, currentGame: { ...session, updatedAt: new Date().toISOString() } };
    this.persist();
  }

  private requireDayRound(session: GameSession): number {
    if (session.uiPhase.kind !== "day") {
      throw new GameFacadeError(`this action requires the "day" phase, current phase is "${session.uiPhase.kind}"`);
    }
    return session.uiPhase.round;
  }

  /** The current day's round number, valid from any of this day's decision-making sub-phases ("day" itself, an in-progress candidateVote, or an in-progress keepOrEliminateVote). */
  private requireDayRound2(session: GameSession): number {
    if (session.uiPhase.kind === "day" || session.uiPhase.kind === "voting" || session.uiPhase.kind === "keepOrEliminateVoting") {
      return session.uiPhase.round;
    }
    throw new GameFacadeError(`this action requires the "day", "voting", or "keepOrEliminateVoting" phase, current phase is "${session.uiPhase.kind}"`);
  }

  /** Alive state after EVERY recorded event so far. Throws if the log is somehow inconsistent (a player dying twice) - defensive; appendEvent already validates before anything is committed. */
  private currentAliveState(session: GameSession): AliveState {
    let alive = initAliveState(session.config);
    session.eventLog.forEach(({ event }) => {
      if (event.type === "nightResult") {
        event.died.forEach((p) => {
          if (alive[p] === false) throw new GameFacadeError(`player "${p}" died but was already dead`);
          alive = markDead(alive, p);
        });
      }
      if (event.type === "dayElimination") {
        event.eliminated.forEach((p) => {
          if (alive[p] === false) throw new GameFacadeError(`player "${p}" was eliminated but was already dead`);
          alive = markDead(alive, p);
        });
      }
    });
    return alive;
  }

  /**
   * Appends `event`, validating it BEFORE committing - throws (and leaves
   * `session` untouched) on an invalid event. Replaces the old Bayesian
   * facade's "dry-run computeSteps()" validation with direct, deterministic
   * checks: the actor (for a single-actor Observation) must be alive right
   * now, a dayElimination must match its round's actual vote chain
   * (validateDayElimination), and any death must not double-kill someone
   * (currentAliveState's own guard).
   */
  private appendEvent(session: GameSession, event: GameEvent): GameSession {
    if (event.type !== "candidateVote" && event.type !== "keepOrEliminateVote" && event.type !== "nightResult" && event.type !== "dayElimination") {
      const alive = this.currentAliveState(session);
      if (alive[event.actor] !== true) {
        throw new GameFacadeError(`"${event.actor}" is dead and cannot produce a new action`);
      }
    }

    const entry: EventLogEntry = { event, uiPhaseBefore: session.uiPhase };
    const candidate: GameSession = { ...session, eventLog: [...session.eventLog, entry] };

    if (event.type === "dayElimination") {
      const votesThisRound = candidate.eventLog
        .map((e) => e.event)
        .filter((e): e is Extract<GameEvent, { type: "candidateVote" | "keepOrEliminateVote" }> => e.type === "candidateVote" || e.type === "keepOrEliminateVote");
      validateDayElimination(event, votesThisRound, this.currentAliveState(session));
    }

    this.currentAliveState(candidate); // throws on an inconsistent result (defensive re-check)
    return candidate;
  }

  private requireVotingDraft<K extends "candidateVote" | "keepOrEliminateVote">(
    session: GameSession,
    kind: K
  ): K extends "candidateVote" ? CandidateVoteDraft : KeepOrEliminateDraft {
    if (!session.votingDraft || session.votingDraft.kind !== kind) {
      throw new GameFacadeError(`no in-progress ${kind} draft`);
    }
    return session.votingDraft as any;
  }

  // ============================================================
  // Menu / lifecycle
  // ============================================================

  getAppScreen(): "MENU" | "GAME" {
    return getAppScreen(this.state);
  }

  /** Everything about the current session a UI needs to render config/phase/history summaries, EXCLUDING `myRole`'s actual value (only whether it's been set). */
  getPublicSessionView(): PublicSessionView {
    const s = this.requireGame();
    return {
      config: s.config,
      myPlayerNumber: s.myPlayerNumber,
      hasMyRole: s.myRole !== null,
      uiPhase: s.uiPhase,
      votingDraft: s.votingDraft,
      finalRoles: s.finalRoles,
      confirmedOutcome: s.confirmedOutcome,
      eventCount: s.eventLog.length,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      engineVersion: s.engineVersion,
    };
  }

  /** Every distinct role in this game's configuration - for a role picker. */
  getRoleOptions(): RoleId[] {
    const s = this.requireGame();
    return Array.from(new Set(s.config.roles));
  }

  createGame(setup: GameSetupInput): void {
    const config = buildGameConfig(setup.playerCount, setup.roleCounts);
    validateGameConfig(config, defaultRoleRegistry);
    if (config.players.length !== config.roles.length) {
      throw new GameFacadeError(
        `role counts must add up to exactly the player count (got ${config.roles.length} roles for ${config.players.length} players)`
      );
    }
    if (!config.players.includes(setup.myPlayerNumber)) {
      throw new GameFacadeError(`myPlayerNumber "${setup.myPlayerNumber}" is not one of this game's players`);
    }
    const now = new Date().toISOString();
    const session: GameSession = {
      schemaVersion: APP_SCHEMA_VERSION,
      engineVersion: CURRENT_ENGINE_VERSION,
      createdAt: now,
      updatedAt: now,
      config,
      myPlayerNumber: setup.myPlayerNumber,
      myRole: null,
      eventLog: [],
      uiPhase: { kind: "day", round: 0 },
      votingDraft: null,
      phaseBeforeFinish: null,
      finalRoles: null,
      confirmedOutcome: null,
    };
    this.state = { ...this.state, currentGame: session };
    this.persist();
  }

  setPlayerRole(role: RoleId): void {
    const session = this.requireGame();
    if (!session.config.roles.includes(role)) throw new GameFacadeError(`role "${role}" is not part of this game's configuration`);
    this.updateSession({ ...session, myRole: role });
  }

  discardGame(): void {
    this.state = { ...this.state, currentGame: null };
    this.persist();
  }

  saveGameToHistory(): void {
    const session = this.requireGame();
    const entry: HistoryGameEntry = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, savedAt: new Date().toISOString(), session };
    this.state = { ...this.state, currentGame: null, history: [...this.state.history, entry] };
    this.persist();
  }

  // ============================================================
  // Day / night
  // ============================================================

  getCurrentPhase(): UiPhase {
    return this.requireGame().uiPhase;
  }

  /**
   * True while the current phase was entered by a pure phase transition
   * (startNight/startVoting/startKeepOrEliminateVote) that never appended
   * an event - i.e. there is nothing for undoLastEvent() to undo, but the
   * phase itself can still be backed out of accident-free via
   * cancelCurrentSubPhase(). False for "day" (there is nothing to cancel
   * back to) and "finished" (use resumeGame() instead).
   */
  canCancelCurrentPhase(): boolean {
    return this.requireGame().uiPhase.kind !== "day" && this.requireGame().uiPhase.kind !== "finished";
  }

  /**
   * Backs out of an accidentally-started night/vote/keep-or-eliminate vote,
   * discarding any in-progress draft, WITHOUT recording anything - safe
   * specifically because startNight()/startVoting()/startKeepOrEliminateVote()
   * only ever change `uiPhase`, they never append an event (see each of
   * their own docs), so there is nothing in the event log to undo. Reverts
   * to exactly the phase that started this one:
   *  - "night" -> the day it was started from
   *  - "voting" (initial) -> that same day
   *  - "voting" (revote) -> the tied initial vote (its event is still in
   *    the log, so the UI's existing "noDraft"/getVoteRecoveryState()
   *    handling picks it back up as "tied", offering the same next steps)
   *  - "keepOrEliminateVoting" -> the tied revote, the same way
   */
  cancelCurrentSubPhase(): void {
    const session = this.requireGame();
    const phase = session.uiPhase;
    let target: UiPhase;
    if (phase.kind === "night") {
      target = { kind: "day", round: phase.round - 1 };
    } else if (phase.kind === "voting" && phase.stage === "initial") {
      target = { kind: "day", round: phase.round };
    } else if (phase.kind === "voting" && phase.stage === "revote") {
      target = { kind: "voting", round: phase.round, stage: "initial", candidates: phase.candidates };
    } else if (phase.kind === "keepOrEliminateVoting") {
      target = { kind: "voting", round: phase.round, stage: "revote", candidates: phase.candidates };
    } else {
      throw new GameFacadeError(`cancelCurrentSubPhase() has nothing to cancel from the "${phase.kind}" phase`);
    }
    this.updateSession({ ...session, uiPhase: target, votingDraft: null });
  }

  startNight(): void {
    const session = this.requireGame();
    const round = this.requireDayRound(session);
    this.updateSession({ ...session, uiPhase: { kind: "night", round: round + 1 } });
  }

  /** Records this night's deaths (may be empty) and advances to the following day. */
  confirmNightDeaths(deadPlayers: PlayerId[]): void {
    const session = this.requireGame();
    if (session.uiPhase.kind !== "night") throw new GameFacadeError(`confirmNightDeaths() requires the "night" phase, current phase is "${session.uiPhase.kind}"`);
    const round = session.uiPhase.round;
    const withEvent = this.appendEvent(session, { type: "nightResult", round, died: [...deadPlayers] });
    this.updateSession({ ...withEvent, uiPhase: { kind: "day", round } });
  }

  // ============================================================
  // Day actions (suspect/defend/nominate) and claims
  // ============================================================

  /** `intensity` (1-5 stars, defaults to 3) is how confidently the actor means this - see ActionIntensity's own doc and relations/affinity.ts's use of it. */
  recordAction(actor: PlayerId, type: "suspect" | "defend" | "nominate", target: PlayerId, intensity?: ActionIntensity): void {
    const session = this.requireGame();
    const round = this.requireDayRound(session);
    this.updateSession(this.appendEvent(session, { type, round, actor, target, intensity } as GameEvent));
  }

  recordSelfRoleClaim(actor: PlayerId, claim: RoleExpression): void {
    const session = this.requireGame();
    const round = this.requireDayRound(session);
    this.updateSession(this.appendEvent(session, { type: "selfRoleClaim", round, actor, claim }));
  }

  recordRoleAssertion(actor: PlayerId, target: PlayerId, claim: RoleExpression): void {
    const session = this.requireGame();
    const round = this.requireDayRound(session);
    this.updateSession(this.appendEvent(session, { type: "roleAssertion", round, actor, target, claim }));
  }

  recordInvestigationReport(actor: PlayerId, target: PlayerId, mechanic: InvestigationMechanic, result: boolean, night?: number): void {
    const session = this.requireGame();
    const round = this.requireDayRound(session);
    this.updateSession(this.appendEvent(session, { type: "investigationReport", round, actor, target, mechanic, result, night }));
  }

  // ============================================================
  // Voting
  // ============================================================

  startVoting(stage: "initial" | "revote", candidates: PlayerId[]): void {
    const session = this.requireGame();
    const round = this.requireDayRound2(session);
    this.updateSession({
      ...session,
      uiPhase: { kind: "voting", round, stage, candidates: [...candidates] },
      votingDraft: { kind: "candidateVote", candidates: [...candidates], handsRaised: {} },
    });
  }

  recordHandsForCandidate(candidate: PlayerId, voters: PlayerId[]): void {
    const session = this.requireGame();
    const draft = this.requireVotingDraft(session, "candidateVote");
    this.updateSession({ ...session, votingDraft: { ...draft, handsRaised: { ...draft.handsRaised, [candidate]: [...voters] } } });
  }

  confirmVote(): CandidateVoteOutcome {
    const session = this.requireGame();
    if (session.uiPhase.kind !== "voting") throw new GameFacadeError('confirmVote() requires the "voting" phase');
    const draft = this.requireVotingDraft(session, "candidateVote");
    const event: GameEvent = { type: "candidateVote", round: session.uiPhase.round, stage: session.uiPhase.stage, candidates: draft.candidates, handsRaised: draft.handsRaised };
    const withEvent = this.appendEvent(session, event);
    this.updateSession({ ...withEvent, votingDraft: null });
    const alive = this.currentAliveState(withEvent);
    return resolveCandidateVote(event as any, alive);
  }

  /** Vote tally so far (including inferred abstention-to-last-candidate) for the in-progress draft. */
  getVoteTallySoFar(): CandidateTally[] {
    const session = this.requireGame();
    if (session.uiPhase.kind !== "voting") throw new GameFacadeError('getVoteTallySoFar() requires the "voting" phase');
    const draft = this.requireVotingDraft(session, "candidateVote");
    const alive = this.currentAliveState(session);
    const provisional: GameEvent = { type: "candidateVote", round: session.uiPhase.round, stage: session.uiPhase.stage, candidates: draft.candidates, handsRaised: draft.handsRaised };
    return tallyCandidateVote(provisional as any, alive).candidates;
  }

  startKeepOrEliminateVote(candidates: PlayerId[]): void {
    const session = this.requireGame();
    const round = this.requireDayRound2(session);
    this.updateSession({
      ...session,
      uiPhase: { kind: "keepOrEliminateVoting", round, candidates: [...candidates] },
      votingDraft: { kind: "keepOrEliminateVote", candidates: [...candidates], eliminateHands: [] },
    });
  }

  recordEliminateHands(voters: PlayerId[]): void {
    const session = this.requireGame();
    const draft = this.requireVotingDraft(session, "keepOrEliminateVote");
    this.updateSession({ ...session, votingDraft: { ...draft, eliminateHands: [...voters] } });
  }

  confirmKeepOrEliminateVote(): KeepOrEliminateOutcome {
    const session = this.requireGame();
    if (session.uiPhase.kind !== "keepOrEliminateVoting") throw new GameFacadeError('confirmKeepOrEliminateVote() requires the "keepOrEliminateVoting" phase');
    const draft = this.requireVotingDraft(session, "keepOrEliminateVote");
    const event: GameEvent = { type: "keepOrEliminateVote", round: session.uiPhase.round, candidates: draft.candidates, eliminateHands: draft.eliminateHands };
    const withEvent = this.appendEvent(session, event);
    this.updateSession({ ...withEvent, votingDraft: null });
    const alive = this.currentAliveState(withEvent);
    return resolveKeepOrEliminateVote(event as any, alive);
  }

  /**
   * When the "voting"/"keepOrEliminateVoting" phase has no in-progress
   * draft (votingDraft === null) - either because the vote was just
   * confirmed, or because Undo removed some later event - tells the UI
   * what's safe to do next:
   *  - "noRecordedVote": no vote event for this exact round+stage/kind
   *    exists yet (a fresh phase, or Undo removed the vote event itself) -
   *    starting a brand new vote here is safe.
   *  - "tied": the last recorded vote for this round+stage already exists
   *    and tied - the existing "move to revote/keep-or-eliminate" UI
   *    applies, nothing to record yet.
   *  - "decisive": the last recorded vote for this round already exists
   *    and resolved decisively (a winner, or eliminateAll/keepAll) -
   *    `eliminated` is what recordDayElimination() should be called with.
   *    Starting a NEW vote here instead would append a second vote event
   *    for the same round+stage, which dayEliminationValidation.ts then
   *    correctly rejects as an illegal chain - this is how the UI avoids
   *    ever offering that trap.
   */
  getVoteRecoveryState(): { kind: "noRecordedVote" } | { kind: "tied" } | { kind: "decisive"; eliminated: PlayerId[] } {
    const session = this.requireGame();
    const last = session.eventLog[session.eventLog.length - 1]?.event;
    const alive = this.currentAliveState(session);

    if (session.uiPhase.kind === "voting" && last?.type === "candidateVote" && last.round === session.uiPhase.round && last.stage === session.uiPhase.stage) {
      const outcome = resolveCandidateVote(last, alive);
      return outcome.kind === "tie" ? { kind: "tied" } : { kind: "decisive", eliminated: [outcome.candidate] };
    }
    if (session.uiPhase.kind === "keepOrEliminateVoting" && last?.type === "keepOrEliminateVote" && last.round === session.uiPhase.round) {
      const outcome = resolveKeepOrEliminateVote(last, alive);
      return { kind: "decisive", eliminated: outcome.kind === "eliminateAll" ? [...outcome.candidates] : [] };
    }
    return { kind: "noRecordedVote" };
  }

  /** Finalizes the day's elimination (possibly empty) and returns to the "day" phase for the SAME round. */
  recordDayElimination(eliminated: PlayerId[]): void {
    const session = this.requireGame();
    const round = this.requireDayRound2(session);
    const withEvent = this.appendEvent(session, { type: "dayElimination", round, eliminated: [...eliminated] });
    this.updateSession({ ...withEvent, uiPhase: { kind: "day", round } });
  }

  // ============================================================
  // Finish game - fully manual, always resumable (see this redesign's own
  // notes: there is no more world-tracking to auto-suggest a winner from,
  // and the old auto-suggestion was itself a source of real bugs).
  // ============================================================

  finishGame(confirmedOutcome: "townWon" | "mafiaWon" | "unknown"): void {
    const session = this.requireGame();
    const phaseBeforeFinish = session.uiPhase.kind === "finished" ? session.phaseBeforeFinish : session.uiPhase;
    // Default every player's final role to "citizen" (the most common role,
    // and a far less misleading blank-state than an arbitrary role) the
    // FIRST time the game finishes - never overwrites roles already entered
    // on an earlier finish. The viewer's own seat defaults to their actual
    // known role instead, since that one is never actually in doubt.
    const finalRoles =
      session.finalRoles ??
      Object.fromEntries(session.config.players.map((p) => [p, p === session.myPlayerNumber && session.myRole ? session.myRole : "citizen"]));
    this.updateSession({ ...session, uiPhase: { kind: "finished" }, phaseBeforeFinish, confirmedOutcome, finalRoles });
  }

  /** Returns to the live game exactly where Finish Game was called from - Finish Game must never be a dead end. */
  resumeGame(): void {
    const session = this.requireGame();
    if (session.uiPhase.kind !== "finished") throw new GameFacadeError("resumeGame() requires the \"finished\" phase");
    if (!session.phaseBeforeFinish) throw new GameFacadeError("no phase to resume to");
    this.updateSession({ ...session, uiPhase: session.phaseBeforeFinish, phaseBeforeFinish: null });
  }

  setFinalRole(player: PlayerId, role: RoleId): void {
    const session = this.requireGame();
    if (!session.config.players.includes(player)) throw new GameFacadeError(`"${player}" is not one of this game's players`);
    this.updateSession({ ...session, finalRoles: { ...(session.finalRoles ?? {}), [player]: role } });
  }

  // ============================================================
  // Undo
  // ============================================================

  /**
   * Undoes the most recently CONFIRMED event: drops it from eventLog and
   * restores uiPhase to exactly what it was immediately before that event.
   * Safe by construction: undo only ever removes the LAST event, and
   * nothing later in the log can depend on it. Does NOT touch myRole/
   * finalRoles/confirmedOutcome/votingDraft - those are simple idempotent
   * setters a caller corrects by calling them again.
   */
  undoLastEvent(): void {
    const session = this.requireGame();
    if (session.eventLog.length === 0) throw new GameFacadeError("no events to undo");
    const last = session.eventLog[session.eventLog.length - 1];
    const candidate: GameSession = { ...session, eventLog: session.eventLog.slice(0, -1), uiPhase: last.uiPhaseBefore, votingDraft: null };
    this.currentAliveState(candidate); // defensive re-validation - should never throw for a removed tail event
    this.updateSession(candidate);
  }

  canUndo(): boolean {
    const session = this.requireGame();
    return session.eventLog.length > 0;
  }

  // ============================================================
  // Read-only relationship views
  // ============================================================

  getEventLog(): { event: GameEvent; description: string }[] {
    return this.requireGame().eventLog.map(({ event }) => ({ event, description: describeGameEvent(event) }));
  }

  private affinityMatrix(session: GameSession): AffinityMatrix {
    return computeAffinityMatrix(session.config.players, session.eventLog.map((e) => e.event));
  }

  /**
   * Arrows (one per individual suspect/nominate/defend action - see
   * RelationshipArrow's own doc), detected teams (dynamic clustering, see
   * relations/clustering.ts), and confirmed team facts (see relations/
   * confirmedFacts.ts) - the UI's single entry point for everything the
   * player circle and team panel need. EXCLUDES the viewer's own player
   * from `confirmedTeams`/team membership is not filtered here (the UI
   * decides how to render its own seat), but confirmedTeams never includes
   * information the viewer doesn't already know some other way (it is
   * derived only from the viewer's OWN recorded investigation reports).
   */
  getRelationshipView(): RelationshipView {
    const session = this.requireGame();
    const events = session.eventLog.map((e) => e.event);

    const arrows: RelationshipArrow[] = [];
    events.forEach((event, i) => {
      if (event.type === "suspect" || event.type === "nominate") {
        arrows.push({ id: `${i}`, type: "attack", eventType: event.type, actor: event.actor, target: event.target, round: event.round });
      } else if (event.type === "defend") {
        arrows.push({ id: `${i}`, type: "support", eventType: "defend", actor: event.actor, target: event.target, round: event.round });
      }
    });

    const matrix = this.affinityMatrix(session);
    const teams = detectTeams(session.config.players, matrix).map((members) => ({ members }));
    const confirmedTeams = deriveConfirmedTeams(events, session.myPlayerNumber, session.myRole, defaultRoleRegistry);

    return { arrows, teams, confirmedTeams };
  }

  /** Throws for myPlayerNumber - the caller must never route its own player through the shared "player info" screen. */
  getPlayerInfo(player: PlayerId): PlayerInfo {
    const session = this.requireGame();
    if (player === session.myPlayerNumber) throw new GameFacadeError("cannot expose your own player info");
    const alive = this.currentAliveState(session);
    const events = session.eventLog.map((e) => e.event).filter((e) => eventInvolvesPlayer(e, player));
    const matrix = this.affinityMatrix(session);
    const confirmedTeams = deriveConfirmedTeams(session.eventLog.map((e) => e.event), session.myPlayerNumber, session.myRole, defaultRoleRegistry);

    const relationships: PlayerRelationshipScore[] = session.config.players
      .filter((p) => p !== player && p !== session.myPlayerNumber)
      .map((other) => ({ other, score: affinityBetween(matrix, player, other) }))
      .filter((r) => r.score !== 0)
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score));

    return {
      player,
      alive: alive[player] === true,
      confirmedTeam: confirmedTeams[player],
      relationships,
      events: events.map((event) => ({ event, description: describeGameEvent(event) })),
    };
  }

  // ============================================================
  // History
  // ============================================================

  listHistory(): HistoryGameEntry[] {
    return this.state.history;
  }

  deleteHistoryEntry(id: string): void {
    this.state = { ...this.state, history: this.state.history.filter((h) => h.id !== id) };
    this.persist();
  }

  clearHistory(): void {
    this.state = { ...this.state, history: [] };
    this.persist();
  }

  exportHistoryJson(): string {
    return JSON.stringify(this.state.history, null, 2);
  }

  /** Wipes ALL persisted application state (menu + any in-progress game + history). Reloading the page after this is the caller's (UI's) responsibility. */
  clearAllData(): void {
    this.state = { schemaVersion: APP_SCHEMA_VERSION, appVersion: this.state.appVersion, currentGame: null, history: [] };
    this.persist();
  }
}
