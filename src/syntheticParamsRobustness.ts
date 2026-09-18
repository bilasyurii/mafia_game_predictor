import { GameConfig } from "./types";
import { defaultRoleRegistry, hasMechanic } from "./roles";
import { getInvestigationResult } from "./investigation";
import { BehavioralModelParams, defaultBehavioralModelParams } from "./behavioralModel";
import { BehavioralStats, TeamBucket, computeBehavioralStats } from "./simulation/syntheticGame";
import { SimulationOutput } from "./simulation/types";
import { smoothedSplit } from "./syntheticBehavioralModel";

/**
 * DIAGNOSTIC ONLY (leave-one-synthetic-game-out robustness investigation -
 * see this milestone's own report). Recomputes syntheticBehavioralModelParams'
 * exact smoothing procedure (smoothedSplit, unchanged, imported directly
 * from syntheticBehavioralModel.ts - not reimplemented, not re-tuned) from
 * PER-GAME raw counts (via computeBehavioralStats, unchanged, imported
 * directly from simulation/syntheticGame.ts) instead of the pooled
 * 10-game aggregate, so any 9-of-10-games subset (and therefore every
 * leave-one-game-out fit) can be reconstructed. Never touches either real
 * game, never touches syntheticBehavioralModelParams itself, never changes
 * the smoothing constant. See syntheticParamsRobustnessReport.ts for the
 * full 10-game analysis built on top of this file.
 */

// ============================================================
// Per-game raw counts
// ============================================================

/** investigationReport's joint (truthful/falseResult/bluff) breakdown is not part of computeBehavioralStats' two independent marginals - recomputed here exactly as syntheticBehavioralModel.ts's own top-of-file doc describes (hasMechanic + getInvestigationResult, against ground truth), per game. */
export function investigationReportJointCounts(config: GameConfig, output: SimulationOutput): [truthful: number, falseResult: number, bluff: number] {
  let truthful = 0;
  let falseResult = 0;
  let bluff = 0;
  output.publicEvidence.forEach((e) => {
    if (e.type !== "investigationReport") return;
    const holds = hasMechanic(defaultRoleRegistry, output.groundTruth.roles[e.actor] as any, e.mechanic);
    if (!holds) {
      bluff += 1;
      return;
    }
    const matches = getInvestigationResult(defaultRoleRegistry, e.mechanic, output.groundTruth.roles[e.target] as any) === e.result;
    if (matches) truthful += 1;
    else falseResult += 1;
  });
  return [truthful, falseResult, bluff];
}

export interface PerGameCounts {
  seed: number;
  suspectCounts: TeamBucket;
  defendCounts: TeamBucket;
  nominateCounts: TeamBucket;
  roleClaims: BehavioralStats["roleClaims"];
  investigationReportJoint: [truthful: number, falseResult: number, bluff: number];
  voteCounts: BehavioralStats["voteCounts"];
}

export function computePerGameCounts(seed: number, config: GameConfig, output: SimulationOutput): PerGameCounts {
  const stats = computeBehavioralStats(config, output);
  return {
    seed,
    suspectCounts: stats.suspectCounts,
    defendCounts: stats.defendCounts,
    nominateCounts: stats.nominateCounts,
    roleClaims: stats.roleClaims,
    investigationReportJoint: investigationReportJointCounts(config, output),
    voteCounts: stats.voteCounts,
  };
}

// ============================================================
// Summing counts across any subset of games (full 10, or 9-of-10 for
// leave-one-out)
// ============================================================

const emptyBucket = (): TeamBucket => ({ townToMafia: 0, townToTown: 0, mafiaToMafia: 0, mafiaToTown: 0 });
function addBucket(a: TeamBucket, b: TeamBucket): TeamBucket {
  return {
    townToMafia: a.townToMafia + b.townToMafia,
    townToTown: a.townToTown + b.townToTown,
    mafiaToMafia: a.mafiaToMafia + b.mafiaToMafia,
    mafiaToTown: a.mafiaToTown + b.mafiaToTown,
  };
}

export interface SummedCounts {
  suspectCounts: TeamBucket;
  defendCounts: TeamBucket;
  nominateCounts: TeamBucket;
  roleClaims: BehavioralStats["roleClaims"];
  investigationReportJoint: [number, number, number];
  voteCounts: BehavioralStats["voteCounts"];
}

