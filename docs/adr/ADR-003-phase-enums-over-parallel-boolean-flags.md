# ADR-003: Phase enums (state machines) instead of parallel boolean flags

## Status

Proposed

## Date

2026-07-13

## Related

- Reinforces constraint from root `AGENTS.md` (lines 41–47): "Do not collapse
  payment lifecycles into booleans"
- Same constraint repeated in `src/AGENTS.md`, `src/lib/AGENTS.md`,
  `src/queries/AGENTS.md`, `src/publish/AGENTS.md`, `src/hooks/AGENTS.md`
- Issue #1155
- Issue #1064 (Architecture Audit)

## Context

The root `AGENTS.md` already prohibits collapsing payment lifecycles into
booleans — the constraint lists 10 distinct lifecycle states (requested,
attempted, wallet acknowledged, settled/proven, receipt published, merchant
confirmed, expired, failed, refunded, fulfilled). This rule appears in **6 of
12 AGENTS.md files** across the repository.

However, the guidance does not specify a **concrete type-level pattern** for
how to model these states. The most prominent violation remains in production:

`LightningPaymentProcessor` (`src/components/lightning/LightningPaymentProcessor.tsx`,
869 lines) tracks its payment flow with three independent `useState<boolean>`
flags:

```typescript
const [isGeneratingInvoice, setIsGeneratingInvoice] = useState(false)   // L115
const [isPaymentInProgress, setIsPaymentInProgress] = useState(false)  // L116
const [isCheckingForReceipt, setIsCheckingForReceipt] = useState(false) // L117
```

These encode a sequential lifecycle (generate → pay → check → done) but
nothing prevents **impossible states** — e.g., `isGeneratingInvoice=true AND
isPaymentInProgress=true` simultaneously:

| isGeneratingInvoice | isPaymentInProgress | isCheckingForReceipt | Meaningful? |
|---|---|---|---|
| true | true | false | No — cannot generate and pay simultaneously |
| false | true | true | No — sequential coupling not represented |
| true | false | true | No — cannot generate and check receipt simultaneously |
| true | true | true | No — undefined behavior |

With N independent booleans, the type system permits `2^N` states, but only
`N + 1` are valid. The remaining `2^N - N - 1` states are bugs waiting to
happen.

**Note:** The `hasCompletedRef` reset bug flagged in earlier analysis was
already fixed on master (two reset paths added at L647 and L676). The
boolean anti-pattern itself remains.

## Decision

Lifecycle phases in React components will be modeled as a **discriminated
union** (phase enum) rather than parallel boolean flags.

For `LightningPaymentProcessor`, the three booleans will be replaced by a
single `PaymentPhase` state:

```typescript
type PaymentPhase =
  | { kind: 'idle' }
  | { kind: 'generating-invoice' }
  | { kind: 'processing-payment'; method: 'nwc' | 'webln' | 'nip60' }
  | { kind: 'checking-receipt' }
  | { kind: 'background-monitoring'; invoice: string }
  | { kind: 'completed'; proofType: PaymentProof['type'] }
  | { kind: 'failed'; error: string }

const [phase, setPhase] = useState<PaymentPhase>({ kind: 'idle' })
```

The `background-monitoring` variant explicitly models the QR code payment path
(where the component watches for external payment without setting
`isPaymentInProgress`). This path was previously implicit — all three
booleans false but the background `useEffect` (L293) actively monitoring.

### Rule for future code

> **Any component with 3+ boolean `useState` flags that collectively represent
> phases of a single lifecycle MUST use a discriminated union type instead.**

Two flags may be permitted if they are genuinely orthogonal (e.g.,
`isExpanded` and `isLoading` on unrelated concerns). Three or more flags that
describe a sequential process must be consolidated.

This rule makes the existing AGENTS.md constraint ("Do not collapse payment
lifecycles into booleans") mechanically enforceable — the type system rejects
impossible states rather than relying on convention.

## Invariants

- Only one phase is active at any time — the type system enforces this
- Phase transitions are explicit: `idle → generating-invoice → idle` (with
  invoice), `idle → processing-payment → checking-receipt → completed`, etc.
- The phase carries its own payload (e.g., `method` for processing,
  `proofType` for completed, `error` for failed) rather than separate state
  variables
- Phase checks use exhaustive pattern matching (`switch (phase.kind)`) so
  adding a new phase is a compile error in every consumer until handled
- Refs (`hasCompletedRef`, `hasRequestedInvoiceRef`) remain for imperative
  guards but their role is reduced — the phase itself becomes the primary
  source of truth

## Consequences

### Positive

- **Impossible states are unrepresentable**: the compiler rejects
  `isGeneratingInvoice && isPaymentInProgress` because there is no phase with
  both properties
- **Exhaustive checking**: `switch (phase.kind)` produces a compile error when
  a new phase is added but not handled
- **Richer state per phase**: `processing-payment` carries `method`,
  eliminating a parallel `paymentMethod` state variable; `completed` carries
  `proofType`, eliminating a separate variable
- **Simpler effects**: the background-monitoring effect can key off
  `phase.kind === 'background-monitoring'` instead of the current
  `!isGeneratingInvoice && !isPaymentInProgress && !hasCompleted`
- **Self-documenting**: the phase type documents the component's lifecycle in
  one place

### Costs

- **Migration effort**: `LightningPaymentProcessor` is ~870 lines and touches
  the booleans in ~12 locations across generation, payment, monitoring, and
  error handlers
- **Render logic changes**: `isGeneratingInvoice` checks in JSX become
  `phase.kind === 'generating-invoice'` — slightly more verbose in templates
- **Transitional period**: until the migration lands, the booleans remain, and
  reviewers must be vigilant about not adding new boolean phase flags
- **Learning curve**: contributors unfamiliar with discriminated unions need
  to understand exhaustive switch patterns

## Rollout / PR sequence

### PR 1 — Define `PaymentPhase` type and transition helper

Introduce the `PaymentPhase` type alongside the existing booleans. Add a
`setPhase` wrapper that sets the phase and, as a transitional bridge, also
sets the corresponding booleans. No behavior changes.

### PR 2 — Migrate read sites

Replace all `isGeneratingInvoice` / `isPaymentInProgress` /
`isCheckingForReceipt` read sites with `phase.kind === ...` checks. Remove
the boolean-derived guards from effects. Keep booleans as write-only mirrors
during this PR.

### PR 3 — Migrate write sites and remove booleans

Replace all `setIsGeneratingInvoice(true)` etc. with
`setPhase({ kind: 'generating-invoice' })`. Remove the boolean state
variables and the transitional bridge.

### PR 4 — Enrich phase payloads and simplify refs

Move `paymentMethod` into the `processing-payment` phase variant. Evaluate
whether `hasCompletedRef` can be replaced by `phase.kind === 'completed'`.

### PR 5 — Audit other components for the 3-flag anti-pattern

Search for components with 3+ boolean `useState` flags and evaluate whether
they represent lifecycle phases. File issues for any that should be migrated.

## Notes

The AGENTS.md constraint "Do not collapse payment lifecycles into booleans"
(lines 41–47) was established independently by the project maintainers before
this ADR. This ADR makes that constraint concrete: it specifies the TypeScript
pattern (discriminated union) that implements the rule, and it provides a
migration path for the most prominent violator (`LightningPaymentProcessor`).

The AGENTS.md itself says: "Do not use AGENTS text as proof that behavior
already exists." The code does not yet comply with the constraint it
documents. This ADR is the implementation plan to close that gap.
