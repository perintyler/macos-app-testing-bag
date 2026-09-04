/**
 * The one process boundary: everything reaches the accessibility tree by
 * running the `axprobe` binary, never by shelling out ad hoc.
 *
 * Two properties this file exists to guarantee:
 *
 *  1. Arguments travel as argv, never interpolated into a shell string. A
 *     selector or output path is user data and must not be able to become a
 *     command.
 *  2. Every run is bounded and SIGKILLed on timeout. A process blocked inside
 *     an AX call on an unresponsive app does not reliably die on SIGTERM, and a
 *     hung probe would otherwise hang the session that called it.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AxProbeError, classifyProbeFailure } from "./classify-error.js";

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the bag's source lives, which is NOT where this module runs from.
 *
 * Barry bundles a bag's tools into ~/Library/Caches/Barry/bags/<name>-<hash>/
 * before running them, so in production `import.meta.url` resolves into the
 * cache and a path relative to it points at nothing. The Swift binary stays in
 * the bag, so the bag directory has to be found rather than assumed:
 *
 *  1. BARRY_BAG_DIR / MACOS_APP_TESTING_DIR, when something sets it explicitly.
 *  2. Relative to this module — correct in dev (running from src/) and for a
 *     bundle that happens to sit in the bag.
 *  3. The conventional checkout, which is where `barry install` registered it
 *     from and where `swift build` puts the binary.
 *
 * Every candidate is probed for the binary rather than trusted, so a wrong
 * guess falls through to the next instead of failing as "not built".
 */
function candidateRoots(): string[] {
  const fromEnv = process.env.MACOS_APP_TESTING_DIR ?? process.env.BARRY_BAG_DIR;
  return [
    ...(fromEnv ? [fromEnv] : []),
    resolve(HERE, ".."),
    resolve(HERE, "../.."),
    resolve(homedir(), "repos/bags/macos-app-testing"),
  ];
}

/**
 * Release before debug: a stale debug build left over from development would
 * otherwise silently win over a fresh release one.
 */
function buildPaths(): string[] {
  return candidateRoots().flatMap((root) => [
    resolve(root, ".build/release/axprobe"),
    resolve(root, ".build/debug/axprobe"),
  ]);
}

/** Default ceiling for a probe run. Waits are bounded by their own --timeout. */
const DEFAULT_TIMEOUT_MS = 30_000;

export function probeBinaryPath(): string | null {
  return buildPaths().find((p) => existsSync(p)) ?? null;
}

/**
 * Locate the built probe, or explain how to build it. Reported as a normal
 * failure rather than a thrown ENOENT so the caller sees the fix.
 */
function requireBinary(): string {
  const found = probeBinaryPath();
  if (found) return found;
  throw new AxProbeError(
    "ax-error",
    "axprobe is not built. Run `swift build -c release` in the macos-app-testing bag " +
      `(looked in: ${candidateRoots().join(", ")}), or set MACOS_APP_TESTING_DIR to it.`,
    [],
    "",
  );
}

export interface ProbeResult {
  ok: boolean;
  [key: string]: unknown;
}

/**
 * Run one probe command and parse its JSON result.
 *
 * `timeoutSeconds` is the probe's own polling budget; the process ceiling is
 * derived from it so a `wait --timeout 20` is not killed at 10s by the runner
 * that asked for it.
 */
export async function runProbe(
  args: string[],
  options: { timeoutSeconds?: number } = {},
): Promise<ProbeResult> {
  const binary = requireBinary();
  const pollMs = (options.timeoutSeconds ?? 0) * 1000;
  const timeout = Math.max(DEFAULT_TIMEOUT_MS, pollMs + 10_000);

  try {
    const { stdout } = await execFileAsync(binary, args, {
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: 32 * 1024 * 1024, // a deep AX snapshot is large; truncation would corrupt the JSON
    });
    return JSON.parse(stdout) as ProbeResult;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; code?: number | string; killed?: boolean };
    if (err.killed) {
      throw new AxProbeError(
        "timeout",
        `axprobe did not finish within ${Math.round(timeout / 1000)}s — the target app may be unresponsive.`,
        [],
        err.stdout ?? "",
      );
    }
    // A nonzero exit is the probe's normal failure channel: it still printed a
    // JSON body, which carries the kind.
    throw classifyProbeFailure(err.stdout ?? "", typeof err.code === "number" ? err.code : null);
  }
}

/** Build the shared `--app` / `--timeout` / `--selector` argument tail. */
export function probeArgs(
  command: string,
  opts: { app?: string; selector?: string; timeoutSeconds?: number; extra?: string[] },
): string[] {
  const args = [command];
  if (opts.app) args.push("--app", opts.app);
  if (opts.selector) args.push("--selector", opts.selector);
  if (opts.timeoutSeconds && opts.timeoutSeconds > 0) args.push("--timeout", String(opts.timeoutSeconds));
  if (opts.extra) args.push(...opts.extra);
  return args;
}
