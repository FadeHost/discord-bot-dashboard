const SCRIPT_CAPITAL_A = 0x1d4d0;
const SCRIPT_LOWERCASE_A = 0x1d4ea;

/** Format Latin letters with Mathematical Bold Script (Royal) Unicode characters. */
export function toRoyalBold(value) {
  return [...String(value ?? "")]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      if (codePoint >= 0x41 && codePoint <= 0x5a) {
        return String.fromCodePoint(SCRIPT_CAPITAL_A + codePoint - 0x41);
      }
      if (codePoint >= 0x61 && codePoint <= 0x7a) {
        return String.fromCodePoint(SCRIPT_LOWERCASE_A + codePoint - 0x61);
      }
      return character;
    })
    .join("");
}

/** Format every Sugar embed title consistently and add one trailing bow. */
export function formatEmbedTitle(value) {
  const title = String(value ?? "")
    .trim()
    .replace(/(?:\s*🎀)+$/u, "")
    .trim();
  if (!title) throw new Error("An embed title is required.");
  return `${toRoyalBold(title)} 🎀`;
}
