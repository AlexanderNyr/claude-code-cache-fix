const KEEP_LAST = parseInt(process.env.CACHE_FIX_IMAGE_KEEP_LAST || "0", 10);
const PLACEHOLDER = "[image stripped from history — file may still be on disk]";

function stripOldToolResultImages(messages, keepLast) {
  if (!keepLast || keepLast <= 0 || !Array.isArray(messages)) {
    return { messages, stats: null };
  }

  const userMsgIndices = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") userMsgIndices.push(i);
  }

  if (userMsgIndices.length <= keepLast) {
    return { messages, stats: null };
  }

  const cutoffIdx = userMsgIndices[userMsgIndices.length - keepLast];

  let strippedCount = 0;
  let strippedBytes = 0;

  const result = messages.map((msg, msgIdx) => {
    if (msg.role !== "user" || msgIdx >= cutoffIdx || !Array.isArray(msg.content)) {
      return msg;
    }

    let msgModified = false;
    const newContent = msg.content.map((block) => {
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        let toolModified = false;
        const newToolContent = block.content.map((item) => {
          if (item.type === "image") {
            strippedCount++;
            if (item.source?.data) {
              strippedBytes += item.source.data.length;
            }
            toolModified = true;
            return { type: "text", text: PLACEHOLDER };
          }
          return item;
        });
        if (toolModified) {
          msgModified = true;
          return { ...block, content: newToolContent };
        }
      }
      return block;
    });

    return msgModified ? { ...msg, content: newContent } : msg;
  });

  const stats = strippedCount > 0
    ? { strippedCount, strippedBytes, estimatedTokens: Math.ceil(strippedBytes * 0.125) }
    : null;

  return { messages: strippedCount > 0 ? result : messages, stats };
}

export { stripOldToolResultImages, PLACEHOLDER };

export default {
  name: "image-strip",
  description: "Strip base64 images from old tool results to reduce token waste",
  enabled: false,
  order: 150,

  async onRequest(ctx) {
    const keepLast = parseInt(ctx.meta.imageKeepLast ?? KEEP_LAST, 10);
    if (!keepLast || keepLast <= 0) return;
    if (!ctx.body.messages) return;

    const { messages, stats } = stripOldToolResultImages(ctx.body.messages, keepLast);
    if (stats) {
      ctx.body.messages = messages;
      ctx.meta.imageStripStats = stats;
      process.stderr.write(
        `[image-strip] stripped ${stats.strippedCount} images (~${stats.estimatedTokens} tokens saved)\n`
      );
    }
  },
};
