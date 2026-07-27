# Final Fix A Report — harness/e2e-orchestration

Date: 2026-07-27

## Files Changed

### Defect 1 — conductor.js finalStatus case mismatch

**`harness-run/lib/conductor.js` (lines 15–29)**
- Replaced the raw uppercase comparisons `x.outcome === 'FAILED' || x.outcome === 'CRASHED'` with a normalized comparison: outcomes are lowercased into a local array `outcomes`, so `failed`, `crashed`, `partial` (any case) all match.
- Added `partial` to the FAILED vocabulary (partial implement = not complete).
- Added UNKNOWN return when all stage outcomes are null/absent (no records carried any outcome).
- EXIT still wins over FAILED (check order: exited first, then failed).
- `stages[].outcome` preserves original value verbatim — only the comparison normalizes.

**`harness-run/lib/conductor.test.js` (lines 30–57 new tests)**
- 6 new tests: lowercase failed → FAILED, lowercase crashed → FAILED, lowercase partial → FAILED, EXIT wins over failed, all-null → UNKNOWN, all success → COMPLETE.

### Defect 2 — weights.js floor invariant

**`harness-bridge/lib/weights.js` (complete rewrite of normalizeTo100 + loadWeights + applyWeightChange)**
- `normalizeTo100`: all-zero total now returns an equal split (floor(100/n) per check, remainder distributed to first checks) rather than returning sum-0. Post-normalization floor: any weight < 1 is raised to 1, and the deficit is taken off the largest weights (those with the most room above 1).
- `loadWeights`: clamps each merged weight to [1, 60] BEFORE calling normalizeTo100, so huge (e.g. 1000) and negative (e.g. -50) overrides cannot reach zero or negative after proportional scaling.
- `applyWeightChange`: same floor-1 post-condition applied to the proportionally-distributed "others" after clamping the changed check to [1,60] via ±15 bounds.

**`harness-bridge/workflow.js` (lines 269–313, mirror updated)**
- `_normalizeTo100` and `_loadWeights` updated byte-for-byte to match lib/weights.js.

**`harness-bridge/lib/weights.test.js` (new tests added)**
- Fixed the vacuous "ceiling 60 and floor 1" test: now uses a raw weight object starting at 56 so the +15 request binds the ceiling at exactly 60; also tests floor via 8-step chain.
- Added `assertInvariants` helper (sum=100, min>=1, max<=60).
- Invariant loop over both CHECKS_A and CHECKS_B: base defaults, huge override, negative override, all-zeros override, unknown-id override, chain of 8 alternating applyWeightChange calls.

## Mirror Sites Grepped

Commands run:
```
grep -n "normalizeTo100\|_normalizeTo100\|loadWeights\|_loadWeights\|applyWeightChange\|_applyWeightChange" harness-*/workflow.js
```

Results:
- `harness-bridge/workflow.js:270` — `_normalizeTo100` ✓ UPDATED
- `harness-bridge/workflow.js:282` — `_loadWeights` ✓ UPDATED
- `harness-bridge/workflow.js:288` — `_normalizeTo100` call ✓ UPDATED
- `harness-bridge/workflow.js:326` — `_loadWeights` call site (no change needed, signature unchanged)

No other workflow.js files reference these functions. `harness-implement/workflow.js`, `harness-intake/workflow.js`, `harness-plan/workflow.js`, `harness-intake-v2/workflow.js`, `harness-split-DEPRECATED/workflow.js` — none contain any of the searched names.

## Failing Test Output (Before Fix)

```
not ok 36 - invariants: CHECKS_A huge override
  error: 'CHECKS_A huge: min must be ≥ 1, got 0'
not ok 37 - invariants: CHECKS_A negative override
not ok 38 - invariants: CHECKS_A all-zeros override
not ok 42 - invariants: CHECKS_B huge override
not ok 43 - invariants: CHECKS_B negative override
not ok 44 - invariants: CHECKS_B all-zeros override
not ok 46 - invariants: CHECKS_B chain of 8 alternating applyWeightChange calls
not ok 174 - assembleRunSummary: lowercase failed → FAILED
  error: Expected values to be strictly equal: + actual - expected
not ok 175 - assembleRunSummary: lowercase crashed → FAILED
not ok 176 - assembleRunSummary: lowercase partial → FAILED
not ok 178 - assembleRunSummary: all-null outcomes → UNKNOWN
# tests 435
# pass 424
# fail 11
```

## Passing Test Output (After Fix)

```
# tests 435
# pass 435
# fail 0
```

## Mirror Parity Comparison Output

```
MATCH | CHECKS_A | null override
MATCH | CHECKS_A | huge override
MATCH | CHECKS_A | negative override
MATCH | CHECKS_A | all-zeros override
MATCH | CHECKS_A | unknown-id override
MATCH | CHECKS_B | null override
MATCH | CHECKS_B | huge override
MATCH | CHECKS_B | negative override
MATCH | CHECKS_B | all-zeros override
MATCH | CHECKS_B | unknown-id override

All cases match.
```

Verification script was `/tmp/mirror-parity-check.mjs`; deleted after use.

## All-Zeros Design Choice

When all weights in the input map are zero (or all overrides are zero), `normalizeTo100` returns an **equal split**: `floor(100/n)` per check, with the remainder distributed one point at a time to the first `(100 % n)` checks. This preserves the invariants (sum=100, min>=1, max<=60) and is deterministic.

The alternative — returning the caller's base defaults — was rejected because `normalizeTo100` does not receive the defaults; it only sees the merged map. Falling back to defaults would require threading extra state through the call. The equal split is simpler, self-contained, and correct: it means an all-zeros override file neutralizes the weight differentiation (every check contributes equally) rather than silently disabling the gate (sum=0) or crashing.

## node --check Parity

Before and after the change, `node --check harness-bridge/workflow.js` produces:

```
SyntaxError: Illegal return statement
```

Same error class, same location (`return` at line 441). No new syntax error was introduced.

## Final Test Count

- Before new tests: 417 tests, 0 failures
- After adding tests (pre-fix): 435 tests, 11 failures
- After applying fixes: **435 tests, 0 failures**
