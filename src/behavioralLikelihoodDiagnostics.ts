import { BehavioralModelParams, CandidateVoteBehaviorParams, RoleClaimBehaviorParams, createBehavioralHandlers } from "./behavioralModel";
import { PlayerId } from "./types";
import { defaultRoleRegistry, Team } from "./roles";
import { TeamAlignmentBehaviorParams } from "./behavioralModel";
import { InvestigationReportLikelihoodParams } from "./investigationReportLikelihood";
import { ActionModel } from "./actionModel";
import { createUniformActionModel } from "./uniformActionModel";
import { createNightResultHandler } from "./nightResultLikelihood";
import { Evidence, LikelihoodModel, ObservationHandler, ObservationHandlerMap, createLikelihoodModel } from "./evidence";
import { GroundTruthTeams } from "./replay";

/**
 * DIAGNOSTIC-ONLY module for this investigation: how strongly does a
 * behavioral observation move the world posterior, and how do repeated
 * observations combine? Nothing here is used by any production inference
 * path (driver.ts/processEvidence.ts/updateProbabilities.ts are all
 * untouched) and nothing here changes defaultBehavioralModelParams or
 * syntheticBehavioralModelParams. See behavioralContributionReport.ts for
 * the two-real-game decomposition built on top of these helpers.
 */

/**
 * A fully UNINFORMATIVE BehavioralModelParams: every category's buckets are
 * set EQUAL to each other, so every behavioral observation handler returns
 * the SAME number regardless of which candidate world it's scored against -
 * a world-independent constant that cancels exactly in updateProbabilities'
 * renormalization (see its own "Identifiability note"). This is NOT the
 * same thing as defaultBehavioralModelParams: the existing "flat neutral"
 * default already has suspect/defend/nominate/candidateVote/
 * keepOrEliminateVote at flat 0.5/0.5, but its selfRoleClaim (0.7/0.2/0.2)
 * and investigationReport (0.7/0.15/0.25) are NOT flat - a claim being true
 * vs. false already carries real, non-cancelling information even in the
 * "neutral" default. This function additionally flattens exactly those two
 * categories, producing the true "zero behavioral information" baseline
 * needed to isolate mechanical/deterministic evidence's contribution alone.
 */
export function buildUninformativeBehavioralParams(base: BehavioralModelParams): BehavioralModelParams {
  const flatAlignment: TeamAlignmentBehaviorParams = {
    mafia: { ownTeam: 0.5, otherTeam: 0.5 },
    town: { ownTeam: 0.5, otherTeam: 0.5 },
  };
  return {
    ...base,
    selfRoleClaim: { truthful: 1 / 3, falseSameTeam: 1 / 3, falseDifferentTeam: 1 / 3 },
    roleAssertion: { truthful: 1 / 3, falseSameTeam: 1 / 3, falseDifferentTeam: 1 / 3 },
    investigationReport: { truthful: 1 / 3, falseResult: 1 / 3, bluff: 1 / 3 },
    suspect: flatAlignment,
    defend: flatAlignment,
    nominate: flatAlignment,
    repeatFactor: 1,
    candidateVote: { vote: flatAlignment, abstain: { mafia: 0.5, town: 0.5 } },
    keepOrEliminateVote: {
      mafia: { eliminateSharedTeam: 0.5, keepSharedTeam: 0.5, eliminateNoSharedTeam: 0.5, keepNoSharedTeam: 0.5 },
      town: { eliminateSharedTeam: 0.5, keepSharedTeam: 0.5, eliminateNoSharedTeam: 0.5, keepNoSharedTeam: 0.5 },
    },
  };
}

/**
 * The exact per-observation likelihood a suspect/defend/nominate handler
 * (teamAlignmentLikelihood.ts's createTeamAlignmentHandler) would compute,
 * for a hypothetical world where the actor holds `actorTeam` and the target
 * holds `targetTeam` - without needing to build a whole World/EvidenceContext.
 * Mirrors createTeamAlignmentHandler's own same/different-team dispatch
 * exactly (see behavioralModel.ts's lookupTeamAlignment).
 */
export function teamAlignmentLikelihood(
  params: TeamAlignmentBehaviorParams,
  actorTeam: Team,
  targetTeam: Team
): number {
  const bucket = params[actorTeam] ?? { ownTeam: 0.5, otherTeam: 0.5 };
  return actorTeam === targetTeam ? bucket.ownTeam : bucket.otherTeam;
}

/**
 * For one observed act (e.g. "X suspects Y"), with Y's team held at its
 * true/assumed value: the likelihood under "actor is mafia" vs "actor is
 * town", and their ratio - exactly the quantity part A of this
 * investigation asks for ("World A: X is mafia; World B: X is town").
 */
export function mafiaVsTownLikelihoodRatio(
  params: TeamAlignmentBehaviorParams,
  targetTeam: Team
): { likelihoodIfMafia: number; likelihoodIfTown: number; ratio: number } {
  const likelihoodIfMafia = teamAlignmentLikelihood(params, "mafia", targetTeam);
  const likelihoodIfTown = teamAlignmentLikelihood(params, "town", targetTeam);
  return { likelihoodIfMafia, likelihoodIfTown, ratio: likelihoodIfMafia / likelihoodIfTown };
}

