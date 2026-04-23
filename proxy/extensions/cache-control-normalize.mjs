function stripCacheControlMarkers(msg) {
  if (!msg || msg.role !== "user" || !Array.isArray(msg.content)) return 0;
  let n = 0;
  for (let i = 0; i < msg.content.length; i++) {
    const block = msg.content[i];
    if (block && typeof block === "object" && block.cache_control) {
      const { cache_control, ...rest } = block;
      msg.content[i] = rest;
      n++;
    }
  }
  return n;
}

function countUserCacheControlMarkers(body) {
  if (!body || !Array.isArray(body.messages)) return 0;
  let n = 0;
  for (const msg of body.messages) {
    if (msg?.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block && typeof block === "object" && block.cache_control) n++;
    }
  }
  return n;
}

export { stripCacheControlMarkers, countUserCacheControlMarkers };

export default {
  name: "cache-control-normalize",
  description: "Strip scattered cache_control markers from user messages and apply canonical placement",
  order: 400,

  async onRequest(ctx) {
    const { body } = ctx;
    if (!Array.isArray(body.messages)) return;

    const markerCount = countUserCacheControlMarkers(body);
    if (markerCount === 0) return;

    for (const msg of body.messages) {
      if (msg.role === "user") {
        stripCacheControlMarkers(msg);
      }
    }

    // Apply canonical cache_control at the last block of the last user message
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const msg = body.messages[i];
      if (msg.role !== "user" || !Array.isArray(msg.content) || msg.content.length === 0) continue;
      const lastBlock = msg.content[msg.content.length - 1];
      if (lastBlock && typeof lastBlock === "object") {
        msg.content[msg.content.length - 1] = {
          ...lastBlock,
          cache_control: { type: "ephemeral" },
        };
      }
      break;
    }
  },
};
