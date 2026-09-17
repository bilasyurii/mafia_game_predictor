import { AliveState, PlayerId, World } from "./types";
import { hasMechanic, RoleRegistry } from "./roles";

/**
 * Deterministic game-state/win-condition reasoning over a SPECIFIC hidden
 * World. This is NOT Bayesian evidence: nothing here reads or writes a
 * World's `probability`, nothing here is wired into updateProbabilities or
 * any LikelihoodModel, and it never touches the posterior. It only answers
 * "given that this world's role assignment were true, and this alive
 * state, what does that world's game state currently look like".
 *
 * "Town wins when all Mafia are eliminated" and "Mafia wins when Town has
 * no possible winning path" are the two rules given. getGameOutcome
 * applies ONLY the part of these rules that is a rule-guaranteed fact
 * about the CURRENT alive state, not a prediction about how the rest of
 * the game will go:
 *  - mafiaAlive === 0 unconditionally means Town has already won.
 *  - townAlive === 0 unconditionally means Mafia has already won - this is
 *    not the naive `mafiaAlive >= townAlive` headcount check; it is the
 *    trivial special case of "Town has no possible winning path" that
 *    needs no assumption about anyone's future behavior at all (with zero
 *    Town members, no sequence of actions, however fortunate, can ever
 *    produce a Town win).
 *  - Otherwise: "ongoing". Nothing in the mechanical rules (resolveNight,
 *    voting.ts) guarantees that no further Mafia elimination is possible
 *    while both teams still have living members - voting alone can always
 *    mechanically remove anyone - so asserting "Mafia has already won"
 *    beyond the townAlive === 0 case would require assuming a SPECIFIC
 *    future strategy, which is not a rule. See
 *    canTownForceWinUnderOptimalPlay for that separate, explicitly
 *    optional, non-authoritative strategic model - it is never called
 *    from here.
 */
export type GameOutcome = "townWon" | "mafiaWon" | "ongoing";

/**
 * The only state canTownForceWinUnderOptimalPlay's search needs: how many
 * living players are on each team, and whether the two mechanics that can
 * independently change a team's count while the game continues (Doctor's
 * protect, which can prevent a Town death; Commissioner's checkIsMafia,
 * which can cause a Mafia death) still have a living holder. Which
 * SPECIFIC player holds which role, or which specific players are already
 * dead, never matters beyond these four numbers - the search is symmetric
 * in every other way.
 *
 * Neutral-team roles are out of scope: none exist in defaultRoleRegistry,
 * and this module makes no claim about how a future neutral role would
 * affect either team's win condition.
 *
 * extractTeamCounts always produces an internally consistent TeamCounts
 * (doctorAlive/commissionerAlive true implies townAlive counts them, so
 * e.g. both true implies townAlive >= 2). canTownForceWinUnderOptimalPlay
 * itself does not validate this - it is a precondition on any TeamCounts
 * passed to it directly (as several of this module's own tests do, to
 * exercise the search exhaustively over small counts).
 */
export interface TeamCounts {
  mafiaAlive: number;
  townAlive: number;
  doctorAlive: boolean;
  commissionerAlive: boolean;
}

/**
 * Extracts TeamCounts from a specific World + AliveState. Never reads
 * `world.probability` and never consults the Bayesian posterior - this is
 * why getGameOutcome takes a single World, not a World[]; see
 * getPossibleWorlds for classifying an entire posterior.
 */
export function extractTeamCounts(
  world: World,
  alive: AliveState,
  registry: RoleRegistry
): TeamCounts {
  const players = Object.keys(world.roles);
  const isAlive = (p: PlayerId) => alive[p] === true;

  const mafiaAlive = players.filter(
    (p) => isAlive(p) && registry[world.roles[p]].team === "mafia"
  ).length;
  const townAlive = players.filter(
    (p) => isAlive(p) && registry[world.roles[p]].team === "town"
  ).length;
  const doctorAlive = players.some(
    (p) => isAlive(p) && hasMechanic(registry, world.roles[p], "protect")
  );
  const commissionerAlive = players.some(
    (p) => isAlive(p) && hasMechanic(registry, world.roles[p], "checkIsMafia")
  );

  return { mafiaAlive, townAlive, doctorAlive, commissionerAlive };
}

