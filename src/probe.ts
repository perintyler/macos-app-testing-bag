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
  // An explicit override is AUTHORITATIVE, not merely first. Falling through to
  // another checkout when it does not pan out would run a binary the caller did
  // not point at and report success — the wrong-target failure this bag refuses
  // elsewhere by making an ambiguous app a hard error.
  const fromEnv = process.env.MACOS_APP_TESTING_DIR ?? process.env.BARRY_BAG_DIR;
  if (fromEnv) return [fromEnv];
  return [
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

/** A candidate root is the bag itself only if it carries the probe's sources. */
function packageRoot(): string | null {
  return candidateRoots().find((root) => existsSync(resolve(root, "Package.swift"))) ?? null;
}

/**
 * One build at a time, shared by every caller in this process.
 *
 * Tool handlers run concurrently, so without this a session calling three
 * tools at once would start three `swift build`s against the same .build
 * directory. SwiftPM takes its own file lock, so they would serialize anyway —
 * but each would pay full latency and the failure text would interleave.
 */
let building: Promise<string> | null = null;

async function buildBinary(root: string): Promise<string> {
  // `swift build` is quiet on success and writes diagnostics to stderr; a
  // failure here is a real problem (no toolchain, broken source) and must not
  // be reported as "not built", which would send the caller in a circle.
  try {
    await execFileAsync("swift", ["build", "-c", "release"], {
      cwd: root,
      timeout: 300_000, // a cold first build resolves the toolchain and can take minutes
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    // SwiftPM prints compiler diagnostics to STDOUT, not stderr — reading only
    // stderr drops the actual reason and leaves a generic "is the toolchain
    // installed?", which sends the caller after the wrong problem.
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const output = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
    const detail = output ? output.split("\n").slice(-8).join("\n") : "";
    throw new AxProbeError(
      "ax-error",
      `axprobe is missing and \`swift build -c release\` failed in ${root}.` +
        (detail ? `\n${detail}` : " No output from swift — is the toolchain installed?"),
      [],
      detail,
    );
  }

  const built = probeBinaryPath();
  if (built) return built;
  // The build reported success and the binary still is not there — say exactly
  // that rather than looping or claiming a build is needed again.
  throw new AxProbeError(
    "ax-error",
    `\`swift build -c release\` succeeded in ${root} but no axprobe binary appeared under .build/.`,
    [],
    "",
  );
}

/**
 * Locate the built probe, building it once on demand if it is missing.
 *
 * The binary is a build product that does not survive a fresh clone, and
 * `barry install` does not build it — so without this the bag registers, loads
 * all its tools, and fails on the first real call. Building on demand costs one
 * compile the first time and nothing afterwards.
 */
async function requireBinary(): Promise<string> {
  const found = probeBinaryPath();
  if (found) return found;

  const root = packageRoot();
  if (!root) {
    throw new AxProbeError(
      "ax-error",
      "axprobe is not built and its sources were not found " +
        `(looked in: ${candidateRoots().join(", ")}). ` +
        "Set MACOS_APP_TESTING_DIR to the macos-app-testing bag directory.",
      [],
      "",
    );
  }

  building ??= buildBinary(root).finally(() => {
    building = null;
  });
  return building;
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
  const binary = await requireBinary();
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
