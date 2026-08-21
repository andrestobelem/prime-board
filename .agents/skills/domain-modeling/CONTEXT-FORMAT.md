# CONTEXT.md Format

## Structure

```md
# {Context Name}

{One or two sentence description of what this context is and why it exists.}

## Language

**Order**:
{A one or two sentence description of the term}
_Avoid_: Purchase, transaction

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: Bill, payment request

**Customer**:
A person or organization that places orders.
_Avoid_: Client, buyer, account
```

## Rules

- **Be opinionated.** When several words describe one concept, choose the best word and list the others under `_Avoid_`.
- **Keep definitions tight.** Use one or two sentences. Define what the term IS, not what it does.
- **Include only terms specific to this project's context.** Do not include general programming concepts such as timeouts, error types, or utility patterns, even when the project uses them extensively. Before you add a term, decide whether it is unique to this context. Include only unique concepts.
- **Group terms under subheadings** when natural clusters emerge. Use a flat list when all terms belong to one cohesive area.

## Single vs multi-context repos

**Single context (most repos):** One `CONTEXT.md` at the repo root.

**Multiple contexts:** A `CONTEXT-MAP.md` at the repo root lists the contexts, where they live, and how they relate to each other:

```md
# Context Map

## Contexts

- [Ordering](./src/ordering/CONTEXT.md) — receives and tracks customer orders
- [Billing](./src/billing/CONTEXT.md) — generates invoices and processes payments
- [Fulfillment](./src/fulfillment/CONTEXT.md) — manages warehouse picking and shipping

## Relationships

- **Ordering → Fulfillment**: Ordering emits `OrderPlaced` events; Fulfillment consumes them to start picking
- **Fulfillment → Billing**: Fulfillment emits `ShipmentDispatched` events; Billing consumes them to generate invoices
- **Ordering ↔ Billing**: Shared types for `CustomerId` and `Money`
```

Determine the applicable structure as follows:

- If `CONTEXT-MAP.md` exists, read it to find the contexts.
- If only a root `CONTEXT.md` exists, use a single context.
- If neither file exists, create a root `CONTEXT.md` when you resolve the first term.

When multiple contexts exist, determine which context relates to the current topic. If the relation is unclear, ask.