function sameCounts(a: TeamCounts, b: TeamCounts): boolean {
  return (
    a.mafiaAlive === b.mafiaAlive &&
    a.townAlive === b.townAlive &&
    a.doctorAlive === b.doctorAlive &&
    a.commissionerAlive === b.commissionerAlive
  );
}

/**
 * NOT a rule. This is the internal transition of ONE particular, explicitly
 * named, optional strategic model (see canTownForceWinUnderOptimalPlay) -
 * never a deterministic consequence of the game's actual rules, and never
 * called from getGameOutcome or getPossibleWorlds. Every "assumption"
 * documented below is a strategic/behavioral choice this model makes, not
 * something resolveNight or voting.ts guarantees.
 *
 * One full round (a night, then the following day), as a single
 * deterministic state transition rather than a branching search: every
 * actor's move is already resolved to its best interest before this
 * function runs, so there is nothing left to branch on. This is
 * deliberately narrower than simulating real resolveNight/voting.ts
 * mechanics play-by-play:
 *
 *  - The Doctor (if alive) is assumed to always successfully protect
 *    whichever target the Mafia would otherwise kill, fully blocking that
 *    night's kill. The real no-consecutive-repeat-target constraint (see
 *    night.ts) is NOT modeled - matches the same kind of v1 simplification
 *    already used by nightResultLikelihood.ts's marginalization.
 *  - The Commissioner (if alive, and a Mafia killer is alive to check
 *    against) is assumed to always correctly identify and kill an actual
 *    Mafia member that same night. Real information-gathering (which
 *    target to check, and getting it right) is not modeled.
 *  - Per resolveNight's actual mechanics, the Commissioner's check-and-kill
 *    and the Mafia's kill both resolve from the SAME start-of-night alive
 *    state, so one is never preventable by the other landing on the same
 *    player this same night - this function mirrors that exactly.
 *  - The day phase is modeled via voting.ts's own final, decisive
 *    team-vs-team mechanic (resolveKeepOrEliminateVote: an elimination
 *    requires strictly outnumbering the "keep" side; an exact tie keeps
 *    everyone) as a bounded stand-in for the whole day-voting process.
 *    Multi-candidate nomination/plurality dynamics (resolveCandidateVote)
 *    are NOT modeled - inventing who gets nominated and how votes split
 *    among 3+ candidates would require behavioral assumptions this project
 *    does not make.
 *  - Whichever side is adversarially eliminating a player from the other
 *    team (Mafia's night kill when the Doctor can't block it; Mafia's
 *    day-vote win) is assumed to target the more mechanically dangerous
 *    remaining role first - Commissioner, then Doctor - before a generic
 *    teammate, since this function is answering a worst-case-for-Town
 *    question (see canTownForceWinUnderOptimalPlay).
 */
function stepRound(state: TeamCounts): TeamCounts {
  let { mafiaAlive, townAlive, doctorAlive, commissionerAlive } = state;
  const mafiaHasKiller = mafiaAlive >= 1;

  // --- Night ---
  if (commissionerAlive && mafiaHasKiller) {
    mafiaAlive -= 1;
  }
  if (mafiaHasKiller && !doctorAlive) {
    townAlive -= 1;
    if (commissionerAlive) {
      commissionerAlive = false;
    }
  }

  // --- Day ---
  if (mafiaAlive > 0 && townAlive > 0) {
    if (townAlive > mafiaAlive) {
      mafiaAlive -= 1;
    } else if (mafiaAlive > townAlive) {
      townAlive -= 1;
      if (commissionerAlive) {
        commissionerAlive = false;
      } else if (doctorAlive) {
        doctorAlive = false;
      }
    }
    // an exact tie forces "keepAll" - nobody is eliminated this day.
  }

  return { mafiaAlive, townAlive, doctorAlive, commissionerAlive };
}

