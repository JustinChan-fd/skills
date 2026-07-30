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
  'run-window-guessed': 'the run window was inferred rather than given',
  'no-usable-usage': 'lines parsed, but none carried a usage record',
  'model-id-disagreement': 'sources reported different model ids for one call',
  'model-id-absent': 'no source reported a model id',
  'direct-api-calls-untracked': 'work bypassed Claude Code and emits no telemetry',
});

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
