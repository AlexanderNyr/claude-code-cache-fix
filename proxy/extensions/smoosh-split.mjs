const TRAILING_SMOOSH = /\n\n(<system-reminder>\n(?:(?!<\/system-reminder>)[\s\S])*?\n<\/system-reminder>)\s*$/;

function splitSmooshedReminders(messages) {
  if (!Array.isArray(messages)) return { messages, stats: null };

  let totalPeeled = 0;

  const result = messages.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;

    const out = [];
    const peeledReminders = [];
    let mutated = false;

    for (const block of msg.content) {
      if (block?.type === "tool_result" && typeof block.content === "string") {
        const reminders = [];
        let s = block.content;
        while (true) {
          const m = s.match(TRAILING_SMOOSH);
          if (!m) break;
          reminders.unshift(m[1]);
          s = s.slice(0, m.index);
        }
        if (reminders.length > 0) {
          out.push({ ...block, content: s });
          for (const r of reminders) peeledReminders.push({ type: "text", text: r });
          totalPeeled += reminders.length;
          mutated = true;
          continue;
        }
      }
      out.push(block);
    }

    if (mutated) {
      return { ...msg, content: [...out, ...peeledReminders] };
    }
    return msg;
  });

  return {
    messages: totalPeeled > 0 ? result : messages,
    stats: totalPeeled > 0 ? { peeled: totalPeeled } : null,
  };
}

export { splitSmooshedReminders, TRAILING_SMOOSH };

export default {
  name: "smoosh-split",
  description: "Peel smooshed system-reminders from tool_result content into standalone blocks",
  enabled: false,
  order: 320,

  async onRequest(ctx) {
    if (!ctx.body.messages) return;

    const { messages, stats } = splitSmooshedReminders(ctx.body.messages);
    if (stats) {
      ctx.body.messages = messages;
      ctx.meta.smooshSplitStats = stats;
      process.stderr.write(
        `[smoosh-split] peeled ${stats.peeled} reminder(s) from tool_result.content\n`
      );
    }
  },
};
