import { GameConfig, RoleId } from "./types";

export type Team = "mafia" | "town" | "neutral";

/**
 * Private, mechanical actions a role can perform. Says nothing about
 * whether anyone observes them, and nothing about how trustworthy any
 * resulting statement is - that's the evidence layer's job.
 */
export type MechanicId =
  | "planTargets"
  | "unanimousNightKill"
  | "checkIsCommissioner"
  | "checkIsMafia"
  | "protect";

/**
 * Every field below `mechanic` is descriptive metadata, not an executable
 * spec: night.ts and uniformActionModel.ts hand-implement each mechanic's
 * actual runtime behavior directly against its `mechanic` id (e.g.
 * hasMechanic(..., "unanimousNightKill"), hasMechanic(..., "protect")),
 * and never read targetsPlayer/usesPerGame/requiresTeamConsensus/
 * noConsecutiveRepeatTarget. They document, for a human reader, the shape
 * of behavior the hand-written code next to them is expected to implement -
 * changing one of these values does not change any runtime behavior, and
 * there is deliberately no generic engine that would make it do so (see
 * the architecture-audit findings this comment was added from).
 */
export interface RoleMechanic {
  mechanic: MechanicId;
  targetsPlayer: boolean;
  /** Omit for unlimited/every applicable phase (e.g. every night). */
  usesPerGame?: number;
  /**
   * This mechanic only resolves when every current living holder of it
   * agrees on the same target (the mafia kill) - false/omitted for
   * mechanics one player exercises independently.
   */
  requiresTeamConsensus?: boolean;
  /** This mechanic's target may not repeat the immediately preceding one. */
  noConsecutiveRepeatTarget?: boolean;
}

export interface RoleDefinition {
  id: RoleId;
  team: Team;
  /** At most one living player may hold this role. */
  unique: boolean;
  mechanics: RoleMechanic[];
}

export type RoleRegistry = Record<RoleId, RoleDefinition>;

/**
 * Public speech/behavior (selfRoleClaim, roleAssertion, investigationReport,
 * candidateVote, keepOrEliminateVote, suspect, defend, nominate) is
 * deliberately absent from every role's
 * mechanics list - any player, regardless of role, can say or do any of
 * these.
 */
export const defaultRoleRegistry: RoleRegistry = {
  citizen: {
    id: "citizen",
    team: "town",
    unique: false,
    mechanics: [],
  },
  mafia: {
    id: "mafia",
    team: "mafia",
    unique: false,
    mechanics: [
      {
        mechanic: "unanimousNightKill",
        targetsPlayer: true,
        requiresTeamConsensus: true,
      },
    ],
  },
  don: {
    id: "don",
    team: "mafia",
    unique: true,
    mechanics: [
      /**
       * The Don's private preselection of 3 kill targets, declared to the
       * moderator on the initial night and known to all Mafia. This entry
       * is intentionally declarative-only in the current engine: it does
       * not constrain resolveNight or enumerateHiddenNightActions (each
       * night's mafia kill still requires every living killer to
       * independently choose the same target, exactly as the rules
       * specify - the plan does not mechanically determine that choice),
       * and it does not create any public evidence (no Evidence type
       * reveals it, and none should - the public observer never learns
       * the plan). The current uniform ActionModel correspondingly does
       * not model any behavioral influence from Mafia knowing the plan.
       * Any future such effect belongs exclusively in an explicit,
       * opt-in ActionModel - never as a default assumption, and never as
       * a mechanical restriction, unless the game rules themselves
       * change.
       */
      { mechanic: "planTargets", targetsPlayer: true, usesPerGame: 1 },
      {
        mechanic: "unanimousNightKill",
        targetsPlayer: true,
        requiresTeamConsensus: true,
      },
      { mechanic: "checkIsCommissioner", targetsPlayer: true },
    ],
  },
  doctor: {
    id: "doctor",
    team: "town",
    unique: true,
    mechanics: [
      {
        mechanic: "protect",
        targetsPlayer: true,
        noConsecutiveRepeatTarget: true,
      },
    ],
  },
  commissioner: {
    id: "commissioner",
    team: "town",
    unique: true,
    mechanics: [{ mechanic: "checkIsMafia", targetsPlayer: true }],
  },
};

/**
 * The one generic question the evidence layer is allowed to ask about a
 * role: "can it do X" - never "is it named X".
 */
export function hasMechanic(
  registry: RoleRegistry,
  role: RoleId,
  mechanic: MechanicId
): boolean {
  return registry[role].mechanics.some((m) => m.mechanic === mechanic);
}

/**
 * The one generic team-based question the evidence layer is allowed to ask
 * about two roles: are they on the same team - never which team by name.
 */
export function sameTeam(registry: RoleRegistry, a: RoleId, b: RoleId): boolean {
  return registry[a].team === registry[b].team;
}

export function validateGameConfig(
  config: GameConfig,
  registry: RoleRegistry
): void {
  const counts = new Map<RoleId, number>();
  config.roles.forEach((role) => {
    counts.set(role, (counts.get(role) ?? 0) + 1);
  });

  for (const [role, count] of counts) {
    if (registry[role].unique && count > 1) {
      throw new Error(`Role "${role}" is unique but appears ${count} times`);
    }
  }
}