/**
 * The cumulative likelihood ratio after N repetitions of the SAME
 * per-observation ratio - what actually happens today for N DIFFERENT
 * targets by the same actor (suspect/defend/nominate, or any other
 * evidence type): ratio^n. See repeatedPosition in behavioralModel.ts -
 * it only fires for an EXACT actor+type+SAME-target repeat, never "many
 * distinct targets by the same actor," so accusing 5 different players
 * compounds at full, undamped strength regardless of repeatFactor.
 *
 * IMPORTANT FINDING (see this investigation's report, part F): even for an
 * EXACT repeat where repeatedPosition DOES fire, `repeatFactor` turns out
 * to have ZERO effect on the resulting posterior, for ANY value - not just
 * at its current default of 1. teamAlignmentParamsFrom's `repeated ? base *
 * repeatFactor : base` multiplies EVERY candidate world's likelihood for
 * that one observation by the identical scalar `repeatFactor` (it is
 * computed from ctx.history/observation alone - never from `world` - so it
 * cannot differ between worlds). A multiplicative constant applied
 * uniformly to every world's likelihood is exactly the case
 * updateProbabilities.ts's own "Identifiability note" describes: it cancels
 * in the renormalization and never changes any world's relative posterior.
 * So `cumulativeRatioForExactRepeat` below is mathematically IDENTICAL to
 * the undamped `ratio^n`, regardless of repeatFactor's value - there is no
 * dial here that actually works as a diminishing-returns control, despite
 * appearances. See behavioralLikelihoodDiagnostics.test.ts for a direct,
 * code-level proof against the real updateProbabilities()/processEvidence().
 */
export function cumulativeRatioForDistinctTargets(perObservationRatio: number, n: number): number {
  return perObservationRatio ** n;
}

// ============================================================
// Feature-ablation diagnostics
// ============================================================

/** Every behavioral evidence type - i.e. every key of ObservationHandlerMap, which is exactly what createBehavioralHandlers() produces. */
export const ALL_BEHAVIORAL_EVIDENCE_TYPES = [
  "selfRoleClaim",
  "roleAssertion",
  "investigationReport",
  "suspect",
  "defend",
  "nominate",
  "candidateVote",
  "keepOrEliminateVote",
] as const;

export type BehavioralEvidenceType = (typeof ALL_BEHAVIORAL_EVIDENCE_TYPES)[number];

/**
 * Builds a LikelihoodModel where only the behavioral evidence types in
 * `enabledTypes` contribute their real (BehavioralModelParams-configured)
 * likelihood; every OTHER behavioral type is replaced with a constant
 * handler returning 1 - a world-independent likelihood that cancels
 * exactly in updateProbabilities' renormalization (same mechanism as
 * behavioralEvidenceWeight=0, just applied per-type instead of uniformly).
 * Mechanical evidence (nightResult, dayElimination) is NEVER ablated - it
 * is wired up exactly as createBehavioralLikelihoodModel does, via the same
 * production createNightResultHandler/createUniformActionModel, so every
 * ablation scenario still has full mechanical grounding.
 *
 * Reuses createBehavioralHandlers/createLikelihoodModel/
 * createNightResultHandler unchanged - this function only decides which of
 * the eight already-built handlers to keep vs. replace with a constant. No
 * production likelihood implementation (teamAlignmentLikelihood.ts,
 * investigationReportLikelihood.ts, etc.) is modified or reimplemented.
 */
export function buildAblatedBehavioralModel(
  params: BehavioralModelParams,
  enabledTypes: ReadonlySet<BehavioralEvidenceType>,
  actionModel: ActionModel = createUniformActionModel(defaultRoleRegistry)
): LikelihoodModel {
  const fullHandlers = createBehavioralHandlers(params);
  const alwaysOne: ObservationHandler = () => 1;
  const ablated = { ...fullHandlers } as ObservationHandlerMap;
  ALL_BEHAVIORAL_EVIDENCE_TYPES.forEach((t) => {
    if (!enabledTypes.has(t)) {
      (ablated as Record<string, ObservationHandler>)[t] = alwaysOne;
    }
  });
  return createLikelihoodModel(ablated, createNightResultHandler(actionModel));
}

// ============================================================
// selfRoleClaim / roleAssertion / investigationReport ratios
// ============================================================

/**
 * The three raw configured values plus the two most interpretable ratios:
 * truthful-vs-falseSameTeam and truthful-vs-falseDifferentTeam. Used
 * identically for selfRoleClaim and roleAssertion (same param shape).
 */
export function roleClaimLikelihoodRatios(params: RoleClaimBehaviorParams) {
  return {
    truthful: params.truthful,
    falseSameTeam: params.falseSameTeam,
    falseDifferentTeam: params.falseDifferentTeam,
    truthfulVsFalseSameTeam: params.truthful / params.falseSameTeam,
    truthfulVsFalseDifferentTeam: params.truthful / params.falseDifferentTeam,
  };
}

