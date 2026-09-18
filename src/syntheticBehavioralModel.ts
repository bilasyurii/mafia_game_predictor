import { BehavioralModelParams, defaultBehavioralModelParams } from "./behavioralModel";

/**
 * Behavioral priors derived from the 10-game synthetic Claude-CLI experiment
 * (seeds 1000-1009, 7-player games: Don/Mafia/Commissioner/Doctor/3
 * Citizens, unbatched claude-haiku-4-5-20251001 - see
 * src/simulation/runSyntheticExperiment.ts and this milestone's report for
 * the raw aggregate). NOT derived from, or tuned against, either of the two
 * held-out real recorded games (game1.ts/game2.ts) - those are evaluated
 * separately, AFTER these parameters are fixed, and never fed back in.
 *
 * Every raw count below is taken directly from
 * synthetic-experiment-1000-aggregate.json's `behavioralStats`, with one
 * exception: `investigationReport`'s three-way split (truthful/falseResult/
 * bluff) needed the JOINT breakdown of "does the actor hold the mechanic"
 * and "does the claimed result match reality," which the aggregate's own
 * two independent marginal counts don't directly give - that was recomputed
 * locally from the 10 saved output.json transcripts using the project's own
 * hasMechanic/getInvestigationResult, with no Claude calls involved
 * (truthful=17, falseResult=0, bluff=2, matching the aggregate's
 * truthfulHolder=17/bluffNonHolder=2 and resultMatchesTruth=18/
 * resultContradictsTruth=1 marginals as a cross-check: 17 holder-matches +
 * 1 lucky bluff-match = 18 total matches; 2 bluffs - 1 lucky match = 1
 * contradicted bluff).
 *
 * `roleAssertion` and `keepOrEliminateVote` have ZERO synthetic
 * observations (this harness's DayActionDecision schema has no "accuse
 * another player of a role" option, and no game reached a second
 * consecutive tied vote) - both are left at defaultBehavioralModelParams's
 * values, unchanged. `repeatFactor` also stays at its default (1): the only
 * available signal (20 repeated-position events across 209 total
 * suspect/defend/nominate acts) would need each act's full "was a repeat
 * even possible here" opportunity structure to estimate an unbiased
 * multiplicative adjustment, which this milestone does not attempt to
 * reconstruct - see this file's own report for why an honest "not
 * estimated" beats a rough guess here.
 */

/**
 * Symmetric Dirichlet(kappa) shrinkage toward a UNIFORM prior over
 * `counts.length` categories: category i's smoothed probability is
 * (count_i + kappa/k) / (total + kappa). kappa=10 total pseudo-observations,
 * spread evenly across categories - chosen so a category needs a reasonably
 * large real sample (roughly N>=30-40) before the raw ratio dominates the
 * estimate, while staying close to the uninformed uniform split when N is
 * tiny (e.g. Mafia's own-team `defend` count, N=5). This is the ONE
 * consistent smoothing rule applied to every category below, so results
 * stay comparable across parameters - a stronger/weaker kappa is a
 * reasonable future adjustment, not a claim that 10 is uniquely correct.
 */
export const SMOOTHING_PSEUDO_COUNT = 10;

export function smoothedSplit(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  const perCategory = SMOOTHING_PSEUDO_COUNT / counts.length;
  return counts.map((c) => (c + perCategory) / (total + SMOOTHING_PSEUDO_COUNT));
}

// ============================================================
// Raw counts, verbatim from synthetic-experiment-1000-aggregate.json
// ============================================================

// selfRoleClaim: { truthful, falseSameTeam, falseDifferentTeam } - pooled across all 10 games (N=27)
const SELF_ROLE_CLAIM_COUNTS = [19, 0, 8];

// investigationReport: { truthful, falseResult, bluff } - recomputed jointly, see top doc (N=19)
const INVESTIGATION_REPORT_COUNTS = [17, 0, 2];

// suspect/defend/nominate: [ownTeam, otherTeam] counts, per team
const SUSPECT_TOWN_COUNTS = [38, 40]; // townToTown, townToMafia (N=78)
const SUSPECT_MAFIA_COUNTS = [0, 47]; // mafiaToMafia, mafiaToTown (N=47)
const DEFEND_TOWN_COUNTS = [35, 5]; // (N=40)
const DEFEND_MAFIA_COUNTS = [2, 3]; // (N=5) - very small sample, see report
const NOMINATE_TOWN_COUNTS = [9, 13]; // (N=22)
const NOMINATE_MAFIA_COUNTS = [0, 17]; // (N=17)

