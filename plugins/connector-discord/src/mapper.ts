import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Message } from "discord.js";
import type { GatewayLogger, InboundAttachment, InboundEnvelope } from "@dobby.ai/plugin-sdk";

function stripBotMention(text: string, botUserId: string): string {
  const mentionRegex = new RegExp(`<@!?${botUserId}>`, "g");
  return text.replace(mentionRegex, "").trim();
}

function sanitizeFileName(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

async function downloadAttachment(url: string, targetPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download attachment from ${url}: ${response.status}`);
  }

  const data = await response.arrayBuffer();
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, Buffer.from(data));
}

function mapAttachmentBase(messageAttachment: {
  id: string;
  name: string | null;
  contentType: string | null;
  size: number;
  url: string;
}): InboundAttachment {
  return {
    id: messageAttachment.id,
    size: messageAttachment.size,
    remoteUrl: messageAttachment.url,
    ...(messageAttachment.name ? { fileName: messageAttachment.name } : {}),
    ...(messageAttachment.contentType ? { mimeType: messageAttachment.contentType } : {}),
  };
}

export async function mapDiscordMessage(
  message: Message,
  connectorId: string,
  botUserId: string,
  sourceId: string,
  attachmentsRoot: string,
  logger: GatewayLogger,
): Promise<InboundEnvelope | null> {
  if (message.author.bot) return null;

  const isDirectMessage = message.guildId == null;
  const mentionedBot = message.mentions.users.has(botUserId);

  const chatId = message.channelId;
  const threadId = message.channel.isThread() ? message.channelId : undefined;

  const cleanedText = stripBotMention(message.content ?? "", botUserId);

  const attachments: InboundAttachment[] = [];

  for (const attachment of message.attachments.values()) {
    const base = mapAttachmentBase(attachment);
    const attachmentDir = join(attachmentsRoot, sourceId, message.id);
    const fileName = sanitizeFileName(attachment.name ?? attachment.id);
    const localPath = join(attachmentDir, fileName);

    try {
      await downloadAttachment(attachment.url, localPath);
      attachments.push({
        ...base,
        localPath,
      });
    } catch (error) {
      logger.warn({ err: error, attachmentUrl: attachment.url }, "Failed to download Discord attachment; keeping metadata only");
      attachments.push(base);
    }
  }

  return {
    connectorId,
    platform: "discord",
    accountId: botUserId,
    source: {
      type: "channel",
      id: sourceId,
    },
    chatId,
    messageId: message.id,
    userId: message.author.id,
    userName: message.author.username,
    text: cleanedText,
    attachments,
    timestampMs: message.createdTimestamp,
    raw: message.toJSON(),
    isDirectMessage,
    mentionedBot,
    ...(message.guildId ? { guildId: message.guildId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}
