import assert from "node:assert/strict";
import test from "node:test";
import {
  OUTBOUND_MESSAGE_KIND_METADATA_KEY,
  OUTBOUND_MESSAGE_KIND_PROGRESS,
} from "@dobby.ai/plugin-sdk";
import { FeishuConnector, type FeishuConnectorConfig } from "../src/connector.js";

interface FakeMessageApiCall {
  path?: Record<string, unknown>;
  params?: Record<string, unknown>;
  data: Record<string, unknown>;
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

function createClientRecorder() {
  const calls = {
    create: [] as FakeMessageApiCall[],
    reply: [] as FakeMessageApiCall[],
    update: [] as FakeMessageApiCall[],
    patch: [] as FakeMessageApiCall[],
  };

  const client = {
    im: {
      v1: {
        message: {
          async create(payload: FakeMessageApiCall) {
            calls.create.push(payload);
            return { data: { message_id: `create-${calls.create.length}` } };
          },
          async reply(payload: FakeMessageApiCall) {
            calls.reply.push(payload);
            return { data: { message_id: `reply-${calls.reply.length}` } };
          },
          async update(payload: FakeMessageApiCall) {
            calls.update.push(payload);
            return { data: { message_id: `update-${calls.update.length}` } };
          },
          async patch(payload: FakeMessageApiCall) {
            calls.patch.push(payload);
            return { data: { message_id: `patch-${calls.patch.length}` } };
          },
        },
      },
    },
  };

  return { calls, client };
}

function createConnector(config: Partial<FeishuConnectorConfig> = {}) {
  const connector = new FeishuConnector(
    "feishu.main",
    {
      appId: "app-id",
      appSecret: "app-secret",
      messageFormat: "card_markdown",
      replyMode: "direct",
      ...config,
    },
    "/tmp/attachments",
    createLogger() as never,
  );
  const recorder = createClientRecorder();
  (connector as unknown as { client: typeof recorder.client }).client = recorder.client;
  return { connector, calls: recorder.calls };
}

function parseContent(call: FakeMessageApiCall): unknown {
  return JSON.parse(String(call.data.content));
}

test("Feishu connector keeps card_markdown messages as interactive cards by default", async () => {
  const { connector, calls } = createConnector();

  await connector.send({
    platform: "feishu",
    accountId: "feishu.main",
    chatId: "chat-1",
    mode: "create",
    text: "final answer",
  });

  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0]?.data.msg_type, "interactive");
  assert.deepEqual(parseContent(calls.create[0] as FakeMessageApiCall), {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: "dobby",
      },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: [
        {
          tag: "markdown",
          content: "final answer",
        },
      ],
    },
  });
});

test("Feishu connector renders progress messages as text while keeping final messages as cards", async () => {
  const { connector, calls } = createConnector({ replyMode: "reply" });

  await connector.send({
    platform: "feishu",
    accountId: "feishu.main",
    chatId: "chat-1",
    mode: "create",
    text: "Codex is thinking...",
    metadata: {
      [OUTBOUND_MESSAGE_KIND_METADATA_KEY]: OUTBOUND_MESSAGE_KIND_PROGRESS,
    },
  });

  await connector.send({
    platform: "feishu",
    accountId: "feishu.main",
    chatId: "chat-1",
    mode: "create",
    replyToMessageId: "root-1",
    text: "Running command: pwd",
    metadata: {
      [OUTBOUND_MESSAGE_KIND_METADATA_KEY]: OUTBOUND_MESSAGE_KIND_PROGRESS,
    },
  });

  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0]?.data.msg_type, "text");
  assert.deepEqual(parseContent(calls.create[0] as FakeMessageApiCall), {
    text: "Codex is thinking...",
  });

  assert.equal(calls.reply.length, 1);
  assert.equal(calls.reply[0]?.data.msg_type, "text");
  assert.deepEqual(parseContent(calls.reply[0] as FakeMessageApiCall), {
    text: "Running command: pwd",
  });
});

test("Feishu connector resolves update format per message instead of only from connector defaults", async () => {
  const { connector, calls } = createConnector();

  await connector.send({
    platform: "feishu",
    accountId: "feishu.main",
    chatId: "chat-1",
    mode: "update",
    targetMessageId: "final-1",
    text: "final answer",
  });

  await connector.send({
    platform: "feishu",
    accountId: "feishu.main",
    chatId: "chat-1",
    mode: "update",
    targetMessageId: "status-1",
    text: "Retrying...",
    metadata: {
      [OUTBOUND_MESSAGE_KIND_METADATA_KEY]: OUTBOUND_MESSAGE_KIND_PROGRESS,
    },
  });

  assert.equal(calls.patch.length, 1);
  assert.equal(calls.patch[0]?.path?.message_id, "final-1");
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0]?.path?.message_id, "status-1");
  assert.equal(calls.update[0]?.data.msg_type, "text");
  assert.deepEqual(parseContent(calls.update[0] as FakeMessageApiCall), {
    text: "Retrying...",
  });
});
