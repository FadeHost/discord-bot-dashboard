import test from "node:test";
import assert from "node:assert/strict";

import { createDeepSeekClient } from "../src/deepseek.js";

function okResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("DeepSeek uses the official chat-completions endpoint and parses a mocked reply", async () => {
  let request;
  const generateReply = createDeepSeekClient({
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return okResponse({ choices: [{ message: { content: "  Hello there!  " } }] });
    },
  });

  assert.equal(await generateReply("How are you?"), "Hello there!");
  assert.equal(request.url, "https://api.deepseek.com/chat/completions");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, "Bearer test-key");

  const body = JSON.parse(request.options.body);
  assert.equal(body.model, "deepseek-flash");
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 300);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.messages[1].content, "How are you?");
  assert.match(body.messages[0].content, /sweet, playful, warm, and helpful/i);
});

test("DeepSeek errors do not expose provider response text or credentials", async () => {
  const generateReply = createDeepSeekClient({
    apiKey: "test-key",
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { message: "secret provider detail" } }), { status: 401 }),
  });

  await assert.rejects(generateReply("Hi"), (error) => {
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(error.message, /secret provider detail|test-key/);
    return true;
  });
});

test("DeepSeek request timeout aborts the request", async () => {
  let signal;
  const generateReply = createDeepSeekClient({
    apiKey: "test-key",
    timeoutMs: 5,
    fetchImpl: (_url, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });

  await assert.rejects(generateReply("Hi"), /timed out/);
  assert.equal(signal.aborted, true);
});

test("DeepSeek rejects oversized or malformed provider responses", async () => {
  const oversized = createDeepSeekClient({
    apiKey: "test-key",
    fetchImpl: async () => new Response("x".repeat(70 * 1024), { status: 200 }),
  });
  const malformed = createDeepSeekClient({
    apiKey: "test-key",
    fetchImpl: async () => new Response("{", { status: 200 }),
  });

  await assert.rejects(oversized("Hi"), /invalid response/);
  await assert.rejects(malformed("Hi"), /invalid response/);
});

test("DeepSeek requires a non-empty key when a client is created", () => {
  assert.throws(() => createDeepSeekClient({ apiKey: "  " }), /API key is required/);
});
