import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@larksuiteoapi/node-sdk";
import type { GatewayLogger, InboundAttachment, InboundEnvelope } from "@dobby.ai/plugin-sdk";

interface FeishuMention {
  key: string;
  id?: {
    union_id?: string;
    user_id?: string;
    open_id?: string;
  };
  name: string;
  tenant_key?: string;
}

export interface FeishuMessageEvent {
  app_id?: string;
  sender: {
    sender_id?: {
      union_id?: string;
      user_id?: string;
      open_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time: string;
    update_time?: string;
    chat_id: string;
    thread_id?: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: FeishuMention[];
    user_agent?: string;
  };
}

interface MapFeishuMessageOptions {
  event: FeishuMessageEvent;
  connectorId: string;
  routeId: string;
  attachmentsRoot: string;
  client: Client;
  logger: GatewayLogger;
  downloadAttachments: boolean;
  botOpenId?: string;
  botName?: string;
}

interface AttachmentDescriptor {
  fileKey: string;
  fileName: string;
  mimeType?: string;
  resourceType: string;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function sanitizeFileName(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

function normalizeWhitespace(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function normalizeComparableName(value: string): string {
  return normalizeWhitespace(value).replace(/^@+/, "").toLowerCase();
}

function collectPostText(node: unknown, output: string[]): void {
  if (typeof node === "string") {
    const trimmed = node.trim();
    if (trimmed.length > 0) {
      output.push(trimmed);
    }
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectPostText(item, output);
    }
    return;
  }

  if (!node || typeof node !== "object") {
    return;
  }

  const record = node as Record<string, unknown>;
  if (record.tag === "text" && typeof record.text === "string") {
    const trimmed = record.text.trim();
    if (trimmed.length > 0) {
      output.push(trimmed);
    }
  }

  for (const value of Object.values(record)) {
    collectPostText(value, output);
  }
}

function isBotMention(mention: FeishuMention, botOpenId?: string, botName?: string): boolean {
  if (botOpenId) {
    return mention.id?.open_id === botOpenId || mention.id?.user_id === botOpenId || mention.id?.union_id === botOpenId;
  }

  if (botName) {
    return normalizeComparableName(mention.name) === normalizeComparableName(botName);
  }

  return false;
}

function replaceMentionKeys(text: string, mentions: FeishuMention[]): string {
  let next = text;
  for (const mention of mentions) {
    const replacement = mention.name.length > 0 ? `@${mention.name}` : "@user";
    next = next.split(mention.key).join(replacement);
  }
  return next;
}

function stripBotMentions(text: string, mentions: FeishuMention[], botOpenId?: string, botName?: string): string {
  let next = text;
  for (const mention of mentions) {
    if (!isBotMention(mention, botOpenId, botName)) {
      continue;
    }
    next = next.split(mention.key).join("");
    if (mention.name.length > 0) {
      next = next.split(`@${mention.name}`).join("");
    }
  }
  return normalizeWhitespace(next);
}

function extractMessageText(event: FeishuMessageEvent, botOpenId?: string, botName?: string): string {
  const { message } = event;
  const mentions = message.mentions ?? [];
  const parsed = safeParseJson(message.content);
  let text = "";

  switch (message.message_type) {
    case "text":
      text = typeof (parsed as { text?: unknown } | null)?.text === "string"
        ? (parsed as { text: string }).text
        : message.content;
      break;
    case "post": {
      const parts: string[] = [];
      collectPostText(parsed, parts);
      text = parts.join("\n");
      break;
    }
    case "file":
      text = typeof (parsed as { file_name?: unknown } | null)?.file_name === "string"
        ? `[file] ${(parsed as { file_name: string }).file_name}`
        : "(file)";
      break;
    case "image":
      text = "(image)";
      break;
    case "audio":
      text = "(audio)";
      break;
    case "media":
      text = typeof (parsed as { file_name?: unknown } | null)?.file_name === "string"
        ? `[media] ${(parsed as { file_name: string }).file_name}`
        : "(media)";
      break;
    default:
      text = `(${message.message_type})`;
      break;
  }

  const withReadableMentions = replaceMentionKeys(text, mentions);
  return stripBotMentions(withReadableMentions, mentions, botOpenId, botName);
}

function attachmentDescriptor(event: FeishuMessageEvent): AttachmentDescriptor | null {
  const parsed = safeParseJson(event.message.content) as Record<string, unknown> | null;
  if (!parsed) {
    return null;
  }

  if (event.message.message_type === "image" && typeof parsed.image_key === "string") {
    return {
      fileKey: parsed.image_key,
      fileName: `image-${parsed.image_key}.png`,
      mimeType: "image/png",
      resourceType: "image",
    };
  }

  if (event.message.message_type === "file" && typeof parsed.file_key === "string") {
    return {
      fileKey: parsed.file_key,
      fileName: typeof parsed.file_name === "string" ? parsed.file_name : `file-${parsed.file_key}`,
      resourceType: "file",
    };
  }

  return null;
}

async function downloadAttachment(
  client: Client,
  event: FeishuMessageEvent,
  descriptor: AttachmentDescriptor,
  attachmentDir: string,
): Promise<InboundAttachment> {
  const targetPath = join(attachmentDir, sanitizeFileName(descriptor.fileName));
  const resource = await client.im.v1.messageResource.get({
    params: {
      type: descriptor.resourceType,
    },
    path: {
      message_id: event.message.message_id,
      file_key: descriptor.fileKey,
    },
  });

  await resource.writeFile(targetPath);
  return {
    id: descriptor.fileKey,
    fileName: descriptor.fileName,
    ...(descriptor.mimeType ? { mimeType: descriptor.mimeType } : {}),
    localPath: targetPath,
  };
}

export async function mapFeishuMessageEvent(options: MapFeishuMessageOptions): Promise<InboundEnvelope | null> {
  const { event, connectorId, routeId, attachmentsRoot, client, logger, downloadAttachments, botOpenId, botName } = options;
  if (event.sender.sender_type !== "user") {
    return null;
  }

  const routeChannelId = event.message.chat_id;
  const attachmentDir = join(attachmentsRoot, routeChannelId, event.message.message_id);
  await mkdir(attachmentDir, { recursive: true });

  const attachments: InboundAttachment[] = [];
  if (downloadAttachments) {
    const descriptor = attachmentDescriptor(event);
    if (descriptor) {
      try {
        attachments.push(await downloadAttachment(client, event, descriptor, attachmentDir));
      } catch (error) {
        logger.warn(
          {
            err: error,
            connectorId,
            messageId: event.message.message_id,
            fileKey: descriptor.fileKey,
            resourceType: descriptor.resourceType,
          },
          "Failed to download Feishu attachment; keeping metadata only",
        );
        attachments.push({
          id: descriptor.fileKey,
          fileName: descriptor.fileName,
          ...(descriptor.mimeType ? { mimeType: descriptor.mimeType } : {}),
        });
      }
    }
  }

  const senderId = event.sender.sender_id?.open_id
    ?? event.sender.sender_id?.user_id
    ?? event.sender.sender_id?.union_id
    ?? "unknown";

  const mentionedBot = event.message.chat_type === "p2p"
    || (event.message.mentions ?? []).some((mention) => isBotMention(mention, botOpenId, botName))
    || (!botOpenId && !botName && (event.message.mentions?.length ?? 0) > 0);

  const timestampMs = Number.parseInt(event.message.create_time, 10);
  const threadId = event.message.root_id ?? event.message.thread_id;

  return {
    connectorId,
    platform: "feishu",
    accountId: event.app_id ?? connectorId,
    routeId,
    routeChannelId,
    chatId: event.message.chat_id,
    ...(threadId ? { threadId } : {}),
    messageId: event.message.message_id,
    userId: senderId,
    text: extractMessageText(event, botOpenId, botName),
    attachments,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : Date.now(),
    raw: event,
    isDirectMessage: event.message.chat_type === "p2p",
    mentionedBot,
  };
}
