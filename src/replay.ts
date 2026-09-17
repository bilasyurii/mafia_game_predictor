import { PlayerId, RoleExpression, RoleId, World } from "./types";
import { EvidenceStep } from "./processEvidence";
import { getExpressionProbability, getProbability, rankByProbability } from "./probability";
import { GroupRegistry } from "./roleGroups";

/**
 * Turns processEvidence's raw EvidenceStep[] into the small, inspectable
 * shape a human (or a ground-truth evaluation) actually wants per step. Adds
 * NO new inference: every field here is read directly off `step.posterior`/
 * `step.context`, which processEvidence already computed using only public
 * evidence recorded before that step - see processEvidence.ts's own doc for
 * why a later step can never affect an earlier one. In particular, a dead
 * player is simply absent from `alive` and the probability maps from that
 * step onward; nothing here stops or special-cases processing once someone
 * has died - continuing through the whole game is what processEvidence
 * already does by construction (see replay.test.ts).
 */
export interface ReplayStepView {
  index: number;
  evidence: EvidenceStep["evidence"];
  /** Living players at the start of this evidence's own phase, in player order. */
  alive: PlayerId[];
  /** P(player is on the Mafia team), for every currently-living player. */
  mafiaProbability: Record<PlayerId, number>;
  /** P(player = "don"), for every living player - omitted entirely when this
   *  game's config has no "don" role, per "P(Don) where useful". */
  donProbability?: Record<PlayerId, number>;
  commissionerProbability: Record<PlayerId, number>;
  doctorProbability: Record<PlayerId, number>;
  /** Living players ordered by descending Mafia-team probability. */
  rankedByMafia: { player: PlayerId; probability: number }[];
}

function livingPlayersInOrder(step: EvidenceStep): PlayerId[] {
  return step.context.config.players.filter((p) => step.context.alive[p] === true);
}

function perPlayer(
  worlds: World[],
  players: PlayerId[],
  expr: RoleExpression,
  groups: GroupRegistry
): Record<PlayerId, number> {
  const result: Record<PlayerId, number> = {};
  players.forEach((p) => {
    result[p] = getExpressionProbability(worlds, p, expr, groups);
  });
  return result;
}

/**
 * Summarizes a single EvidenceStep. `groups` must be the same GroupRegistry
 * the model itself was scored with (step.context.groups already is - this
 * is just reused directly rather than re-derived, so the Mafia-team
 * probability can never drift from what the inference actually used).
 */
export function summarizeStep(step: EvidenceStep): ReplayStepView {
  const alive = livingPlayersInOrder(step);
  const mafiaGroup: RoleExpression = { kind: "group", group: "mafia" };
  const view: ReplayStepView = {
    index: step.index,
    evidence: step.evidence,
    alive,
    mafiaProbability: perPlayer(step.posterior, alive, mafiaGroup, step.context.groups),
    commissionerProbability: {},
    doctorProbability: {},
    rankedByMafia: rankByProbability(step.posterior, alive, mafiaGroup, step.context.groups),
  };
  alive.forEach((p) => {
    view.commissionerProbability[p] = getProbability(step.posterior, p, "commissioner");
    view.doctorProbability[p] = getProbability(step.posterior, p, "doctor");
  });
  if (step.context.config.roles.includes("don")) {
    view.donProbability = {};
    alive.forEach((p) => {
      view.donProbability![p] = getProbability(step.posterior, p, "don");
    });
  }
  return view;
}

/** summarizeStep, applied to every step of a full processEvidence run. */
export function summarizeReplay(steps: EvidenceStep[]): ReplayStepView[] {
  return steps.map(summarizeStep);
}

// ============================================================
// EVALUATION-ONLY: comparing a replay against known ground truth.
//
// Everything below reads an ALREADY-COMPUTED posterior/ReplayStepView and
// a caller-supplied ground truth; nothing here is wired into
// LikelihoodModel, ActionModel, or any inference path, and nothing here can
// feed back into a World's probability. Use this only for reporting after
// the fact - never pass a GroundTruthRoles into generateWorlds, evidence
// construction, or any EvidenceContext.
// ============================================================

/**
 * Known true roles for SOME players, for post-game evaluation only. Partial
 * by design (Partial<Record<...>>) - e.g. "Mafia: 4, 8, 10" without a
 * further Doctor/Commissioner breakdown is fully representable: players not
 * listed here are simply skipped, never guessed at.
 */
export interface GroundTruthRoles {
  roles: Partial<Record<PlayerId, RoleId>>;
}

/**
 * Complete team-level ground truth, for post-game evaluation only. Unlike
 * GroundTruthRoles (exact role, often only known for some players), this is
 * a plain Record - meant to be used when EVERY player's Mafia-team
 * membership is known, e.g. once a game's full Mafia roster has been
 * revealed (which implies every other player is Town), even when most
 * individual Town roles (Doctor vs Commissioner vs Citizen) are not.
 */
export interface GroundTruthTeams {
  isMafia: Record<PlayerId, boolean>;
}

export interface GroundTruthEvaluationEntry {
  player: PlayerId;
  actualRole: RoleId;
  /** The posterior's P(player = actualRole) at the step this was computed from. */
  posteriorProbabilityOfActualRole: number;
}

/**
 * EVALUATION-ONLY. For every player with a known true role, reports how
 * much posterior mass the model actually assigned to that true role. Takes
 * a plain World[] (typically one step's `.posterior`), never anything from
 * GroundTruthRoles is threaded back into it - this function only reads.
 */
export function evaluateAgainstGroundTruth(
  posterior: World[],
  groundTruth: GroundTruthRoles
): GroundTruthEvaluationEntry[] {
  return Object.entries(groundTruth.roles)
    .filter((entry): entry is [PlayerId, RoleId] => entry[1] !== undefined)
    .map(([player, actualRole]) => ({
      player,
      actualRole,
      posteriorProbabilityOfActualRole: getProbability(posterior, player, actualRole),
    }));
}

/** Human-readable one-line-per-player rendering of a ReplayStepView - for
 *  quick terminal inspection only, not used by any test assertion. */
export function formatReplayStep(view: ReplayStepView): string {
  const lines = [
    `#${view.index} ${view.evidence.type} (round ${view.evidence.round}) - alive: ${view.alive.join(", ")}`,
  ];
  view.rankedByMafia.forEach(({ player, probability }) => {
    const don = view.donProbability ? `, P(don)=${view.donProbability[player].toFixed(3)}` : "";
    lines.push(
      `  ${player}: P(mafia)=${probability.toFixed(3)}${don}, P(doctor)=${view.doctorProbability[player].toFixed(3)}, P(commissioner)=${view.commissionerProbability[player].toFixed(3)}`
    );
  });
  return lines.join("\n");
}