/** Same idea for investigationReport's three-bucket shape. */
export function investigationReportLikelihoodRatios(params: InvestigationReportLikelihoodParams) {
  const truthful = params.truthful as number;
  const falseResult = params.falseResult as number;
  const bluff = params.bluff as number;
  return {
    truthful,
    falseResult,
    bluff,
    truthfulVsFalseResult: truthful / falseResult,
    truthfulVsBluff: truthful / bluff,
  };
}

// ============================================================
// Feature-level synthetic->human transfer diagnostics (suspect/defend/
// nominate/candidateVote breakdown by TRUE team, and cumulative
// log-likelihood mass) - descriptive only, never used to fit or select
// parameters. See behavioralTransferDiagnostics.ts for the full report
// built on top of these helpers.
// ============================================================

function teamOfPlayer(groundTruthTeams: GroundTruthTeams, player: PlayerId): Team {
  return groundTruthTeams.isMafia[player] ? "mafia" : "town";
}

/**
 * Sum of ln(likelihood assigned to the ACTOR's true team, given the
 * TARGET's true team) across every observed event of `type` in `evidence` -
 * the total log-likelihood mass this parameterization assigns to the
 * actually-observed sequence of suspect/defend/nominate acts, evaluated at
 * ground truth. Well-defined only for the team-alignment family (a single
 * actor/target pair per event); see cumulativeCandidateVoteLogLikelihood for
 * the per-voter multi-actor case.
 */
export function cumulativeTeamAlignmentLogLikelihood(
  evidence: readonly Evidence[],
  groundTruthTeams: GroundTruthTeams,
  params: TeamAlignmentBehaviorParams,
  type: "suspect" | "defend" | "nominate"
): number {
  let sum = 0;
  evidence.forEach((e) => {
    if (e.type !== type) return;
    const actorTeam = teamOfPlayer(groundTruthTeams, (e as any).actor);
    const targetTeam = teamOfPlayer(groundTruthTeams, (e as any).target);
    sum += Math.log(teamAlignmentLikelihood(params, actorTeam, targetTeam));
  });
  return sum;
}

/** Same idea as cumulativeTeamAlignmentLogLikelihood, for candidateVote's per-voter raised-hand factor (abstainers excluded - they carry no target). */
export function cumulativeCandidateVoteLogLikelihood(
  evidence: readonly Evidence[],
  groundTruthTeams: GroundTruthTeams,
  params: CandidateVoteBehaviorParams
): number {
  let sum = 0;
  evidence.forEach((e) => {
    if (e.type !== "candidateVote") return;
    Object.entries(e.handsRaised).forEach(([candidate, voters]) => {
      (voters ?? []).forEach((voter) => {
        const voterTeam = teamOfPlayer(groundTruthTeams, voter);
        const candidateTeam = teamOfPlayer(groundTruthTeams, candidate);
        sum += Math.log(teamAlignmentLikelihood(params.vote, voterTeam, candidateTeam));
      });
    });
  });
  return sum;
}

export interface ActorSuspectStats {
  actor: PlayerId;
  totalSuspects: number;
  distinctTargets: number;
  repeatedTargetActs: number;
}

/**
 * Descriptive breakdown of every `suspect` event in `evidence`: how many
 * targeted an actually-Mafia player vs an actually-town player (ground
 * truth), and, per actor, how many distinct targets vs. exact-target
 * repeats. Purely observational - draws no conclusion about correctness.
 */
export function suspectBreakdown(evidence: readonly Evidence[], groundTruthTeams: GroundTruthTeams) {
  const suspects = evidence.filter((e): e is Extract<Evidence, { type: "suspect" }> => e.type === "suspect");
  const targetMafia = suspects.filter((e) => groundTruthTeams.isMafia[e.target]).length;
  const byActor = new Map<PlayerId, PlayerId[]>();
  suspects.forEach((e) => {
    if (!byActor.has(e.actor)) byActor.set(e.actor, []);
    byActor.get(e.actor)!.push(e.target);
  });
  const perActor: ActorSuspectStats[] = Array.from(byActor.entries()).map(([actor, targets]) => ({
    actor,
    totalSuspects: targets.length,
    distinctTargets: new Set(targets).size,
    repeatedTargetActs: targets.length - new Set(targets).size,
  }));
  return { totalSuspects: suspects.length, targetMafia, targetTown: suspects.length - targetMafia, perActor };
}

/** How many of `type`'s events (suspect/defend/nominate) targeted an actually-Mafia vs actually-town player - the "empirical direction" to compare against a configured ratio's assumption. */
export function empiricalTargetDirection(
  evidence: readonly Evidence[],
  groundTruthTeams: GroundTruthTeams,
  type: "suspect" | "defend" | "nominate"
) {
  const events = evidence.filter((e) => e.type === type) as Extract<Evidence, { type: "suspect" | "defend" | "nominate" }>[];
  const targetMafia = events.filter((e) => groundTruthTeams.isMafia[e.target]).length;
  return { n: events.length, targetMafia, targetTown: events.length - targetMafia };
}
