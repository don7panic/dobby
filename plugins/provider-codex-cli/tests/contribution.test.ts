import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { GatewayAgentEvent } from "@dobby.ai/plugin-sdk";
import {
  CodexCliGatewayRuntime,
  loadStoredThreadId,
  mapToolProfileToSandbox,
} from "../src/contribution.js";

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 12345;
  killed = false;

  kill(_signal?: NodeJS.Signals): boolean {
    this.killed = true;
    return true;
  }
}

function createLogger() {
  const noop = () => undefined;
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => createLogger(),
  } as const;
}

function createRoute(tools: "readonly" | "full" = "full") {
  return {
    routeId: "main",
    profile: {
      projectRoot: "/tmp/project",
      tools,
      mentions: "required" as const,
      provider: "codex-cli.main",
      sandbox: "host.builtin",
    },
  };
}

async function createSessionMetaPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dobby-codex-cli-"));
  return join(dir, "session.json");
}

test("mapToolProfileToSandbox maps gateway tool profile to codex sandbox mode", () => {
  assert.equal(mapToolProfileToSandbox("readonly"), "read-only");
  assert.equal(mapToolProfileToSandbox("full"), "workspace-write");
});

test("loadStoredThreadId tolerates corrupt thread metadata", async () => {
  const sessionMetaPath = await createSessionMetaPath();
  await writeFile(sessionMetaPath, "{not-json", "utf-8");

  const threadId = await loadStoredThreadId(sessionMetaPath, createLogger() as never, "codex-cli.main", "conversation:1");
  assert.equal(threadId, undefined);
});

test("Codex CLI runtime persists thread id and emits final assistant message", async () => {
  const sessionMetaPath = await createSessionMetaPath();
  const spawnCalls: Array<{ command: string; args: string[] }> = [];
  const runtime = new CodexCliGatewayRuntime(
    "codex-cli.main",
    "conversation:1",
    createRoute(),
    createLogger() as never,
    {
      command: "codex",
      commandArgs: [],
      model: "gpt-5-codex",
      approvalPolicy: "never",
      configOverrides: [],
      skipGitRepoCheck: true,
    },
    sessionMetaPath,
    undefined,
    false,
    (command, args) => {
      spawnCalls.push({ command, args });
      const child = new FakeChildProcess();
      setImmediate(() => {
        child.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "thread-123" })}\n`);
        child.stdout.write(`${JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "done" } })}\n`);
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    },
  );

  const events: GatewayAgentEvent[] = [];
  runtime.subscribe((event) => {
    events.push(event);
  });

  await runtime.prompt("Please help");

  assert.deepEqual(events, [
    { type: "status", message: "Codex is thinking..." },
    { type: "message_complete", text: "done" },
  ]);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0]?.command, "codex");
  assert.deepEqual(spawnCalls[0]?.args, [
    "-a",
    "never",
    "-C",
    "/tmp/project",
    "-s",
    "workspace-write",
    "-m",
    "gpt-5-codex",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-",
  ]);

  const persisted = JSON.parse(await readFile(sessionMetaPath, "utf-8")) as { threadId: string };
  assert.equal(persisted.threadId, "thread-123");
});

test("Codex CLI runtime maps command execution items to status and tool events", async () => {
  const sessionMetaPath = await createSessionMetaPath();
  const runtime = new CodexCliGatewayRuntime(
    "codex-cli.main",
    "conversation:2",
    createRoute("readonly"),
    createLogger() as never,
    {
      command: "codex",
      commandArgs: [],
      approvalPolicy: "never",
      configOverrides: [],
      skipGitRepoCheck: false,
    },
    sessionMetaPath,
    undefined,
    false,
    (_command, args) => {
      assert.deepEqual(args, [
        "-a",
        "never",
        "-C",
        "/tmp/project",
        "-s",
        "read-only",
        "exec",
        "--json",
        "-",
      ]);

      const child = new FakeChildProcess();
      setImmediate(() => {
        child.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "thread-456" })}\n`);
        child.stdout.write(`${JSON.stringify({ type: "item.started", item: { id: "cmd_1", type: "command_execution", command: "pwd" } })}\n`);
        child.stdout.write(`${JSON.stringify({ type: "item.completed", item: { id: "cmd_1", type: "command_execution", command: "pwd", exit_code: 0, aggregated_output: "/tmp/project\n", status: "completed" } })}\n`);
        child.stdout.write(`${JSON.stringify({ type: "item.completed", item: { id: "msg_1", type: "agent_message", text: "all set" } })}\n`);
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    },
  );

  const events: GatewayAgentEvent[] = [];
  runtime.subscribe((event) => {
    events.push(event);
  });

  await runtime.prompt("Show pwd");

  assert.deepEqual(events, [
    { type: "status", message: "Codex is thinking..." },
    { type: "command_start", command: "pwd" },
    { type: "tool_start", toolName: "pwd" },
    { type: "tool_end", toolName: "pwd", isError: false, output: "command: pwd\nstatus: completed\nexitCode: 0\n/tmp/project" },
    { type: "message_complete", text: "all set" },
  ]);
});

