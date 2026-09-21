import { PlayerId } from "../types";
import { AffinityMatrix, affinityBetween } from "./affinity";

/**
 * Greedy agglomerative clustering over the affinity matrix: repeatedly
 * merges the two clusters with the highest average inter-cluster affinity,
 * stopping once no remaining pair has POSITIVE average affinity. This is
 * what makes the team count dynamic rather than fixed at 2 - early game,
 * with little or no signal, most players stay as their own singleton
 * cluster; as cooperation/opposition signals accumulate, clusters merge
 * and the picture naturally consolidates. O(players^3) worst case, trivial
 * for the player counts this game has (<= 20).
 *
 * Returns every cluster, in descending order of size (ties broken by
 * smallest member id) - including singletons, so the caller can decide how
 * to present "not enough data yet" players (see viewModel.ts).
 */
export function detectTeams(players: PlayerId[], matrix: AffinityMatrix): PlayerId[][] {
  let clusters: PlayerId[][] = players.map((p) => [p]);

  function interClusterAffinity(a: PlayerId[], b: PlayerId[]): number {
    let sum = 0;
    let count = 0;
    a.forEach((x) => {
      b.forEach((y) => {
        sum += affinityBetween(matrix, x, y);
        count += 1;
      });
    });
    return count === 0 ? 0 : sum / count;
  }

  for (;;) {
    let bestPair: [number, number] | null = null;
    let bestScore = 0; // only merge on a genuinely positive signal
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const score = interClusterAffinity(clusters[i], clusters[j]);
        if (score > bestScore) {
          bestScore = score;
          bestPair = [i, j];
        }
      }
    }
    if (!bestPair) break;
    const [i, j] = bestPair;
    const merged = [...clusters[i], ...clusters[j]];
    clusters = clusters.filter((_, index) => index !== i && index !== j);
    clusters.push(merged);
  }

  return clusters
    .map((cluster) => [...cluster].sort())
    .sort((a, b) => (b.length !== a.length ? b.length - a.length : a[0].localeCompare(b[0])));
}
