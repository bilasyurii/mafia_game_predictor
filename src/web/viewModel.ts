import { PlayerId, RoleId } from "../types";
import { MafiaPredictorFacade, PublicPlayerProbability } from "../app/gameFacade";
import { UiPhase } from "../app/types";

/**
 * Pure, DOM-free view-model builders for the browser UI (web/src/app.ts
 * renders these; this file never touches window/document). Kept in src/web/
 * (inside the existing src/ tree) rather than web/src/ specifically so it
 * is covered by the project's existing `npx tsc --noEmit`/`npm test`
 * without any new configuration - see this milestone's own report.
 *
 * The single safety-critical property every function here upholds: nothing
 * returned ever includes the viewer's own role or own Mafia-team
 * probability - see buildGameScreenViewModel's own doc.
 */

export interface PlayerCircleViewModel {
  player: PlayerId;
  isMe: boolean;
  alive: boolean;
  /** undefined ONLY for `isMe` - see buildGameScreenViewModel. */
  mafiaProbability?: number;
  /** undefined ONLY for `isMe` (same reasoning as mafiaProbability) or a dead player (no bar is shown for them). */
  barStyle?: ProbabilityBarStyle;
}

export interface GameScreenViewModel {
  phaseLabel: string;
  phase: UiPhase;
  players: PlayerCircleViewModel[];
  canUndo: boolean;
}

function phaseLabel(phase: UiPhase): string {
  switch (phase.kind) {
    case "day":
      return `Day ${phase.round + 1}`;
    case "night":
      return `Night ${phase.round}`;
    case "voting":
      return phase.stage === "initial" ? `Day ${phase.round + 1} - Voting` : `Day ${phase.round + 1} - Revote`;
    case "keepOrEliminateVoting":
      return `Day ${phase.round + 1} - Keep or Eliminate`;
    case "finished":
      return "Game Finished";
  }
}

/**
 * The main game screen's data. `players` includes EVERY player, including
 * the viewer's own seat (isMe: true) - but that entry's mafiaProbability is
 * always `undefined`, never the real number, because it is built from
 * getPublicPlayerProbabilities() (which already excludes the viewer's own
 * player entirely) rather than any per-player lookup that could include it.
 * This is enforced by construction, not by a rendering convention a future
 * change could forget.
 */
export function buildGameScreenViewModel(facade: MafiaPredictorFacade): GameScreenViewModel {
  const session = facade.getPublicSessionView();
  const publicProbs = facade.getPublicPlayerProbabilities();
  const byPlayer = new Map<PlayerId, PublicPlayerProbability>(publicProbs.map((p) => [p.player, p]));
  const neutral = facade.getPriorMafiaProbability();

  const players: PlayerCircleViewModel[] = session.config.players.map((player) => {
    const isMe = player === session.myPlayerNumber;
    if (isMe) {
      return { player, isMe: true, alive: true }; // alive-state for self is filled in below, mafiaProbability/barStyle deliberately omitted
    }
    const p = byPlayer.get(player);
    const alive = p?.alive ?? true;
    return {
      player,
      isMe: false,
      alive,
      mafiaProbability: p?.mafiaProbability,
      barStyle: alive && p ? computeProbabilityBarStyle(p.mafiaProbability, neutral) : undefined,
    };
  });

  // fill in the viewer's own alive-state (public, safe info - only P(mafia)/role are secret) without ever touching probability.
  const meAliveEntry = players.find((p) => p.isMe);
  if (meAliveEntry) {
    const allDead = new Set<PlayerId>();
    facade.getEventLog().forEach(({ event }) => {
      if (event.type === "nightResult") event.died.forEach((d) => allDead.add(d));
      if (event.type === "dayElimination") event.eliminated.forEach((d) => allDead.add(d));
    });
    meAliveEntry.alive = !allDead.has(session.myPlayerNumber);
  }

  return { phaseLabel: phaseLabel(session.uiPhase), phase: session.uiPhase, players, canUndo: facade.canUndo() };
}

export interface RoleEntryViewModel {
  needsRole: boolean;
  roleOptions: RoleId[];
}

export function buildRoleEntryViewModel(facade: MafiaPredictorFacade): RoleEntryViewModel {
  const session = facade.getPublicSessionView();
  return { needsRole: !session.hasMyRole, roleOptions: facade.getRoleOptions() };
}

/**
 * How a player's vertical probability bar should be drawn, expressed as
 * plain data so the direction/color mapping bug (green bar growing
 * downward - visually implying "more suspicious" while colored as "more
 * trustworthy") can be unit-tested without a DOM. Semantic contract: more
 * town-like (mafiaProbability -> 0) grows UP and is colored "town"
 * (green); more mafia-like (mafiaProbability -> 1) grows DOWN and is
 * colored "mafia" (red).
 *
 * `neutral` is the "no lean either way" point - the game's actual prior
 * P(mafia team) (see gameFacade.ts's getPriorMafiaProbability()), NOT a
 * universal 0.5. With a typical role mix (mafia team a minority of the
 * players) the prior is well below 0.5, so anchoring at 0.5 would render
 * every player as visibly "leaning town" from the very start of the game,
 * before any evidence exists - found by actually playing a game through a
 * browser, not by the narrower unit tests that only ever exercised this
 * function with a hardcoded 0.5. At exactly `neutral`, heightPercent is 0 -
 * no visible fill either direction. Defaults to 0.5 to keep the function
 * trivially testable/usable when no game-specific prior is available.
 */
export interface ProbabilityBarStyle {
  direction: "up" | "down";
  color: "town" | "mafia";
  heightPercent: number;
}

export function computeProbabilityBarStyle(mafiaProbability: number, neutral: number = 0.5): ProbabilityBarStyle {
  if (mafiaProbability > neutral) {
    const span = 1 - neutral; // max possible deviation on the "more mafia" side
    const heightPercent = span > 0 ? ((mafiaProbability - neutral) / span) * 50 : 50;
    return { direction: "down", color: "mafia", heightPercent };
  }
  const span = neutral; // max possible deviation on the "more town" side
  const heightPercent = span > 0 ? ((neutral - mafiaProbability) / span) * 50 : 0;
  return { direction: "up", color: "town", heightPercent };
}

export interface HistoryListEntryViewModel {
  id: string;
  savedAt: string;
  playerCount: number;
  result: string;
}

export function buildHistoryListViewModel(facade: MafiaPredictorFacade): HistoryListEntryViewModel[] {
  return facade.listHistory().map((entry) => ({
    id: entry.id,
    savedAt: entry.savedAt,
    playerCount: entry.session.config.players.length,
    result: entry.session.confirmedOutcome ?? "unknown",
  }));
}