test("Codex CLI runtime supports explicit profile, approval policy, sandbox mode, and config overrides", async () => {
  const sessionMetaPath = await createSessionMetaPath();
  const runtime = new CodexCliGatewayRuntime(
    "codex-cli.main",
    "conversation:profiled",
    createRoute(),
    createLogger() as never,
    {
      command: "codex",
      commandArgs: ["--search"],
      profile: "background",
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
      configOverrides: [
        "model_provider = \"crs\"",
        "model_reasoning_effort = \"xhigh\"",
      ],
      skipGitRepoCheck: false,
    },
    sessionMetaPath,
    undefined,
    false,
    (_command, args) => {
      assert.deepEqual(args, [
        "--search",
        "-p",
        "background",
        "-c",
        "model_provider = \"crs\"",
        "-c",
        "model_reasoning_effort = \"xhigh\"",
        "-a",
        "never",
        "-C",
        "/tmp/project",
        "-s",
        "danger-full-access",
        "exec",
        "--json",
        "-",
      ]);

      const child = new FakeChildProcess();
      setImmediate(() => {
        child.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "thread-danger" })}\n`);
        child.stdout.write(`${JSON.stringify({ type: "item.completed", item: { id: "msg_1", type: "agent_message", text: "done with overrides" } })}\n`);
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    },
  );

  await runtime.prompt("Work in the background");
});

test("Codex CLI runtime retries without resume when previous thread cannot be resumed", async () => {
  const sessionMetaPath = await createSessionMetaPath();
  await writeFile(sessionMetaPath, JSON.stringify({ threadId: "stale-thread", updatedAtMs: Date.now() }), "utf-8");

  const spawnCalls: string[][] = [];
  const runtime = new CodexCliGatewayRuntime(
    "codex-cli.main",
    "conversation:3",
    createRoute(),
    createLogger() as never,
    {
      command: "codex",
      commandArgs: [],
      approvalPolicy: "never",
      configOverrides: [],
      skipGitRepoCheck: false,
    },
    sessionMetaPath,
    "stale-thread",
    false,
    (_command, args) => {
      spawnCalls.push(args);
      const child = new FakeChildProcess();
      setImmediate(() => {
        if (spawnCalls.length === 1) {
          child.stderr.write("resume failed: thread not found\n");
          child.stdout.end();
          child.stderr.end();
          child.emit("close", 1, null);
          return;
        }

        child.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "fresh-thread" })}\n`);
        child.stdout.write(`${JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "fresh result" } })}\n`);
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    },
  );

  const events: GatewayAgentEvent[] = [];
  runtime.subscribe((event) => {
    events.push(event);
  });

  await runtime.prompt("Try again");

  assert.equal(spawnCalls.length, 2);
  assert.deepEqual(spawnCalls[0], [
    "-a",
    "never",
    "-C",
    "/tmp/project",
    "-s",
    "workspace-write",
    "exec",
    "resume",
    "--json",
    "stale-thread",
    "-",
  ]);
  assert.deepEqual(spawnCalls[1], [
    "-a",
    "never",
    "-C",
    "/tmp/project",
    "-s",
    "workspace-write",
    "exec",
    "--json",
    "-",
  ]);
  assert.deepEqual(events, [
    { type: "status", message: "Codex is thinking..." },
    { type: "message_complete", text: "fresh result" },
  ]);

  const persisted = JSON.parse(await readFile(sessionMetaPath, "utf-8")) as { threadId: string };
  assert.equal(persisted.threadId, "fresh-thread");
});

test("Codex CLI runtime surfaces missing binary errors", async () => {
  const sessionMetaPath = await createSessionMetaPath();
  const runtime = new CodexCliGatewayRuntime(
    "codex-cli.main",
    "conversation:4",
    createRoute(),
    createLogger() as never,
    {
      command: "codex",
      commandArgs: [],
      approvalPolicy: "never",
      configOverrides: [],
      skipGitRepoCheck: false,
    },
    sessionMetaPath,
    undefined,
    false,
    () => {
      const error = new Error("spawn codex ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
  );

  await assert.rejects(
    runtime.prompt("hello"),
    /Codex CLI command not found: 'codex'/,
  );
});
