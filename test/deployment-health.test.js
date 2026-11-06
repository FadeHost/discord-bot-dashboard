import test from "node:test";
import assert from "node:assert/strict";

import { verifyDeploymentHealth } from "../scripts/verify-deployment-health.js";

const EXPECTED_SHA = "a".repeat(40);
const HEALTH_URL = "https://sugar.fadehost.app/health";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("deployment verification accepts a healthy response for the expected commit", async () => {
  const result = await verifyDeploymentHealth({
    healthUrl: HEALTH_URL,
    expectedSha: EXPECTED_SHA,
    fetchImpl: async (url, options) => {
      assert.equal(url, HEALTH_URL);
      assert.equal(options.headers.accept, "application/json");
      return jsonResponse({ ok: true, version: EXPECTED_SHA });
    },
    attempts: 1,
  });

  assert.deepEqual(result, { attempts: 1, version: EXPECTED_SHA });
});

test("deployment verification retries until the expected commit is live", async () => {
  let calls = 0;
  const waits = [];
  const result = await verifyDeploymentHealth({
    healthUrl: HEALTH_URL,
    expectedSha: EXPECTED_SHA,
    attempts: 3,
    intervalMs: 15_000,
    sleep: async (milliseconds) => waits.push(milliseconds),
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({
        ok: true,
        version: calls < 3 ? "b".repeat(40) : EXPECTED_SHA,
      });
    },
  });

  assert.equal(calls, 3);
  assert.deepEqual(waits, [15_000, 15_000]);
  assert.deepEqual(result, { attempts: 3, version: EXPECTED_SHA });
});

test("deployment verification retries unhealthy HTTP responses without logging body text", async () => {
  let calls = 0;
  const diagnostics = [];
  await assert.rejects(
    verifyDeploymentHealth({
      healthUrl: HEALTH_URL,
      expectedSha: EXPECTED_SHA,
      attempts: 2,
      intervalMs: 0,
      sleep: async () => {},
      onRetry: (info) => diagnostics.push(info),
      fetchImpl: async () => {
        calls += 1;
        return new Response("sensitive diagnostic payload", { status: 503 });
      },
    }),
    (error) => {
      assert.match(error.message, /failed after 2 attempts/);
      assert.match(error.message, /HTTP 503/);
      assert.doesNotMatch(error.message, /sensitive diagnostic payload/);
      return true;
    },
  );

  assert.equal(calls, 2);
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[0].lastResult, "HTTP 503");
});

test("deployment failure reports the most recent retry result", async () => {
  let calls = 0;
  const diagnostics = [];
  await assert.rejects(
    verifyDeploymentHealth({
      healthUrl: HEALTH_URL,
      expectedSha: EXPECTED_SHA,
      attempts: 2,
      intervalMs: 0,
      sleep: async () => {},
      onRetry: (info) => diagnostics.push(info),
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? new Response("starting", { status: 503 })
          : new Response("{invalid json", { status: 200 });
      },
    }),
    (error) => {
      assert.match(error.message, /HTTP 200 with invalid or oversized JSON/);
      assert.doesNotMatch(error.message, /HTTP 503/);
      return true;
    },
  );

  assert.equal(calls, 2);
  assert.deepEqual(
    diagnostics.map(({ lastResult }) => lastResult),
    ["HTTP 503", "HTTP 200 with invalid or oversized JSON"],
  );
});

test("deployment verification requires ok=true and an exact commit match", async () => {
  await assert.rejects(
    verifyDeploymentHealth({
      healthUrl: HEALTH_URL,
      expectedSha: EXPECTED_SHA,
      attempts: 1,
      fetchImpl: async () => jsonResponse({ ok: false, version: EXPECTED_SHA }),
    }),
    /ok=false/,
  );

  await assert.rejects(
    verifyDeploymentHealth({
      healthUrl: HEALTH_URL,
      expectedSha: EXPECTED_SHA,
      attempts: 1,
      fetchImpl: async () => jsonResponse({ ok: true, version: "b".repeat(40) }),
    }),
    new RegExp(`serving ${"b".repeat(40)}`),
  );
});

test("deployment verification rejects unsafe URLs and invalid expected SHAs", async () => {
  let calls = 0;
  const options = {
    expectedSha: EXPECTED_SHA,
    attempts: 1,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ ok: true, version: EXPECTED_SHA });
    },
  };

  await assert.rejects(
    verifyDeploymentHealth({ ...options, healthUrl: "http://sugar.fadehost.app/health" }),
    /valid HTTPS URL/,
  );
  await assert.rejects(
    verifyDeploymentHealth({ ...options, healthUrl: "https://sugar.fadehost.app/" }),
    /ending in \/health/,
  );
  await assert.rejects(
    verifyDeploymentHealth({ ...options, healthUrl: HEALTH_URL, expectedSha: "not-a-sha" }),
    /40 hexadecimal characters/,
  );
  assert.equal(calls, 0);
});
