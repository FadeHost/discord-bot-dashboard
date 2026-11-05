import { cleanAddressedMessage, isAddressedToSugar } from "./message-trigger.js";

const MAX_CONCURRENT_REQUESTS = 2;
const MAX_SEEN_MESSAGES = 500;
const DEDUPE_TTL_MS = 10 * 60 * 1000;
const MAX_REPLY_LENGTH = 1_800;
const BUSY_REPLY = "I’m helping a couple of people at once. Try me again in a moment.";
const FAILURE_REPLY = "I can’t reach my AI right now. Please try me again in a little bit.";

/**
 * Make a bounded Discord message handler. Only locally detected direct
 * addresses reach generateReply; no message is sent for intent classification.
 *
 * @param {object} options
 * @param {(message: string) => Promise<string>} options.generateReply
 * @param {() => string|undefined} options.getBotUserId
 * @param {() => number} [options.now]
 */
export function createMessageResponder({ generateReply, getBotUserId, now = Date.now } = {}) {
  if (typeof generateReply !== "function") {
    throw new Error("A reply generator is required.");
  }

  let activeRequests = 0;
  const seenMessages = new Map();

  return async function respondToMessage(message) {
    if (!message?.guild || !message.author || message.author.bot || message.webhookId) return;

    const botUserId = getBotUserId?.();
    if (!isAddressedToSugar(message.content, botUserId)) return;
    if (!rememberMessage(message.id, seenMessages, now())) return;

    if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
      await safeReply(message, BUSY_REPLY);
      return;
    }

    const userMessage = cleanAddressedMessage(message.content, botUserId);
    const prompt =
      userMessage ||
      "The user addressed you by name but did not include a question. Reply with a brief, friendly greeting.";

    activeRequests += 1;
    try {
      let reply;
      try {
        reply = await generateReply(prompt);
      } catch {
        console.error("[ai] DeepSeek request failed; a friendly fallback was sent.");
        await safeReply(message, FAILURE_REPLY);
        return;
      }

      const text = [...String(reply ?? "").trim()].slice(0, MAX_REPLY_LENGTH).join("");
      if (text) await safeReply(message, text);
    } finally {
      activeRequests -= 1;
    }
  };
}

async function safeReply(message, content) {
  try {
    await message.reply({
      content,
      allowedMentions: { parse: [], repliedUser: false },
    });
  } catch {
    console.error("[ai] Could not send the Discord reply.");
  }
}

function rememberMessage(id, seenMessages, timestamp) {
  if (!id) return true;

  for (const [messageId, seenAt] of seenMessages) {
    if (timestamp - seenAt >= DEDUPE_TTL_MS) seenMessages.delete(messageId);
  }

  if (seenMessages.has(id)) return false;
  seenMessages.set(id, timestamp);

  while (seenMessages.size > MAX_SEEN_MESSAGES) {
    seenMessages.delete(seenMessages.keys().next().value);
  }

  return true;
}
