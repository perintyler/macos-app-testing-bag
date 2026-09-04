import { defineTool } from "@barry/tools";
import { z } from "zod";
import { probeArgs, runProbe } from "./probe.js";

const NS = "macos-app-testing";

/**
 * How a target app is named. Bundle id is preferred: it is stable across
 * localizations and rebuilds, whereas the display name is not.
 */
const appSchema = {
  app: z.string().describe("Target app — bundle id (com.barry.actions) or display name (Barry Actions)"),
  pid: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Process id, when several processes share the bundle id (a built copy alongside an installed one)"),
};

const selectorHelp =
  "Selector: `id=Foo` (exact AXIdentifier), `id^=turn-` (prefix), `role=AXButton`, " +
  "`title=Save`, `title*=Sav`. Bare text is treated as `id=`.";

function withPid(pid: number | undefined): string[] {
  return pid ? ["--pid", String(pid)] : [];
}

export const status = defineTool({
  namespace: NS,
  access: "read",
  name: "status",
  description:
    "Whether UI testing can run at all: is Accessibility permission granted, and is the target app running. " +
    "Lists every process matching the app so an ambiguous target is visible before an assertion depends on it.",
  schema: { app: z.string().optional().describe("Optional app to also report on") },
  handler: async ({ app }) => runProbe(app ? ["status", "--app", app] : ["status"]),
});

export const listRunningApps = defineTool({
  namespace: NS,
  access: "read",
  name: "list_running_apps",
  description: "Running applications with their bundle ids and pids — how to find the name to pass as `app`.",
  schema: {},
  handler: async () => runProbe(["list-apps"]),
});

export const snapshotUi = defineTool({
  namespace: NS,
  access: "read",
  name: "snapshot_ui",
  description:
    "The app's accessibility tree as JSON — identifiers, roles, titles, values and frames. " +
    "Use this to discover selectors, the way a browser snapshot is used before clicking.",
  schema: {
    ...appSchema,
    max_depth: z.number().int().min(1).max(100).optional().describe("How deep to walk (default 40)"),
  },
  handler: async ({ app, pid, max_depth }) =>
    runProbe([
      ...probeArgs("snapshot", { app }),
      ...withPid(pid),
      ...(max_depth ? ["--max-depth", String(max_depth)] : []),
    ]),
});

export const listWindows = defineTool({
  namespace: NS,
  access: "read",
  name: "list_windows",
  description: "The app's windows with their titles and frames.",
  schema: appSchema,
  handler: async ({ app, pid }) => runProbe([...probeArgs("windows", { app }), ...withPid(pid)]),
});

export const findElement = defineTool({
  namespace: NS,
  access: "read",
  name: "find_element",
  description: `Find elements matching a selector. ${selectorHelp}`,
  schema: {
    ...appSchema,
    selector: z.string().describe(selectorHelp),
    timeout_seconds: z.number().min(0).max(120).optional().describe("Poll this long for a match before failing"),
  },
  handler: async ({ app, pid, selector, timeout_seconds }) =>
    runProbe([...probeArgs("find", { app, selector, timeoutSeconds: timeout_seconds }), ...withPid(pid)], {
      timeoutSeconds: timeout_seconds,
    }),
});

export const waitForElement = defineTool({
  namespace: NS,
  access: "read",
  name: "wait_for_element",
  description:
    "Poll until an element appears, or fail at the timeout. Use this instead of sleeping after a launch — " +
    "a fixed sleep either races the app or makes every run pay for the worst case.",
  schema: {
    ...appSchema,
    selector: z.string().describe(selectorHelp),
    timeout_seconds: z.number().min(0).max(120).default(10).describe("How long to poll"),
  },
  handler: async ({ app, pid, selector, timeout_seconds }) =>
    runProbe([...probeArgs("wait", { app, selector, timeoutSeconds: timeout_seconds }), ...withPid(pid)], {
      timeoutSeconds: timeout_seconds,
    }),
});

/**
 * The assertion this bag was built for.
 *
 * A process that is running is not a window a user can see. The defect that
 * motivated this (barry a6342ae8) set `contentViewController`, which re-sizes
 * the window to the hosted view's fitting size and discards the configured
 * contentRect: a NavigationSplitView reports no intrinsic size, so the window
 * came up 1pt wide — alive, responsive, and showing nothing. The same root
 * cause can overflow instead of collapse, which is why both bounds are checked.
 */
