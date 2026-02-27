import test from "node:test";
import assert from "node:assert/strict";
import {
  applyContributionTemplates,
  ensureGatewayConfigShape,
  setDefaultProviderIfMissingOrInvalid,
  upsertAllowListPackage,
} from "../shared/config-mutators.js";

test("upsertAllowListPackage is idempotent", () => {
  const config = ensureGatewayConfigShape({});
  upsertAllowListPackage(config, "@dobby.ai/provider-pi", true);
  upsertAllowListPackage(config, "@dobby.ai/provider-pi", true);

  assert.equal(config.extensions?.allowList?.length, 1);
  assert.equal(config.extensions?.allowList?.[0]?.package, "@dobby.ai/provider-pi");
  assert.equal(config.extensions?.allowList?.[0]?.enabled, true);
});

test("applyContributionTemplates allocates new instance IDs when needed", () => {
  const config = ensureGatewayConfigShape({
    providers: {
      defaultProviderId: "pi.main",
      instances: {
        "pi.main": {
          contributionId: "provider.pi",
          config: {},
        },
      },
    },
  });

  const added = applyContributionTemplates(config, {
    providers: [
      { id: "pi.main", contributionId: "provider.another", config: {} },
      { id: "pi.main", contributionId: "provider.third", config: {} },
    ],
    connectors: [],
    sandboxes: [],
  });

  assert.deepEqual(added.providers, ["pi.main-2", "pi.main-3"]);
  assert.equal(config.providers?.instances?.["pi.main-2"]?.contributionId, "provider.another");
  assert.equal(config.providers?.instances?.["pi.main-3"]?.contributionId, "provider.third");
});

test("setDefaultProviderIfMissingOrInvalid picks lexicographically first provider", () => {
  const config = ensureGatewayConfigShape({
    providers: {
      defaultProviderId: "missing",
      instances: {
        "z.main": { contributionId: "provider.z", config: {} },
        "a.main": { contributionId: "provider.a", config: {} },
      },
    },
  });

  setDefaultProviderIfMissingOrInvalid(config);
  assert.equal(config.providers?.defaultProviderId, "a.main");
});
