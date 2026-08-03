// gaps — the named-holes container. See test/gaps.test.mjs for the measurements
// that motivated each code, and docs/PLAN.md M2 for where it sits in the record.
//
// The governing principle, carried from M0: a zero is plottable and false, which is
// worse than a hole. `prices.mjs` already honours it for cost (`usd: null`,
// `unpriced: []`, `complete: false`). This is the same rule for STRUCTURAL holes —
// the things that went missing around the numbers rather than in them.
//
// A gap does NOT condemn the record. `ok: false` means "this record is not worth
// reading"; a gap means "this record is worth reading, and here is precisely what is
// missing from it." Collapsing the two throws away a mostly-good run.

// A closed set, for the same reason blocked.mjs REASONS is closed: "how often does
// Alfred lose the subagents dir" has to be answerable by aggregating telemetry rather
// than grepping prose. Free text defeats that silently, so it is refused at the
// boundary. Adding a code here is deliberate; accepting an unknown one is not.
export const GAP_CODES = Object.freeze({
  'subagents-unreadable': 'the subagents directory exists but could not be read',
  'session-id-absent': 'no session id was available to join on',
  'session-id-mismatch': 'the session id Alfred generated disagrees with the one the worker log reported',
  'run-window-guessed': 'the run window was inferred rather than given',
  'no-usable-usage': 'lines parsed, but none carried a usage record',
  'model-id-disagreement': 'sources reported different model ids for one call',
  'model-id-absent': 'no source reported a model id',
  'direct-api-calls-untracked': 'work bypassed Claude Code and emits no telemetry',
  // Added for #42. Same family as the rest: the numbers in this record may be fine,
  // but what they can be COMPARED TO is not known. A record whose stamp names a
  // rubric+fixture digest the repo cannot reproduce is the trend line lying without
  // any single reading being false. Aggregatable so "how often do we produce
  // uncomparable results" is a query rather than a grep.
  'suite-stamp-invalid': 'the suite stamp is missing, malformed, or disagrees with the suite on disk',
  // Added for A5. THE SAME FAMILY as suite-stamp-invalid: the numbers may be perfect,
  // but what cohort this record belongs to is not known. `'alfred_thin'` and
  // `'alfred-thin'` aggregate as two arms, so a single typo silently halves a sample —
  // and the comparison between arms is the entire reason the sink exists. Named rather
  // than thrown: a mislabelled record is still worth reading, per this module's own
  // "a gap does NOT condemn the record" rule.
  'provenance-arm-unknown': 'the record names an arm that is not in the known set',
  // Added for D, and it is the first code in this set that a LIVE RUN found rather than a
  // review. Same family as model-id-disagreement one line up — two sources for one fact that
  // do not agree — but about the dollar figure rather than the model name. Measured 2026-08-03:
  // both jarvis#7 runs priced 5.34% and 6.04% under the vendor because the result line carries
  // two token ledgers and we were summing the smaller one. Five shorter records agreed to 6dp,
  // which is exactly why this needs to aggregate: one record's 5% gap is invisible, and "our
  // two cost sources diverge on long runs" is only visible across the sink.
  'cost-source-disagreement': 'our computed cost and the vendor-reported cost do not agree',
});

// THE CLOSED SET OF ARMS, for exactly the reason GAP_CODES above is closed: "how does the
// thin runner compare to the arm it replaced" has to be answerable by aggregating the sink
// rather than by grepping prose, and free text defeats that without ever erroring.
//
//   single-agent         one `claude -p`, no harness. The control.
//   alfred-multi-agent   Alfred as it stood before the thin rewrite (phase orchestration).
//   alfred-thin          the single-session runner Phase B builds.
//
// NOT VALIDATED BY THROWING. `isKnownArm` returns a boolean and the caller records a gap,
// because `buildRecord`'s standing rule is that report failure cannot fail the run being
// reported on — and a backfill of four historical records is precisely where a strict
// validator would abort the job it was meant to document.
export const ARM_IDS = Object.freeze({
  SINGLE_AGENT: 'single-agent',
  MULTI_AGENT: 'alfred-multi-agent',
  THIN: 'alfred-thin',
});

// Derived from ARM_IDS, never a second list. Two hand-maintained copies of the same set is the
// #67 drift shape, and here the drift would be invisible: an id in one and not the other reads
// as "that arm is a typo" on records that spelled it exactly as the code that wrote them did.
export const ARMS = Object.freeze(Object.values(ARM_IDS));

// `null` is KNOWN-GOOD, not unknown. Most records — every hook-reported session — state no
// arm at all, and if that were a gap the list would carry a permanent hole on nearly
// everything and stop distinguishing anything. Absent is unobserved; wrong is wrong.
export function isKnownArm(arm) {
  return arm === null || arm === undefined || ARMS.includes(arm);
}

export function newGaps() {
  return [];
}

export function noteGap(gaps, code, detail) {
  if (!Object.hasOwn(GAP_CODES, code)) {
    // Thrown, not recorded-as-unknown: an unaggregatable hole in the hole-tracker is
    // the same class of defect it exists to prevent.
    throw new Error(`unknown gap code: ${code}`);
  }
  if (typeof detail !== 'string' || detail.trim() === '') {
    throw new Error(`gap ${code} requires a detail — an unexplained hole is not actionable`);
  }
  gaps.push({ code, detail });
  return gaps;
}

