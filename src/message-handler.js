import { cleanAddressedMessage, isAddressedToSugar } from "./message-trigger.js";

const MAX_CONCURRENT_REQUESTS = 2;
const MAX_SEEN_MESSAGES = 500;
const DEDUPE_TTL_MS = 10 * 60 * 1000;
const MAX_REPLY_LENGTH = 1_800;
const BUSY_REPLY = "I’m helping a couple of people at once. Try me again in a moment.";
const FAILURE_REPLY = "I can’t reach my AI right now. Please try me again in a little bit.";
const CLEAR_MEMORY = /^(?:forget (?:me|our chat|our conversation)|clear (?:my )?memory|forget everything about me)[.!?]*$/i;

export function createMessageResponder({ generateReply, getBotUserId, memory, now = Date.now } = {}) {
  if (typeof generateReply !== "function") throw new Error("A reply generator is required.");
  let activeRequests = 0;
  const seenMessages = new Map();

  return async function respondToMessage(message) {
    if (!message?.guild || !message.author || message.author.bot || message.webhookId) return;
    const botUserId = getBotUserId?.();
    const isReplyToSugar = await referencesBotMessage(message, botUserId);
    if (!isAddressedToSugar(message.content, botUserId) && !isReplyToSugar) return;
    if (!rememberMessage(message.id, seenMessages, now())) return;
    if (activeRequests >= MAX_CONCURRENT_REQUESTS) { await safeReply(message, BUSY_REPLY); return; }

    const userMessage = cleanAddressedMessage(message.content, botUserId);
    const prompt = userMessage || (isReplyToSugar
      ? "The user replied to your previous message. Continue naturally, using the reply as context."
      : "The user addressed you by name but did not include a question. Reply with a brief, natural greeting.");
    activeRequests += 1;
    try {
      if (memory && CLEAR_MEMORY.test(prompt.trim())) {
        memory.clear(message.guild.id, message.author.id);
        await safeReply(message, "Of course ♡ I’ve cleared our saved conversation.");
        return;
      }
      const history = memory ? memory.getHistory(message.guild.id, message.author.id) : [];
      const profile = buildMemberContext(message.member, message.author);
      let reply;
      try { reply = await generateReply(prompt, history, profile); }
      catch {
        console.error("[ai] DeepSeek request failed; a friendly fallback was sent.");
        await safeReply(message, FAILURE_REPLY); return;
      }
      const text = [...String(reply ?? "").trim()].slice(0, MAX_REPLY_LENGTH).join("");
      if (text) {
        if (memory) memory.addExchange(message.guild.id, message.author.id, prompt, text);
        await safeReply(message, text);
      }
    } finally { activeRequests -= 1; }
  };
}

async function referencesBotMessage(message, botUserId) {
  if (!botUserId || !message.reference?.messageId) return false;
  try {
    const referenced = message.reference.message ?? await message.channel.messages.fetch(message.reference.messageId);
    return referenced?.author?.id === botUserId;
  } catch { return false; }
}

export function buildMemberContext(member, user) {
  return {
    username: user?.username ?? "",
    displayName: member?.displayName ?? user?.globalName ?? user?.username ?? "",
    roles: member?.roles?.cache
      ? member.roles.cache.filter((role) => role.name !== "@everyone").map((role) => role.name).slice(0, 20) : [],
    accountCreated: user?.createdAt?.toISOString?.() ?? "",
    memberSince: member?.joinedAt?.toISOString?.() ?? "",
  };
}

async function safeReply(message, content) {
  try { await message.reply({ content, allowedMentions: { parse: [], repliedUser: false } }); }
  catch { console.error("[ai] Could not send the Discord reply."); }
}

function rememberMessage(id, seenMessages, timestamp) {
  if (!id) return true;
  for (const [messageId, seenAt] of seenMessages) if (timestamp - seenAt >= DEDUPE_TTL_MS) seenMessages.delete(messageId);
  if (seenMessages.has(id)) return false;
  seenMessages.set(id, timestamp);
  while (seenMessages.size > MAX_SEEN_MESSAGES) seenMessages.delete(seenMessages.keys().next().value);
  return true;
}
