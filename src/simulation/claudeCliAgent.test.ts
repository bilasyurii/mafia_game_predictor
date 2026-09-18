import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createClaudeCliAgent } from "./claudeCliAgent";
import { buildUserPrompt } from "./promptBuilder";
import { PublicGameStateView, SimulationDecisionRequest } from "./types";

/**
 * Tests for the claude-CLI-backed provider. Never invokes the real `claude`
 * binary - this project has no existing convention for tests that call
 * external services, so every test here injects a fake `spawnFn` that
 * behaves like node:child_process's spawn but returns scripted output.
 */

interface FakeSpawnCall {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin: string;
}

function makeFakeSpawn(behavior: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  emitError?: Error;
}) {
  const calls: FakeSpawnCall[] = [];
  const spawnFn = ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let stdinBuffer = "";
    child.stdin = {
      write: (chunk: string) => {
        stdinBuffer += chunk;
      },
      end: () => {
        calls.push({ command, args, env: options.env, stdin: stdinBuffer });
        setImmediate(() => {
          if (behavior.emitError) {
            child.emit("error", behavior.emitError);
            return;
          }
          if (behavior.stdout) child.stdout.emit("data", Buffer.from(behavior.stdout));
          if (behavior.stderr) child.stderr.emit("data", Buffer.from(behavior.stderr));
          child.emit("close", behavior.exitCode ?? 0);
        });
      },
    };
    return child;
  }) as any;
  return { spawnFn, calls };
}

function envelope(result: unknown, usage?: object): string {
  return JSON.stringify({
    result: typeof result === "string" ? result : JSON.stringify(result),
    is_error: false,
    subtype: "success",
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 900,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 17000,
      ...usage,
    },
  });
}

const targetRequest: SimulationDecisionRequest = {
  kind: "mafiaKill",
  player: "2",
  view: {
    self: "2",
    phase: { phase: "night", round: 1 },
    players: ["1", "2", "3"],
    alive: ["1", "2", "3"],
    publicHistory: [],
    private: { role: "mafia", teammates: [] },
  },
};

test("1. successful structured response parsing maps to a typed decision and reported usage", async () => {
  const { spawnFn } = makeFakeSpawn({ stdout: envelope({ target: "3" }) });
  const agent = createClaudeCliAgent({ spawnFn });

  const response = await agent.decide(targetRequest);

  assert.deepEqual(response.decision, { type: "targetChoice", target: "3" });
  assert.equal(response.usage?.inputTokens, 900);
  assert.equal(response.usage?.outputTokens, 20);
  assert.equal(response.usage?.cacheReadInputTokens, 17000);
  assert.equal(response.usage?.costUsd, 0.0123);
});

test("1b. a fenced JSON result (```json ... ```) is still parsed correctly", async () => {
  const fenced = "```json\n" + JSON.stringify({ target: "1" }) + "\n```";
  const { spawnFn } = makeFakeSpawn({ stdout: envelope(fenced) });
  const agent = createClaudeCliAgent({ spawnFn });

  const response = await agent.decide(targetRequest);
  assert.deepEqual(response.decision, { type: "targetChoice", target: "1" });
});

test("2. malformed response handling: non-JSON stdout rejects rather than silently continuing", async () => {
  const { spawnFn } = makeFakeSpawn({ stdout: "not json at all" });
  const agent = createClaudeCliAgent({ spawnFn });
  await assert.rejects(() => agent.decide(targetRequest));
});

test("2b. a process error/non-zero exit rejects with a descriptive error", async () => {
  const { spawnFn } = makeFakeSpawn({ exitCode: 1, stderr: "rate limited" });
  const agent = createClaudeCliAgent({ spawnFn });
  await assert.rejects(() => agent.decide(targetRequest), /rate limited/);
});

test("2c. an is_error/failed-subtype envelope rejects rather than being treated as a decision", async () => {
  const { spawnFn } = makeFakeSpawn({
    stdout: JSON.stringify({ result: "session limit reached", is_error: true, subtype: "error_max_turns" }),
  });
  const agent = createClaudeCliAgent({ spawnFn });
  await assert.rejects(() => agent.decide(targetRequest));
});

test("3. invalid decision handling: a structurally incomplete decision (missing required target) is rejected, not silently repaired", async () => {
  const { spawnFn } = makeFakeSpawn({ stdout: envelope({}) });
  const agent = createClaudeCliAgent({ spawnFn });
  await assert.rejects(() => agent.decide(targetRequest), /target/);
});

test("4. player-information boundary: the exact prompt sent is buildUserPrompt(request) - nothing added, nothing dropped", async () => {
  const { spawnFn, calls } = makeFakeSpawn({ stdout: envelope({ target: "3" }) });
  const agent = createClaudeCliAgent({ spawnFn });

  await agent.decide(targetRequest);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].stdin, buildUserPrompt(targetRequest));
});

test("4b. a citizen's request view (no teammates/investigations/saves) never leaks into the transmitted prompt", async () => {
  const citizenView: PublicGameStateView = {
    self: "5",
    phase: { phase: "day", round: 1 },
    players: ["1", "2", "3", "4", "5"],
    alive: ["1", "2", "3", "4", "5"],
    publicHistory: [],
    private: { role: "citizen" },
  };
  const request: SimulationDecisionRequest = { kind: "dayAction", player: "5", view: citizenView };
  const { spawnFn, calls } = makeFakeSpawn({ stdout: envelope({}) });
  const agent = createClaudeCliAgent({ spawnFn });

  await agent.decide(request);

  // Only the serialized VIEW portion of the prompt matters here - the schema
  // instructions appended after it legitimately mention "mafia" as a claimable
  // group name available to any player (see promptBuilder.ts's schemaFor),
  // which is not a leak of this citizen's own state.
  const sentPrompt = calls[0].stdin;
  const viewPortion = sentPrompt.split("\n\n")[0];
  assert.ok(!viewPortion.includes('"teammates"'));
  assert.ok(!viewPortion.includes('"investigations"'));
  assert.ok(!viewPortion.includes('"saves"'));
  assert.ok(!viewPortion.includes('"mafia"')); // no role name beyond this player's own ("citizen") is present in the state itself
});

test("5. ANTHROPIC_API_KEY is never passed to the child process, even if set in the parent process", async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
  try {
    const { spawnFn, calls } = makeFakeSpawn({ stdout: envelope({ target: "3" }) });
    const agent = createClaudeCliAgent({ spawnFn });

    await agent.decide(targetRequest);

    assert.equal(calls[0].env.ANTHROPIC_API_KEY, undefined);
    assert.equal(calls[0].env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1");
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});

test("the CLI is invoked with the expected model/effort/output-format/json-schema flags", async () => {
  const { spawnFn, calls } = makeFakeSpawn({ stdout: envelope({ target: "3" }) });
  const agent = createClaudeCliAgent({ spawnFn, model: "claude-haiku-4-5-20251001", effort: "low" });

  await agent.decide(targetRequest);

  const { args } = calls[0];
  assert.deepEqual(args.slice(0, 6), [
    "-p",
    "--model",
    "claude-haiku-4-5-20251001",
    "--effort",
    "low",
    "--output-format",
  ]);
  assert.ok(args.includes("--json-schema"));
});

test("a subprocess timeout rejects rather than hanging forever", async () => {
  // never calls back - simulates a hung process
  const spawnFn = (() => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => {}, end: () => {} };
    child.kill = () => {};
    return child;
  }) as any;

  const agent = createClaudeCliAgent({ spawnFn, timeoutMs: 20 });
  await assert.rejects(() => agent.decide(targetRequest), /timed out/);
});
