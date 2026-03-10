import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConfigListEntries,
  CONFIG_SECTION_VALUES,
  isConfigSection,
  previewConfigValue,
} from "../commands/config.js";

test("isConfigSection accepts only supported top-level config sections", () => {
  for (const section of CONFIG_SECTION_VALUES) {
    assert.equal(isConfigSection(section), true);
  }

  assert.equal(isConfigSection("provider"), false);
  assert.equal(isConfigSection("bot"), false);
});

test("previewConfigValue returns stable compact previews", () => {
  assert.equal(previewConfigValue("abc"), "\"abc\"");
  assert.equal(previewConfigValue(123), "123");
  assert.equal(previewConfigValue(true), "true");
  assert.equal(previewConfigValue(null), "null");
  assert.equal(previewConfigValue({ a: 1, b: 2, c: 3, d: 4 }), "{a, b, c, ...}");
});

test("buildConfigListEntries summarizes object values with type and child counts", () => {
  const entries = buildConfigListEntries({
    providers: {
      default: "pi.main",
      items: {
        "pi.main": { type: "provider.pi" },
      },
    },
    featureFlag: true,
  });

  assert.deepEqual(
    entries.map((entry) => ({ key: entry.key, type: entry.type, children: entry.children })),
    [
      { key: "featureFlag", type: "boolean", children: undefined },
      { key: "providers", type: "object", children: 2 },
    ],
  );
});

test("buildConfigListEntries handles primitive roots", () => {
  const entries = buildConfigListEntries("plain");
  assert.deepEqual(entries, [
    {
      key: "(value)",
      type: "string",
      preview: "\"plain\"",
    },
  ]);
});
