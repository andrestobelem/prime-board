---
name: diagnosing-bugs
description: Diagnosis loop for hard bugs and performance regressions. Use when the user says "diagnose"/"debug this", or reports something broken/throwing/failing/slow.
---

# Diagnosing Bugs

Use this discipline for hard bugs. Skip a phase only with an explicit reason.

When you explore the codebase, read `CONTEXT.md` if it exists. Use it to understand the relevant modules. Also check ADRs in the area you will change.

## Redact

This skill requires commands, outputs, and captured artifacts. **Redact every secret first**. Replace each secret with `<REDACTED>`. Build loops against environment variables so credentials remain in the environment and do not appear in output. Captured artifacts can contain authorization headers. Quote only lines that provide diagnostic evidence.

If the redacted output does not provide enough evidence, state that fact and ask the user for more information.

## Phase 1 — Build a feedback loop

**This is the skill.** The remaining phases are mechanical. First obtain a **tight** pass/fail signal for the bug. The signal must go red on _this_ bug. Bisection, hypothesis testing, and instrumentation use this signal. Without it, code inspection alone will not find the cause.

Spend extra effort on this phase. **Be aggressive. Be creative. Continue until you have a useful signal.**

### Ways to construct a loop — try these in roughly this order

1. **Failing test** at the seam that reaches the bug — unit, integration, or e2e.
2. **Curl / HTTP script** against a running development server.
3. **CLI invocation** with fixture input. Diff stdout against a known-good snapshot.
4. **Headless browser script** (Playwright / Puppeteer). Drive the UI and assert on DOM/console/network.
5. **Replay a captured trace.** Save a real network request, payload, or event log to disk. Replay it through the code path in isolation.
6. **Throwaway harness.** Run a minimal subset of the system (one service with mocked dependencies) that exercises the bug path with one function call.
7. **Property / fuzz loop.** If the bug produces "sometimes wrong output", run 1000 random inputs and identify the failure mode.
8. **Bisection harness.** If the bug appeared between two known states (commit, dataset, or version), automate "boot at state X, check, repeat" so you can run `git bisect run`.
9. **Differential loop.** Run the same input through the old and new versions, or two configurations, and diff the outputs.
10. **HITL bash script.** Use this as a last resort. If a human must click, drive _them_ with `scripts/hitl-loop.template.sh` so the loop remains structured. Feed the captured output back into the diagnosis.

A correct feedback loop provides most of the work needed to fix the bug.

### Tighten the loop

Treat the loop as a product. Once you have a loop, **tighten** it:

- Make it faster. Cache setup, skip unrelated initialization, and narrow the test scope.
- Make the signal sharper. Assert on the specific symptom, not "didn't crash".
- Make it more deterministic. Pin time, seed RNG, isolate the filesystem, and freeze the network.

A 30-second flaky loop provides little value. A 2-second deterministic loop is tight and supports effective debugging.

### Non-deterministic bugs

The goal is not a clean reproduction. The goal is a **higher reproduction rate**. Run the trigger 100×, run it in parallel, add stress, narrow timing windows, or inject sleeps. A bug with a 50% failure rate is debuggable. A 1% failure rate is not. Increase the rate until debugging is practical.

### When you genuinely cannot build a loop

Stop and state that you cannot build a loop. List what you tried. Ask the user for one of: (a) access to an environment that reproduces the bug, (b) a redacted captured artifact (HAR file, log dump, core dump, or screen recording with timestamps), or (c) permission to add temporary production instrumentation. Do **not** form hypotheses without a loop.

### Completion criterion — a tight loop that goes red

Phase 1 is complete when the loop is **tight** and **red-capable**. You must identify **one command** — a script path, test invocation, or curl — that you have **already run at least once**. Show the invocation and redacted output. The command must be:

- [ ] **Red-capable** — it drives the actual bug code path and asserts the **user's exact symptom**, so it can go red on this bug and green once fixed. Not "runs without erroring" — it must be able to _catch this specific bug_.
- [ ] **Deterministic** — same verdict every run (flaky bugs: a pinned, high reproduction rate, per above).
- [ ] **Fast** — seconds, not minutes.
- [ ] **Agent-runnable** — you can run it unattended; a human in the loop only via `scripts/hitl-loop.template.sh`.

If you start reading code to build a theory before this command exists, **stop**. Jumping directly to a hypothesis is the failure this skill prevents. Without a red-capable command, do not start Phase 2.

## Phase 2 — Reproduce and minimize

Run the loop until it goes red. Confirm that the bug appears.

Confirm:

- [ ] The loop produces the failure mode the **user** described, not a different nearby failure. A wrong bug produces a wrong fix.
- [ ] The failure is reproducible across multiple runs. For a non-deterministic bug, reproduce it at a rate that supports debugging.
- [ ] You captured the exact symptom (error message, wrong output, or slow timing). Later phases use this symptom to verify the fix.

### Minimize

After the loop goes red, reduce the reproduction to the **smallest scenario that still goes red**. Remove inputs, callers, configuration, data, and steps **one at a time**. Run the loop after each removal. Keep only elements required for the failure.

A minimal reproduction reduces the Phase 3 hypothesis space and becomes the Phase 5 regression test.

The phase is complete when **every remaining element is load-bearing**. Removing any element must make the loop go green.

Do not continue until you have reproduced **and** minimized the bug.

## Phase 3 — Hypothesise

Generate **3–5 ranked hypotheses** before testing any hypothesis. Generating one hypothesis can anchor you on the first plausible idea.

Each hypothesis must be **falsifiable**. State its prediction.

> Format: "If <X> is the cause, then <changing Y> will make the bug disappear / <changing Z> will make it worse."

If you cannot state the prediction, the hypothesis is not testable. Discard it or make it precise.

**Show the ranked list to the user before testing.** The user may have domain knowledge that changes the order ("we just deployed a change to #3") or may have ruled out some hypotheses. This is a low-cost checkpoint. If the user is AFK, continue with your ranking.

## Phase 4 — Instrument

Map each probe to one prediction from Phase 3. **Change one variable at a time.**

Tool preference:

1. **Debugger / REPL inspection** if the env supports it. One breakpoint beats ten logs.
2. **Targeted logs** at boundaries that distinguish the hypotheses.
3. Do not "log everything and grep".

**Tag every debug log** with a unique prefix, such as `[DEBUG-a4f2]`. Remove all tagged logs at the end with one grep. Untagged logs can remain; tagged logs must be removed.

**Performance branch.** For performance regressions, logs are usually not useful. Establish a baseline measurement first (timing harness, `performance.now()`, profiler, or query plan). Then bisect. Measure first and fix second.

## Phase 5 — Fix + regression test

Write the regression test **before the fix**, but only when a **correct seam** exists.

A correct seam lets the test exercise the **real bug pattern** at the call site. If the only seam is too shallow (for example, a single-caller test when the bug needs multiple callers, or a unit test that cannot reproduce the triggering chain), a regression test at that seam gives false confidence.

**If no correct seam exists, that is the finding.** Record it. The codebase architecture prevents the bug from being captured by a regression test. Flag this for the next phase.

If a correct seam exists:

1. Turn the minimized reproduction into a failing test at that seam.
2. Run the test and confirm that it fails.
3. Apply the fix.
4. Run the test and confirm that it passes.
5. Re-run the Phase 1 feedback loop against the original (un-minimized) scenario.

## Phase 6 — Cleanup

Complete these checks before you declare the work done:

- [ ] The original reproduction no longer reproduces (re-run the Phase 1 loop).
- [ ] The regression test passes, or the absence of a seam is documented.
- [ ] All `[DEBUG-...]` instrumentation is removed (`grep` the prefix).
- [ ] Throwaway prototypes are deleted or moved to a clearly marked debug location.
- [ ] The correct hypothesis is stated in the commit or PR message so the next debugger can use it.
