function normalizeToolUseInputs(body) {
  if (!body || typeof body !== "object") return 0;
  if (!Array.isArray(body.messages) || !Array.isArray(body.tools)) return 0;

  const toolSchemas = Object.create(null);
  for (const tool of body.tools) {
    if (!tool || typeof tool !== "object") continue;
    const name = tool.name;
    if (typeof name !== "string") continue;
    const props = tool.input_schema?.properties;
    if (!props || typeof props !== "object") continue;
    toolSchemas[name] = Object.keys(props);
  }

  let modified = 0;
  for (const msg of body.messages) {
    if (!msg || msg.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;
    for (let i = 0; i < msg.content.length; i++) {
      const block = msg.content[i];
      if (!block || block.type !== "tool_use") continue;
      if (!block.input || typeof block.input !== "object" || Array.isArray(block.input)) continue;
      const schemaKeys = toolSchemas[block.name];
      if (!schemaKeys) continue;

      const currentKeys = Object.keys(block.input);
      const schemaKeySet = new Set(schemaKeys);
      const hasExtras = currentKeys.some((k) => !schemaKeySet.has(k));

      const presentSchemaKeys = schemaKeys.filter((k) =>
        Object.prototype.hasOwnProperty.call(block.input, k)
      );
      const currentInSchema = currentKeys.filter((k) => schemaKeySet.has(k));

      let orderDiffers = presentSchemaKeys.length !== currentInSchema.length;
      if (!orderDiffers) {
        for (let j = 0; j < presentSchemaKeys.length; j++) {
          if (presentSchemaKeys[j] !== currentInSchema[j]) {
            orderDiffers = true;
            break;
          }
        }
      }

      if (!hasExtras && !orderDiffers) continue;

      const newInput = {};
      for (const k of presentSchemaKeys) {
        newInput[k] = block.input[k];
      }
      msg.content[i] = { ...block, input: newInput };
      modified++;
    }
  }
  return modified;
}

export { normalizeToolUseInputs };

export default {
  name: "tool-input-normalize",
  description: "Normalize tool_use input field ordering to match schema for cache stability",
  enabled: false,
  order: 280,

  async onRequest(ctx) {
    if (!ctx.body.messages || !ctx.body.tools) return;
    const count = normalizeToolUseInputs(ctx.body);
    if (count > 0) {
      ctx.meta.toolInputNormalizeCount = count;
    }
  },
};
