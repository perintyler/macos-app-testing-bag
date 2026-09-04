// axprobe — read and drive a native macOS app through its accessibility tree.
//
// Generalized from bags/sessions/sessions-macos/app/qa/axprobe.swift, which was
// BarrySessions-specific (hardcoded bundle id, hardcoded turn-/tool- row
// identifiers, recompiled to /tmp on every run).
//
// The AXUIElement C API is used directly rather than the AppleScript
// `entire contents` bridge, which does not recurse reliably into
// NSHostingView-backed SwiftUI trees.
//
// SAFETY, and the reason this tool exists in this shape: every mutation
// resolves an element inside a NAMED target app and writes to that element.
// There is no CGEvent posting, no cliclick, no System Events keystroke — a
// synthetic event lands wherever focus happens to be, which on a machine the
// user is sitting at means it can land in their half-written message. A
// targeted AX write cannot leak to another app, whatever is frontmost.
import AppKit
import ApplicationServices

// MARK: - Output

/// Errors are reported as JSON on stdout with a nonzero exit, so a caller gets
/// the same shape whether the run succeeded or failed and never has to parse
/// prose out of stderr.
func fail(_ kind: String, _ message: String, exitCode: Int32 = 1) -> Never {
    emit(["ok": false, "error": kind, "message": message])
    exit(exitCode)
}

func emit(_ value: Any) {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]),
          let text = String(data: data, encoding: .utf8) else {
        print("{\"ok\":false,\"error\":\"encoding\",\"message\":\"result was not encodable\"}")
        exit(1)
    }
    print(text)
}

// MARK: - Argument parsing

var args = Array(CommandLine.arguments.dropFirst())

/// Pull `--name value` out of the argument list, leaving positionals behind.
func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: "--\(name)"), i + 1 < args.count else { return nil }
    let value = args[i + 1]
    args.removeSubrange(i...(i + 1))
    return value
}

func flag(_ name: String) -> Bool {
    guard let i = args.firstIndex(of: "--\(name)") else { return false }
    args.remove(at: i)
    return true
}

let appOption = option("app")
let pidOption = Int32(option("pid") ?? "")
let selectorOption = option("selector")
let timeoutSeconds = Double(option("timeout") ?? "0") ?? 0
let minWidth = Double(option("min-width") ?? "200") ?? 200
let minHeight = Double(option("min-height") ?? "200") ?? 200
let minElements = Int(option("min-elements") ?? "3") ?? 3
// The ceiling defaults to the visible frame of the largest screen, scaled by a
// tolerance for legitimately oversized windows. A hosted view that ignores the
// window's contentRect can grow without bound as easily as it can collapse —
// observed at 1040x2498 on a 982pt-tall display — and a window taller than
// every screen shows the user its top and hides the rest.
let maxOverflowFactor = Double(option("max-overflow-factor") ?? "1.5") ?? 1.5
let valueOption = option("value")
// Some elements are reachable only as another element's ATTRIBUTE, not as a
// child in the AX tree — a scroll area's AXVerticalScrollBar is the case that
// matters here, and it carries no identifier of its own to select by.
let viaOption = option("via")
let actionOption = option("action") ?? "AXPress"
let outputOption = option("output")
let maxDepth = Int(option("max-depth") ?? "40") ?? 40
_ = flag("json") // JSON is the only output format; accepted for callers that pass it explicitly.

guard let command = args.first else {
    fail("usage", "usage: axprobe <command> [--app <bundle-id|name>] [--pid <pid>] [--selector <sel>] [options]", exitCode: 2)
}
args.removeFirst()

// MARK: - AX attribute helpers

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
}

func children(_ el: AXUIElement) -> [AXUIElement] {
    guard let raw = attr(el, kAXChildrenAttribute as String) else { return [] }
    return (raw as? [AXUIElement]) ?? []
}

func stringAttr(_ el: AXUIElement, _ name: String) -> String? {
    attr(el, name) as? String
}

func identifier(_ el: AXUIElement) -> String? { stringAttr(el, kAXIdentifierAttribute as String) }
func role(_ el: AXUIElement) -> String? { stringAttr(el, kAXRoleAttribute as String) }
func title(_ el: AXUIElement) -> String? { stringAttr(el, kAXTitleAttribute as String) }

