---
name: tdd
description: Test-driven development. Use when the user wants to build features or fix bugs test-first, mentions "red-green-refactor", or wants integration tests.
---

# Test-Driven Development

TDD is the red → green loop. This skill defines the tests to keep, their locations, the anti-patterns, and the loop rules. Apply every section on every cycle. Consult it before and during the loop.

When exploring the codebase, read `CONTEXT.md` (if it exists) so test names and interface vocabulary match the project's domain language, and respect ADRs in the area you're touching.

## What a good test is

Tests verify behavior through public interfaces, not implementation details. Code can change completely while tests remain valid. A good test reads like a specification: "user can checkout with valid cart" identifies the capability. The test survives refactoring because it does not depend on internal structure.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

## Seams — where tests go

A **seam** is the public interface where you observe behavior without reaching inside a module. Test at seams, never against internals.

**Test only at agreed seams.** Before writing a test, list the seams under test and confirm them with the user. Do not write a test at an unconfirmed seam. You cannot test everything. Agreeing the seams first focuses effort on critical paths and complex logic instead of every edge case.

Ask: "What's the public interface, and which seams should we test?"

When the interface shape is in question — module depth, seam location, or exposed behavior — call the Skill tool with "codebase-design" for the vocabulary. That skill is the shared source for the terms module, interface, depth, seam, adapter, leverage, and locality. Consult it as a reference; do not run it as a session.

## Anti-patterns

- **Implementation-coupled** — mocks internal collaborators, tests private methods, or verifies through a side channel (querying the database instead of using the interface). The test fails after a refactor even when behavior is unchanged.
- **Tautological** — recomputes the expected value with the same method as the code (`expect(add(a, b)).toBe(a + b)`, a snapshot derived by hand the same way, a constant asserted equal to itself). The assertion passes by construction and cannot detect a disagreement. Get expected values from an independent source of truth: a known-good literal, a worked example, or the spec.
- **Horizontal slicing** — writes all tests before all implementation. Bulk tests verify _imagined_ behavior and focus on structure instead of user-facing behavior. They make test design insensitive to real changes and commit to a structure before the implementation is understood. Use **vertical slices** instead: one test → one implementation → repeat. Each test is a **tracer bullet** that responds to what the previous cycle taught you.

## Rules of the loop

- **Red before green.** Write the failing test first. Then write only enough code to pass it. Do not anticipate future tests or add speculative features.
- **One slice at a time.** Use one seam, one test, and one minimal implementation per cycle.
- **Refactoring is not part of the loop.** Do it during the review stage (see the `code-review` skill), not during the red → green implementation cycle.
