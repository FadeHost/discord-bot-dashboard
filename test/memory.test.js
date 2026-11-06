import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../src/memory.js";

test("memory is isolated by guild and user and survives a new store instance", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugar-memory-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = new MemoryStore(dir);
  first.addExchange("123456", "654321", "hello", "hi there");
  assert.deepEqual(first.getHistory("123456", "654321").map((item) => item.content), ["hello", "hi there"]);
  assert.deepEqual(first.getHistory("123457", "654321"), []);
  assert.deepEqual(new MemoryStore(dir).getHistory("123456", "654321").map((item) => item.role), ["user", "assistant"]);
});

test("memory clear removes only the selected user's history", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugar-memory-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new MemoryStore(dir);
  store.addExchange("123456", "654321", "hello", "hi");
  store.addExchange("123456", "654322", "hello", "hello back");
  store.clear("123456", "654321");
  assert.deepEqual(store.getHistory("123456", "654321"), []);
  assert.equal(store.getHistory("123456", "654322").length, 2);
});

test("memory bounds message count and rejects corrupt files without overwriting them", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugar-memory-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new MemoryStore(dir);
  for (let i = 0; i < 10; i += 1) store.addExchange("123456", "654321", `u${i}`, `a${i}`);
  assert.equal(store.getHistory("123456", "654321").length, 12);
  fs.writeFileSync(path.join(dir, "memory.json"), "{");
  assert.throws(() => new MemoryStore(dir), /invalid JSON/);
  assert.equal(fs.readFileSync(path.join(dir, "memory.json"), "utf8"), "{");
});