/// The element's displayed value, as a string when it reasonably converts.
/// Conditional casts throughout: these arrive as CFTypeRef, and a wrong
/// attribute type must read as "absent" rather than trap the probe.
func valueString(_ el: AXUIElement) -> String? {
    guard let raw = attr(el, kAXValueAttribute as String) else { return nil }
    if let s = raw as? String { return s }
    if let n = raw as? NSNumber { return n.stringValue }
    return nil
}

/// `as? AXValue` cannot be used to vet these: a conditional downcast to a
/// CoreFoundation type always succeeds (Swift 6 rejects it outright), so it
/// would wave through an attribute of the wrong type and then read garbage out
/// of it. Compare the CFTypeID instead, and let AXValueGetValue confirm the
/// value actually holds the geometry it claims to.
func axValue(_ raw: CFTypeRef) -> AXValue? {
    guard CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    return (raw as! AXValue)
}

func frame(_ el: AXUIElement) -> CGRect? {
    guard let posV = attr(el, kAXPositionAttribute as String),
          let sizeV = attr(el, kAXSizeAttribute as String),
          let posValue = axValue(posV), let sizeValue = axValue(sizeV) else { return nil }
    var pos = CGPoint.zero, size = CGSize.zero
    // A false return means the AXValue held a different kind of geometry; the
    // zero-initialized locals would then read as a 0x0 rect at the origin,
    // which window-health would report as a failure rather than a pass.
    guard AXValueGetValue(posValue, .cgPoint, &pos),
          AXValueGetValue(sizeValue, .cgSize, &size) else { return nil }
    return CGRect(origin: pos, size: size)
}

func rectJSON(_ r: CGRect) -> [String: Any] {
    ["x": Int(r.origin.x), "y": Int(r.origin.y), "width": Int(r.width), "height": Int(r.height)]
}

// MARK: - Selectors

/// A selector is a small, explicit matcher rather than a query language.
/// Supported forms, matched against the element's AX attributes:
///
///   id=Foo          exact AXIdentifier
///   id^=Foo         AXIdentifier prefix (replaces the prototype's hardcoded
///                   `turn-`/`tool-` knowledge)
///   role=AXButton   exact AXRole
///   title=Save      exact AXTitle
///   title*=Sav      AXTitle contains
///
/// Bare text with no `=` is treated as `id=`, which is the common case.
struct Selector {
    enum Kind { case idExact, idPrefix, roleExact, titleExact, titleContains }
    let kind: Kind
    let needle: String

    init?(_ raw: String) {
        // Order matters: the two-character operators must be tested before the
        // single-character `=`, or `id^=x` parses as id equal to "^=x".
        if raw.hasPrefix("id^=") { kind = .idPrefix; needle = String(raw.dropFirst(4)) }
        else if raw.hasPrefix("title*=") { kind = .titleContains; needle = String(raw.dropFirst(7)) }
        else if raw.hasPrefix("id=") { kind = .idExact; needle = String(raw.dropFirst(3)) }
        else if raw.hasPrefix("role=") { kind = .roleExact; needle = String(raw.dropFirst(5)) }
        else if raw.hasPrefix("title=") { kind = .titleExact; needle = String(raw.dropFirst(6)) }
        else if raw.contains("=") { return nil }
        else { kind = .idExact; needle = raw }
        if needle.isEmpty { return nil }
    }

    func matches(_ el: AXUIElement) -> Bool {
        switch kind {
        case .idExact: return identifier(el) == needle
        case .idPrefix: return identifier(el)?.hasPrefix(needle) ?? false
        case .roleExact: return role(el) == needle
        case .titleExact: return title(el) == needle
        case .titleContains: return title(el)?.contains(needle) ?? false
        }
    }
}

// MARK: - Tree walking

/// Depth-capped so a cyclic or pathologically deep AX tree cannot hang the
/// probe — the prototype's 40 is kept as the default.
func firstMatch(_ el: AXUIElement, _ sel: Selector, depth: Int = 0) -> AXUIElement? {
    if depth > maxDepth { return nil }
    if sel.matches(el) { return el }
    for child in children(el) {
        if let hit = firstMatch(child, sel, depth: depth + 1) { return hit }
    }
    return nil
}

func allMatches(_ el: AXUIElement, _ sel: Selector, into acc: inout [AXUIElement], depth: Int = 0) {
    if depth > maxDepth { return }
    if sel.matches(el) { acc.append(el) }
    for child in children(el) { allMatches(child, sel, into: &acc, depth: depth + 1) }
}

