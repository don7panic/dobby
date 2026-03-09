import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeRegistry } from "../runtime-registry.js";
import type { ConversationRuntime, GatewayLogger } from "../types.js";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createLogger(): GatewayLogger {
  return {
    error() {},
    warn() {},
    info() {},
    debug() {},
  } as unknown as GatewayLogger;
}

function createConversationRuntime(id: string, abortCalls: string[], closeCalls: string[]): ConversationRuntime {
  return {
    key: id,
    routeId: "route.main",
    route: {
      projectRoot: "/tmp/project",
      tools: "full",
      allowMentionsOnly: true,
      maxConcurrentTurns: 1,
    },
    providerId: "provider.main",
    sandboxId: "host.builtin",
    runtime: {
      async prompt() {},
      subscribe() {
        return () => {};
      },
      async abort() {
        abortCalls.push(id);
      },
      dispose() {},
    },
    async close() {
      closeCalls.push(id);
    },
  };
}

test("cancel aborts the active run and drops queued turns", async () => {
  const registry = new RuntimeRegistry(createLogger());
  const abortCalls: string[] = [];
  const closeCalls: string[] = [];
  let runtimeCount = 0;
  const createRuntime = async (): Promise<ConversationRuntime> => {
    runtimeCount += 1;
    return createConversationRuntime(`runtime-${runtimeCount}`, abortCalls, closeCalls);
  };

  const firstStarted = deferred();
  const releaseFirst = deferred();
  const started: string[] = [];

  const firstTurn = registry.run("conversation", createRuntime, async (runtime) => {
    started.push(runtime.key);
    firstStarted.resolve(undefined);
    await releaseFirst.promise;
  });

  await firstStarted.promise;

  const secondTurn = registry.run("conversation", createRuntime, async (runtime) => {
    started.push(runtime.key);
  });
  const thirdTurn = registry.run("conversation", createRuntime, async (runtime) => {
    started.push(runtime.key);
  });

  assert.equal(await registry.cancel("conversation"), true);
  assert.deepEqual(abortCalls, ["runtime-1"]);

  releaseFirst.resolve(undefined);
  await Promise.all([firstTurn, secondTurn, thirdTurn]);

  assert.deepEqual(started, ["runtime-1"]);
  assert.deepEqual(closeCalls, []);

  await registry.run("conversation", createRuntime, async (runtime) => {
    started.push(runtime.key);
  });

  assert.deepEqual(started, ["runtime-1", "runtime-1"]);
  assert.equal(runtimeCount, 1);
});

test("reset closes the current runtime and recreates it on the next turn", async () => {
  const registry = new RuntimeRegistry(createLogger());
  const abortCalls: string[] = [];
  const closeCalls: string[] = [];
  let runtimeCount = 0;
  const createRuntime = async (): Promise<ConversationRuntime> => {
    runtimeCount += 1;
    return createConversationRuntime(`runtime-${runtimeCount}`, abortCalls, closeCalls);
  };

  const firstStarted = deferred();
  const releaseFirst = deferred();
  const started: string[] = [];

  const firstTurn = registry.run("conversation", createRuntime, async (runtime) => {
    started.push(runtime.key);
    firstStarted.resolve(undefined);
    await releaseFirst.promise;
  });

  await firstStarted.promise;

  const queuedTurn = registry.run("conversation", createRuntime, async (runtime) => {
    started.push(runtime.key);
  });

  const resetPromise = registry.reset("conversation");
  releaseFirst.resolve(undefined);

  assert.equal(await resetPromise, true);
  await Promise.all([firstTurn, queuedTurn]);

  assert.deepEqual(abortCalls, ["runtime-1"]);
  assert.deepEqual(closeCalls, ["runtime-1"]);
  assert.deepEqual(started, ["runtime-1"]);

  await registry.run("conversation", createRuntime, async (runtime) => {
    started.push(runtime.key);
  });

  assert.deepEqual(started, ["runtime-1", "runtime-2"]);
  assert.equal(runtimeCount, 2);
});
