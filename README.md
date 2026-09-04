# macOS App Testing

Drive and assert native macOS app UI through the accessibility tree.

A running process is not a visible window. An app whose hosted view discards its
configured size can launch, stay alive, respond to signals and pass every
liveness check while showing the user nothing at all. This bag asks the app what
it is actually showing.

## Why not a VM

Virtual machines are how you get a *clean machine* — snapshot, run, discard.
They are not how you *drive* a Mac UI: XCUITest, Appium's mac2 driver and every
comparable tool reach the same accessibility APIs underneath, and a VM adds
three costs that matter here.

1. Accessibility permission cannot be granted non-interactively while SIP is
   enabled, and this harness depends on exactly that permission.
2. `Virtualization.framework` and the macOS EULA cap a host at two concurrent
   guests, so it buys little parallelism.
3. Apps under test that talk to a service on the host turn into a networking
   problem.

So this bag runs on the host and stays VM-agnostic: a plain CLI with no
assumption that it owns the machine. If you later want clean-machine runs,
install [Tart](https://tart.run/) and run this same bag inside the guest.

## Safety

Nothing here posts synthetic input. Every action resolves an `AXUIElement`
inside a **named** app and calls `AXUIElementPerformAction` or
`AXUIElementSetAttributeValue` on that element.

There is no `CGEvent` posting, no `cliclick`, no System Events keystroke — a
synthetic event lands wherever focus happens to be, which on a machine someone
is using can mean their half-written message. A targeted accessibility call
cannot leak to another app regardless of what is frontmost. `src/tools.test.ts`
enforces this rather than trusting it.

## Setup

```bash
pnpm install
```

The `axprobe` binary builds itself on first use — the first tool call after a
fresh clone pays one compile (~15s) and every call after it is instant. Build it
ahead of time with `swift build -c release` if you would rather not pay that
inside a run. A build failure reports swift's own diagnostics, so a missing
toolchain and a broken source read differently.

Then grant **Accessibility** permission to whatever runs the tools (your
terminal, or the Barry runner) in System Settings → Privacy & Security →
Accessibility. The grant is per-binary. `screenshot_app` additionally needs
Screen Recording.

Check both with `status` — it reports the real answer and distinguishes
*permission denied* from *app not running* from *ready*.

## Tools

| Tool | Access | Purpose |
|---|---|---|
| `status` | read | Permission state, and every process matching an app |
| `list_running_apps` | read | Running apps with bundle ids and pids |
| `snapshot_ui` | read | The accessibility tree as JSON |
| `list_windows` | read | Windows with titles and frames |
| `find_element` | read | Elements matching a selector |
| `wait_for_element` | read | Poll until an element appears |
| `assert_window_healthy` | read | Assert a window a user could actually see |
| `screenshot_app` | read | Window-scoped PNG capture |
| `click_element` | write | `AXPress` an element — not a coordinate click |
| `set_element_value` | write | Set `AXValue` — not synthetic typing |

## Selectors

An explicit matcher, not a query language:

| Form | Matches |
|---|---|
| `id=Foo` | exact `AXIdentifier` |
| `id^=turn-` | `AXIdentifier` prefix |
| `role=AXButton` | exact `AXRole` |
| `title=Save` | exact `AXTitle` |
| `title*=Sav` | `AXTitle` contains |

Bare text is treated as `id=`. An app is only as testable as the identifiers it
sets — though window health and screenshots work without any.

## Choosing the right process

A freshly built app and an installed copy share a bundle id. The tools **refuse
to guess** and report `ambiguous-app` with each candidate's path; pass `pid` to
choose.

This refusal is the point: asserting against the wrong process yields a green
result that means nothing. It was found while testing this bag — a health check
aimed at a new build silently answered from the installed one.

## Assertions that can fail

`assert_window_healthy` checks the ways a window can be "running" and still
useless:

- smaller than a floor (the 1x80pt collapse)
- larger than the screen it is on (the same root cause overflowing instead)
- entirely offscreen, or minimized
- a subtree too small to be showing anything

Each failure names the specific problem and exits nonzero.

## Example

```bash
axprobe status --app com.barry.actions
axprobe window-health --app com.barry.actions --timeout 10
axprobe find --app com.barry.actions --selector 'role=AXButton'
axprobe set-value --app com.barry.sessions --selector id=MessageScrollView --value 0
```
