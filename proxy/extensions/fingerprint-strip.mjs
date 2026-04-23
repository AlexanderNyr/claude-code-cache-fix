import { createHash } from "node:crypto";

const FINGERPRINT_SALT = "59cf53e54c78";
const FINGERPRINT_INDICES = [4, 7, 20];

function computeFingerprint(messageText, version) {
  const chars = FINGERPRINT_INDICES.map((i) => messageText[i] || "0").join("");
  const input = `${FINGERPRINT_SALT}${chars}${version}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 3);
}

function extractRealUserMessageText(messages) {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const content = msg.content;
    if (!Array.isArray(content)) {
      if (typeof content === "string" && !content.startsWith("<system-reminder>")) {
        return content;
      }
      continue;
    }
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string" && !block.text.startsWith("<system-reminder>")) {
        return block.text;
      }
    }
  }
  return "";
}

function extractFirstMessageText(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const first = messages[0];
  if (!first || first.role !== "user") return "";
  const content = first.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return "";
}

function stabilizeFingerprint(system, messages) {
  if (!Array.isArray(system)) return null;

  const attrIdx = system.findIndex(
    (b) => b.type === "text" && typeof b.text === "string" && b.text.includes("x-anthropic-billing-header:")
  );
  if (attrIdx === -1) return null;

  const attrBlock = system[attrIdx];
  const versionMatch = attrBlock.text.match(/cc_version=([^;]+)/);
  if (!versionMatch) return null;

  const fullVersion = versionMatch[1];
  const dotParts = fullVersion.split(".");
  if (dotParts.length < 4) return null;

  const baseVersion = dotParts.slice(0, 3).join(".");
  const oldFingerprint = dotParts[3];

  const realText = extractRealUserMessageText(messages);
  const realVerification = computeFingerprint(realText, baseVersion);
  const legacyText = extractFirstMessageText(messages);
  const legacyVerification = computeFingerprint(legacyText, baseVersion);

  let verificationPassed = false;
  if (realVerification === oldFingerprint) {
    verificationPassed = true;
  } else if (legacyVerification === oldFingerprint) {
    verificationPassed = true;
  }

  if (!verificationPassed) return null;

  const stableFingerprint = computeFingerprint(realText, baseVersion);
  if (stableFingerprint === oldFingerprint) return null;

  const newVersion = `${baseVersion}.${stableFingerprint}`;
  const newText = attrBlock.text.replace(
    `cc_version=${fullVersion}`,
    `cc_version=${newVersion}`
  );

  return { attrIdx, newText, oldFingerprint, stableFingerprint };
}

export { computeFingerprint, extractRealUserMessageText, extractFirstMessageText, stabilizeFingerprint };

export default {
  name: "fingerprint-strip",
  description: "Stabilize cc_version fingerprint in system prompt for cache prefix consistency",
  order: 100,

  async onRequest(ctx) {
    const { body } = ctx;
    if (!body.system || !body.messages) return;

    const result = stabilizeFingerprint(body.system, body.messages);
    if (result) {
      body.system[result.attrIdx] = { ...body.system[result.attrIdx], text: result.newText };
    }
  },
};
