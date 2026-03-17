import assert from "node:assert/strict";
import test from "node:test";
import { availabilityFromHealthStatus, statusItemFromConnector } from "../connector-status.js";
import type { ConnectorHealth, ConnectorPlugin } from "../types.js";

function createHealth(status: ConnectorHealth["status"]): ConnectorHealth {
  const now = Date.now();
  return {
    status,
    statusSinceMs: now,
    updatedAtMs: now,
  };
}

test("availabilityFromHealthStatus maps connector health into user-facing availability", () => {
  assert.equal(availabilityFromHealthStatus("ready"), "online");
  assert.equal(availabilityFromHealthStatus("degraded"), "degraded");
  assert.equal(availabilityFromHealthStatus("reconnecting"), "reconnecting");
  assert.equal(availabilityFromHealthStatus("starting"), "offline");
  assert.equal(availabilityFromHealthStatus("failed"), "offline");
  assert.equal(availabilityFromHealthStatus("stopped"), "offline");
});

test("statusItemFromConnector exposes connector metadata and health summary", () => {
  const connector: ConnectorPlugin = {
    id: "discord.main",
    platform: "discord",
    name: "discord",
    capabilities: {
      updateStrategy: "edit",
      supportedSources: ["channel"],
      supportsThread: true,
      supportsTyping: true,
      supportsFileUpload: false,
    },
    async start() {},
    async send() {
      return {};
    },
    async stop() {},
    getHealth() {
      return {
        ...createHealth("ready"),
        detail: "Discord gateway connected",
        restartCount: 2,
      };
    },
  };

  const item = statusItemFromConnector(connector);
  assert.equal(item.connectorId, "discord.main");
  assert.equal(item.platform, "discord");
  assert.equal(item.connectorName, "discord");
  assert.equal(item.availability, "online");
  assert.equal(item.online, true);
  assert.equal(item.health.detail, "Discord gateway connected");
  assert.equal(item.health.restartCount, 2);
});