/**
 * NOT a rule-derived fact, and NOT called by getGameOutcome or
 * getPossibleWorlds. This is one particular, explicitly named, optional
 * strategic model - analogous to how ActionModel is a separate, pluggable,
 * explicitly-uncalibrated-by-default interface that the Bayesian core
 * never assumes on its own. It answers: under stepRound's documented
 * strategic assumptions (perfect Doctor prediction, perfect Commissioner
 * identification, a fully-informed adversarial Mafia, and day voting
 * modeled as a two-bloc majority battle), could Town force mafiaAlive to 0
 * before townAlive reaches 0?
 *
 * This is a genuine "what would happen under this specific play style"
 * forecast, not a claim about what the rules alone guarantee. Callers that
 * want a rule-guaranteed answer should use getGameOutcome instead, which
 * never calls this function.
 *
 * Terminates because the state is finite and every round is
 * weakly-decreasing (kills only remove players; doctorAlive/
 * commissionerAlive only ever go from true to false) - so a round either
 * makes strict progress toward a terminal count, or it changes nothing at
 * all, in which case it will change nothing forever after (stepRound is a
 * pure function of its input), which this function detects directly as a
 * permanent stalemate, returning false (this model predicts Town never
 * forces mafiaAlive to 0), even though nobody's count literally reaches 0
 * within this search.
 */
export function canTownForceWinUnderOptimalPlay(counts: TeamCounts): boolean {
  let state = counts;
  for (;;) {
    if (state.mafiaAlive === 0) return true;
    if (state.townAlive === 0) return false;
    const next = stepRound(state);
    if (sameCounts(next, state)) return false;
    state = next;
  }
}

/**
 * The smallest deterministic, rule-guaranteed API for this milestone's
 * three questions - see this module's top-of-file doc comment for why only
 * the two zero-count cases are rule-guaranteed, and why every other state
 * is honestly "ongoing" rather than a predicted "mafiaWon":
 *  1. Has Town already won -> "townWon" (mafiaAlive === 0; see below for
 *     the deliberate tie-break on a simultaneous wipe).
 *  2. Has Mafia already won -> "mafiaWon" (townAlive === 0 only).
 *  3. Is the game still ongoing -> "ongoing" (neither of the above).
 *
 * Deliberately does NOT call canTownForceWinUnderOptimalPlay - that
 * function is a separate, optional, non-authoritative strategic forecast,
 * never something this rule-guaranteed API assumes on a caller's behalf.
 * A caller who wants that forecast calls it explicitly, the same way a
 * caller who wants a specific ActionModel passes one explicitly.
 *
 * If mafiaAlive and townAlive are BOTH 0 in the given alive state (a
 * mutual last-player kill - a real, mechanically reachable resolveNight
 * outcome in a 2-living-player endgame, not a hypothetical), this returns
 * "townWon": a literal reading of "Town wins when all Mafia are
 * eliminated" has no exception for Town also being wiped out, and
 * mafiaAlive === 0 is checked first. Documented explicitly since it is not
 * obvious from the rule text alone.
 *
 * Deviates from the sketched `getGameOutcome(world, alive, history,
 * config, roles)` signature: `history`/`config` are dropped because this
 * project already has a dedicated, single place that turns history into
 * AliveState (facts.ts's getAliveStateAt/getAliveStateForEvidence) -
 * duplicating that here would be redundant and could drift out of sync
 * with it. Callers derive `alive` there first, exactly as
 * processEvidence.ts already does for likelihood scoring.
 */
export function getGameOutcome(
  world: World,
  alive: AliveState,
  registry: RoleRegistry
): GameOutcome {
  const counts = extractTeamCounts(world, alive, registry);
  if (counts.mafiaAlive === 0) return "townWon";
  if (counts.townAlive === 0) return "mafiaWon";
  return "ongoing";
}

/** getGameOutcome's three outcomes, applied across a whole set of worlds. */
export interface PossibleWorlds {
  townWon: World[];
  mafiaWon: World[];
  ongoing: World[];
}

/**
 * Classifies every world in `worlds` (e.g. an EvidenceStep's `posterior`,
 * or generateWorlds's raw output) by getGameOutcome. Never reads
 * `world.probability` for anything other than filtering: a world the
 * Bayesian layer has already zeroed out (mechanically impossible given the
 * observed public history - see nightResultLikelihood.ts, which returns
 * exactly 0 for an unreachable `died` set) is excluded from every bucket,
 * rather than being reported as "ongoing". Never mutates `worlds` or any
 * world's `probability`.
 */
export function getPossibleWorlds(
  worlds: World[],
  alive: AliveState,
  registry: RoleRegistry
): PossibleWorlds {
  const result: PossibleWorlds = { townWon: [], mafiaWon: [], ongoing: [] };

  worlds
    .filter((world) => world.probability > 0)
    .forEach((world) => {
      result[getGameOutcome(world, alive, registry)].push(world);
    });

  return result;
}
