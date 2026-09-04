import { describe, expect, it } from "vitest";
import { classifyProbeFailure, PERMISSION_REMEDY } from "./classify-error.js";

describe("classifyProbeFailure", () => {
  it("reads the kind from the probe's error field", () => {
    const err = classifyProbeFailure('{"ok":false,"error":"not-found","message":"no element matched id=Foo"}', 1);
    expect(err.kind).toBe("not-found");
    expect(err.message).toBe("no element matched id=Foo");
  });

  it("carries the remedy on a denied permission, so the caller need not know it", () => {
    const err = classifyProbeFailure('{"ok":false,"error":"permission-denied","message":"not granted"}', 3);
    expect(err.kind).toBe("permission-denied");
    expect(err.message).toContain("System Settings");
  });

  it("does not duplicate the remedy when the probe already included it", () => {
    const withRemedy = `{"ok":false,"error":"permission-denied","message":"denied. ${PERMISSION_REMEDY}"}`;
    const err = classifyProbeFailure(withRemedy, 3);
    expect(err.message.match(/System Settings/g)).toHaveLength(1);
  });

  it("appends the specific problems to an unhealthy-window failure", () => {
    const err = classifyProbeFailure(
      '{"ok":false,"error":"unhealthy-window","message":"window is unhealthy","problems":["width 1pt < required 200pt"]}',
      1,
    );
    expect(err.kind).toBe("unhealthy-window");
    expect(err.problems).toEqual(["width 1pt < required 200pt"]);
    expect(err.message).toContain("width 1pt");
  });

  it("passes an unknown kind through as ax-error rather than guessing", () => {
    const err = classifyProbeFailure('{"ok":false,"error":"some-future-kind","message":"whatever happened"}', 1);
    expect(err.kind).toBe("ax-error");
    expect(err.message).toBe("whatever happened");
  });

  it("keeps non-JSON output verbatim — a crash before reporting is still evidence", () => {
    const err = classifyProbeFailure("dyld: Library not loaded", 5);
    expect(err.kind).toBe("ax-error");
    expect(err.message).toContain("dyld");
  });

  it("says something useful when the probe produced nothing at all", () => {
    const err = classifyProbeFailure("", 1);
    expect(err.kind).toBe("ax-error");
    expect(err.message).toContain("no output");
  });
});
