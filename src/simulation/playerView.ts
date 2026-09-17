import { GameConfig, PlayerId, RoleId } from "../types";
import { Evidence } from "../evidence";
import { GamePhase } from "../facts";
import { RoleRegistry, sameTeam } from "../roles";
import { PrivateInvestigation, PrivateKnowledge, PrivateSave, PublicGameStateView } from "./types";

/**
 * Builds exactly the state one player is allowed to see at a given point in
 * the game - the single deterministic chokepoint enforcing this project's
 * simulation information boundary ("the LLM MUST NEVER receive information
 * unavailable to that simulated player"). Everything returned is either
 * public (publicHistory, alive, players) or `player`'s own legitimate
 * private knowledge, derived from `groundTruthRoles`/`ownInvestigations`/
 * `ownSaves` but never exposing another player's true role.
 */
export function buildPlayerView(
  player: PlayerId,
  phase: GamePhase,
  config: GameConfig,
  publicHistory: Evidence[],
  alive: PlayerId[],
  groundTruthRoles: Record<PlayerId, RoleId>,
  registry: RoleRegistry,
  ownInvestigations: PrivateInvestigation[],
  ownSaves: PrivateSave[]
): PublicGameStateView {
  const role = groundTruthRoles[player];
  const isMafiaTeam = registry[role].team === "mafia";

  const privateKnowledge: PrivateKnowledge = { role };
  if (isMafiaTeam) {
    privateKnowledge.teammates = config.players.filter(
      (p) => p !== player && sameTeam(registry, groundTruthRoles[p], role)
    );
  }
  if (ownInvestigations.length > 0) {
    privateKnowledge.investigations = [...ownInvestigations];
  }
  if (ownSaves.length > 0) {
    privateKnowledge.saves = [...ownSaves];
  }

  return {
    self: player,
    phase,
    players: [...config.players],
    alive: [...alive],
    publicHistory: [...publicHistory],
    private: privateKnowledge,
  };
}

/**
 * A compact, prompt-ready text rendering of a PublicGameStateView - plain
 * JSON, since the goal is small structured input tokens, not a
 * natural-language transcript reconstruction. A real SimulationAgent is free
 * to build its own prompt directly from the structured view instead of
 * calling this.
 */
export function formatPromptText(view: PublicGameStateView): string {
  return JSON.stringify(view);
}
