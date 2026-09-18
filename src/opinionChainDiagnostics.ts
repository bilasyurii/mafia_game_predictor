import { PlayerId, World } from "./types";
import { Evidence, EvidenceContext, LikelihoodModel, ObservationHandler, ObservationHandlerMap, createLikelihoodModel } from "./evidence";
import { BehavioralModelParams, createBehavioralHandlers } from "./behavioralModel";
import { sameTeam } from "./roles";
import { defaultRoleRegistry } from "./roles";
import { tallyCandidateVote } from "./voting";
import { ActionModel } from "./actionModel";
import { createUniformActionModel } from "./uniformActionModel";
import { createNightResultHandler } from "./nightResultLikelihood";

/**
 * DIAGNOSTIC ONLY: is a player's suspect/nominate/vote-for-X a fresh public
 * opinion, or a repeated/echoed manifestation of an opinion they already
 * expressed about X earlier? Nothing here changes any production likelihood
 * implementation (teamAlignmentLikelihood.ts, candidateVoteLikelihood.ts,
 * etc. are all imported and used unchanged) or any BehavioralModelParams.
 * See opinionChainReport.ts for the full 10-synthetic + 2-real-game
 * analysis built on top of this file.
 */

// ============================================================
// 1. Sequence extraction
// ============================================================

export type TargetedActType = "suspect" | "nominate" | "vote";

export interface TargetedAct {
  step: number;
  type: TargetedActType;
  actor: PlayerId;
  target: PlayerId;
}

/**
 * Flattens suspect/nominate (already actor->target) and candidateVote
 * (one event covering many voters -> expanded into one "vote" act per
 * voter who actually raised a hand; abstainers produce no act, since
 * abstaining doesn't target anyone) into one chronological actor->target
 * act stream. defend/selfRoleClaim/investigationReport/keepOrEliminateVote
 * are deliberately excluded - see this investigation's own report for why
 * (defend is an opposite-valence opinion; the others aren't about a
 * specific OTHER player's role at all in the same "accusation" sense).
 */
export function extractTargetedActs(evidence: readonly Evidence[]): TargetedAct[] {
  const acts: TargetedAct[] = [];
  evidence.forEach((e, step) => {
    if (e.type === "suspect" || e.type === "nominate") {
      acts.push({ step, type: e.type, actor: e.actor, target: e.target });
    } else if (e.type === "candidateVote") {
      Object.entries(e.handsRaised).forEach(([candidate, voters]) => {
        (voters ?? []).forEach((voter) => {
          acts.push({ step, type: "vote", actor: voter, target: candidate });
        });
      });
    }
  });
  return acts;
}

// ============================================================
// 2 & 3. Chains, clustering stats, and sequence categories
// ============================================================

export type ChainCategory =
  | "A_suspectOnly"
  | "B_suspectNominate"
  | "C_suspectVote"
  | "D_suspectNominateVote"
  | "E_nominateVote"
  | "F_voteOnly"
  | "other";

export interface ActorTargetChain {
  actor: PlayerId;
  target: PlayerId;
  acts: TargetedAct[]; // chronological
  distinctTypes: Set<TargetedActType>;
  typeSequence: TargetedActType[];
  category: ChainCategory;
  hasRepeatedType: boolean; // F in the investigation's own numbering: same exact type repeated for this actor+target
}

function classifyChain(distinctTypes: Set<TargetedActType>): ChainCategory {
  const has = (t: TargetedActType) => distinctTypes.has(t);
  if (has("suspect") && has("nominate") && has("vote")) return "D_suspectNominateVote";
  if (has("suspect") && has("nominate")) return "B_suspectNominate";
  if (has("suspect") && has("vote")) return "C_suspectVote";
  if (has("nominate") && has("vote")) return "E_nominateVote";
  if (has("suspect")) return "A_suspectOnly";
  if (has("vote")) return "F_voteOnly";
  return "other";
}