func countElements(_ el: AXUIElement, depth: Int = 0) -> Int {
    if depth > maxDepth { return 0 }
    return children(el).reduce(1) { $0 + countElements($1, depth: depth + 1) }
}

func describe(_ el: AXUIElement) -> [String: Any] {
    var out: [String: Any] = [:]
    if let v = identifier(el) { out["identifier"] = v }
    if let v = role(el) { out["role"] = v }
    if let v = title(el) { out["title"] = v }
    if let v = valueString(el) { out["value"] = v }
    if let f = frame(el) { out["frame"] = rectJSON(f) }
    return out
}

func tree(_ el: AXUIElement, depth: Int = 0) -> [String: Any] {
    var node = describe(el)
    if depth < maxDepth {
        let kids = children(el).map { tree($0, depth: depth + 1) }
        if !kids.isEmpty { node["children"] = kids }
    }
    return node
}

// MARK: - App resolution

func runningApps() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular || $0.bundleIdentifier != nil }
}

/// Every running app matching `wanted`, by bundle id first and then by
/// localized name, so `--app "Barry Actions"` and `--app com.barry.actions`
/// both work.
func matchingApps(_ wanted: String) -> [NSRunningApplication] {
    let byBundle = NSRunningApplication.runningApplications(withBundleIdentifier: wanted)
    if !byBundle.isEmpty { return byBundle }
    return runningApps().filter { $0.localizedName == wanted }
}

/// Resolve the app to act on.
///
/// An ambiguous match is a HARD ERROR rather than a silent "first wins". A
/// developer testing a freshly built copy of an app they also have installed
/// has two processes under one bundle id, and picking either by luck means the
/// assertion can pass against the app that was NOT changed — a green result
/// carrying no information, which is the failure mode this bag exists to
/// close. `--pid` disambiguates.
func resolveApp(_ wanted: String) -> NSRunningApplication? {
    if let pid = pidOption {
        return runningApps().first { $0.processIdentifier == pid }
    }
    let hits = matchingApps(wanted)
    if hits.count > 1 {
        let described = hits.map { "pid \($0.processIdentifier) (\($0.bundleURL?.path ?? "unknown path"))" }
        fail("ambiguous-app",
             "\(hits.count) running processes match \(wanted): \(described.joined(separator: ", ")). "
             + "Pass --pid <pid> to choose one.",
             exitCode: 4)
    }
    return hits.first
}

/// Poll until `probe` returns a value or the deadline passes. Replaces the
/// prototype's fixed `sleep 3` / `sleep 6`, which was its main flakiness
/// source: too short and the assert raced the app's launch, too long and every
/// run paid for the worst case.
func poll<T>(_ probe: () -> T?) -> T? {
    if timeoutSeconds <= 0 { return probe() }
    let deadline = Date().addingTimeInterval(timeoutSeconds)
    while true {
        if let hit = probe() { return hit }
        if Date() >= deadline { return nil }
        // A UI settles on the main thread; 100ms is short enough to feel
        // immediate and long enough not to spin the CPU during a launch.
        Thread.sleep(forTimeInterval: 0.1)
        // Let AX notifications and app state land between polls.
        RunLoop.current.run(until: Date().addingTimeInterval(0.01))
    }
}

// MARK: - Permission

/// The one check that must never quietly succeed. A denied Accessibility grant
/// makes every query return nothing, which is indistinguishable from "the app
/// has no such element" unless it is reported as its own failure — the exact
/// "check that cannot fail" hazard this bag exists to close.
func requireTrust() {
    if AXIsProcessTrusted() { return }
    fail("permission-denied",
         "Accessibility permission is not granted to the process running axprobe. "
         + "Grant it in System Settings → Privacy & Security → Accessibility "
         + "(add the terminal or runner binary), then re-run.",
         exitCode: 3)
}

// MARK: - Commands

/// `list-apps` and `status` deliberately run before app resolution: they are
/// how a caller diagnoses a missing app or permission in the first place.
if command == "list-apps" {
    let apps = runningApps().compactMap { app -> [String: Any]? in
        guard let name = app.localizedName else { return nil }
        return ["name": name, "bundleId": app.bundleIdentifier ?? "", "pid": app.processIdentifier]
    }
    emit(["ok": true, "trusted": AXIsProcessTrusted(), "apps": apps])
    exit(0)
}

