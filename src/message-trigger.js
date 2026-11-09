const GREETING_PREFIX =
  /^(?:(?:hey|hi|hello|yo|okay|ok|excuse me|good morning|good afternoon|good evening)\b[\s,:!?-]*)+/i;
const NON_NAME_FOLLOWER = /^(?:daddy|mommy|momma|baby|rush|cookie|cookies|cake|candy|water|coffee|tea|soda|drink|food)\b/i;
const DIRECT_REQUEST =
  /^(?:can|could|would|will|do|did|are)\s+you\b|^(?:can|could|would)\s+i\s+ask\b|^(?:is that you|please\b|help\b|tell\b|explain\b|summari[sz]e\b|translate\b|what\b|why\b|how\b|when\b|where\b|who\b|quick question\b|i have a question\b|i need (?:some )?(?:help|advice|a hand|you|to ask)\b|i was wondering\b|i wanted to ask\b|we need to talk\b|thanks\b|thank you\b|forget\b|clear\b|let['’]s talk\b)/i;
const TRAILING_ADDRESS =
  /^(?:what|why|how|when|where|who|can|could|would|will|do|did|are|please|help|tell|explain|thanks|thank you|quick question|i have a question)\b/i;
const GREETING_ONLY = /^(?:hey|hi|hello|yo|good morning|good afternoon|good evening)[.!?]*$/i;

/**
 * Detect direct address locally. This function must run before any provider call.
 *
 * @param {string} content
 * @param {string|undefined} botUserId
 */
export function isAddressedToSugar(content, botUserId) {
  const text = String(content ?? "").trim();
  if (!text) return false;

  if (botUserId && hasBotMention(text, botUserId)) return true;

  const withoutGreeting = text.replace(GREETING_PREFIX, "").trimStart();
  const name = withoutGreeting.match(/^sugar\b(.*)$/i);

  if (name) {
    const remainder = name[1].trim();
    if (!remainder || GREETING_ONLY.test(remainder)) return true;
    if (NON_NAME_FOLLOWER.test(remainder)) return false;

    const afterName = remainder.replace(/^[,!:?]+\s*/, "").trimStart();
    return DIRECT_REQUEST.test(afterName);
  }

  const trailingName = text.match(/(?:^|[,!?]|\s)\s*sugar[.!?]*\s*$/i);
  if (!trailingName) return false;

  const beforeName = text.slice(0, trailingName.index).trim();
  return /[?]\s*$/.test(text) || TRAILING_ADDRESS.test(beforeName);
}

/**
 * Remove the bot's mention/name before sending only the addressed text to AI.
 * The resulting prompt is bounded independently of Discord's message limit.
 *
 * @param {string} content
 * @param {string|undefined} botUserId
 * @param {number} [maxLength]
 */
export function cleanAddressedMessage(content, botUserId, maxLength = 1_200) {
  let text = String(content ?? "");

  if (botUserId) {
    const escapedId = String(botUserId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`<@!?${escapedId}>`, "g"), " ");
  }

  text = text
    .replace(
      /^(?:(?:hey|hi|hello|yo|okay|ok|excuse me|good morning|good afternoon|good evening)\b[\s,:!?-]*)*sugar\b[\s,:!?-]*/i,
      "",
    )
    .replace(/(?:[,!?]\s*)sugar[.!?]*\s*$/i, "")
    .trim();

  return [...text].slice(0, maxLength).join("");
}

function hasBotMention(content, botUserId) {
  const escapedId = String(botUserId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<@!?${escapedId}>`).test(content);
}