/** Groups a flat act stream into per-(actor,target) chronological chains. */
export function groupIntoChains(acts: TargetedAct[]): ActorTargetChain[] {
  const byKey = new Map<string, TargetedAct[]>();
  acts.forEach((act) => {
    const key = `${act.actor}|${act.target}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(act);
  });

  return Array.from(byKey.entries()).map(([key, chainActs]) => {
    const [actor, target] = key.split("|");
    const sorted = [...chainActs].sort((a, b) => a.step - b.step);
    const distinctTypes = new Set(sorted.map((a) => a.type));
    const typeSequence = sorted.map((a) => a.type);
    const typeCounts = new Map<TargetedActType, number>();
    sorted.forEach((a) => typeCounts.set(a.type, (typeCounts.get(a.type) ?? 0) + 1));
    const hasRepeatedType = Array.from(typeCounts.values()).some((c) => c > 1);
    return { actor, target, acts: sorted, distinctTypes, typeSequence, category: classifyChain(distinctTypes), hasRepeatedType };
  });
}

export interface ClusterStats {
  numSuspect: number;
  numNominate: number;
  numVotes: number;
  numDistinctActorTargetPairs: number;
  numChains: number; // == numDistinctActorTargetPairs, named for clarity per the investigation's own terms
  totalTargetedActs: number;
  avgActionsPerTarget: number;
  maxActionsPerTarget: number;
  categoryCounts: Record<ChainCategory, number>;
  repeatedTypeChains: number; // chains with hasRepeatedType === true (category F in the investigation's numbering)
  distinctTargetActors: number; // number of DISTINCT actors who acted on >=2 DIFFERENT targets (category G)
}

const EMPTY_CATEGORY_COUNTS: Record<ChainCategory, number> = {
  A_suspectOnly: 0,
  B_suspectNominate: 0,
  C_suspectVote: 0,
  D_suspectNominateVote: 0,
  E_nominateVote: 0,
  F_voteOnly: 0,
  other: 0,
};

export function computeClusterStats(acts: TargetedAct[], chains: ActorTargetChain[]): ClusterStats {
  const categoryCounts = { ...EMPTY_CATEGORY_COUNTS };
  chains.forEach((c) => {
    categoryCounts[c.category] += 1;
  });

  const actorTargets = new Map<PlayerId, Set<PlayerId>>();
  chains.forEach((c) => {
    if (!actorTargets.has(c.actor)) actorTargets.set(c.actor, new Set());
    actorTargets.get(c.actor)!.add(c.target);
  });
  const distinctTargetActors = Array.from(actorTargets.values()).filter((s) => s.size >= 2).length;

  const chainLengths = chains.map((c) => c.acts.length);

  return {
    numSuspect: acts.filter((a) => a.type === "suspect").length,
    numNominate: acts.filter((a) => a.type === "nominate").length,
    numVotes: acts.filter((a) => a.type === "vote").length,
    numDistinctActorTargetPairs: chains.length,
    numChains: chains.length,
    totalTargetedActs: acts.length,
    avgActionsPerTarget: chains.length === 0 ? 0 : acts.length / chains.length,
    maxActionsPerTarget: chainLengths.length === 0 ? 0 : Math.max(...chainLengths),
    categoryCounts,
    repeatedTypeChains: chains.filter((c) => c.hasRepeatedType).length,
    distinctTargetActors,
  };
}

// ============================================================
// 6 & 7. Collapsed-chain diagnostic replay model
// ============================================================

/**
 * True if (actor,target) already produced a suspect/nominate/vote act
 * strictly BEFORE this point in the game, per ctx.history (which
 * processEvidence already scopes to "everything recorded before the item
 * being scored" - see evidence.ts's EvidenceContext doc). Reused for both
 * the suspect/nominate handlers (single actor) and the per-voter check
 * inside the candidateVote handler below.
 */
function hasEarlierTargetedAct(actor: PlayerId, target: PlayerId, history: readonly Evidence[]): boolean {
  return history.some(
    (e) =>
      (e.type === "suspect" && e.actor === actor && e.target === target) ||
      (e.type === "nominate" && e.actor === actor && e.target === target) ||
      (e.type === "candidateVote" && (e.handsRaised[target] ?? []).includes(actor))
  );
}

/**
 * Builds a DIAGNOSTIC-ONLY LikelihoodModel: identical to
 * createBehavioralLikelihoodModel(params), EXCEPT that a suspect/nominate/
 * candidateVote contribution for a specific (actor,target) pair is replaced
 * with the world-independent constant 1 (uninformative - see
 * updateProbabilities.ts's "Identifiability note") whenever that SAME
 * (actor,target) pair already produced a suspect/nominate/vote earlier in
 * the game. The FIRST such act for a given (actor,target) pair always
 * scores at full, real strength; only subsequent "re-statements of the same
 * opinion" are collapsed. selfRoleClaim, roleAssertion, investigationReport,
 * defend, and keepOrEliminateVote are NEVER touched - this is the explicit
 * "control" isolation this investigation's own report asks for (item 7):
 * only the suspect/nominate/vote "opinion chain" family is ever collapsed.
 *
 * For candidateVote specifically (one event, many voters): each voter's OWN
 * raised-hand/abstain factor is scored independently (mirroring
 * candidateVoteLikelihood.ts's createCandidateVoteHandler exactly, via the
 * same tallyCandidateVote), and only a voter whose vote is itself redundant
 * (they already suspected/nominated/voted for this exact candidate earlier)
 * has THEIR factor replaced with 1 - other voters in the SAME event are
 * unaffected. Abstaining is never "collapsible" (it targets no one).
 */
export function buildCollapsedChainModel(
  params: BehavioralModelParams,
  actionModel: ActionModel = createUniformActionModel(defaultRoleRegistry)
): LikelihoodModel {
  const real = createBehavioralHandlers(params);

  const collapsedSuspect: ObservationHandler = (observation: any, world: World, ctx: EvidenceContext) =>
    hasEarlierTargetedAct(observation.actor, observation.target, ctx.history) ? 1 : real.suspect(observation, world, ctx);

  const collapsedNominate: ObservationHandler = (observation: any, world: World, ctx: EvidenceContext) =>
    hasEarlierTargetedAct(observation.actor, observation.target, ctx.history) ? 1 : real.nominate(observation, world, ctx);

  const collapsedCandidateVote: ObservationHandler = (observation: any, world: World, ctx: EvidenceContext) => {
    const tally = tallyCandidateVote(observation, ctx.alive);
    let likelihood = 1;
    tally.candidates.forEach((candidateTally: any) => {
      candidateTally.raisedHands.forEach((voter: PlayerId) => {
        if (hasEarlierTargetedAct(voter, candidateTally.candidate, ctx.history)) return; // collapsed: factor 1
        const same = sameTeam(ctx.roles, world.roles[voter], world.roles[candidateTally.candidate]);
        const factor = same ? params.candidateVote.vote[ctx.roles[world.roles[voter]].team]?.ownTeam ?? 0.5
          : params.candidateVote.vote[ctx.roles[world.roles[voter]].team]?.otherTeam ?? 0.5;
        likelihood *= factor;
      });
    });
    tally.abstainers.forEach((voter: PlayerId) => {
      likelihood *= params.candidateVote.abstain[ctx.roles[world.roles[voter]].team] ?? 0.2;
    });
    return likelihood;
  };

  const collapsedHandlers: ObservationHandlerMap = {
    ...real,
    suspect: collapsedSuspect as any,
    nominate: collapsedNominate as any,
    candidateVote: collapsedCandidateVote as any,
  };

  return createLikelihoodModel(collapsedHandlers, createNightResultHandler(actionModel));
}