// THE TRANSCRIPT-SHAPE TRIPWIRE.
//
// Keyed on parsed-but-unusable, NOT on totals being zero. A tripwire that fires on
// every trivial session gets muted within a week, and a muted tripwire reads as
// coverage while proving nothing. So: lines we could parse, none of which carried
// usage, means the shape moved under us — refuse rather than report $0.00.
export function usageRefusal({ lines_parsed = 0, usable_usage_records = 0 } = {}) {
  if (lines_parsed > 0 && usable_usage_records === 0) {
    return {
      refused: true,
      code: 'no-usable-usage',
      detail:
        `parsed ${lines_parsed} line(s) but found 0 usage records — ` +
        'the transcript shape may have changed; refusing rather than reporting $0',
    };
  }
  return { refused: false, code: null, detail: null };
}

// Model identity, reconciled across however many sources a caller happens to have.
//
// Measured 2026-07-30 on one session through the Bedrock gateway: the api_request log
// said `claude-haiku-4-5-20251001` while both metrics and the JSON output said
// `sonney`, on identical token counts and an identical $0.291135 that priced out to
// opus-5 exactly. Picking a winner produces a confident per-model figure that is
// wrong, with no error to notice. So a disagreement resolves to null and is named.
export function reconcileModel(sources = {}, gaps = null) {
  const entries = Object.entries(sources).filter(
    ([, id]) => typeof id === 'string' && id.trim() !== '',
  );

  if (entries.length === 0) {
    if (gaps) noteGap(gaps, 'model-id-absent', 'no source reported a model id');
    return null;
  }

  const distinct = [...new Set(entries.map(([, id]) => id))];
  if (distinct.length === 1) return distinct[0];

  if (gaps) {
    const named = entries.map(([source, id]) => `${source}=${id}`).join(', ');
    noteGap(gaps, 'model-id-disagreement', `sources disagree on model id: ${named}`);
  }
  return null;
}

// THE TWO COST SOURCES, compared. Reports; never corrects.
//
// WHY THIS EXISTS. `report.mjs` has recorded both `total_usd` (ours, from the copied price
// table) and `vendor_usd` (the CLI's own `total_cost_usd`) since M2, and the two agreeing has
// been cited repeatedly as the evidence the table is right. Nothing ever CHECKED that they
// agreed. On 2026-08-03 a live run made the omission expensive: both real jarvis#7 runs came in
// 5.34% and 6.04% under the vendor, and the only reason anyone noticed was a human reading two
// numbers side by side in a console line.
//
// The cause is fixed (96cb211 — the result line carries two token ledgers and we summed the
// smaller). This is the tripwire for the next one, and it is deliberately not tied to that
// cause: any future divergence between the two sources fires it, whatever the reason.
//
// A PREDICATE, NOT A FIX. It does not adjust a figure, pick a winner, or fail the record.
// Choosing between the two is analysis and belongs in alfred-telemetry, per the standing
// separation of concerns: Alfred writes raw metrics and names holes.
//
// THE TOLERANCE IS RELATIVE, AND IT HAS TO BE. Five records in the sink agree to 6dp but not to
// the bit: ours 0.825523 against vendor 0.8255230000000001 differ by 1.11e-16, which is the same
// IEEE 754 number arrived at by a different summation order. An absolute epsilon that caught
// that would fire on every record and be muted within a week — this module's own muted-tripwire
// rule. 0.1% is four orders of magnitude above the float noise and two below the defect found.
export const COST_AGREEMENT_TOLERANCE = 0.001;

// BOTH SOURCES OR NO COMPARISON. `comparable: false` is reported separately from
// `disagrees: false` because collapsing them is the denominator-asymmetry defect: an absent
// vendor figure would read as agreement, silently degrading a two-source check into a
// one-source assertion. That is not hypothetical here — the Phase C backfill dry run rebuilt
// all five records with `vendor_usd: null` and looked perfectly clean.
export function costSourceDisagreement({ ours = null, vendor = null } = {}) {
  const none = { disagrees: false, comparable: false, code: null, detail: null, relative: null };

  // `typeof === 'number'` FIRST, and not `Number(x)`. `Number(null)` is 0, not NaN, so a
  // finite-check alone lets a missing vendor figure through as a zero — which then reads as a
  // 100% disagreement or, worse, as agreement against another zero. Caught by the
  // missing-source test on the first run of this function, which is the whole reason that test
  // exists: absent must never be coerced into a number.
  if (typeof ours !== 'number' || typeof vendor !== 'number') return none;
  const a = ours;
  const b = vendor;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return none;
  // A zero denominator has no relative difference to state. Both-zero is agreement; one-zero is
  // a disagreement that this function cannot quantify, so it is reported as incomparable rather
  // than as a division by zero dressed up as Infinity percent.
  if (a === 0) return { ...none, comparable: b === 0 };

  const relative = Math.abs(b - a) / Math.abs(a);
  if (relative <= COST_AGREEMENT_TOLERANCE) {
    return { ...none, comparable: true, relative };
  }

  return {
    disagrees: true,
    comparable: true,
    relative,
    code: 'cost-source-disagreement',
    // BOTH FIGURES AND THE MAGNITUDE. A code alone cannot be triaged — 5% is a defect worth
    // chasing and 1e-16 is float noise, and they would otherwise aggregate identically.
    detail:
      `ours ${a} vs vendor ${b} — a ${(relative * 100).toFixed(2)}% difference, ` +
      `beyond the ${(COST_AGREEMENT_TOLERANCE * 100).toFixed(1)}% tolerance`,
  };
}
