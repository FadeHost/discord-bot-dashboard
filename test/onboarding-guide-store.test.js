import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { OnboardingGuideStore } from "../src/onboarding-guide-store.js";

const CHANNEL_ID = "941800000000000420";
const MESSAGE_ID = "941800000000000421";

function makeDataDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugar-onboarding-guide-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

test("onboarding guide message IDs persist across store instances", (t) => {
  const dataDir = makeDataDir(t);
  const firstStore = new OnboardingGuideStore(dataDir);

  assert.equal(firstStore.getMessageId(CHANNEL_ID), null);
  firstStore.setMessageId(CHANNEL_ID, MESSAGE_ID);

  const restartedStore = new OnboardingGuideStore(dataDir);
  assert.equal(restartedStore.getMessageId(CHANNEL_ID), MESSAGE_ID);
});

test("invalid onboarding guide data is not overwritten", (t) => {
  const dataDir = makeDataDir(t);
  const file = path.join(dataDir, "onboarding-guide.json");
  const original = "{ invalid json";
  fs.writeFileSync(file, original);

  assert.throws(() => new OnboardingGuideStore(dataDir), /invalid JSON/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("onboarding guide store accepts only Discord snowflake IDs", (t) => {
  const store = new OnboardingGuideStore(makeDataDir(t));

  assert.throws(() => store.getMessageId("not-a-channel"), /valid Discord channel ID/);
  assert.throws(() => store.setMessageId(CHANNEL_ID, "not-a-message"), /valid Discord message ID/);
});