if command == "status" {
    let trusted = AXIsProcessTrusted()
    var out: [String: Any] = ["ok": true, "trusted": trusted]
    var matchCount = 0
    if let wanted = appOption {
        // status lists every match rather than resolving to one, because
        // "which process am I about to test?" is exactly what it is asked.
        let hits = matchingApps(wanted)
        matchCount = hits.count
        out["matches"] = hits.map {
            ["name": $0.localizedName ?? wanted,
             "bundleId": $0.bundleIdentifier ?? "",
             "pid": $0.processIdentifier,
             "path": $0.bundleURL?.path ?? ""]
        }
        out["app"] = ["name": wanted, "running": !hits.isEmpty]
    }
    // `state` collapses the two independent conditions into the single answer a
    // caller acts on, while both raw booleans stay visible above.
    out["state"] = !trusted ? "permission-denied"
        : (appOption != nil && matchCount == 0) ? "app-not-running"
        : (appOption != nil && matchCount > 1 && pidOption == nil) ? "ambiguous-app" : "ready"
    emit(out)
    exit(0)
}

requireTrust()

guard let wantedApp = appOption else {
    fail("usage", "--app <bundle-id|name> is required for \(command)", exitCode: 2)
}

// The app itself is polled for, so a caller can launch and assert in one step
// without a hand-tuned sleep in between.
guard let app = poll({ resolveApp(wantedApp) }) else {
    fail("app-not-running", "no running application matches \(wantedApp)")
}
let axApp = AXUIElementCreateApplication(app.processIdentifier)

func requireSelector() -> Selector {
    guard let raw = selectorOption else {
        fail("usage", "--selector is required for \(command)", exitCode: 2)
    }
    guard let sel = Selector(raw) else {
        fail("usage", "unparseable selector: \(raw)", exitCode: 2)
    }
    return sel
}

func requireElement(_ sel: Selector) -> AXUIElement {
    guard let hit = poll({ firstMatch(axApp, sel) }) else {
        fail("not-found", "no element matched \(selectorOption ?? "") in \(wantedApp)")
    }
    return hit
}

