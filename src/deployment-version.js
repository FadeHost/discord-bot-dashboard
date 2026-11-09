import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA_PATTERN = /^[a-f0-9]{40}$/i;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_ENVIRONMENT_VARIABLES = ["GIT_COMMIT_SHA", "GITHUB_SHA"];

/**
 * Resolve the deployed source revision without returning arbitrary environment
 * values. FadeHost does not document a commit-SHA environment variable, so use
 * the checked-out Git metadata when no standard revision variable is present.
 *
 * @param {{env?: NodeJS.ProcessEnv, gitRevision?: () => string}} [options]
 */
export function resolveDeploymentVersion({ env = process.env, gitRevision = readGitRevision } = {}) {
  for (const name of VERSION_ENVIRONMENT_VARIABLES) {
    const value = env[name]?.trim();
    if (value && SHA_PATTERN.test(value)) return value.toLowerCase();
  }

  try {
    const value = gitRevision().trim();
    if (SHA_PATTERN.test(value)) return value.toLowerCase();
  } catch {
    // The deployed files may not include Git metadata. Report that explicitly.
  }

  return "unknown";
}

function readGitRevision() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1_000,
  });
}
