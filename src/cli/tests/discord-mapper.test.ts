import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pino from "pino";
import { mapDiscordMessage } from "../../../plugins/connector-discord/src/mapper.js";

function createMessage(overrides?: {
  id?: string;
  content?: string;
  attachments?: Map<string, unknown>;
}): unknown {
  return {
    id: overrides?.id ?? "msg-1",
    content: overrides?.content ?? "hello",
    author: {
      id: "user-1",
      username: "alice",
      bot: false,
    },
    attachments: overrides?.attachments ?? new Map(),
    mentions: {
      users: {
        has: () => false,
      },
    },
    guildId: "guild-1",
    channelId: "channel-1",
    channel: {
      isThread: () => false,
    },
    createdTimestamp: 1_700_000_000_000,
    toJSON: () => ({ ok: true }),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const logger = pino({ enabled: false });

test("mapDiscordMessage does not create attachment directory when message has no attachments", async () => {
  const root = await mkdtemp(join(tmpdir(), "dobby-discord-mapper-empty-"));
  const message = createMessage();

  const envelope = await mapDiscordMessage(
    message as never,
    "discord.main",
    "bot-1",
    "source-1",
    root,
    logger,
  );

  assert.ok(envelope);
  assert.deepEqual(envelope.attachments, []);
  assert.equal(await pathExists(join(root, "source-1", "msg-1")), false);
});

test("mapDiscordMessage only creates attachment directory when a download succeeds", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("file-body", { status: 200 }));

  const root = await mkdtemp(join(tmpdir(), "dobby-discord-mapper-file-"));
  const message = createMessage({
    attachments: new Map([
      ["att-1", {
        id: "att-1",
        name: "hello.png",
        contentType: "image/png",
        size: 9,
        url: "https://example.test/hello.png",
      }],
    ]),
  });

  const envelope = await mapDiscordMessage(
    message as never,
    "discord.main",
    "bot-1",
    "source-1",
    root,
    logger,
  );

  assert.ok(envelope);
  assert.equal(envelope.attachments.length, 1);
  assert.equal(await pathExists(join(root, "source-1", "msg-1")), true);
  assert.equal(envelope.attachments[0]?.localPath, join(root, "source-1", "msg-1", "hello.png"));
  assert.equal(await readFile(join(root, "source-1", "msg-1", "hello.png"), "utf-8"), "file-body");
});

test("mapDiscordMessage does not leave an empty attachment directory when download fails", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 500 }));

  const root = await mkdtemp(join(tmpdir(), "dobby-discord-mapper-fail-"));
  const message = createMessage({
    attachments: new Map([
      ["att-1", {
        id: "att-1",
        name: "broken.png",
        contentType: "image/png",
        size: 9,
        url: "https://example.test/broken.png",
      }],
    ]),
  });

  const envelope = await mapDiscordMessage(
    message as never,
    "discord.main",
    "bot-1",
    "source-1",
    root,
    logger,
  );

  assert.ok(envelope);
  assert.equal(envelope.attachments.length, 1);
  assert.equal(envelope.attachments[0]?.localPath, undefined);
  assert.equal(await pathExists(join(root, "source-1", "msg-1")), false);
});
