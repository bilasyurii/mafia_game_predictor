import { GameEvent, PlayerId } from "../types";

/**
 * The relationship-based replacement for the old Bayesian probability
 * engine (see this app's redesign notes). Nothing here computes a
 * probability or a likelihood - it produces a cheap, symmetric pairwise
 * "affinity" score per player pair, positive for cooperation signals and
 * negative for opposition signals, purely from already-recorded GameEvents.
 * O(players^2 + events^2) worst case, trivial for a phone even at 20
 * players and a few hundred events - unlike world-enumeration, there is no
 * factorial blowup anywhere in this file.
 *
 * What moves the score (from real gameplay heuristics, not a formula
 * derived from synthetic data):
 *  - `defend(actor, target)`: a direct cooperation signal between them.
 *  - `suspect(actor, target)` / `nominate(actor, target)`: a direct
 *    opposition signal between them.
 *
 *    Each of these three carries its own `intensity` (1-5 stars, 3 =
 *    normal/default - see types.ts's ActionIntensity), scaled linearly
 *    around that default: a barely-there "I have a slight feeling" 1-star
 *    suspicion moves the score a third as much as normal, a certain 5-star
 *    one moves it two-thirds more. This only scales the DIRECT bump between
 *    actor and target - the shared-target bonus below stays independent of
 *    any single action's confidence, since it's the co-occurrence pattern
 *    itself that's the signal there, not how sure either player sounded.
 *  - Voting FOR a candidate (raising a hand for them, in either vote type)
 *    is itself an opposition signal toward that candidate - you're voting
 *    to potentially remove them.
 *  - Two players targeting the SAME third party (suspecting, nominating, or
 *    voting for the same person) IN THE SAME ROUND is a cooperation signal
 *    BETWEEN THOSE TWO - not about the shared target. This is one of the
 *    most useful signals in practice: mafia members tend to pile onto the
 *    same citizen without coordinating explicitly, and citizens who happen
 *    to agree on a genuine suspect show the same pattern.
 *
 *    Its bonus is split across however many players shared that target that
 *    round, NOT flat per pair - a near-unanimous vote (everyone piling onto
 *    the one obviously-losing candidate, including mafia voting along to
 *    avoid standing out) is close to zero information and must not swamp
 *    every pair's score, while two players uniquely converging on the same
 *    target while the rest of the table disagrees is real signal and keeps
 *    close to the full bonus. Without this, a single late-game unanimous
 *    vote could bump literally every pair of players at once and wash out
 *    everything more selective recorded earlier in the game.
 *
 * selfRoleClaim/roleAssertion/investigationReport/nightResult/
 * dayElimination never move the score - claims can be lies, and deaths
 * carry no actor. They're still shown in the UI (event history, arrows for
 * the behavioral ones), just not counted as relationship signal.
 *
 * Recency: a player's read of someone can genuinely change over the game -
 * they suspect someone early on, then come around and defend them once
 * more evidence comes in. Every event's contribution is weighted down by
 * ROUND_DECAY per round of age (relative to the most recent round seen in
 * the log), so newer events dominate the net score while older ones still
 * pull it partway, rather than either staying flat forever or being wiped
 * out the instant a newer, contradicting signal shows up. Because the
 * whole matrix is always recomputed from scratch from `events` (nothing
 * here is persisted or updated incrementally - see this app's own notes),
 * this age-based weighting is just the closed-form way to blend "previous
 * relation" and "new relation" without carrying any extra state around.
 */

/** Each event's contribution shrinks by this factor per round of age relative to the most recent round in the log - e.g. 0.8 means an event 5 rounds old still counts for 0.8^5 ≈ 33% of its original weight. */
export const ROUND_DECAY = 0.8;

export const AFFINITY_WEIGHTS = {
  /** A defends B. */
  defend: 3,
  /** A suspects/nominates B, or A raises a hand for B as a candidate/to eliminate B. */
  directOpposition: -3,
  /**
   * Total cooperation credit shared among every pair of players who
   * independently targeted (suspected/nominated/voted for) the same third
   * player in the same round - split evenly across however many pairs that
   * group actually has (see this file's own doc), so a 2-player
   * coincidence gets the full weight and a near-unanimous vote gets almost
   * none.
   */
  sharedTarget: 1,
};

export type AffinityMatrix = Map<PlayerId, Map<PlayerId, number>>;

