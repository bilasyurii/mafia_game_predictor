import { AliveState, GameConfig, PlayerId, RoleExpression, RoleId, World } from "../types";
import { Evidence } from "../evidence";
import { InvestigationMechanic } from "../investigation";
import { defaultRoleRegistry, validateGameConfig } from "../roles";
import { defaultGroupRegistry } from "../roleGroups";
import { generateWorlds } from "../generateWorlds";
import { GameSetting, processEvidence } from "../processEvidence";
import { createBehavioralLikelihoodModel, defaultBehavioralModelParams } from "../behavioralModel";
import { describeEvidence } from "../gameEvaluation";
import { getPossibleWorlds } from "../gameOutcome";
import { initAliveState, markDead } from "../facts";
import { CandidateTally, CandidateVoteOutcome, KeepOrEliminateOutcome, resolveCandidateVote, resolveKeepOrEliminateVote, tallyCandidateVote } from "../voting";
import { getExpressionProbability, getProbability } from "../probability";
import { getTeammateProbabilities } from "./teamAlignment";
import {
  APP_SCHEMA_VERSION,
  AppState,
  CandidateVoteDraft,
  CURRENT_ENGINE_VERSION,
  CURRENT_PREDICTOR_VERSION,
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
 * The facade/application-state layer between a future UI and the existing
 * Bayesian engine (see this milestone's own architecture report for the
 * full rationale). A UI built on top of this file never imports
 * evidence.ts/behavioralModel.ts/generateWorlds.ts/processEvidence.ts/
 * updateProbabilities.ts directly - every predictor-facing question goes
 * through a method here, which reuses those files completely unchanged.
 *
 * `session.eventLog` (an ordered Evidence[] plus, per entry, the UiPhase
 * active immediately before it) is the ONE authoritative source of truth.
 * The posterior (World[]) is NEVER persisted - it is always recomputed from
 * `eventLog` via computeSteps(), exactly the same processEvidence() call a
 * fresh replay of a finished game already uses elsewhere in this project.
 * This makes an engine/predictor upgrade automatically apply to old saved
 * games on next load (no silently-stale cached posterior), and makes undo
 * exactly "drop the last event, recompute" (see undoLastEvent()).
 */

export class GameFacadeError extends Error {}

export interface PublicPlayerProbability {
  player: PlayerId;
  alive: boolean;
  mafiaProbability: number;
  commissionerProbability: number;
  doctorProbability: number;
  donProbability?: number;
}

export interface PlayerInfo extends PublicPlayerProbability {
  teammateProbabilities: Record<PlayerId, number>;
  events: { event: Evidence; description: string }[];
}

function eventInvolvesPlayer(event: Evidence, player: PlayerId): boolean {
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
      return (
        event.candidates.includes(player) ||
        Object.values(event.handsRaised).some((voters) => (voters ?? []).includes(player))
      );
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

  private setting(config: GameConfig): GameSetting {
    return { config, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  }

  /** The ONE place a LikelihoodModel is constructed - swap the params object here to change the predictor's behavioral assumptions; never inline elsewhere. */
  private model() {
    return createBehavioralLikelihoodModel(defaultBehavioralModelParams);
  }

  /**
   * Recomputes the full posterior from `session.eventLog` - the single
   * "replay" operation everything else in this class is built on. Throws
   * exactly when processEvidence/updateProbabilities would (a malformed or
   * mechanically-impossible event) - callers that are VALIDATING a
   * not-yet-committed event call this on a candidate session BEFORE
   * assigning it to `this.state`, so an invalid manual entry is rejected
   * without corrupting the persisted log (see appendEvent).
   */
  private computeSteps(session: GameSession) {
    const worlds = generateWorlds(session.config);
    const events = session.eventLog.map((e) => e.event);
    return processEvidence(worlds, events, this.model(), this.setting(session.config));
  }

  private currentWorlds(session: GameSession): World[] {
    const steps = this.computeSteps(session);
    return steps.length > 0 ? steps[steps.length - 1].posterior : generateWorlds(session.config);
  }

  /** Alive state after EVERY recorded event so far - independent of uiPhase, always "as of right now". */
  private currentAliveState(session: GameSession): AliveState {
    let alive = initAliveState(session.config);
    session.eventLog.forEach(({ event }) => {
      if (event.type === "nightResult") event.died.forEach((p) => (alive = markDead(alive, p)));
      if (event.type === "dayElimination") event.eliminated.forEach((p) => (alive = markDead(alive, p)));
    });
    return alive;
  }

  /** Appends `event`, validating it via a dry-run computeSteps() BEFORE committing - throws (and leaves `session` untouched) on an invalid event. */
  private appendEvent(session: GameSession, event: Evidence): GameSession {
    const entry: EventLogEntry = { event, uiPhaseBefore: session.uiPhase };
    const candidate: GameSession = { ...session, eventLog: [...session.eventLog, entry] };
    this.computeSteps(candidate); // throws on an invalid/impossible event - candidate is discarded, nothing persisted
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

  createGame(setup: GameSetupInput): void {
    const config = buildGameConfig(setup.playerCount, setup.roleCounts);
    validateGameConfig(config, defaultRoleRegistry);
    if (!config.players.includes(setup.myPlayerNumber)) {
      throw new GameFacadeError(`myPlayerNumber "${setup.myPlayerNumber}" is not one of this game's players`);
    }
    const now = new Date().toISOString();
    const session: GameSession = {
      schemaVersion: APP_SCHEMA_VERSION,
      engineVersion: CURRENT_ENGINE_VERSION,
      predictorVersion: CURRENT_PREDICTOR_VERSION,
      createdAt: now,
      updatedAt: now,
      config,
      myPlayerNumber: setup.myPlayerNumber,
      myRole: null,
      eventLog: [],
      uiPhase: { kind: "day", round: 0 },
      votingDraft: null,
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

  startNight(): void {
    const session = this.requireGame();
    const round = this.requireDayRound(session);
    this.updateSession({ ...session, uiPhase: { kind: "night", round: round + 1 } });
  }

  /** Records this night's deaths (may be empty) and advances to the following day. Day 1 has no preceding night, so this is never called before it. */
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

  recordAction(actor: PlayerId, type: "suspect" | "defend" | "nominate", target: PlayerId): void {
    const session = this.requireGame();
    const round = this.requireDayRound(session);
    this.updateSession(this.appendEvent(session, { type, round, actor, target } as Evidence));
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

  /** `stage: "initial"` starts fresh from the "day" phase; `stage: "revote"` continues from the "voting" phase a just-confirmed tied vote left the session in. */
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

  /** Commits the in-progress candidateVote draft as a real event and returns the engine's own resolution (winner, or a tie needing a revote) - never invents a different voting model, reuses voting.ts's resolveCandidateVote unchanged. */
  confirmVote(): CandidateVoteOutcome {
    const session = this.requireGame();
    if (session.uiPhase.kind !== "voting") throw new GameFacadeError('confirmVote() requires the "voting" phase');
    const draft = this.requireVotingDraft(session, "candidateVote");
    const event: Evidence = { type: "candidateVote", round: session.uiPhase.round, stage: session.uiPhase.stage, candidates: draft.candidates, handsRaised: draft.handsRaised };
    const withEvent = this.appendEvent(session, event);
    this.updateSession({ ...withEvent, votingDraft: null });
    const alive = this.currentAliveState(withEvent);
    return resolveCandidateVote(event as any, alive);
  }

  /** Vote tally so far (including inferred abstention-to-last-candidate) for the in-progress draft - for a live "N votes" display before confirming. */
  getVoteTallySoFar(): CandidateTally[] {
    const session = this.requireGame();
    if (session.uiPhase.kind !== "voting") throw new GameFacadeError('getVoteTallySoFar() requires the "voting" phase');
    const draft = this.requireVotingDraft(session, "candidateVote");
    const alive = this.currentAliveState(session);
    const provisional: Evidence = { type: "candidateVote", round: session.uiPhase.round, stage: session.uiPhase.stage, candidates: draft.candidates, handsRaised: draft.handsRaised };
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

  /** The current day's round number, valid from any of this day's decision-making sub-phases ("day" itself, an in-progress candidateVote, or an in-progress keepOrEliminateVote) - never from "night" or "finished". */
  private requireDayRound2(session: GameSession): number {
    if (session.uiPhase.kind === "day" || session.uiPhase.kind === "voting" || session.uiPhase.kind === "keepOrEliminateVoting") {
      return session.uiPhase.round;
    }
    throw new GameFacadeError(`this action requires the "day", "voting", or "keepOrEliminateVoting" phase, current phase is "${session.uiPhase.kind}"`);
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
    const event: Evidence = { type: "keepOrEliminateVote", round: session.uiPhase.round, candidates: draft.candidates, eliminateHands: draft.eliminateHands };
    const withEvent = this.appendEvent(session, event);
    this.updateSession({ ...withEvent, votingDraft: null });
    const alive = this.currentAliveState(withEvent);
    return resolveKeepOrEliminateVote(event as any, alive);
  }

  /** Finalizes the day's elimination (possibly empty - "leave everyone") and returns to the "day" phase for the SAME round. */
  recordDayElimination(eliminated: PlayerId[]): void {
    const session = this.requireGame();
    const round = this.requireDayRound2(session);
    const withEvent = this.appendEvent(session, { type: "dayElimination", round, eliminated: [...eliminated] });
    this.updateSession({ ...withEvent, uiPhase: { kind: "day", round } });
  }

  // ============================================================
  // Finish game
  // ============================================================

  /** "unknown" unless the CURRENT posterior's nonzero worlds are unanimous - see gameOutcome.ts's getPossibleWorlds (unchanged): a live, incomplete-information game can only be called with certainty when every remaining possible world agrees. */
  getSuggestedOutcome(): "townWon" | "mafiaWon" | "unknown" {
    const session = this.requireGame();
    const worlds = this.currentWorlds(session);
    const alive = this.currentAliveState(session);
    const possible = getPossibleWorlds(worlds, alive, defaultRoleRegistry);
    if (possible.ongoing.length > 0) return "unknown";
    if (possible.townWon.length > 0 && possible.mafiaWon.length === 0) return "townWon";
    if (possible.mafiaWon.length > 0 && possible.townWon.length === 0) return "mafiaWon";
    return "unknown";
  }

  finishGame(confirmedOutcome: "townWon" | "mafiaWon" | "unknown"): void {
    const session = this.requireGame();
    this.updateSession({ ...session, uiPhase: { kind: "finished" }, confirmedOutcome });
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
   * restores uiPhase to exactly what it was immediately before that event
   * (stored per-entry - see EventLogEntry). Safe by construction: undo only
   * ever removes the LAST event, and nothing later in the log can depend on
   * it (there is nothing later), so the remaining prefix is always a valid
   * history - re-validated via computeSteps() as a defensive check anyway.
   * Does NOT touch myRole/finalRoles/confirmedOutcome/votingDraft - those
   * are simple idempotent setters a caller corrects by calling them again,
   * not part of the sequential eventLog this method operates on.
   */
  undoLastEvent(): void {
    const session = this.requireGame();
    if (session.eventLog.length === 0) throw new GameFacadeError("no events to undo");
    const last = session.eventLog[session.eventLog.length - 1];
    const candidate: GameSession = { ...session, eventLog: session.eventLog.slice(0, -1), uiPhase: last.uiPhaseBefore, votingDraft: null };
    this.computeSteps(candidate); // defensive re-validation - should never throw for a removed tail event
    this.updateSession(candidate);
  }

  canUndo(): boolean {
    const session = this.requireGame();
    return session.eventLog.length > 0;
  }

  // ============================================================
  // Read-only predictor views
  // ============================================================

  getEventLog(): { event: Evidence; description: string }[] {
    return this.requireGame().eventLog.map(({ event }) => ({ event, description: describeEvidence(event) }));
  }

  /** Every living player's probabilities, EXCLUDING myPlayerNumber entirely - not merely "the UI shouldn't call this for self", but structurally omitted, per this milestone's "hard to accidentally expose" requirement. */
  getPublicPlayerProbabilities(): PublicPlayerProbability[] {
    const session = this.requireGame();
    const worlds = this.currentWorlds(session);
    const alive = this.currentAliveState(session);
    const hasDon = session.config.roles.includes("don");
    return session.config.players
      .filter((p) => p !== session.myPlayerNumber)
      .map((player) => ({
        player,
        alive: alive[player] === true,
        mafiaProbability: getExpressionProbability(worlds, player, { kind: "group", group: "mafia" }, defaultGroupRegistry),
        commissionerProbability: getProbability(worlds, player, "commissioner"),
        doctorProbability: getProbability(worlds, player, "doctor"),
        ...(hasDon ? { donProbability: getProbability(worlds, player, "don") } : {}),
      }));
  }

  /** Throws for myPlayerNumber - the caller must never route its own player through the shared "player info" screen (see this milestone's report). */
  getPlayerInfo(player: PlayerId): PlayerInfo {
    const session = this.requireGame();
    if (player === session.myPlayerNumber) throw new GameFacadeError("cannot expose your own player info");
    const worlds = this.currentWorlds(session);
    const alive = this.currentAliveState(session);
    const hasDon = session.config.roles.includes("don");
    const events = session.eventLog.map((e) => e.event).filter((e) => eventInvolvesPlayer(e, player));
    return {
      player,
      alive: alive[player] === true,
      mafiaProbability: getExpressionProbability(worlds, player, { kind: "group", group: "mafia" }, defaultGroupRegistry),
      commissionerProbability: getProbability(worlds, player, "commissioner"),
      doctorProbability: getProbability(worlds, player, "doctor"),
      ...(hasDon ? { donProbability: getProbability(worlds, player, "don") } : {}),
      teammateProbabilities: getTeammateProbabilities(worlds, player, session.config.players, defaultRoleRegistry),
      events: events.map((event) => ({ event, description: describeEvidence(event) })),
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

  /** Wipes ALL persisted application state (menu + any in-progress game + history) - the "Clear All Data" menu action. Reloading the page after this is the caller's (UI's) responsibility. */
  clearAllData(): void {
    this.state = { schemaVersion: APP_SCHEMA_VERSION, appVersion: this.state.appVersion, currentGame: null, history: [] };
    this.persist();
  }
}
