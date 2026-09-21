import { GameEvent, RoleExpression } from "./types";

/** Human-readable one-line description of a GameEvent, for the UI's action log / history. */
export function describeGameEvent(event: GameEvent): string {
  switch (event.type) {
    case "selfRoleClaim":
      return `${event.actor} claims ${describeExpression(event.claim)}`;
    case "roleAssertion":
      return `${event.actor} asserts ${event.target} is ${describeExpression(event.claim)}`;
    case "investigationReport":
      return `${event.actor} reports ${event.mechanic} on ${event.target} = ${event.result ? "YES" : "NO"}`;
    case "suspect":
      return `${event.actor} suspects ${event.target}${describeIntensity(event.intensity)}`;
    case "defend":
      return `${event.actor} defends ${event.target}${describeIntensity(event.intensity)}`;
    case "nominate":
      return `${event.actor} nominates ${event.target}${describeIntensity(event.intensity)}`;
    case "candidateVote":
      return `vote (${event.stage}): candidates=[${event.candidates.join(",")}]`;
    case "keepOrEliminateVote":
      return `keep/eliminate vote: candidates=[${event.candidates.join(",")}]`;
    case "nightResult":
      return `night ${event.round}: died=[${event.died.join(",")}]`;
    case "dayElimination":
      return `day ${event.round} elimination: [${event.eliminated.join(",")}]`;
  }
}

function describeExpression(expr: RoleExpression): string {
  return expr.kind === "role" ? expr.role : `<${expr.group}>`;
}

/** " (★★★☆☆)" for a non-default intensity - omitted entirely at the 3-star default to keep the common case uncluttered. */
function describeIntensity(intensity: number | undefined): string {
  if (intensity === undefined || intensity === 3) return "";
  return ` (${"★".repeat(intensity)}${"☆".repeat(5 - intensity)})`;
}