function bump(matrix: AffinityMatrix, a: PlayerId, b: PlayerId, amount: number): void {
  if (a === b) return; // no self-affinity
  [
    [a, b],
    [b, a],
  ].forEach(([x, y]) => {
    const row = matrix.get(x) ?? new Map<PlayerId, number>();
    row.set(y, (row.get(y) ?? 0) + amount);
    matrix.set(x, row);
  });
}

export function affinityBetween(matrix: AffinityMatrix, a: PlayerId, b: PlayerId): number {
  if (a === b) return 0;
  return matrix.get(a)?.get(b) ?? 0;
}

interface TargetGroup {
  round: number;
  actors: Set<PlayerId>;
}

/** Keyed by `${target}#${round}` - keeps two players who happened to target the same eventual target in UNRELATED rounds from being pooled into one giant "coordinated" group with everyone else who ever targeted that player over the course of the whole game. */
function recordTargeting(targetedBy: Map<string, TargetGroup>, target: PlayerId, round: number, actor: PlayerId): void {
  const key = `${target}#${round}`;
  const group = targetedBy.get(key) ?? { round, actors: new Set<PlayerId>() };
  group.actors.add(actor);
  targetedBy.set(key, group);
}

/** How much of an event's raw weight still counts, `round` rounds before the most recent round seen in the log - see this file's own "Recency" doc. */
function decayFor(round: number, latestRound: number): number {
  const age = Math.max(0, latestRound - round);
  return Math.pow(ROUND_DECAY, age);
}

/** A missing intensity (an event recorded before this existed) is treated as the default, 3-star strength - see types.ts's ActionIntensity. */
export const DEFAULT_INTENSITY = 3;

/** Scales a suspect/defend/nominate action's direct bump by how confidently it was made, linearly around the 3-star default (1 star = 1/3 weight, 5 stars = 5/3 weight). */
function intensityMultiplier(intensity: number | undefined): number {
  return (intensity ?? DEFAULT_INTENSITY) / DEFAULT_INTENSITY;
}

export function computeAffinityMatrix(players: PlayerId[], events: GameEvent[]): AffinityMatrix {
  const matrix: AffinityMatrix = new Map(players.map((p) => [p, new Map<PlayerId, number>()]));
  /** (target, round) -> every distinct player who suspected/nominated/voted for them that round - used for the shared-target bonus. */
  const targetedBy = new Map<string, TargetGroup>();
  const latestRound = events.reduce((max, e) => Math.max(max, e.round), 0);

  events.forEach((event) => {
    const decay = decayFor(event.round, latestRound);
    if (event.type === "defend") {
      bump(matrix, event.actor, event.target, AFFINITY_WEIGHTS.defend * decay * intensityMultiplier(event.intensity));
    } else if (event.type === "suspect" || event.type === "nominate") {
      bump(matrix, event.actor, event.target, AFFINITY_WEIGHTS.directOpposition * decay * intensityMultiplier(event.intensity));
      recordTargeting(targetedBy, event.target, event.round, event.actor);
    } else if (event.type === "candidateVote") {
      event.candidates.forEach((candidate) => {
        const voters = event.handsRaised[candidate] ?? [];
        voters.forEach((voter) => {
          bump(matrix, voter, candidate, AFFINITY_WEIGHTS.directOpposition * decay);
          // co-voters for this candidate get their shared-target bonus below,
          // via the single targetedBy pass shared with suspect/nominate -
          // recording it here too would double-count it.
          recordTargeting(targetedBy, candidate, event.round, voter);
        });
      });
    } else if (event.type === "keepOrEliminateVote") {
      event.eliminateHands.forEach((voter) => {
        event.candidates.forEach((candidate) => {
          bump(matrix, voter, candidate, AFFINITY_WEIGHTS.directOpposition * decay);
        });
      });
    }
  });

  // Shared-target bonus: every pair of distinct players who targeted the
  // same person in the same round (via suspect/nominate/candidateVote hand)
  // splits a FIXED total bonus across however many pairs that group has -
  // a 2-player group gets the full weight per pair, a near-unanimous group
  // gets almost none per pair (see this file's own doc for why) - then
  // that whole group's contribution decays with its round's age, same as
  // every other signal.
  targetedBy.forEach(({ round, actors }) => {
    const list = [...actors];
    const pairCount = (list.length * (list.length - 1)) / 2;
    if (pairCount === 0) return;
    const perPairBonus = (AFFINITY_WEIGHTS.sharedTarget / pairCount) * decayFor(round, latestRound);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        bump(matrix, list[i], list[j], perPairBonus);
      }
    }
  });

  return matrix;
}
