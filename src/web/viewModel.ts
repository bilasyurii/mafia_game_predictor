import { PlayerId, RoleId } from "../types";
import { DetectedTeam, MafiaPredictorFacade, RelationshipArrow } from "../app/gameFacade";
import { UiPhase } from "../app/types";
import { ConfirmedTeam } from "../relations/confirmedFacts";

/**
 * Pure, DOM-free view-model builders for the browser UI (web/src/app.ts
 * renders these; this file never touches window/document). Kept in src/web/
 * (inside the existing src/ tree) rather than web/src/ specifically so it
 * is covered by the project's existing `npx tsc --noEmit`/`npm test`
 * without any new configuration.
 *
 * There is no probability anywhere in this file - see this app's
 * relationship-based redesign. The safety-critical property that survives
 * from the old design: nothing returned ever includes the viewer's own
 * role - see buildGameScreenViewModel's own doc.
 */

export interface PlayerCircleViewModel {
  player: PlayerId;
  isMe: boolean;
  alive: boolean;
  confirmedTeam?: ConfirmedTeam;
}

export interface GameScreenViewModel {
  phaseLabel: string;
  phase: UiPhase;
  players: PlayerCircleViewModel[];
  canUndo: boolean;
  arrows: RelationshipArrow[];
  teams: DetectedTeam[];
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
 * The main game screen's data: every player (including the viewer's own
 * seat, isMe: true), the relationship arrows and detected teams for the
 * circle + team panel, and the phase/undo state. `confirmedTeam` on a
 * player entry comes only from the VIEWER's own investigation reports
 * (see relations/confirmedFacts.ts) - it is never withheld for the
 * viewer's own seat specially, since it never reveals anything the viewer
 * doesn't already know (it's the viewer's own check result).
 */
export function buildGameScreenViewModel(facade: MafiaPredictorFacade): GameScreenViewModel {
  const session = facade.getPublicSessionView();
  const relationships = facade.getRelationshipView();

  const allDead = new Set<PlayerId>();
  facade.getEventLog().forEach(({ event }) => {
    if (event.type === "nightResult") event.died.forEach((d) => allDead.add(d));
    if (event.type === "dayElimination") event.eliminated.forEach((d) => allDead.add(d));
  });

  const players: PlayerCircleViewModel[] = session.config.players.map((player) => ({
    player,
    isMe: player === session.myPlayerNumber,
    alive: !allDead.has(player),
    confirmedTeam: relationships.confirmedTeams[player],
  }));

  return {
    phaseLabel: phaseLabel(session.uiPhase),
    phase: session.uiPhase,
    players,
    canUndo: facade.canUndo(),
    arrows: relationships.arrows,
    teams: relationships.teams,
  };
}

export interface RoleEntryViewModel {
  needsRole: boolean;
  roleOptions: RoleId[];
}

export function buildRoleEntryViewModel(facade: MafiaPredictorFacade): RoleEntryViewModel {
  const session = facade.getPublicSessionView();
  return { needsRole: !session.hasMyRole, roleOptions: facade.getRoleOptions() };
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
