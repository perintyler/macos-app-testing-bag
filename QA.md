<!-- tools: Bash,Read -->
# QA: macos-app-testing

What only a live app can show. The unit tests cover the pure logic — selector
parsing, error classification, the safety invariant — these steps cover the
parts that need a real window on a real screen.

## Requirements

- macOS on Apple Silicon, with the Swift toolchain.
- **Accessibility permission for the process running these steps.** The grant is
  per-binary, so it working in one terminal proves nothing about another. If
  step 1 reports `permission-denied`, that is a setup problem, not a bag bug.
- Screen Recording permission, for the screenshot step only.
- At least one ordinary app running with a visible window (Finder is fine).

## Setup

```bash
cd ~/repos/bags/macos-app-testing
swift build -c release
pnpm install
P=.build/release/axprobe
```

## Test Steps

### 1. It compiles, typechecks, and the unit tests pass

```bash
swift build -c release && npx tsc --noEmit && npx vitest run
```

**Expected:** exit 0, 34 tests passed.

### 2. Permission is reported honestly

```bash
$P status
```

**Expected:** `"trusted": true` and `"state": "ready"`. If `trusted` is false,
every other step will fail with `permission-denied` — grant it and re-run
rather than reading the failures as bag bugs.

### 3. The health check passes on a healthy window

```bash
$P window-health --app Finder
```

**Expected:** `"ok": true`, exit 0, with a frame of plausible size.

### 4. The health check FAILS when it should

A check that has never been seen to fail is a claim, not a result. Each of these
must exit nonzero and name the problem:

```bash
$P window-health --app Finder --min-width 5000;    echo "exit=$? (expect 1)"
$P window-health --app Finder --min-elements 99999; echo "exit=$? (expect 1)"
$P window-health --app NoSuchApp123;                echo "exit=$? (expect 1)"
$P window-health;                                   echo "exit=$? (expect 2, usage)"
```

**Expected:** exits 1, 1, 1, 2. The first reports `width … < required 5000pt`,
the second an element-count problem, the third `app-not-running`.

### 5. Ambiguity is refused, not guessed

Launch a second copy of an app you also have installed, so two processes share
one bundle id:

```bash
$P status --app com.barry.actions
```

**Expected:** when more than one process matches, `"state": "ambiguous-app"`,
the `matches` array lists each pid with its bundle path, and any assertion
without `--pid` exits 4. Asserting against the wrong process would otherwise
pass green while testing the app you did not change.

### 6. The safety invariant holds under mutation

```bash
cp src/probe.ts /tmp/probe.bak
printf '\nconst leak = "CGEvent";\n' >> src/probe.ts
npx vitest run src/tools.test.ts    # Expected: 1 failed
cp /tmp/probe.bak src/probe.ts
npx vitest run src/tools.test.ts    # Expected: all passed
```

**Expected:** the guard goes red on the injected `CGEvent` reference and green
once restored.

### 7. Reading a real tree works

```bash
$P find --app Finder --selector 'role=AXButton' | head -20
$P snapshot --app Finder --max-depth 3 | head -20
```

**Expected:** JSON with at least one element; roles and frames present.

### 8. Polling beats sleeping

```bash
time $P wait --app Finder --selector 'role=AXWindow' --timeout 10
```

**Expected:** returns in well under a second — the timeout is a ceiling, not a
delay. A missing element takes the full timeout and then fails:

```bash
time $P wait --app Finder --selector 'id=NoSuchElement' --timeout 3; echo "exit=$? (expect 1)"
```

### 9. Window-scoped screenshot

```bash
$P screenshot --app Finder --output /tmp/qa-finder.png && ls -la /tmp/qa-finder.png
```

**Expected:** a PNG of the Finder window alone, not the whole display. Without
Screen Recording permission it fails with that named as the cause, rather than
writing an empty or black file.

## Success Criteria

- [ ] `swift build -c release`, `tsc --noEmit` and `vitest run` all pass
- [ ] `status` reports permission truthfully, and says `ready` when it is
- [ ] `window-health` passes on a healthy window
- [ ] `window-health` **fails**, nonzero and specifically, on each of the four
      broken cases in step 4
- [ ] an ambiguous app target is refused with exit 4, not guessed
- [ ] the no-synthetic-input test fails when the rule is violated
- [ ] `find` and `snapshot` return real elements from a live app
- [ ] `wait` returns immediately when present and fails at the timeout when not
- [ ] `screenshot` writes a window-scoped PNG

## Cleanup

```bash
rm -f /tmp/qa-finder.png /tmp/probe.bak
git checkout src/probe.ts   # in case step 6 was interrupted mid-mutation
```
