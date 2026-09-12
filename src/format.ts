/** Formats a 0-1 probability as a percentage string, e.g. 0.2456 -> "24.56%". */
export function formatProbability(probability: number): string {
  return `${(probability * 100).toFixed(2)}%`;
}