switch command {
case "snapshot":
    emit(["ok": true, "app": wantedApp, "tree": tree(axApp)])

case "windows":
    let windows = (attr(axApp, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
    emit(["ok": true, "app": wantedApp, "count": windows.count, "windows": windows.map(describe)])

case "find":
    let sel = requireSelector()
    var hits: [AXUIElement] = []
    // Poll for the first match, then collect siblings — otherwise a caller with
    // a timeout would get whatever subset happened to exist on the first tick.
    _ = poll({ firstMatch(axApp, sel) })
    allMatches(axApp, sel, into: &hits)
    if hits.isEmpty { fail("not-found", "no element matched \(selectorOption ?? "") in \(wantedApp)") }
    // AX exposes nested text sub-elements that repeat their row's identifier;
    // dedup to one entry per distinct identifier, preserving document order.
    var seen = Set<String>()
    let unique = hits.filter { el in
        guard let id = identifier(el) else { return true }
        return seen.insert(id).inserted
    }
    emit(["ok": true, "count": unique.count, "elements": unique.map(describe)])

case "wait":
    let sel = requireSelector()
    let hit = requireElement(sel)
    emit(["ok": true, "element": describe(hit)])

case "frame":
    let sel = requireSelector()
    let hit = requireElement(sel)
    guard let f = frame(hit) else { fail("no-frame", "element has no position/size") }
    emit(["ok": true, "frame": rectJSON(f), "element": describe(hit)])

case "attr":
    let sel = requireSelector()
    let hit = requireElement(sel)
    guard let name = args.first else { fail("usage", "attr requires an attribute name", exitCode: 2) }
    guard let raw = attr(hit, name) else { fail("not-found", "element has no attribute \(name)") }
    emit(["ok": true, "attribute": name, "value": (raw as? String) ?? String(describing: raw)])

case "window-health":
    // The assertion that would have caught a6342ae8, where the window opened
    // 1x80pt: the process was alive and every liveness check passed while the
    // app showed nothing. Each condition below is one way a window can be
    // "running" and still invisible to a user.
    let windows = (attr(axApp, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
    var target: AXUIElement?
    if let raw = selectorOption, let sel = Selector(raw) {
        target = poll({ windows.first(where: { sel.matches($0) }) ?? firstMatch(axApp, sel) })
    } else {
        target = poll({ (attr(axApp, kAXWindowsAttribute as String) as? [AXUIElement])?.first })
    }
    guard let window = target else {
        // Distinguish "this app has no windows at all" from "the selector
        // missed". The former is the normal state of a menu-bar/NSPopover app,
        // which is invisible to AX until it opts in — a different problem, with
        // a different fix, from a wrong selector.
        if windows.isEmpty && selectorOption == nil {
            fail("no-windows",
                 "\(wantedApp) has no windows in the accessibility tree. A menu-bar or NSPopover app is not "
                 + "reachable until it exposes its content (e.g. NSApp.setAccessibilityChildren behind a "
                 + "UI-test env flag). If it should have a window, it may still be starting — pass --timeout.")
        }
        fail("not-found", "no window matched \(selectorOption ?? "") in \(wantedApp)")
    }

    var problems: [String] = []
    let f = frame(window)
    if let f {
        if Double(f.width) < minWidth { problems.append("width \(Int(f.width))pt < required \(Int(minWidth))pt") }
        if Double(f.height) < minHeight { problems.append("height \(Int(f.height))pt < required \(Int(minHeight))pt") }
        // A window parked entirely beyond every screen is running and invisible.
        let onScreen = NSScreen.screens.contains { $0.frame.intersects(f) }
        if !onScreen && !NSScreen.screens.isEmpty { problems.append("window is entirely offscreen") }
        // The other half of the same defect: a view that discards the window's
        // contentRect can overflow the display instead of collapsing, leaving
        // most of the UI unreachable. Checking only a floor would call that
        // healthy.
        if let screen = NSScreen.screens.map(\.visibleFrame).max(by: { $0.height < $1.height }) {
            let maxW = Double(screen.width) * maxOverflowFactor
            let maxH = Double(screen.height) * maxOverflowFactor
            if Double(f.width) > maxW {
                problems.append("width \(Int(f.width))pt overflows the \(Int(screen.width))pt screen")
            }
            if Double(f.height) > maxH {
                problems.append("height \(Int(f.height))pt overflows the \(Int(screen.height))pt screen")
            }
        }
    } else {
        problems.append("window reports no position/size")
    }
    // Count through the app's own child tree rather than the element handed
    // back by kAXWindowsAttribute. Those two references are not equivalent for
    // every app: BarryIdentities' window reports 5 children via AXChildren and
    // 0 via the windows-attribute handle, so counting the latter called a fully
    // populated window empty. A false alarm is as damaging as a missed defect —
    // it trains the reader to ignore the check.
    let windowFromTree = children(axApp).first { el in
        guard let f = frame(el), let wf = frame(window) else { return false }
        return role(el) == "AXWindow" && f == wf
    }
    let elements = countElements(windowFromTree ?? window)
    if elements < minElements {
        problems.append("window subtree has \(elements) element(s) < required \(minElements) — hosted view is likely empty")
    }
    if let minimized = attr(window, kAXMinimizedAttribute as String) as? Bool, minimized {
        problems.append("window is minimized")
    }

    var out: [String: Any] = [
        "ok": problems.isEmpty,
        "app": wantedApp,
        "elements": elements,
        "window": describe(window),
    ]
    if let f { out["frame"] = rectJSON(f) }
    if !problems.isEmpty {
        out["error"] = "unhealthy-window"
        out["problems"] = problems
        emit(out)
        exit(1)
    }
    emit(out)

case "perform":
    // AXPress on the element itself — not a click at its coordinates.
    let sel = requireSelector()
    let hit = requireElement(sel)
    let result = AXUIElementPerformAction(hit, actionOption as CFString)
    guard result == .success else {
        fail("action-failed", "\(actionOption) failed with AXError \(result.rawValue)")
    }
    emit(["ok": true, "action": actionOption, "element": describe(hit)])

case "set-value":
    // A targeted AXValue write — not synthetic typing. This is also how
    // scrolling is done (set AXVerticalScrollBar to a 0...1 position), which is
    // why there is no separate scroll command.
    let sel = requireSelector()
    guard let raw = valueOption else { fail("usage", "--value is required for set-value", exitCode: 2) }
    var hit = requireElement(sel)
    // Hop to an attribute-referenced element when asked. Scrolling is
    // `--selector id=MessageScrollView --via AXVerticalScrollBar --value 0`:
    // still a targeted AX write to this app's own element, never a synthetic
    // scroll-wheel event that could land in another window.
    if let via = viaOption {
        guard let raw = attr(hit, via) else {
            fail("not-found", "element has no \(via) attribute")
        }
        guard CFGetTypeID(raw) == AXUIElementGetTypeID() else {
            fail("not-found", "\(via) is not an accessibility element")
        }
        hit = (raw as! AXUIElement)
    }
    let priorRaw = attr(hit, kAXValueAttribute as String)
    let priorValue: String? = (priorRaw as? NSNumber)?.stringValue ?? (priorRaw as? String)
    // A numeric string sets a number (scroll bars, sliders); anything else sets
    // a string. Guessing wrong yields kAXErrorIllegalArgument, reported below.
    let value: CFTypeRef = Double(raw).map { $0 as CFNumber } ?? (raw as CFString)
    let result = AXUIElementSetAttributeValue(hit, kAXValueAttribute as CFString, value)
    guard result == .success else {
        fail("set-value-failed", "setting AXValue failed with AXError \(result.rawValue)")
    }
    // Read the value back. AXUIElementSetAttributeValue returning .success means
    // the write was ACCEPTED, not that it took effect — a SwiftUI ScrollView
    // reports success and ignores it, so a caller trusting the return code
    // "scrolls" forever without moving. Reporting `applied` makes a write that
    // does nothing visible instead of silently passing.
    let readBack = attr(hit, kAXValueAttribute as String)
    let observed: String? = (readBack as? NSNumber)?.stringValue ?? (readBack as? String)
    // Three outcomes, not two. A SwiftUI ScrollView CLAMPS a scroll write —
    // asking for 0 from 1.0 lands around 0.68 and moves the view a real
    // distance — so treating "not exactly what I asked for" as failure would
    // call working pagination broken. What must not pass silently is a write
    // that changed nothing at all.
    let before = priorValue.flatMap { Double($0) }
    let after = observed.flatMap { Double($0) }
    let exact = observed.map { obs in
        if let want = Double(raw), let got = Double(obs) { return abs(want - got) < 0.001 }
        return obs == raw
    } ?? false
    let moved: Bool = {
        if exact { return true }
        guard let b = before, let a = after else { return false }
        return abs(a - b) > 0.001
    }()

    var out: [String: Any] = ["ok": moved, "value": raw, "element": describe(hit)]
    if let observed { out["observed"] = observed }
    if let priorValue { out["previous"] = priorValue }
    out["exact"] = exact
    if !moved {
        out["error"] = "value-not-applied"
        out["message"] = "the write was accepted but the value did not change "
            + "(still \(observed ?? "unset")) — this control may not honour AX value writes."
        emit(out)
        exit(1)
    }
    emit(out)

case "screenshot":
    // Window-scoped capture via screencapture(1) -l <windowID>, which the repo
    // has no equivalent of: screen-recorder captures the whole display and the
    // browser bags capture web pixels only.
    guard let output = outputOption else { fail("usage", "--output is required for screenshot", exitCode: 2) }
    let listing = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
    let infos = (listing as? [[String: Any]]) ?? []
    guard let match = infos.first(where: { ($0[kCGWindowOwnerPID as String] as? pid_t) == app.processIdentifier }),
          let windowID = match[kCGWindowNumber as String] as? Int else {
        fail("not-found", "no on-screen window found for \(wantedApp) — is it visible?")
    }
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    proc.arguments = ["-x", "-o", "-l", String(windowID), output]
    do { try proc.run() } catch { fail("screenshot-failed", "could not run screencapture: \(error)") }
    proc.waitUntilExit()
    guard proc.terminationStatus == 0, FileManager.default.fileExists(atPath: output) else {
        fail("screenshot-failed",
             "screencapture exited \(proc.terminationStatus). Screen Recording permission is required "
             + "in System Settings → Privacy & Security → Screen Recording.")
    }
    emit(["ok": true, "output": output, "windowId": windowID])

default:
    fail("usage", "unknown command: \(command)", exitCode: 2)
}
