/**
 * Turning an axprobe failure into something a caller can branch on.
 *
 * The probe reports every failure as JSON on stdout with a nonzero exit —
 * `{"ok": false, "error": "<kind>", "message": "..."}` — so the kind is read
 * from a stable field rather than pattern-matched out of prose. Message text is
 * for humans and may be reworded; the kind is the contract.
 *
 * Modeled on macos-pages/src/classify-error.ts, including its central rule:
 * an unrecognized kind falls through with its message passed through verbatim,
 * because guessing at an unknown failure hides it.
 */

export type AxErrorKind =
  | "permission-denied"
  | "app-not-running"
  | "not-found"
  | "no-windows"
  | "unhealthy-window"
  | "usage"
  | "timeout"
  | "ax-error";

export class AxProbeError extends Error {
  readonly kind: AxErrorKind;
  readonly problems: string[];
  readonly raw: string;

  constructor(kind: AxErrorKind, message: string, problems: string[], raw: string) {
    super(message);
    this.name = "AxProbeError";
    this.kind = kind;
    this.problems = problems;
    this.raw = raw;
  }
}

/** Kinds the probe emits verbatim. Anything else becomes `ax-error`. */
const KNOWN_KINDS = new Set<string>([
  "permission-denied",
  "app-not-running",
  "not-found",
  "no-windows",
  "unhealthy-window",
  "usage",
  "timeout",
]);

/**
 * A denied Accessibility grant is the one failure that must never be softened
 * into an empty result: every query returns nothing when it is missing, which
 * reads exactly like "the app has no such element". The remedy travels with the
 * error so the caller does not have to know it.
 */
export const PERMISSION_REMEDY =
  "Grant Accessibility permission in System Settings → Privacy & Security → Accessibility " +
  "to the process running these tools (your terminal, or the Barry runner), then re-run.";

export interface ProbeFailure {
  error?: unknown;
  message?: unknown;
  problems?: unknown;
}

/**
 * Classify a finished probe run. Pure in `(stdout, exitCode)` so it is testable
 * without spawning anything.
 */
export function classifyProbeFailure(stdout: string, exitCode: number | null): AxProbeError {
  const trimmed = stdout.trim();
  let parsed: ProbeFailure | null = null;
  try {
    parsed = trimmed ? (JSON.parse(trimmed) as ProbeFailure) : null;
  } catch {
    // Not JSON — the probe crashed before it could report, so the raw output is
    // the only evidence there is. Passing it through beats inventing a kind.
    parsed = null;
  }

  const rawKind = typeof parsed?.error === "string" ? parsed.error : null;
  const kind: AxErrorKind = rawKind && KNOWN_KINDS.has(rawKind) ? (rawKind as AxErrorKind) : "ax-error";

  const problems = Array.isArray(parsed?.problems)
    ? parsed.problems.filter((p): p is string => typeof p === "string")
    : [];

  let message =
    typeof parsed?.message === "string" && parsed.message
      ? parsed.message
      : trimmed || `axprobe exited ${exitCode ?? "with no status"} and produced no output`;

  if (problems.length > 0) message = `${message}: ${problems.join("; ")}`;
  if (kind === "permission-denied" && !message.includes("System Settings")) {
    message = `${message} ${PERMISSION_REMEDY}`;
  }

  return new AxProbeError(kind, message, problems, trimmed);
}
