function sortSkillsBlock(text) {
  const match = text.match(
    /^([\s\S]*?\n\n)(- [\s\S]+?)(\n<\/system-reminder>\s*)$/
  );
  if (!match) return text;
  const [, header, entriesText, footer] = match;
  const entries = entriesText.split(/\n(?=- )/);
  entries.sort();
  return header + entries.join("\n") + footer;
}

function sortDeferredToolsBlock(text) {
  const match = text.match(
    /^(<system-reminder>\nThe following deferred tools are now available[^\n]*\n)([\s\S]+?)(\n<\/system-reminder>\s*)$/
  );
  if (!match) return text;
  const [, header, toolsList, footer] = match;
  const tools = toolsList.split("\n").map((t) => t.trim()).filter(Boolean);
  tools.sort();
  return header + tools.join("\n") + footer;
}

function isSkillsBlock(text) {
  return typeof text === "string" && text.includes("User-invocable skills");
}

function isDeferredToolsBlock(text) {
  return typeof text === "string" && text.includes("deferred tools are now available");
}

export { sortSkillsBlock, sortDeferredToolsBlock, isSkillsBlock, isDeferredToolsBlock };

export default {
  name: "sort-stabilization",
  description: "Deterministic ordering of skills, deferred tools, and tool definitions",
  order: 200,

  async onRequest(ctx) {
    const { body } = ctx;

    if (Array.isArray(body.system)) {
      for (let i = 0; i < body.system.length; i++) {
        const block = body.system[i];
        if (block.type !== "text" || typeof block.text !== "string") continue;

        if (isSkillsBlock(block.text)) {
          const sorted = sortSkillsBlock(block.text);
          if (sorted !== block.text) {
            body.system[i] = { ...block, text: sorted };
          }
        } else if (isDeferredToolsBlock(block.text)) {
          const sorted = sortDeferredToolsBlock(block.text);
          if (sorted !== block.text) {
            body.system[i] = { ...block, text: sorted };
          }
        }
      }
    }

    if (Array.isArray(body.tools)) {
      body.tools.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    }
  },
};