/** Sums an arbitrary subset of per-game counts - used for both the full 10-game total and every leave-one-out 9-game total. */
export function sumPerGameCounts(games: readonly PerGameCounts[]): SummedCounts {
  return games.reduce<SummedCounts>(
    (acc, g) => ({
      suspectCounts: addBucket(acc.suspectCounts, g.suspectCounts),
      defendCounts: addBucket(acc.defendCounts, g.defendCounts),
      nominateCounts: addBucket(acc.nominateCounts, g.nominateCounts),
      roleClaims: {
        truthful: acc.roleClaims.truthful + g.roleClaims.truthful,
        falseSameTeam: acc.roleClaims.falseSameTeam + g.roleClaims.falseSameTeam,
        falseDifferentTeam: acc.roleClaims.falseDifferentTeam + g.roleClaims.falseDifferentTeam,
      },
      investigationReportJoint: [
        acc.investigationReportJoint[0] + g.investigationReportJoint[0],
        acc.investigationReportJoint[1] + g.investigationReportJoint[1],
        acc.investigationReportJoint[2] + g.investigationReportJoint[2],
      ],
      voteCounts: {
        town: {
          forMafiaCandidate: acc.voteCounts.town.forMafiaCandidate + g.voteCounts.town.forMafiaCandidate,
          forTownCandidate: acc.voteCounts.town.forTownCandidate + g.voteCounts.town.forTownCandidate,
          abstain: acc.voteCounts.town.abstain + g.voteCounts.town.abstain,
        },
        mafia: {
          forMafiaCandidate: acc.voteCounts.mafia.forMafiaCandidate + g.voteCounts.mafia.forMafiaCandidate,
          forTownCandidate: acc.voteCounts.mafia.forTownCandidate + g.voteCounts.mafia.forTownCandidate,
          abstain: acc.voteCounts.mafia.abstain + g.voteCounts.mafia.abstain,
        },
      },
    }),
    {
      suspectCounts: emptyBucket(),
      defendCounts: emptyBucket(),
      nominateCounts: emptyBucket(),
      roleClaims: { truthful: 0, falseSameTeam: 0, falseDifferentTeam: 0 },
      investigationReportJoint: [0, 0, 0],
      voteCounts: {
        town: { forMafiaCandidate: 0, forTownCandidate: 0, abstain: 0 },
        mafia: { forMafiaCandidate: 0, forTownCandidate: 0, abstain: 0 },
      },
    }
  );
}

/** Every game except the one at `holdoutIndex` - the leave-one-out subset. */
export function leaveOneOut(games: readonly PerGameCounts[], holdoutIndex: number): SummedCounts {
  return sumPerGameCounts(games.filter((_, i) => i !== holdoutIndex));
}

// ============================================================
// Building BehavioralModelParams from counts - EXACT replica of
// syntheticBehavioralModel.ts's own assembly, using the SAME imported
// smoothedSplit (never reimplemented, never re-tuned). Verified in
// syntheticParamsRobustness.test.ts to reproduce syntheticBehavioralModelParams
// byte-for-byte when fed the full 10-game summed counts.
// ============================================================

export function buildParamsFromCounts(counts: SummedCounts): BehavioralModelParams {
  const [selfRoleClaimTruthful, selfRoleClaimFalseSame, selfRoleClaimFalseDiff] = smoothedSplit([
    counts.roleClaims.truthful,
    counts.roleClaims.falseSameTeam,
    counts.roleClaims.falseDifferentTeam,
  ]);
  const [investigationTruthful, investigationFalseResult, investigationBluff] = smoothedSplit(counts.investigationReportJoint);

  const [suspectTownOwn, suspectTownOther] = smoothedSplit([counts.suspectCounts.townToTown, counts.suspectCounts.townToMafia]);
  const [suspectMafiaOwn, suspectMafiaOther] = smoothedSplit([counts.suspectCounts.mafiaToMafia, counts.suspectCounts.mafiaToTown]);
  const [defendTownOwn, defendTownOther] = smoothedSplit([counts.defendCounts.townToTown, counts.defendCounts.townToMafia]);
  const [defendMafiaOwn, defendMafiaOther] = smoothedSplit([counts.defendCounts.mafiaToMafia, counts.defendCounts.mafiaToTown]);
  const [nominateTownOwn, nominateTownOther] = smoothedSplit([counts.nominateCounts.townToTown, counts.nominateCounts.townToMafia]);
  const [nominateMafiaOwn, nominateMafiaOther] = smoothedSplit([counts.nominateCounts.mafiaToMafia, counts.nominateCounts.mafiaToTown]);

  const townVoted = counts.voteCounts.town.forMafiaCandidate + counts.voteCounts.town.forTownCandidate;
  const mafiaVoted = counts.voteCounts.mafia.forMafiaCandidate + counts.voteCounts.mafia.forTownCandidate;
  const [voteTownAbstain] = smoothedSplit([counts.voteCounts.town.abstain, townVoted]);
  const [voteMafiaAbstain] = smoothedSplit([counts.voteCounts.mafia.abstain, mafiaVoted]);
  const [voteTownOwn, voteTownOther] = smoothedSplit([counts.voteCounts.town.forTownCandidate, counts.voteCounts.town.forMafiaCandidate]);
  const [voteMafiaOwn, voteMafiaOther] = smoothedSplit([counts.voteCounts.mafia.forMafiaCandidate, counts.voteCounts.mafia.forTownCandidate]);

  return {
    ...defaultBehavioralModelParams,
    selfRoleClaim: { truthful: selfRoleClaimTruthful, falseSameTeam: selfRoleClaimFalseSame, falseDifferentTeam: selfRoleClaimFalseDiff },
    investigationReport: { truthful: investigationTruthful, falseResult: investigationFalseResult, bluff: investigationBluff },
    suspect: { town: { ownTeam: suspectTownOwn, otherTeam: suspectTownOther }, mafia: { ownTeam: suspectMafiaOwn, otherTeam: suspectMafiaOther } },
    defend: { town: { ownTeam: defendTownOwn, otherTeam: defendTownOther }, mafia: { ownTeam: defendMafiaOwn, otherTeam: defendMafiaOther } },
    nominate: { town: { ownTeam: nominateTownOwn, otherTeam: nominateTownOther }, mafia: { ownTeam: nominateMafiaOwn, otherTeam: nominateMafiaOther } },
    candidateVote: {
      vote: { town: { ownTeam: voteTownOwn, otherTeam: voteTownOther }, mafia: { ownTeam: voteMafiaOwn, otherTeam: voteMafiaOther } },
      abstain: { town: voteTownAbstain, mafia: voteMafiaAbstain },
    },
  };
}
