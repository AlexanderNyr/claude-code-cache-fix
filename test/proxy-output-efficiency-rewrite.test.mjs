import { test } from "node:test";
import assert from "node:assert/strict";
import ext, {
  normalizeReplacement,
  replaceSection,
  rewriteOutputEfficiency,
  SECTION_HEADER,
} from "../proxy/extensions/output-efficiency-rewrite.mjs";

// --- Unit tests: normalizeReplacement ---

test("normalizeReplacement: prepends header if missing", () => {
  const result = normalizeReplacement("Be concise and direct.");
  assert.ok(result.startsWith(SECTION_HEADER));
  assert.ok(result.includes("Be concise and direct."));
});

test("normalizeReplacement: keeps header if already present", () => {
  const input = "# Output efficiency\n\nBe concise.";
  assert.equal(normalizeReplacement(input), input);
});

test("normalizeReplacement: returns empty for empty input", () => {
  assert.equal(normalizeReplacement(""), "");
  assert.equal(normalizeReplacement(null), "");
  assert.equal(normalizeReplacement(undefined), "");
});

// --- Unit tests: replaceSection ---

test("replaceSection: replaces section up to next heading", () => {
  const text = "Before\n\n# Output efficiency\n\nOld content here.\n\n# Next section\n\nKeep this.";
  const replacement = "# Output efficiency\n\nNew content.";
  const result = replaceSection(text, replacement);
  assert.ok(result.includes("New content."));
  assert.ok(result.includes("Keep this."));
  assert.ok(!result.includes("Old content"));
});

test("replaceSection: replaces section at end of text (no next heading)", () => {
  const text = "Before\n\n# Output efficiency\n\nOld trailing content.";
  const replacement = "# Output efficiency\n\nReplaced.";
  const result = replaceSection(text, replacement);
  assert.equal(result, "Before\n\n# Output efficiency\n\nReplaced.");
});

test("replaceSection: returns null if section not found", () => {
  assert.equal(replaceSection("no such section", "replacement"), null);
});

test("replaceSection: preserves content before the section", () => {
  const text = "# System prompt\n\nImportant stuff.\n\n# Output efficiency\n\nReplace me.";
  const result = replaceSection(text, "# Output efficiency\n\nNew.");
  assert.ok(result.startsWith("# System prompt\n\nImportant stuff."));
});

// --- Unit tests: rewriteOutputEfficiency ---

test("rewriteOutputEfficiency: rewrites matching system block", () => {
  const system = [
    { type: "text", text: "# System\n\nPreamble.\n\n# Output efficiency\n\nOld." },
  ];
  const result = rewriteOutputEfficiency(system, "# Output efficiency\n\nNew.");
  assert.ok(result);
  assert.ok(result[0].text.includes("New."));
  assert.ok(!result[0].text.includes("Old."));
});

test("rewriteOutputEfficiency: preserves cache_control on rewritten block", () => {
  const system = [
    {
      type: "text",
      text: "# Output efficiency\n\nOld content.",
      cache_control: { type: "ephemeral" },
    },
  ];
  const result = rewriteOutputEfficiency(system, "# Output efficiency\n\nNew.");
  assert.ok(result);
  assert.deepEqual(result[0].cache_control, { type: "ephemeral" });
});

test("rewriteOutputEfficiency: returns null when no match", () => {
  const system = [{ type: "text", text: "no output efficiency section" }];
  assert.equal(rewriteOutputEfficiency(system, "replacement"), null);
});

test("rewriteOutputEfficiency: returns null when replacement is empty", () => {
  const system = [{ type: "text", text: "# Output efficiency\n\nContent." }];
  assert.equal(rewriteOutputEfficiency(system, ""), null);
});

test("rewriteOutputEfficiency: returns null for non-array system", () => {
  assert.equal(rewriteOutputEfficiency(null, "replacement"), null);
  assert.equal(rewriteOutputEfficiency("string", "replacement"), null);
});

// --- Integration tests: onRequest ---

test("onRequest: rewrites when replacement is provided via meta", async () => {
  const ctx = {
    body: {
      system: [
        { type: "text", text: "# Preamble\n\nStuff.\n\n# Output efficiency\n\nDefault verbose instructions." },
      ],
    },
    headers: {},
    meta: { outputEfficiencyReplacement: "Be concise. No fluff." },
  };

  await ext.onRequest(ctx);
  assert.ok(ctx.body.system[0].text.includes("Be concise"));
  assert.ok(!ctx.body.system[0].text.includes("Default verbose"));
});

test("onRequest: no-op when no replacement configured", async () => {
  const original = "# Output efficiency\n\nKeep this.";
  const ctx = {
    body: { system: [{ type: "text", text: original }] },
    headers: {},
    meta: {},
  };

  await ext.onRequest(ctx);
  assert.equal(ctx.body.system[0].text, original);
});

test("onRequest: no-op when system is missing", async () => {
  const ctx = { body: {}, headers: {}, meta: { outputEfficiencyReplacement: "text" } };
  await ext.onRequest(ctx);
  assert.equal(ctx.body.system, undefined);
});
