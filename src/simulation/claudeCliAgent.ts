import { spawn } from "child_process";
import { AgentResponse, SimulationAgent, SimulationDecisionRequest } from "./types";
import { buildUserPrompt, decisionFromParsedJson } from "./promptBuilder";

/**
 * A SimulationAgent backed by the user's existing Claude subscription via
 * the `claude -p` CLI, instead of an Anthropic API key. No Anthropic SDK
 * dependency, no ANTHROPIC_API_KEY - authentication is whatever this
 * machine's Claude Code login already is. See this milestone's own
 * diagnostic measurements for why `--model`/`--effort low`/
 * CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 are all present: a bare `claude -p` call
 * measured ~$0.08 (invoking Sonnet 5 internally); this configuration
 * measured ~$0.003-0.02 per call, Haiku-only.
 */
export const DEFAULT_CLAUDE_CLI_MODEL_ID = "claude-haiku-4-5-20251001";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeCliAgentOptions {
  model?: string;
  effort?: ClaudeEffort;
  /** Executable name/path - default "claude". Overridable for testing or an alternate install location. */
  claudeBinary?: string;
  /** Safety cap in case the subprocess hangs. Default 60s - generous relative to the 1-12s observed in diagnostics. */
  timeoutMs?: number;
  /** Injectable for tests, so no test ever invokes the real CLI. Defaults to node:child_process's spawn. */
  spawnFn?: typeof spawn;
}

interface ClaudePrintUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ClaudePrintEnvelope {
  result: string;
  is_error?: boolean;
  subtype?: string;
  total_cost_usd?: number;
  usage?: ClaudePrintUsage;
}

/**
 * A permissive JSON Schema per request kind, passed to `claude -p
 * --json-schema` so the CLI validates structural shape itself. Deliberately
 * loose (no `oneOf`/`const`/`additionalProperties: false`) since the CLI's
 * schema-validator support is not something this project controls or has
 * fully characterized - the real legality/shape guarantees still come from
 * decisionFromParsedJson (structural) and validation.ts (semantic), exactly
 * as for every other provider. `reason` is included everywhere since
 * SimulationDecision's own types already accept (and ignore) it.
 */
function jsonSchemaFor(request: SimulationDecisionRequest): object {
  switch (request.kind) {
    case "dayAction":
      return {
        type: "object",
        properties: {
          suspect: { type: "array", items: { type: "string" } },
          defend: { type: "array", items: { type: "string" } },
          nominate: { type: "string" },
          roleClaim: {
            type: "object",
            properties: { kind: { type: "string" }, role: { type: "string" }, group: { type: "string" } },
          },
          investigationClaim: {
            type: "object",
            properties: {
              target: { type: "string" },
              mechanic: { type: "string" },
              result: { type: "boolean" },
              night: { type: "number" },
            },
          },
          reason: { type: "string" },
        },
      };
    case "vote":
      return {
        type: "object",
        properties: { candidate: { type: ["string", "null"] }, reason: { type: "string" } },
        required: ["candidate"],
      };
    case "keepOrEliminateVote":
      return {
        type: "object",
        properties: { eliminate: { type: "boolean" }, reason: { type: "string" } },
        required: ["eliminate"],
      };
    default:
      return {
        type: "object",
        properties: { target: { type: "string" }, reason: { type: "string" } },
        required: ["target"],
      };
  }
}

/** Strips a ```json ... ``` (or plain ```) fence if present, otherwise returns the text unchanged. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1].trim() : trimmed;
}

function runClaudePrint(
  claudeBinary: string,
  args: string[],
  stdinInput: string,
  timeoutMs: number,
  spawnImpl: typeof spawn
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Never pass ANTHROPIC_API_KEY through, regardless of whether the parent
    // process happens to have one set - this provider is subscription-auth only.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = "1";

    const child = spawnImpl(claudeBinary, args, { env });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`claude -p timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude -p exited with code ${code}: ${(stderr || stdout).trim()}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin?.write(stdinInput);
    child.stdin?.end();
  });
}

export function createClaudeCliAgent(options: ClaudeCliAgentOptions = {}): SimulationAgent {
  const model = options.model ?? DEFAULT_CLAUDE_CLI_MODEL_ID;
  const effort = options.effort ?? "low";
  const claudeBinary = options.claudeBinary ?? "claude";
  const timeoutMs = options.timeoutMs ?? 60_000;
  const spawnImpl = options.spawnFn ?? spawn;

  return {
    async decide(request: SimulationDecisionRequest): Promise<AgentResponse> {
      const prompt = buildUserPrompt(request);
      const schema = JSON.stringify(jsonSchemaFor(request));

      const args = ["-p", "--model", model, "--effort", effort, "--output-format", "json", "--json-schema", schema];

      const stdout = await runClaudePrint(claudeBinary, args, prompt, timeoutMs, spawnImpl);

      let envelope: ClaudePrintEnvelope;
      try {
        envelope = JSON.parse(stdout);
      } catch (err) {
        throw new Error(`claude -p returned non-JSON output: ${String(err)}`);
      }

      if (envelope.is_error || (envelope.subtype !== undefined && envelope.subtype !== "success")) {
        throw new Error(`claude -p reported an error (subtype="${envelope.subtype}"): ${envelope.result}`);
      }

      const parsed = JSON.parse(stripCodeFence(envelope.result));
      const decision = decisionFromParsedJson(request, parsed);

      return {
        decision,
        usage: {
          inputTokens: envelope.usage?.input_tokens,
          outputTokens: envelope.usage?.output_tokens,
          cacheCreationInputTokens: envelope.usage?.cache_creation_input_tokens,
          cacheReadInputTokens: envelope.usage?.cache_read_input_tokens,
          costUsd: envelope.total_cost_usd,
        },
      };
    },
  };
}