// candidateVote: abstain is its own 2-way split (abstained vs voted); the
// own/other-team split is conditioned on having voted at all (excludes abstainers).
const VOTE_TOWN_ABSTAIN_COUNTS = [28, 48]; // abstained, voted (N=76 voter-turns)
const VOTE_MAFIA_ABSTAIN_COUNTS = [7, 28]; // (N=35 voter-turns)
const VOTE_TOWN_AMONG_VOTED_COUNTS = [24, 24]; // ownTeam(forTownCandidate), otherTeam(forMafiaCandidate) (N=48)
const VOTE_MAFIA_AMONG_VOTED_COUNTS = [0, 28]; // ownTeam(forMafiaCandidate), otherTeam(forTownCandidate) (N=28)

const [selfRoleClaimTruthful, selfRoleClaimFalseSame, selfRoleClaimFalseDiff] = smoothedSplit(SELF_ROLE_CLAIM_COUNTS);
const [investigationTruthful, investigationFalseResult, investigationBluff] = smoothedSplit(INVESTIGATION_REPORT_COUNTS);

const [suspectTownOwn, suspectTownOther] = smoothedSplit(SUSPECT_TOWN_COUNTS);
const [suspectMafiaOwn, suspectMafiaOther] = smoothedSplit(SUSPECT_MAFIA_COUNTS);
const [defendTownOwn, defendTownOther] = smoothedSplit(DEFEND_TOWN_COUNTS);
const [defendMafiaOwn, defendMafiaOther] = smoothedSplit(DEFEND_MAFIA_COUNTS);
const [nominateTownOwn, nominateTownOther] = smoothedSplit(NOMINATE_TOWN_COUNTS);
const [nominateMafiaOwn, nominateMafiaOther] = smoothedSplit(NOMINATE_MAFIA_COUNTS);

const [voteTownAbstain] = smoothedSplit(VOTE_TOWN_ABSTAIN_COUNTS);
const [voteMafiaAbstain] = smoothedSplit(VOTE_MAFIA_ABSTAIN_COUNTS);
const [voteTownOwn, voteTownOther] = smoothedSplit(VOTE_TOWN_AMONG_VOTED_COUNTS);
const [voteMafiaOwn, voteMafiaOther] = smoothedSplit(VOTE_MAFIA_AMONG_VOTED_COUNTS);

export const syntheticBehavioralModelParams: BehavioralModelParams = {
  ...defaultBehavioralModelParams,

  selfRoleClaim: {
    truthful: selfRoleClaimTruthful,
    falseSameTeam: selfRoleClaimFalseSame,
    falseDifferentTeam: selfRoleClaimFalseDiff,
  },
  // roleAssertion: unchanged - zero synthetic observations (see top doc)

  investigationReport: {
    truthful: investigationTruthful,
    falseResult: investigationFalseResult,
    bluff: investigationBluff,
  },

  suspect: {
    town: { ownTeam: suspectTownOwn, otherTeam: suspectTownOther },
    mafia: { ownTeam: suspectMafiaOwn, otherTeam: suspectMafiaOther },
  },
  defend: {
    town: { ownTeam: defendTownOwn, otherTeam: defendTownOther },
    mafia: { ownTeam: defendMafiaOwn, otherTeam: defendMafiaOther },
  },
  nominate: {
    town: { ownTeam: nominateTownOwn, otherTeam: nominateTownOther },
    mafia: { ownTeam: nominateMafiaOwn, otherTeam: nominateMafiaOther },
  },
  // repeatFactor: unchanged - insufficient data to estimate reliably (see top doc)

  candidateVote: {
    vote: {
      town: { ownTeam: voteTownOwn, otherTeam: voteTownOther },
      mafia: { ownTeam: voteMafiaOwn, otherTeam: voteMafiaOther },
    },
    abstain: { town: voteTownAbstain, mafia: voteMafiaAbstain },
  },
  // keepOrEliminateVote: unchanged - zero synthetic observations (no game reached a second tie)
};
