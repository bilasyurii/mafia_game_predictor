import { GameConfig, PlayerId } from "./types";
import { Evidence } from "./evidence";
import { GroundTruthRoles, GroundTruthTeams } from "./replay";

/**
 * The second real recorded game, transcribed from the user's raw notes as
 * an Evidence[] log for processEvidence - same round-numbering convention
 * as game1.ts: the user's "Day 1" is day round 0 (before any night);
 * "Night N" is night round N; the user's "Day N+1" is day round N (day
 * round N follows night round N).
 *
 * Unlike game1.ts, the role composition here is fully and unambiguously
 * stated ("Mafia: 2, 6 / Don Mafia: 4 / Commissioner: 5 / Doctor: 9 /
 * Citizens: 1, 3, 7, 8") - no clarifying question was needed for that.
 *
 * Several statements in the notes, however, do NOT have an unambiguous
 * mapping onto the existing Evidence model, and were deliberately OMITTED
 * rather than guessed at (see the inline comments at each point below):
 *  - "7 agreed with player 3" / "8 agreed with player 3": player 3 made
 *    several distinct statements (three suspicions and a nomination)
 *    beforehand - "agreeing with 3" doesn't say which one, so this can't be
 *    mapped onto a single SuspectAction/NominateAction without guessing
 *    which target(s) were being endorsed.
 *  - From player 3's defense speech: "was not sure player 5 was actually
 *    Commissioner", "people could vote for whoever they wanted", and the
 *    warning that "player 5 might turn out to be fake" - these are hedges/
 *    expressions of doubt, not definite claims. RoleAssertion only
 *    represents a definite positive claim ("B is <role>"); there is no
 *    "actor expressed doubt about a claim" Evidence type.
 *  - Player 5's "had not checked anyone yet" - there is no Evidence type
 *    for a negative investigation report (a check that did NOT happen).
 *  - "The game ended immediately after this. Mafia won." - not encoded:
 *    there is no Evidence type for a game-outcome announcement, and this is
 *    exactly the kind of outcome-revealing, ground-truth-adjacent fact this
 *    milestone requires be kept out of inference entirely.
 *
 * One statement WAS mapped onto an existing type via a disclosed judgment
 * call, not a new type: "Player 6 said that people should not vote against
 * a Commissioner" is encoded as DefendAction{actor:"6", target:"5"} - the
 * only Commissioner claimant on the table at that point was player 5, and
 * the statement's clear public function is arguing against that specific
 * elimination, which is exactly what DefendAction represents. Flagged here
 * for the user to correct if this reading is wrong.
 *
 * "Attacked"/"suspected" (Day 3) is read as SuspectAction, matching game1.ts's
 * precedent (the project has no separate "attack" Evidence type at all -
 * see game1.ts's own doc for why).
 */
export const game2Players = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

export const game2Evidence: Evidence[] = [
  // --- Day 1 (day round 0): "nobody accused/suspected/defended/nominated/voted... only introductions" ---

  // --- Night 1 (night round 1) ---
  { type: "nightResult", round: 1, died: ["1", "4"] },

  // --- Day 2 (day round 1, follows night round 1) ---
  { type: "suspect", round: 1, actor: "3", target: "5" },
  { type: "suspect", round: 1, actor: "3", target: "7" },
  { type: "suspect", round: 1, actor: "3", target: "8" },
  { type: "nominate", round: 1, actor: "3", target: "5" },
  { type: "nominate", round: 1, actor: "5", target: "3" }, // "objected and nominated player 3"
  { type: "selfRoleClaim", round: 1, actor: "5", claim: { kind: "role", role: "commissioner" } }, // 1st claim
  { type: "defend", round: 1, actor: "6", target: "5" }, // see top-of-file doc: disclosed judgment call
  // "7 agreed with player 3" and "8 agreed with player 3": OMITTED - see top-of-file doc.
  // "9 said nothing": no evidence to record.
  // The nomination LIST ("1. player 5, 2. player 3") is just confirmation of
  // the candidates below, not separate evidence.
  { type: "selfRoleClaim", round: 1, actor: "5", claim: { kind: "role", role: "commissioner" } }, // repeated, during the defense/final-statements phase
  // "said they had not checked anyone yet": OMITTED - no Evidence type for a negative investigation report.
  { type: "selfRoleClaim", round: 1, actor: "3", claim: { kind: "role", role: "citizen" } },
  // Player 3's remaining defense statements (doubt about 5's claim, "vote
  // for whoever you want", the warning that 5 "might turn out to be fake"):
  // OMITTED - see top-of-file doc, these are hedges, not definite claims.
  {
    type: "candidateVote",
    round: 1,
    stage: "initial",
    candidates: ["5", "3"], // moderator called 5 first, per the notes
    handsRaised: { "5": ["3", "7", "8", "9"] },
    // No explicit hand recorded for "3" - "2", "5" (the candidate itself),
    // and "6" abstain; their votes transfer to the last-called candidate
    // ("3") by the existing deterministic abstention rule.
  },
  { type: "dayElimination", round: 1, eliminated: ["5"] },

  // --- Night 2 (night round 2) ---
  { type: "nightResult", round: 2, died: ["3"] },

  // --- Day 3 (day round 2, follows night round 2) ---
  { type: "suspect", round: 2, actor: "6", target: "7" }, // "attacked/suspected"
  { type: "nominate", round: 2, actor: "6", target: "7" },
  { type: "nominate", round: 2, actor: "7", target: "8" },
  // "Players 8 and 9 did not nominate anyone" / "no new attacks/suspicions
  // during the defense stage": nothing to record.
  {
    type: "candidateVote",
    round: 2,
    stage: "initial",
    candidates: ["7", "8"],
    handsRaised: { "7": ["6", "8", "9", "2"], "8": ["7"] },
    // every living player (2,6,7,8,9) raised a hand for one candidate or the
    // other - no abstainers this round.
  },
  { type: "dayElimination", round: 2, eliminated: ["7"] },

  // "The game ended immediately after this. Mafia won.": NOT encoded - see top-of-file doc.
];

/**
 * Known ground truth, for POST-GAME EVALUATION ONLY - never fed into
 * game2Config, game2Evidence, or any EvidenceContext. Unlike game1's
 * partial ground truth, every player's exact role is stated in the notes,
 * so this is complete for all 9 players.
 */
export const game2GroundTruth: GroundTruthRoles = {
  roles: {
    "1": "citizen",
    "2": "mafia",
    "3": "citizen",
    "4": "don",
    "5": "commissioner",
    "6": "mafia",
    "7": "citizen",
    "8": "citizen",
    "9": "doctor",
  },
};

/** The full Mafia-team roster, per "Mafia: 2, 6, 4" in the ground truth. */
export const game2MafiaTeam: PlayerId[] = ["2", "4", "6"];

/** Complete team-level ground truth (POST-GAME EVALUATION ONLY), derived from game2MafiaTeam. */
export const game2GroundTruthTeams: GroundTruthTeams = {
  isMafia: Object.fromEntries(game2Players.map((p) => [p, game2MafiaTeam.includes(p)])),
};

/** Confirmed role composition: 1 Don + 2 Mafia + 1 Commissioner + 1 Doctor + 4 Citizens. */
export const game2Config: GameConfig = {
  players: game2Players,
  roles: ["don", "mafia", "mafia", "commissioner", "doctor", "citizen", "citizen", "citizen", "citizen"],
};
