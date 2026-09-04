import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as tools from "./tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const EXPECTED = [
  "status",
  "list_running_apps",
  "snapshot_ui",
  "list_windows",
  "find_element",
  "wait_for_element",
  "assert_window_healthy",
  "screenshot_app",
  "click_element",
  "set_element_value",
].sort();

/**
 * Every export of tools.ts must be a tool definition — that is what makes the
 * "exports exactly the expected tools" assertion meaningful. A stray helper or
 * re-exported class would otherwise be silently skipped by a permissive filter.
 */
type ToolLike = { name: string; namespace: string; access: string; description: string; handler: unknown };

const definitions: ToolLike[] = Object.values(tools).map((t, i) => {
  const keys = Object.keys(tools);
  if (typeof t !== "object" || t === null || !("name" in t) || !("handler" in t)) {
    throw new Error(`export \`${keys[i]}\` is not a tool definition — tools.ts must export only tools`);
  }
  return t as unknown as ToolLike;
});

describe("tool surface", () => {
  it("exports exactly the expected tools", () => {
    expect(definitions.map((t) => t.name).sort()).toEqual(EXPECTED);
  });

  it("gives every tool a namespace, access, description and handler", () => {
    for (const tool of definitions) {
      expect(tool.namespace, `${tool.name} namespace`).toBe("macos-app-testing");
      expect(["read", "write"], `${tool.name} access`).toContain(tool.access);
      expect(tool.description.length, `${tool.name} description`).toBeGreaterThan(20);
      expect(typeof tool.handler, `${tool.name} handler`).toBe("function");
    }
  });

  it("marks only the two acting tools as writes", () => {
    const writes = definitions.filter((t) => t.access === "write").map((t) => t.name).sort();
    expect(writes).toEqual(["click_element", "set_element_value"]);
  });
});

/**
 * The safety invariant, enforced rather than documented.
 *
 * A synthetic click or keystroke lands wherever focus happens to be. On a
 * machine someone is actively using, that has meant a stray Return sending a
 * half-written message. Every action in this bag must therefore be a targeted
 * AX call against an element in a named app. This test is the analogue of
 * macos-pages' "never drives the interface through System Events".
 */
describe("no synthetic input", () => {
  const sources = ["tools.ts", "probe.ts", "classify-error.ts", "axprobe/main.swift"].map((f) => ({
    file: f,
    text: readFileSync(resolve(HERE, f), "utf8"),
  }));

  const FORBIDDEN = [
    "CGEvent",           // synthetic HID events
    "cliclick",          // coordinate clicking
    "keystroke",         // AppleScript typing
    "key code",          // AppleScript key presses
    "System Events",     // the UI-scripting bridge these arrive through
    "CGWarpMouseCursor", // moving the user's pointer
  ];

  for (const { file, text } of sources) {
    for (const needle of FORBIDDEN) {
      it(`${file} does not use ${needle}`, () => {
        // Comments explaining why these are avoided are the one legitimate
        // mention, so compare against code with comments stripped.
        const code = text
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .split("\n")
          .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
          .join("\n");
        expect(code, `${file} must not use ${needle}`).not.toContain(needle);
      });
    }
  }
});

/**
 * The probe binary must be findable from wherever the tools actually run.
 *
 * Barry bundles a bag's tools into ~/Library/Caches/Barry/bags/<name>-<hash>/
 * before running them. Resolving the binary relative to `import.meta.url` works
 * in dev and breaks in production, where it points into the cache — the bag is
 * registered and enabled, every tool loads, and the first call fails with
 * "axprobe is not built". Found exactly that way.
 */
describe("probe binary resolution", () => {
  it("finds the built binary", async () => {
    const { probeBinaryPath } = await import("./probe.js");
    const found = probeBinaryPath();
    expect(found, "run `swift build -c release` first").not.toBeNull();
    expect(found).toMatch(/\.build\/(release|debug)\/axprobe$/);
  });

  it("treats an explicit override as authoritative, not merely first", () => {
    const source = readFileSync(resolve(HERE, "probe.ts"), "utf8");
    // Falling through past MACOS_APP_TESTING_DIR to another checkout would run
    // a binary the caller did not point at — and report success. Found live:
    // an isolated tree silently resolved to ~/repos/bags.
    expect(source).toMatch(/if \(fromEnv\) return \[fromEnv\]/);
  });

  it("reads swift's stdout when a build fails", () => {
    const source = readFileSync(resolve(HERE, "probe.ts"), "utf8");
    // SwiftPM writes compiler diagnostics to stdout; reading only stderr loses
    // the reason and misreports a broken source as a missing toolchain.
    expect(source).toMatch(/err\.stdout/);
  });

  it("builds at most once across concurrent callers", () => {
    const source = readFileSync(resolve(HERE, "probe.ts"), "utf8");
    // Tool handlers run concurrently; without a shared promise each would
    // start its own `swift build` against one .build directory.
    expect(source).toMatch(/building \?\?=/);
  });

  it("does not depend on the module's own location", async () => {
    const source = readFileSync(resolve(HERE, "probe.ts"), "utf8");
    // A single hardcoded root relative to import.meta.url is the bug: the
    // search has to consider more than where this file happens to sit.
    expect(source).toContain("candidateRoots");
    expect(source).toMatch(/MACOS_APP_TESTING_DIR|BARRY_BAG_DIR/);
  });
});
