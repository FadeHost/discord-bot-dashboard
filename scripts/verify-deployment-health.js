import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA_PATTERN = /^[a-f0-9]{40}$/i;
const MAX_HEALTH_BODY_BYTES = 16 * 1024;
const DEFAULT_ATTEMPTS = 20;
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Wait for the deployed process to serve the expected commit.
 *
 * @param {{
 *   healthUrl?: string,
 *   expectedSha?: string,
 *   fetchImpl?: typeof fetch,
 *   attempts?: number,
 *   intervalMs?: number,
 *   timeoutMs?: number,
 *   sleep?: (milliseconds: number) => Promise<void>,
 *   onRetry?: (info: {attempt: number, maxAttempts: number, lastResult: string}) => void,
 * }} [options]
 */
export async function verifyDeploymentHealth({
  healthUrl,
  expectedSha,
  fetchImpl = globalThis.fetch,
  attempts = DEFAULT_ATTEMPTS,
  intervalMs = DEFAULT_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sleep = delay,
  onRetry = () => {},
} = {}) {
  const endpoint = validateHealthUrl(healthUrl);
  const expectedVersion = normalizeSha(expectedSha);
  if (!expectedVersion) throw new Error("Expected commit SHA must contain 40 hexadecimal characters.");
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 100) {
    throw new Error("Health check attempts must be an integer from 1 to 100.");
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 300_000) {
    throw new Error("Health check interval must be an integer from 0 to 300000 milliseconds.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("Health check timeout must be an integer from 1 to 60000 milliseconds.");
  }

  let lastResult = "no response";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let attemptResult = "request failed";

    try {
      const response = await fetchImpl(endpoint, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });

      if (response.status !== 200) {
        attemptResult = `HTTP ${response.status}`;
        await cancelBody(response);
      } else {
        let payload;
        let invalidJson = false;
        try {
          payload = await readLimitedJson(response);
        } catch {
          attemptResult = "HTTP 200 with invalid or oversized JSON";
          invalidJson = true;
        }

        if (!invalidJson) {
          if (payload && typeof payload === "object" && !Array.isArray(payload)) {
            if (payload.ok !== true) {
              attemptResult = "HTTP 200 with ok=false";
            } else {
              const observedVersion = normalizeSha(payload.version) ?? "unknown";
              if (observedVersion === expectedVersion) {
                return { attempts: attempt, version: expectedVersion };
              }
              attemptResult = `HTTP 200, healthy but serving ${observedVersion}`;
            }
          } else {
            attemptResult = "HTTP 200 with invalid JSON shape";
          }
        }
      }
    } catch {
      attemptResult = controller.signal.aborted ? "request timed out" : "request failed";
    } finally {
      clearTimeout(timer);
    }

    lastResult = attemptResult;
    onRetry({ attempt, maxAttempts: attempts, lastResult });
    if (attempt < attempts) await sleep(intervalMs);
  }

  throw new Error(
    `FadeHost health verification failed after ${attempts} attempts; ` +
      `expected version ${expectedVersion}; last result: ${lastResult}.`,
  );
}

function validateHealthUrl(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("FADEHOST_HEALTH_URL must be a valid HTTPS URL ending in /health.");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname.replace(/\/+$/, "") !== "/health"
  ) {
    throw new Error("FADEHOST_HEALTH_URL must be a valid HTTPS URL ending in /health.");
  }
  return endpoint.href;
}

function normalizeSha(value) {
  if (typeof value !== "string" || !SHA_PATTERN.test(value.trim())) return null;
  return value.trim().toLowerCase();
}

async function readLimitedJson(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_HEALTH_BODY_BYTES) throw new Error("Health response is too large.");
    return JSON.parse(text);
  }

  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_HEALTH_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("Health response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function cancelBody(response) {
  try {
    await response.body?.cancel?.();
  } catch {
    // The status code is sufficient for diagnostics.
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runFromCommandLine() {
  const result = await verifyDeploymentHealth({
    healthUrl: process.env.FADEHOST_HEALTH_URL,
    expectedSha: process.env.EXPECTED_SHA ?? process.env.GITHUB_SHA,
    onRetry: ({ attempt, maxAttempts, lastResult }) => {
      console.log(`[deploy-health] attempt ${attempt}/${maxAttempts}: ${lastResult}`);
    },
  });

  console.log(
    `[deploy-health] FadeHost is healthy on expected commit ${result.version} ` +
      `(attempt ${result.attempts}).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runFromCommandLine().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
