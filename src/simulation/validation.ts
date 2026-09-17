import { GroupId, PlayerId, RoleId } from "../types";
import { InvestigationMechanic } from "../investigation";
import { DayActionDecision, KeepOrEliminateDecision, TargetChoiceDecision, VoteDecision } from "./types";

/**
 * The validation boundary: every LLM decision passes through one of these
 * functions before it is allowed to become an Evidence item or a
 * HiddenNightActions entry. Throwing SimulationValidationError is the only
 * failure mode - callers (driver.ts) turn that into a bounded retry, never a
 * silent fallback to a "valid-looking" action.
 */
export class SimulationValidationError extends Error {}

const VALID_ROLE_IDS: RoleId[] = ["don", "mafia", "citizen", "doctor", "commissioner"];
const VALID_GROUP_IDS: GroupId[] = ["mafia", "town", "activeTown"];
const VALID_INVESTIGATION_MECHANICS: InvestigationMechanic[] = ["checkIsCommissioner", "checkIsMafia"];

function assertKnownPlayer(player: PlayerId, knownPlayers: PlayerId[], what: string): void {
  if (!knownPlayers.includes(player)) {
    throw new SimulationValidationError(`${what} "${player}" is not a player in this game`);
  }
}

function assertLivingTarget(player: PlayerId, alive: PlayerId[], what: string): void {
  if (!alive.includes(player)) {
    throw new SimulationValidationError(`${what} "${player}" is not currently alive`);
  }
}

/** suspect/defend/nominate targets must be currently alive; investigationClaim's target need only be a known player (it may report a check made on someone now dead). */
export function validateDayActionDecision(
  decision: DayActionDecision,
  allPlayers: PlayerId[],
  alive: PlayerId[]
): void {
  (decision.suspect ?? []).forEach((t) => assertLivingTarget(t, alive, "suspect target"));
  (decision.defend ?? []).forEach((t) => assertLivingTarget(t, alive, "defend target"));
  if (decision.nominate !== undefined) {
    assertLivingTarget(decision.nominate, alive, "nominate target");
  }
  if (decision.roleClaim !== undefined) {
    if (decision.roleClaim.kind === "role" && !VALID_ROLE_IDS.includes(decision.roleClaim.role)) {
      throw new SimulationValidationError(`roleClaim names an unknown role "${decision.roleClaim.role}"`);
    }
    if (decision.roleClaim.kind === "group" && !VALID_GROUP_IDS.includes(decision.roleClaim.group)) {
      throw new SimulationValidationError(`roleClaim names an unknown group "${decision.roleClaim.group}"`);
    }
  }
  if (decision.investigationClaim !== undefined) {
    const { target, mechanic } = decision.investigationClaim;
    assertKnownPlayer(target, allPlayers, "investigationClaim target");
    if (!VALID_INVESTIGATION_MECHANICS.includes(mechanic)) {
      throw new SimulationValidationError(`investigationClaim names an unknown mechanic "${mechanic}"`);
    }
  }
}

export function validateVoteDecision(decision: VoteDecision, candidates: PlayerId[]): void {
  if (decision.candidate !== null && !candidates.includes(decision.candidate)) {
    throw new SimulationValidationError(
      `vote candidate "${decision.candidate}" is not one of the candidates on the table (${candidates.join(", ")})`
    );
  }
}

export function validateKeepOrEliminateDecision(decision: KeepOrEliminateDecision): void {
  if (typeof decision.eliminate !== "boolean") {
    throw new SimulationValidationError("keepOrEliminate decision must set a boolean `eliminate`");
  }
}

/** `forbiddenTarget` is the Doctor's own previous save target (the no-consecutive-repeat rule); irrelevant, and always undefined, for every other target-choice kind. */
export function validateTargetChoiceDecision(
  decision: TargetChoiceDecision,
  alive: PlayerId[],
  forbiddenTarget?: PlayerId
): void {
  assertLivingTarget(decision.target, alive, "target");
  if (forbiddenTarget !== undefined && decision.target === forbiddenTarget) {
    throw new SimulationValidationError(
      `target "${decision.target}" cannot be chosen again on a consecutive night`
    );
  }
}
