---
name: codebase-design
description: Shared vocabulary for designing deep modules. Use when the user wants to design or improve a module's interface, find deepening opportunities, decide where a seam goes, make code more testable or AI-navigable, or when another skill needs the deep-module vocabulary.
---

# Codebase Design

Design **deep modules**: place substantial behavior behind a small interface and a clean seam. Test the module through that interface. Use this language and these principles when you design or restructure code. The goals are leverage for callers, locality for maintainers, and testability.

## Glossary

Use these terms exactly. Do not substitute "component," "service," "API," or "boundary." Consistent language is required.

**Module** — anything with an interface and an implementation. The term is independent of scale: it can mean a function, class, package, or tier-spanning slice. _Avoid_: unit, component, service.

**Interface** — every fact a caller must know to use the module correctly. This includes the type signature, invariants, ordering constraints, error modes, required configuration, and performance characteristics. _Avoid_: API, signature (both terms describe only the type-level surface).

**Implementation** — the code inside a module. It is distinct from **Adapter**. A small adapter can have a large implementation (a Postgres repo), and a large adapter can have a small implementation (an in-memory fake). Use "adapter" when the seam is the topic and "implementation" otherwise.

**Depth** — leverage at the interface: the amount of behavior a caller or test can exercise for each unit of interface it must learn. A module is **deep** when substantial behavior sits behind a small interface. It is **shallow** when the interface is nearly as complex as the implementation.

**Seam** _(Michael Feathers)_ — a place where you can alter behavior without editing that place. It is the location where a module's interface lives. Choosing the seam is a design decision that is separate from choosing what goes behind it. _Avoid_: boundary (overloaded with DDD's bounded context).

**Adapter** — a concrete thing that satisfies an interface at a seam. It describes a *role* (the slot it fills), not its contents.

**Leverage** — what callers get from depth: more capability for each unit of interface they learn. One implementation serves N call sites and M tests.

**Locality** — what maintainers get from depth: changes, bugs, knowledge, and verification concentrate in one place instead of spreading across callers. Fix once; fix everywhere.

## Deep vs shallow

**Deep module** = small interface + lots of implementation:

```
┌─────────────────────┐
│   Small Interface   │  ← Few methods, simple params
├─────────────────────┤
│                     │
│  Deep Implementation│  ← Complex logic hidden
│                     │
└─────────────────────┘
```

**Shallow module** = large interface + little implementation (avoid):

```
┌─────────────────────────────────┐
│       Large Interface           │  ← Many methods, complex params
├─────────────────────────────────┤
│  Thin Implementation            │  ← Just passes through
└─────────────────────────────────┘
```

When designing an interface, ask:

- Can I reduce the number of methods?
- Can I simplify the parameters?
- Can I hide more complexity inside?

## Principles

- **Depth is a property of the interface, not the implementation.** A deep module can contain small, mockable, swappable parts. Those parts are not part of the interface. A module can have **internal seams** (private to its implementation and used by its own tests) and an **external seam** at its interface.
- **The deletion test.** Consider deleting the module. If complexity vanishes, the module was a pass-through. If complexity reappears across N callers, the module provides value.
- **The interface is the test surface.** Callers and tests cross the same seam. If a test must go *past* the interface, the module probably has the wrong shape.
- **One adapter means a hypothetical seam. Two adapters means a real one.** Introduce a seam only when something varies across it.

## Designing for testability

Good interfaces make testing direct:

1. **Accept dependencies, don't create them.**

   ```typescript
   // Testable
   function processOrder(order, paymentGateway) {}

   // Hard to test
   function processOrder(order) {
     const gateway = new StripeGateway();
   }
   ```

2. **Return results, don't produce side effects.**

   ```typescript
   // Testable
   function calculateDiscount(cart): Discount {}

   // Hard to test
   function applyDiscount(cart): void {
     cart.total -= discount;
   }
   ```

3. **Small surface area.** Fewer methods = fewer tests needed. Fewer params = simpler test setup.

## Relationships

- A **Module** has exactly one **Interface** (the surface it presents to callers and tests).
- **Depth** is a property of a **Module**, measured against its **Interface**.
- A **Seam** is where a **Module**'s **Interface** lives.
- An **Adapter** sits at a **Seam** and satisfies the **Interface**.
- **Depth** produces **Leverage** for callers and **Locality** for maintainers.

## Rejected framings

- **Depth as ratio of implementation-lines to interface-lines** (Ousterhout): rewards padding the implementation. We use depth-as-leverage instead.
- **"Interface" as the TypeScript `interface` keyword or a class's public methods**: too narrow — interface here includes every fact a caller must know.
- **"Boundary"**: overloaded with DDD's bounded context. Say **seam** or **interface**.

## Going deeper

- **Deepening a cluster given its dependencies** — see [DEEPENING.md](DEEPENING.md): dependency categories, seam discipline, and replace-don't-layer testing.
- **Exploring alternative interfaces** — see [DESIGN-IT-TWICE.md](DESIGN-IT-TWICE.md): spin up parallel sub-agents to design the interface several radically different ways, then compare on depth, locality, and seam placement.
