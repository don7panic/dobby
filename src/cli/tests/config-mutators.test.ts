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
      default: "pi.main",
      items: {
        "pi.main": {
          type: "provider.pi",
        },
      },
    },
  });

  const added = applyContributionTemplates(config, {
    providers: [
      { id: "pi.main", type: "provider.another", config: {} },
      { id: "pi.main", type: "provider.third", config: {} },
    ],
    connectors: [],
    sandboxes: [],
  });

  assert.deepEqual(added.providers, ["pi.main-2", "pi.main-3"]);
  assert.equal(config.providers.items["pi.main-2"]?.type, "provider.another");
  assert.equal(config.providers.items["pi.main-3"]?.type, "provider.third");
});

test("setDefaultProviderIfMissingOrInvalid picks lexicographically first provider", () => {
  const config = ensureGatewayConfigShape({
    providers: {
      default: "missing",
      items: {
        "z.main": { type: "provider.z" },
        "a.main": { type: "provider.a" },
      },
    },
  });

  setDefaultProviderIfMissingOrInvalid(config);
  assert.equal(config.providers.default, "a.main");
});
