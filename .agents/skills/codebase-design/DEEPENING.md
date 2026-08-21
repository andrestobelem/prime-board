# Deepening

How to safely deepen a cluster of shallow modules when dependencies are present. This document uses the vocabulary in [SKILL.md](SKILL.md): **module**, **interface**, **seam**, and **adapter**.

## Dependency categories

When you assess a deepening candidate, classify its dependencies. The category determines how to test the deepened module across its seam.

### 1. In-process

Pure computation with in-memory state and no I/O. You can always deepen this category. Merge the modules and test the new interface directly. No adapter is needed.

### 2. Local-substitutable

Dependencies with local test stand-ins (PGLite for Postgres or an in-memory filesystem). Deepen this category when the stand-in exists. Test the deepened module with the stand-in in the test suite. The seam is internal; do not add a port at the module's external interface.

### 3. Remote but owned (Ports & Adapters)

Your own services across a network boundary (microservices or internal APIs). Define a **port** (interface) at the seam. The deep module owns the logic. Inject the transport as an **adapter**. Tests use an in-memory adapter. Production uses an HTTP/gRPC/queue adapter.

Recommendation shape: *"Define a port at the seam, implement an HTTP adapter for production and an in-memory adapter for testing, so the logic sits in one deep module even though it's deployed across a network."*

### 4. True external (Mock)

Third-party services (Stripe, Twilio, etc.) that you do not control. The deepened module receives the external dependency through an injected port. Tests provide a mock adapter.

## Seam discipline

- **One adapter means a hypothetical seam. Two adapters means a real one.** Introduce a port only when at least two adapters are justified (typically production and test). A single-adapter seam is indirection.
- **Internal seams vs external seams.** A deep module can have internal seams (private to its implementation and used by its own tests) and an external seam at its interface. Tests that use internal seams do not justify exposing them through the interface.

## Testing strategy: replace, don't layer

- Delete old unit tests for shallow modules when tests at the deepened module's interface cover the behavior.
- Write new tests at the deepened module's interface. The **interface is the test surface**.
- Assert observable outcomes through the interface, not internal state.
- Tests must survive internal refactors. They describe behavior, not implementation. If an implementation change requires a test change, the test goes past the interface.
