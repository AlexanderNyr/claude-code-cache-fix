const SECTION_HEADER = "# Output efficiency";
const REPLACEMENT_RAW = process.env.CACHE_FIX_OUTPUT_EFFICIENCY_REPLACEMENT || "";

function normalizeReplacement(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return "";
  return trimmed.startsWith(SECTION_HEADER) ? trimmed : `${SECTION_HEADER}\n\n${trimmed}`;
}

function replaceSection(text, replacement) {
  const start = text.indexOf(SECTION_HEADER);
  if (start === -1) return null;

  const afterHeader = start + SECTION_HEADER.length;
  const remainder = text.slice(afterHeader);
  const nextHeadingMatch = remainder.match(/\n# [^\n]+/);

  if (!nextHeadingMatch || nextHeadingMatch.index == null) {
    return text.slice(0, start) + replacement;
  }

  const nextHeadingStart = afterHeader + nextHeadingMatch.index + 1;
  return text.slice(0, start) + replacement + "\n\n" + text.slice(nextHeadingStart);
}

function rewriteOutputEfficiency(system, replacement) {
  if (!Array.isArray(system) || !replacement) return null;

  let changed = false;
  const rewritten = system.map((block) => {
    if (block?.type !== "text" || typeof block.text !== "string" || !block.text.includes(SECTION_HEADER)) {
      return block;
    }

    const nextText = replaceSection(block.text, replacement);
    if (!nextText || nextText === block.text) return block;

    changed = true;
    return { ...block, text: nextText };
  });

  return changed ? rewritten : null;
}

export { normalizeReplacement, replaceSection, rewriteOutputEfficiency, SECTION_HEADER };

export default {
  name: "output-efficiency-rewrite",
  description: "Replace Claude Code's # Output efficiency system prompt section with custom text",
  enabled: false,
  order: 90,

  async onRequest(ctx) {
    const raw = ctx.meta.outputEfficiencyReplacement ?? REPLACEMENT_RAW;
    const replacement = normalizeReplacement(raw);
    if (!replacement) return;
    if (!ctx.body.system) return;

    const result = rewriteOutputEfficiency(ctx.body.system, replacement);
    if (result) {
      ctx.body.system = result;
    }
  },
};
