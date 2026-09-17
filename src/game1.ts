import { GameConfig, PlayerId } from "./types";
import { Evidence } from "./evidence";
import { GroundTruthRoles, GroundTruthTeams } from "./replay";

/**
 * The first real recorded game, transcribed from the user's raw notes as an
 * Evidence[] log for processEvidence - see this milestone's report for the
 * exact round-numbering mapping used (the user's "Day 1" is round 0, before
 * any night; "Night N" is night round N; the user's "Day N+1" is day round
 * N, since day round N follows night round N).
 *
 * Two readings were not obvious from the raw notes and were resolved by
 * asking rather than guessed at:
 *  - the role composition (see game1Config below) - confirmed: player 10 is
 *    specifically the Don.
 *  - "10 ... defended 10" (self-defense) - NOT confirmed as intended; the
 *    user was unsure what it meant and asked to skip it, so no DefendAction
 *    for it is included below at all (not replaced with a guessed target).
 *
 * Everything else maps directly onto an existing Evidence type using only
 * the actions/targets/results actually stated. "Attacked" is read as a
 * public SuspectAction (the project has no "attack" Evidence type at all -
 * a night kill's actor is never publicly known, see types.ts's Observation
 * doc - so a day-time "attacked" in the notes can only be the public
 * accusation act, i.e. suspect). "Defended" is DefendAction. The bare
 * "7 claimed Commissioner" is a SelfRoleClaim with no investigation content
 * (no target/result stated), so it is NOT an InvestigationReport.
 */
export const game1Players = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"];

export const game1Evidence: Evidence[] = [
  // --- Day 1 (day round 0): "no attacks/defenses and no voting" - nothing to record ---

  // --- Night 1 (night round 1) ---
  { type: "nightResult", round: 1, died: ["2", "4"] },

  // --- Day 2 (day round 1, follows night round 1) ---
  { type: "suspect", round: 1, actor: "6", target: "5" },
  { type: "suspect", round: 1, actor: "6", target: "9" },
  { type: "suspect", round: 1, actor: "6", target: "10" },
  { type: "defend", round: 1, actor: "6", target: "7" },
  { type: "suspect", round: 1, actor: "10", target: "6" },
  { type: "suspect", round: 1, actor: "10", target: "7" },
  // "10 ... defended 10" from the notes is deliberately OMITTED here - the
  // user confirmed this wasn't self-defense but was unsure what it actually
  // meant, and asked to skip it rather than have a target guessed.
  { type: "suspect", round: 1, actor: "1", target: "8" },
  {
    type: "candidateVote",
    round: 1,
    stage: "initial",
    // Candidate call order is not stated in the notes; ["10","7"] vs
    // ["7","10"] both resolve to the same winner here (10) once the two
    // abstainers' votes go to whichever is called last - see this
    // milestone's report - so this ordering choice does not affect anything.
    candidates: ["10", "7"],
    handsRaised: { "10": ["1", "5", "6", "7", "9"], "7": ["3"] },
    // "8" and "10" raised no hand for either candidate: both abstain.
  },
  { type: "dayElimination", round: 1, eliminated: ["10"] },

  // --- Night 2 (night round 2) ---
  { type: "nightResult", round: 2, died: ["1"] },

  // --- Day 3 (day round 2, follows night round 2) ---
  { type: "suspect", round: 2, actor: "5", target: "6" },
  { type: "suspect", round: 2, actor: "5", target: "8" },
  { type: "suspect", round: 2, actor: "6", target: "8" },
  { type: "suspect", round: 2, actor: "7", target: "8" },
  { type: "suspect", round: 2, actor: "7", target: "3" },
  { type: "suspect", round: 2, actor: "9", target: "8" },
  { type: "suspect", round: 2, actor: "3", target: "7" },
  { type: "selfRoleClaim", round: 2, actor: "7", claim: { kind: "role", role: "commissioner" } },
  // No vote/elimination is recorded for Day 3 in the notes - none is added here.

  // --- Night 3 (night round 3) ---
  { type: "nightResult", round: 3, died: ["8"] },
];

/**
 * Known ground truth, for POST-GAME EVALUATION ONLY (see replay.ts's
 * evaluateAgainstGroundTruth) - never fed into game1Config, game1Evidence,
 * or any EvidenceContext. Deliberately partial: confirmed are the
 * observer's own role, the full final Mafia set, and that player 10
 * specifically is the Don (not just Mafia-team) - the notes don't say which
 * specific player holds Doctor vs Commissioner, so those are left out
 * rather than guessed.
 */
export const game1GroundTruth: GroundTruthRoles = {
  roles: {
    "2": "citizen",
    "4": "mafia",
    "8": "mafia",
    "10": "don",
  },
};

/**
 * The full Mafia-team roster, per "final revealed Mafia: 4, 8, 10" - unlike
 * game1GroundTruth's exact roles (only known for 4 players), TEAM
 * membership is fully known for all 10 players: everyone not in this list
 * is thereby confirmed Town, even though their exact role (Doctor,
 * Commissioner, or Citizen) mostly isn't. See game1GroundTruthTeams below,
 * which is what the Brier-score/log-loss evaluation in gameEvaluation.ts
 * actually uses, precisely because it's complete rather than partial.
 */
export const game1MafiaTeam: PlayerId[] = ["4", "8", "10"];

/**
 * Complete team-level ground truth (POST-GAME EVALUATION ONLY - same rule
 * as game1GroundTruth: never fed into inference), derived directly from
 * game1MafiaTeam so the two can never drift apart.
 */
export const game1GroundTruthTeams: GroundTruthTeams = {
  isMafia: Object.fromEntries(game1Players.map((p) => [p, game1MafiaTeam.includes(p)])),
};

/**
 * Confirmed role composition: 1 Don (player 10) + 2 plain Mafia (4, 8) +
 * Doctor + Commissioner + 5 Citizens among the remaining 7 players. Which
 * specific one of the 7 non-Mafia players holds Doctor vs Commissioner is
 * NOT known and is exactly what generateWorlds/processEvidence marginalize
 * over - this config only fixes the multiset, never a specific assignment.
 */
export const game1Config: GameConfig = {
  players: game1Players,
  roles: ["don", "mafia", "mafia", "doctor", "commissioner", "citizen", "citizen", "citizen", "citizen", "citizen"],
};
