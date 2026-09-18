import { AgentResponse, SimulationAgent, SimulationDecisionRequest } from "./types";
import { buildUserPrompt, parseDecisionText, SIMULATION_SYSTEM_PROMPT } from "./promptBuilder";

/**
 * Cheapest currently-available Haiku-class model on the Claude API, verified
 * against Anthropic's own model-overview docs at the time this was written
 * (Claude Haiku 3.5 is retired except on Bedrock/Google Cloud). Exposed as a
 * named default, never hardcoded elsewhere - a caller (or the
 * SIMULATION_MODEL_ID env var, see runOneSyntheticGame.ts) can override it
 * without touching this file.
 */
export const DEFAULT_HAIKU_MODEL_ID = "claude-haiku-4-5-20251001";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";

export interface HaikuAgentOptions {
  /** Never hardcode a real key - always sourced from an environment variable by the caller. */
  apiKey: string;
  model?: string;
  maxTokens?: number;
}

interface AnthropicMessageResponse {
  content: { type: string; text?: string }[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * A SimulationAgent backed by the real Claude API - no SDK dependency (none
 * was already installed in this project; a single JSON-response endpoint
 * doesn't need one, and this avoids adding a dependency for one call type).
 * Uses a short assistant-turn prefill of "{" (see promptBuilder.ts) instead
 * of tool-calling, since tool-use adds several hundred fixed tokens of
 * system-prompt overhead per call - a meaningful fraction of a decision this
 * small - for no benefit here.
 */
export function createHaikuAgent(options: HaikuAgentOptions): SimulationAgent {
  const model = options.model ?? DEFAULT_HAIKU_MODEL_ID;
  const maxTokens = options.maxTokens ?? 300;

  return {
    async decide(request: SimulationDecisionRequest): Promise<AgentResponse> {
      const userPrompt = buildUserPrompt(request);

      const res = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": ANTHROPIC_API_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: SIMULATION_SYSTEM_PROMPT,
          messages: [
            { role: "user", content: userPrompt },
            { role: "assistant", content: "{" },
          ],
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Anthropic API error ${res.status}: ${body}`);
      }

      const data = (await res.json()) as AnthropicMessageResponse;
      const rawText = data.content.find((block) => block.type === "text")?.text ?? "";
      const decision = parseDecisionText(request, rawText);

      return {
        decision,
        usage: {
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
          cacheCreationInputTokens: data.usage.cache_creation_input_tokens,
          cacheReadInputTokens: data.usage.cache_read_input_tokens,
        },
      };
    },
  };
}
