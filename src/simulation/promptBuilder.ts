import { formatPromptText } from "./playerView";
import { InvestigationClaimInput, SimulationDecision, SimulationDecisionRequest } from "./types";

/**
 * Turns a SimulationDecisionRequest into the exact text sent to a real LLM
 * provider, and parses a real provider's raw text response back into a
 * SimulationDecision. Kept separate from haikuAgent.ts so the prompt/parse
 * logic has no dependency on any specific HTTP client or SDK.
 *
 * Deliberately minimal per this milestone's cost-conscious design: the
 * system prompt carries only the fixed behavioral instruction (no full
 * rulebook), and schemaFor() below sends only the JSON schema and rules
 * relevant to THIS SPECIFIC decision - a citizen's day-turn prompt never
 * explains night mechanics, a vote prompt never re-explains nomination, etc.
 */
export const SIMULATION_SYSTEM_PROMPT =
  "You are simulating one player's decision in a game of Mafia (Werewolf). " +
  "Play your character according to the Mafia rules. Make decisions using only " +
  "information available to your character. Do not assume knowledge your character " +
  "does not have. Choose the action you would naturally take given your role and the " +
  "public game history. Respond with ONLY a single JSON object matching the requested " +
  "schema - no markdown formatting, no code fences, and no explanation before or after it.";

function schemaFor(request: SimulationDecisionRequest): string {
  switch (request.kind) {
    case "dayAction":
      return (
        `It is your turn to speak on day ${request.view.phase.round}. You may optionally: ` +
        `suspect one or more alive players, defend one or more alive players, nominate at ` +
        `most one alive player for elimination, claim your own role or team, or report an ` +
        `investigation result (true or false, truthful or not, as you choose). ` +
        `Respond with JSON: {"suspect"?: string[], "defend"?: string[], "nominate"?: string, ` +
        `"roleClaim"?: {"kind":"role","role":"don"|"mafia"|"citizen"|"doctor"|"commissioner"} ` +
        `| {"kind":"group","group":"mafia"|"town"|"activeTown"}, "investigationClaim"?: ` +
        `{"target": string, "mechanic": "checkIsMafia"|"checkIsCommissioner", "result": boolean, ` +
        `"night"?: number}}. Omit any field you don't use - an empty {} is a legal "pass" turn.`
      );
    case "vote": {
      const label = request.stage === "revote" ? "a revote (the previous vote tied)" : "a vote";
      return (
        `This is ${label}. Candidates: [${request.candidates.join(", ")}]. Choose one candidate ` +
        `to raise your hand for, or abstain. Respond with JSON: {"candidate": "<playerId>"} or ` +
        `{"candidate": null} to abstain.`
      );
    }
    case "keepOrEliminateVote":
      return (
        `The vote tied twice in a row. Decide whether to eliminate ALL of ` +
        `[${request.candidates.join(", ")}] or keep them all. ` +
        `Respond with JSON: {"eliminate": true} or {"eliminate": false}.`
      );
    case "mafiaKill":
      return (
        "It is night. As part of the Mafia, choose one living player to target for the kill. " +
        'Respond with JSON: {"target": "<playerId>"}.'
      );
    case "donCheck":
      return (
        "It is night. As the Don, choose one living player to check (you learn only whether " +
        'they are the Commissioner). Respond with JSON: {"target": "<playerId>"}.'
      );
    case "commissionerCheck":
      return (
        "It is night. As the Commissioner, choose one living player to check (you learn only " +
        'whether they are Mafia). Respond with JSON: {"target": "<playerId>"}.'
      );
    case "doctorSave":
      return (
        "It is night. As the Doctor, choose one living player to protect (never the same " +
        'player as your immediately preceding night). Respond with JSON: {"target": "<playerId>"}.'
      );
  }
}

export function buildUserPrompt(request: SimulationDecisionRequest): string {
  return `${formatPromptText(request.view)}\n\n${schemaFor(request)}`;
}

/**
 * The raw completion text is expected to be everything AFTER the "{" this
 * project's providers prefill as the assistant turn (see haikuAgent.ts) - a
 * standard low-overhead way to bias a plain-prompted model toward pure JSON
 * without paying tool-use's fixed per-call token overhead. Strips a trailing
 * code fence if the model added one anyway, despite the system prompt asking
 * it not to.
 */
function extractJsonText(rawCompletionAfterPrefill: string): string {
  let text = "{" + rawCompletionAfterPrefill;
  const fenceIndex = text.indexOf("```");
  if (fenceIndex !== -1) text = text.slice(0, fenceIndex);
  return text.trim();
}

function toStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map((v) => String(v)) : undefined;
}

function normalizeInvestigationClaim(raw: any): InvestigationClaimInput {
  return {
    target: String(raw.target),
    mechanic: raw.mechanic,
    result: Boolean(raw.result),
    ...(raw.night !== undefined && raw.night !== null ? { night: Number(raw.night) } : {}),
  };
}

/**
 * Structural parsing only - turns whatever JSON-shaped object the provider
 * returned into a typed SimulationDecision. Throws on malformed JSON or a
 * clearly wrong shape (e.g. a missing required `target`); driver.ts's
 * retry loop treats that identically to a semantically-invalid decision.
 * Never validates game-rule LEGALITY here (alive targets, known candidates,
 * etc.) - that stays exclusively validation.ts's job.
 */
export function parseDecisionText(request: SimulationDecisionRequest, rawCompletionAfterPrefill: string): SimulationDecision {
  return decisionFromParsedJson(request, JSON.parse(extractJsonText(rawCompletionAfterPrefill)));
}

/**
 * The provider-agnostic half of parseDecisionText: given an ALREADY-PARSED
 * JSON value (however the provider got there - a "{"-prefilled completion
 * for the Messages API, a --json-schema-validated `result` for claude -p,
 * or anything else), normalizes it into a typed SimulationDecision. Kept
 * separate so every provider shares this one normalization path instead of
 * each reimplementing its own field-by-field parsing.
 */
export function decisionFromParsedJson(request: SimulationDecisionRequest, parsed: any): SimulationDecision {
  if (request.kind === "dayAction") {
    const suspect = toStringArray(parsed.suspect);
    const defend = toStringArray(parsed.defend);
    return {
      type: "dayAction",
      ...(suspect ? { suspect } : {}),
      ...(defend ? { defend } : {}),
      ...(parsed.nominate !== undefined && parsed.nominate !== null ? { nominate: String(parsed.nominate) } : {}),
      ...(parsed.roleClaim ? { roleClaim: parsed.roleClaim } : {}),
      ...(parsed.investigationClaim ? { investigationClaim: normalizeInvestigationClaim(parsed.investigationClaim) } : {}),
    };
  }
  if (request.kind === "vote") {
    return {
      type: "vote",
      candidate: parsed.candidate === undefined || parsed.candidate === null ? null : String(parsed.candidate),
    };
  }
  if (request.kind === "keepOrEliminateVote") {
    return { type: "keepOrEliminate", eliminate: Boolean(parsed.eliminate) };
  }
  if (parsed.target === undefined || parsed.target === null) {
    throw new Error(`decision for "${request.kind}" is missing a "target"`);
  }
  return { type: "targetChoice", target: String(parsed.target) };
}
