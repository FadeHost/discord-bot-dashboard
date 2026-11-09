import test from "node:test";
import assert from "node:assert/strict";

import { resolveDeploymentVersion } from "../src/deployment-version.js";

const SHA = "a".repeat(40);

test("deployment version prefers a valid Git commit environment value", () => {
  let gitLookups = 0;
  const version = resolveDeploymentVersion({
    env: { GIT_COMMIT_SHA: ` ${SHA.toUpperCase()} `, GITHUB_SHA: "b".repeat(40) },
    gitRevision: () => {
      gitLookups += 1;
      return "c".repeat(40);
    },
  });

  assert.equal(version, SHA);
  assert.equal(gitLookups, 0);
});

test("deployment version falls back to the checked-out Git revision", () => {
  const version = resolveDeploymentVersion({
    env: { GIT_COMMIT_SHA: "not-a-commit" },
    gitRevision: () => `\n${SHA}\n`,
  });

  assert.equal(version, SHA);
});

test("deployment version is unknown when neither source provides a valid SHA", () => {
  const version = resolveDeploymentVersion({
    env: { GIT_COMMIT_SHA: "not-a-commit", GITHUB_SHA: "also-invalid" },
    gitRevision: () => {
      throw new Error("Git metadata is unavailable");
    },
  });

  assert.equal(version, "unknown");
});
