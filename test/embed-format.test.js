import test from "node:test";
import assert from "node:assert/strict";

import { buildLogEmbed } from "../src/bot.js";
import { formatEmbedTitle, toRoyalBold } from "../src/embed-format.js";

test("Royal bold formatting converts Latin letters and preserves punctuation", () => {
  assert.equal(toRoyalBold("Before / After 123"), "𝓑𝓮𝓯𝓸𝓻𝓮 / 𝓐𝓯𝓽𝓮𝓻 123");
});

test("embed titles use Royal bold and end with one bow", () => {
  assert.equal(formatEmbedTitle("Member joined"), "𝓜𝓮𝓶𝓫𝓮𝓻 𝓳𝓸𝓲𝓷𝓮𝓭 🎀");
  assert.equal(formatEmbedTitle("Member joined 🎀"), "𝓜𝓮𝓶𝓫𝓮𝓻 𝓳𝓸𝓲𝓷𝓮𝓭 🎀");
  assert.throws(() => formatEmbedTitle("   "), /title is required/);
});

test("bot log embeds format titles and section headings without changing their content", () => {
  const embed = buildLogEmbed({
    title: "Message edited",
    color: 0xfbbf24,
    description: "Original message text stays readable.",
    fields: [
      { name: "Before", value: "First version" },
      { name: "After", value: "Second version" },
    ],
  });

  assert.equal(embed.data.title, "𝓜𝓮𝓼𝓼𝓪𝓰𝓮 𝓮𝓭𝓲𝓽𝓮𝓭 🎀");
  assert.equal(embed.data.description, "Original message text stays readable.");
  assert.deepEqual(
    embed.data.fields.map((field) => field.name),
    ["𝓑𝓮𝓯𝓸𝓻𝓮", "𝓐𝓯𝓽𝓮𝓻"],
  );
  assert.equal(embed.data.color, 0xfbbf24);
});
