# ADR-004: Dependency layering rules — stores must not import from queries

## Status

Proposed

## Date

2026-07-13

## Related

- Issue #1158
- Issue #1064 (Architecture Audit)
- ADR-0002 (Strangler-fig I/O migration — stores benefit from clean layering
  during module-by-module migration)
- ADR-003 (Phase enums — same `cart.ts` file, different concern)

## Context

Plebeian Market has two core layers in `src/` that are **bidirectionally
coupled**:

| Direction | Files | Import lines |
|---|---|---|
| Stores → Queries (wrong) | 5 (`cart.ts`, `auth.ts`, `collection.ts`, `ndk.ts`, `product.ts`) | 6 |
| Queries → Stores (correct) | 28 unique files | 33 import lines |

The most severe case is `cart.ts` (1,892 lines), which imports from **5 query
modules**:

```typescript
import { fetchLatestCartSnapshot } from '@/queries/cart'           // L3
import type { SupportedCurrency } from '@/queries/external'        // L4
import { btcExchangeRatesQueryOptions } from '@/queries/external'  // L5
import { productQueryOptions } from '@/queries/products'           // L6
import { shippingOptionQueryOptions } from '@/queries/shipping'    // L7-13
import { v4VForUserQuery } from '@/queries/v4v'                     // L14
```

This creates a **circular dependency**: stores depend on queries, and queries
depend on stores (`ndkActions`, `authStore`, `walletActions`, `configStore`).
Changing a query import triggers store recompilation, which triggers query
recompilation.

**Trend:** The query→store coupling **worsened** from 25 import lines
(previous measurement) to 33 import lines (current master, b6869d52). There
is no automated enforcement — no ESLint config exists in the project at all.

The cart store already contains a partial solution: the `CartSyncDependencies`
dependency-injection type (L378–386) wraps external calls for testability.
But the `defaultCartSyncDependencies` wiring (L388–390) still lives in the
same module and still imports query functions at the top of the file. The
compile-time coupling is not actually broken.

## Decision

Establish explicit dependency-layering rules and enforce them.

### Layering rules

```
┌─────────────────────────────────────────┐
│          Components / Routes             │  (UI layer)
│           src/components, src/routes     │
├──────────────┬──────────────────────────┤
│   Queries    │        Stores            │  (domain layer)
│  src/queries │  src/lib/stores          │
├──────────────┴──────────────────────────┤
│          Core / Lib                     │  (infrastructure)
│     src/lib (non-stores), src/server     │
└─────────────────────────────────────────┘
```

1. **Queries MAY import from Stores** — queries read store state (e.g.,
   `ndkStore`) to configure fetches. This is the expected direction.
2. **Stores MUST NOT import from Queries** — stores should not have
   compile-time dependencies on query modules. If a store needs data from a
   query, it receives it via dependency injection or a callback.
3. **Stores may import from Core/Lib** — `src/lib/constants`, `src/lib/schemas`,
   etc.
4. **Queries may import from Core/Lib** — `src/lib` utilities, schemas, etc.
5. **Components may import from both Stores and Queries** — the UI layer wires
   them together.

### Enforcement

An ESLint `no-restricted-imports` rule scoped to `src/lib/stores/`:

```javascript
{
  overrides: [{
    files: ['src/lib/stores/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['@/queries/*'],
          message: 'Stores must not import from queries. Use dependency injection (see CartSyncDependencies in cart.ts). See ADR-003.',
          allowTypeImports: false,
        }],
      }],
    },
  }],
}
```

Until ESLint is adopted, a CI grep check serves as interim enforcement:

```bash
if grep -rl "from '@/queries" src/lib/stores/; then
  echo "ERROR: Store files must not import from queries. See ADR-003."
  exit 1
fi
```

### Dependency injection pattern

The existing `CartSyncDependencies` pattern is the approved solution, but it
must be **completed**: move the default wiring out of the store module and
into a separate initialization site:

```typescript
// src/lib/stores/cart.ts — NO query imports
type CartSyncDependencies = { /* ... */ }
let cartSyncDependencies: CartSyncDependencies

export function initCartSyncDependencies(deps: CartSyncDependencies) {
  cartSyncDependencies = deps
}

// ... store logic uses cartSyncDependencies.getProductEvent(), etc.

// src/lib/stores/cart-init.ts or boot.ts — query imports live HERE
import { productQueryOptions } from '@/queries/products'
import { shippingOptionQueryOptions } from '@/queries/shipping'
import { initCartSyncDependencies } from '@/lib/stores/cart'

initCartSyncDependencies({
  getProductEvent: fetchProductEventFromQueries,
  getShippingEvent: fetchShippingEventFromQueries,
  // ...
})
```

## Invariants

- **No `import ... from '@/queries/...'` in any file under `src/lib/stores/`**
- Stores receive query-derived data via DI (injected at boot) or via callbacks
  from the UI layer
- The DI wiring code (which imports queries) lives outside the store module —
  in an init module, `boot.ts`, or a provider
- Query modules may freely import from stores; this direction is not restricted
- When a store needs a value from a query (e.g., exchange rates), it either:
  (a) receives it as a parameter from the caller, (b) uses an injected fetch
  function, or (c) subscribes to a store that the UI layer populates from query
  results

## Consequences

### Positive

- **No circular dependencies**: build times improve, hot-module-reload becomes
  more predictable
- **Testable stores in isolation**: store unit tests can inject mock
  dependencies without importing the real query layer
- **Clear layering**: the dependency graph becomes a DAG — queries depend on
  stores and core; stores depend only on core; components depend on both
- **Migration-friendly**: when ADR-0002 changes how queries fetch data, stores
  are unaffected because they don't import queries directly

### Costs

- **Migration effort for 5 store files**: each must be refactored to extract
  query imports into DI wiring
- **`cart.ts` is substantial**: 1,892 lines with 5 query imports. The DI
  extraction is non-trivial but the pattern already exists
- **Boilerplate**: every store that needs query data gains a DI type, an init
  function, and a wiring site
- **Runtime initialization order**: the DI wiring must execute before the store
  is used. This introduces a boot-order dependency (similar to how `boot.ts`
  already initializes NDK before stores use it)
- **No ESLint yet**: the project has no ESLint config. Adopting it requires
  initial setup before this rule can be enforced mechanically

## Rollout / PR sequence

### PR 1 — Add CI grep check

Add the CI grep script that fails the build if any store file imports from
queries. Document the rules. No code changes.

### PR 2 — Extract cart.ts query dependencies into DI wiring

Move `fetchProductEventFromQueries` and `fetchShippingEventFromQueries` into
`cart-init.ts`. Move `defaultCartSyncDependencies` wiring into `cart-init.ts`.
Remove all 5 query imports from `cart.ts`. Wire the DI in `boot.ts`.

### PR 3 — Extract auth.ts query dependencies

Same pattern.

### PR 4 — Extract collection.ts and product.ts query dependencies

Same pattern.

### PR 5 — Set up ESLint with `no-restricted-imports`

Remove the CI grep check once the lint rule is active.

### PR 6 — Audit ndk.ts and verify zero violations

Confirm all store files pass the lint rule.

## Notes

The 28 query files that import from stores are **not** a problem — that
direction is architecturally correct. The issue is solely the 5 store files
that import back into queries, creating cycles. Once those are resolved, the
dependency graph is acyclic.

The root `AGENTS.md` does not currently mention import-direction layering
rules — it focuses on state-type separation (payment lifecycle, sensitive
data). This ADR introduces the import-direction constraint as a new rule.