export const assertWindowHealthy = defineTool({
  namespace: NS,
  access: "read",
  name: "assert_window_healthy",
  description:
    "Assert the app has a window a user could actually see: big enough, not overflowing the screen, " +
    "on screen, not minimized, and with a non-empty subtree. Fails with the specific problems found. " +
    "This is the check a liveness probe cannot make — a collapsed or overflowing window is still a running process.",
  schema: {
    ...appSchema,
    selector: z.string().optional().describe("Which window (default: the app's first window)"),
    min_width: z.number().min(0).optional().describe("Minimum acceptable width in points (default 200)"),
    min_height: z.number().min(0).optional().describe("Minimum acceptable height in points (default 200)"),
    min_elements: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Minimum elements in the window subtree — an empty hosted view fails (default 3)"),
    timeout_seconds: z.number().min(0).max(120).optional().describe("Poll this long for the window to appear"),
  },
  handler: async ({ app, pid, selector, min_width, min_height, min_elements, timeout_seconds }) => {
    const extra = [
      ...withPid(pid),
      ...(min_width !== undefined ? ["--min-width", String(min_width)] : []),
      ...(min_height !== undefined ? ["--min-height", String(min_height)] : []),
      ...(min_elements !== undefined ? ["--min-elements", String(min_elements)] : []),
    ];
    return runProbe(
      probeArgs("window-health", { app, selector, timeoutSeconds: timeout_seconds, extra }),
      { timeoutSeconds: timeout_seconds },
    );
  },
});

export const screenshotApp = defineTool({
  namespace: NS,
  access: "read",
  name: "screenshot_app",
  description:
    "Capture the app's window to a PNG — the visual check the accessibility tree cannot make (color, clipping, overlap). " +
    "Requires Screen Recording permission.",
  schema: {
    ...appSchema,
    output_path: z.string().describe("Where to write the .png (absolute path)"),
  },
  handler: async ({ app, pid, output_path }) =>
    runProbe([...probeArgs("screenshot", { app }), ...withPid(pid), "--output", output_path]),
});

/**
 * Writes below.
 *
 * Both resolve an element inside the named app and act on THAT element. There
 * is no CGEvent posting, no cliclick, no System Events keystroke anywhere in
 * this bag — a synthetic event goes wherever focus happens to be, which on a
 * machine someone is using can mean their half-written message. A targeted AX
 * action cannot leak to another app regardless of what is frontmost.
 */
export const clickElement = defineTool({
  namespace: NS,
  access: "write",
  name: "click_element",
  description:
    "Press an element via its accessibility action (AXPress by default) — targeted at the element itself, " +
    "not a click at screen coordinates, so it cannot land in another app.",
  schema: {
    ...appSchema,
    selector: z.string().describe(selectorHelp),
    action: z.string().optional().describe("AX action to perform (default AXPress)"),
    timeout_seconds: z.number().min(0).max(120).optional().describe("Poll this long for the element"),
  },
  handler: async ({ app, pid, selector, action, timeout_seconds }) =>
    runProbe(
      probeArgs("perform", {
        app,
        selector,
        timeoutSeconds: timeout_seconds,
        extra: [...withPid(pid), ...(action ? ["--action", action] : [])],
      }),
      { timeoutSeconds: timeout_seconds },
    ),
});

export const setElementValue = defineTool({
  namespace: NS,
  access: "write",
  name: "set_element_value",
  description:
    "Set an element's AXValue — filling a text field, or scrolling by setting a scroll bar to a 0–1 position. " +
    "A targeted write, not synthetic typing.",
  schema: {
    ...appSchema,
    selector: z.string().describe(selectorHelp),
    value: z.string().describe("Value to set. A numeric string sets a number (scroll bars, sliders)."),
    timeout_seconds: z.number().min(0).max(120).optional().describe("Poll this long for the element"),
  },
  handler: async ({ app, pid, selector, value, timeout_seconds }) =>
    runProbe(
      probeArgs("set-value", {
        app,
        selector,
        timeoutSeconds: timeout_seconds,
        extra: [...withPid(pid), "--value", value],
      }),
      { timeoutSeconds: timeout_seconds },
    ),
});
