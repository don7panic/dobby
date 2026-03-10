import type {
  ConnectorPlugin,
  GatewayLogger,
  InboundEnvelope,
} from "./types.js";

const DEFAULT_TYPING_INITIAL_DELAY_MS = 0;
const DEFAULT_TYPING_KEEPALIVE_INTERVAL_MS = 8_000;

export interface TypingController {
  prime: () => Promise<void>;
  markVisibleOutput: () => void;
  stop: () => void;
}

export function createTypingKeepAliveController(
  connector: ConnectorPlugin,
  message: InboundEnvelope,
  logger: GatewayLogger,
  options: {
    initialDelayMs?: number;
    keepaliveIntervalMs?: number;
  } = {},
): TypingController {
  const sendTypingMethod = connector.sendTyping;
  if (!connector.capabilities.supportsTyping || !sendTypingMethod) {
    return {
      prime: async () => {},
      markVisibleOutput: () => {},
      stop: () => {},
    };
  }

  const typingTarget = {
    platform: message.platform,
    accountId: message.accountId,
    chatId: message.chatId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
  };
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_TYPING_INITIAL_DELAY_MS;
  const keepaliveIntervalMs = options.keepaliveIntervalMs ?? DEFAULT_TYPING_KEEPALIVE_INTERVAL_MS;
  let stopped = false;
  let visibleOutputSent = false;
  let inFlight = false;
  let keepaliveTimer: NodeJS.Timeout | null = null;

  const clearKeepalive = (): void => {
    if (!keepaliveTimer) {
      return;
    }
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  };

  const sendTyping = async (): Promise<void> => {
    if (stopped || visibleOutputSent || inFlight) {
      return;
    }

    inFlight = true;
    try {
      await sendTypingMethod.call(connector, typingTarget);
    } catch (error) {
      logger.warn(
        {
          err: error,
          connectorId: message.connectorId,
          chatId: message.chatId,
          threadId: message.threadId,
        },
        "Failed to send typing indicator",
      );
    } finally {
      inFlight = false;
    }
  };

  const startKeepalive = (): void => {
    if (keepaliveTimer || stopped || visibleOutputSent) {
      return;
    }

    keepaliveTimer = setInterval(() => {
      void sendTyping();
    }, keepaliveIntervalMs);
  };

  return {
    prime: async () => {
      if (stopped || visibleOutputSent) {
        return;
      }

      if (initialDelayMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, initialDelayMs);
          if (stopped || visibleOutputSent) {
            clearTimeout(timer);
            resolve();
          }
        });
      }

      await sendTyping();
      startKeepalive();
    },
    markVisibleOutput: () => {
      if (visibleOutputSent) {
        return;
      }
      visibleOutputSent = true;
      clearKeepalive();
    },
    stop: () => {
      stopped = true;
      clearKeepalive();
    },
  };
}
