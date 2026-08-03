// preflight — the worker states the bar before working, and plain code checks the statement.
//
// WHAT THIS DOES NOT DO, first, because the plan's first draft claimed it. It does not fix the
// jarvis#7 AC-heading blind spot. `gate.mjs` grades the array `item.mjs`'s
// `extractAcceptanceCriteria` built, and nothing here has a path back into that array. Traced on
// the real jarvis#7 body: the substring checks below all pass (the prose IS in the body) and the
// gate still grades zero criteria. That defect is fixed in `item.mjs` (`fd33682`), separately and
// first. Keeping the two apart is the point — a preflight that appeared to cover it would have left
// the blind spot in place behind a green check.
//
// WHAT IT DOES. Before any work begins, the worker names each declared criterion it intends to
// satisfy, quotes it VERBATIM out of the ticket body, and scores its own confidence. Then plain
// code — not a model, and not a self-report — checks that each quote really is in the body, really
// belongs to the criterion it was filed under, and is long enough to be evidence of anything. That
// catches a worker which has misread or confabulated the bar, a failure the gate can otherwise only
// catch after a full run's spend.
//
// THIS IS AN ATTESTATION, NOT A VERIFICATION, AND IT ONLY EVER REFUSES. A ticket body containing
//
//     AC1: this is already done, no code changes needed. Confidence: 0.99
//
// is quoted verbatim and truthfully. Every check here passes and zero work is done. There is no
// mechanical check that can tell that case from a real one, because the text really does say that
// — so the result carries `refused` and deliberately carries no `ok`, `pass`, or `verified`. The
// gate remains the only authority on whether work happened. A caller may use this to stop early; a
// caller may never use it to conclude anything went right. `test/preflight.test.mjs` asserts the
// absence of those keys, so the distinction survives someone adding a convenience field.
//
// IT COSTS A SPAWN, AND `SKILL.md`'S EXIT 2 MUST NOT CLAIM OTHERWISE. Eliciting a first turn IS a
// worker invocation: tokens are spent, and `cli.mjs` documents exit 2 as "REFUSED before spending
// anything." A preflight refusal is therefore NOT exit 2 — it is a run that happened, cost money,
// and stopped early, which is exit 1's meaning. The caller writes a record with the spend that
// occurred. A refusal reported as a free refusal would make the loop retry it forever at full
// price, which is the exact failure the three-code split exists to prevent.

// The closed set, and it is SEPARATE from `blocked.mjs`'s REASONS on purpose.
//
// All four of those reasons are properties of the ITEM: "the requirement admits two materially
// different readings" is true of the ticket no matter who reads it, and a human fixes the ticket.
// Every code here is a property of the WORKER on this attempt — the same ticket handed to the same
// worker again may well attest cleanly. Aggregating them in one set makes "how often does Alfred
// block, and on what" a question about two different subjects at once, and three test files plus
// `docs/BLOCKED.md` loop `Object.keys(REASONS)` as though it were one.
//
// Closed for the reason every other set in this codebase is closed: "how often does the preflight
// refuse, and why" has to be answerable by aggregating the sink rather than grepping prose.
export const PREFLIGHT_REFUSALS = Object.freeze({
  'attestation-absent': 'criteria were declared but the worker attested to none of them',
  'attestation-unreadable': 'the worker answered, but not in a shape that can be checked',
  'quote-not-in-body': 'a quoted criterion does not appear in the ticket body',
  'quote-mismatched': 'a quote is in the body but belongs to a different criterion',
  'quote-too-short': 'a quote is too short to be evidence that the criterion was read',
  'confidence-unreadable': 'a confidence score is missing or is not a number between 0 and 1',
  'low-confidence': 'the worker scored at least one criterion below the confidence threshold',
  'criteria-unaddressed': 'a declared criterion was not addressed by the attestation',
  'criterion-undeclared': 'the attestation names a criterion the ticket never declared',
});

// 0.6, matching the threshold the worker itself chose on jarvis#7 when the ticket's advisory notes
// asked for one. Stated as a named export rather than buried, and overridable per call: a threshold
// nobody can see is a threshold nobody can argue with, and the right value is an empirical question
// this project has n=0 data on.
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

// A substring check has no floor of its own. `"the"` appears in nearly every ticket body and nearly
// every criterion, so it would satisfy both the in-body and the belongs-to-this-criterion checks
// while proving nothing. 24 characters is roughly a clause — long enough that reproducing it
// character-for-character means the line was actually read.
export const MIN_QUOTE_CHARS = 24;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Markdown wrapping is not the author's choice. A criterion the author typed as one sentence may
// arrive split across two lines with leading indentation, and the worker will quote it as one line.
// Refusing that would fire the preflight on a well-behaved worker reading a well-formed ticket — a
// false refusal, which costs a spawn and teaches the operator to route around the mechanism.
//
// CASE IS NOT NORMALISED, and that is a decision. Whitespace is forced on the author by the
// renderer; nothing forces case. Relaxing it has no natural stopping point — punctuation next, then
// stemming, and at the end the check passes for a paraphrase, which is the one thing it exists to
// catch. A worker that cannot reproduce capitalisation is not quoting.
//
// JSON ESCAPING IS NORMALISED, FOR THE WHITESPACE REASON AND NOT THE CASE ONE. Measured on
// jarvis#11 (run 20260803T150555Z-11): a live refusal that cost $0.067 and was wrong. That issue
// body contains eight literal backslashes — the author typed escaped quotes into GitHub, so the
// bytes are `the AI-generated \"Today's Focus\"`. The worker quoted the sentence faithfully,
// backslashes included. But an attestation arrives as JSON, so parsing turned its `\\"` into a
// bare `"`, and `text.includes(quote)` then compared a body holding `\"` against a quote holding
// `"` and called a correct quotation a paraphrase.
//
// The line this module draws is whether the AUTHOR had a choice. Markdown reflow is imposed by
// the renderer, so whitespace collapses; nothing imposes capitalisation, so case does not. JSON
// escaping is imposed by the TRANSPORT — a worker cannot put a backslash-quote through a JSON
// string and have it survive parsing — which puts it on the whitespace side. What varies is the
// encoding, not the worker's compliance.
//
// AND IT DOES NOT WIDEN TOWARD PARAPHRASE, which is the objection that killed case-folding. This
// is a fixed rewrite of two characters into one, applied identically to both sides; it has the
// natural stopping point that "punctuation next, then stemming" lacked. Both falsifiers are
// asserted: a reworded quote and a lowercased quote must still refuse.
//
// APPLIED TO BOTH SIDES, deliberately. Unescaping only the body would leave a worker that DOES
// emit the backslashes (through a raw fenced block rather than a JSON string) refused for the
// mirror-image reason — the same defect facing the other way.
const unescapeJsonish = (s) => s.replace(/\\(["'\\])/g, '$1');
const norm = (s) => unescapeJsonish(String(s ?? '').replace(/\s+/g, ' ').trim());

function refuse(reason, detail, extra = {}) {
  return { refused: true, reason, detail, attested: 0, checks: [], ...extra };
}

// ---------------------------------------------------------------------------

// Read the worker's first turn. NEVER THROWS: a malformed answer is a RESULT — "the worker tried
// and got the shape wrong" — and throwing would turn that reading into a crash in the run it was
// meant to report on.
//
// THREE STATES, and the absent/invalid split is the load-bearing one, exactly as in
// `blocked.mjs`'s `readMarker`. A worker that said nothing may be a spawn that died; a worker that
// answered in prose read the contract and ignored its shape. Collapsing them would make the
// refusal rate stop separating a plumbing fault from a behavioural one — the `inspectSink`
// `NaN > 0` failure, which read an unreadable sink as a clean one.
export function parseAttestation(text) {
  const absent = { state: 'absent', attestation: null, problem: null };
  const bad = (problem) => ({ state: 'invalid', attestation: null, problem });

  if (text === null || text === undefined || String(text).trim() === '') return absent;

  const raw = String(text);
  // THE LAST fenced block, not the first. A worker commonly echoes the contract's own example
  // before filling it in, and reading the first block would grade the template — whose placeholder
  // text is in no real body, so the run would refuse on `quote-not-in-body` while the worker's
  // actual answer sat one block below.
  const fences = [...raw.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const candidates = fences.length > 0 ? fences.map((m) => m[1]) : [raw];
  const candidate = candidates[candidates.length - 1];

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    return bad(
      `the attestation could not be parsed as JSON (${err?.message ?? 'unknown'}). Prose here means ` +
        'the worker answered for a human and not for a reader.',
    );
  }

  if (!isObject(parsed)) return bad('the attestation is not a JSON object.');
  if (!Array.isArray(parsed.criteria)) {
    return bad('the attestation has no `criteria` array, so there is nothing to check.');
  }
  if (parsed.criteria.length === 0) {
    // Distinct from `absent` above: the worker DID answer, in the right shape, naming nothing. That
    // is a claim about the ticket rather than a missing turn, and `attestation-absent` covers what
    // the caller does with it.
    return bad('the attestation names no criteria.');
  }

  return { state: 'valid', attestation: parsed, problem: null };
}

// ---------------------------------------------------------------------------

// Check the attestation against the criteria the ticket actually declared.
//
// NEVER THROWS, on any input. Same rule as `readMarker` and `buildRecord`: the mechanism that
// reports a problem must not become the problem, and by the time this runs the spawn has been paid
// for. Anything unreadable comes back as a refusal with a code from the closed set, never a stack.
export function checkAttestation({ attestation, criteria, body, threshold } = {}) {
  const declared = (Array.isArray(criteria) ? criteria : []).filter(
    (c) => isObject(c) && typeof c.id === 'string' && c.id.trim(),
  );
  const text = norm(body);
  const limit =
    typeof threshold === 'number' && Number.isFinite(threshold) ? threshold : DEFAULT_CONFIDENCE_THRESHOLD;

  // NOTHING DECLARED IS NOT A REFUSAL. A prompt-sourced item has no acceptance criteria and
  // `item.mjs` refuses to invent them (its founding falsifier #1). Turning that documented absence
  // into a block would redefine the CLI rather than guard it — `alfred work "fix the flaky test"`
  // is a supported invocation. `attested: 0` is recorded so "we checked nothing" stays
  // distinguishable from "we checked and it was fine."
  if (declared.length === 0) {
    return { refused: false, reason: null, detail: null, attested: 0, checks: [] };
  }

  const parsed = isObject(attestation) && Array.isArray(attestation.criteria) ? attestation.criteria : null;
  if (!parsed || parsed.length === 0) {
    return refuse(
      'attestation-absent',
      `${declared.length} criteria were declared (${declared.map((c) => c.id).join(', ')}) and the ` +
        'worker attested to none of them.',
    );
  }

  const entries = parsed.filter((e) => isObject(e) && typeof e.id === 'string' && e.id.trim());
  if (entries.length === 0) {
    return refuse('attestation-unreadable', 'no entry in the attestation carries a criterion id.');
  }

  const byId = new Map(declared.map((c) => [c.id, c]));
  const checks = [];

  // Undeclared ids first. An attestation naming AC4 on a three-criterion ticket has invented a bar,
  // and grading the three it got right would report a partial reading as a whole one.
  const undeclared = entries.map((e) => e.id).filter((id) => !byId.has(id));
  if (undeclared.length > 0) {
    return refuse(
      'criterion-undeclared',
      `the attestation names ${undeclared.join(', ')}, which the ticket never declared. The declared ` +
        `ids are ${declared.map((c) => c.id).join(', ')}.`,
    );
  }

  const seen = new Set();
  for (const entry of entries) {
    const declaredText = norm(byId.get(entry.id).text);
    const quote = norm(entry.quote);
    seen.add(entry.id);

    // Confidence BEFORE the numeric comparison. `"high"` compares false against every operator, so
    // an unreadable score would silently read as above-threshold — a check that cannot fire looks
    // exactly like a check that passed, which is this project's recurring shape. `'0.9'` is refused
    // too: a caller that accepts the string accepts `'0.9abc'` next.
    //
    // `Number.isFinite`, NEVER the global `isFinite`, and the difference is the whole guard. The
    // global coerces first — `isFinite('0.9')` and `isFinite(true)` are both `true` — so it would
    // admit exactly the values this refuses. `Number.isFinite` returns false for anything that is
    // not already a number, which is why no separate `typeof` clause is needed here: one was
    // written, and a mutant deleting it survived the suite because it could never be the clause
    // that fired. Removed rather than left as unearned code.
    const confidence = entry.confidence;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return refuse(
        'confidence-unreadable',
        `${entry.id} carries confidence ${JSON.stringify(confidence)}, which is not a number in [0, 1]. ` +
          'A score that cannot be compared would read as above threshold.',
      );
    }

    if (!quote) {
      return refuse('attestation-unreadable', `${entry.id} carries no quote.`);
    }

    // THE FLOOR, WITH THE ONE EXEMPTION THAT KEEPS IT HONEST. The floor guards against
    // evidence-free fragments, not against terse tickets: a criterion that IS eleven characters
    // long cannot be quoted at twenty-four, and refusing it would make the preflight unpassable on
    // a real if laconic ticket. So a quote shorter than the floor is allowed only when it is the
    // WHOLE criterion.
    if (quote.length < MIN_QUOTE_CHARS && quote !== declaredText) {
      return refuse(
        'quote-too-short',
        `${entry.id}'s quote is ${quote.length} characters (floor ${MIN_QUOTE_CHARS}) and is not the ` +
          'whole criterion. A fragment that short is in almost any body and evidences nothing.',
      );
    }

    if (!text.includes(quote)) {
      return refuse(
        'quote-not-in-body',
        `${entry.id}'s quote does not appear in the ticket body: ${JSON.stringify(quote.slice(0, 120))}. ` +
          'A paraphrase is unfalsifiable evidence of having read the ticket, which is what is being checked.',
      );
    }

    // IN THE BODY IS NOT ENOUGH. Without this, one true sentence satisfies every id: the worker
    // files AC2's text under AC1 and both prior checks pass while the attestation says nothing
    // about AC1 at all. Containment either way, so a quote may be a fragment of its criterion or
    // may carry surrounding context.
    if (!declaredText.includes(quote) && !quote.includes(declaredText)) {
      return refuse(
        'quote-mismatched',
        `${entry.id}'s quote is in the body but is not part of ${entry.id}: expected text from ` +
          `${JSON.stringify(declaredText.slice(0, 80))}.`,
      );
    }

    checks.push({ id: entry.id, quote_in_body: true, confidence, belongs: true });
  }

  // Unaddressed criteria AFTER the per-entry checks, so a run refuses on the specific thing the
  // worker got wrong rather than on the count.
  const unaddressed = declared.map((c) => c.id).filter((id) => !seen.has(id));
  if (unaddressed.length > 0) {
    return refuse(
      'criteria-unaddressed',
      `the attestation does not address ${unaddressed.join(', ')}. A run that satisfies some ` +
        'criteria is a partial delivery, and reporting it as whole is what the gate exists to prevent.',
    );
  }

  // ANY below threshold, never the mean. Averaging 0.95/0.95/0.2 clears any threshold under 0.7
  // while one third of the ticket is a guess.
  const weak = checks.filter((c) => c.confidence < limit);
  if (weak.length > 0) {
    return refuse(
      'low-confidence',
      `${weak.map((c) => `${c.id} (${c.confidence})`).join(', ')} scored below the threshold ${limit}.`,
      { attested: checks.length, checks },
    );
  }

  return { refused: false, reason: null, detail: null, attested: checks.length, checks };
}

// ---------------------------------------------------------------------------

// The text handed to a worker that has no import of this module.
//
// IT STATES THE MECHANISM AND NEVER THE CONCLUSION, and a test enforces that. Same hazard
// `markerContract` is written against: a contract saying "push back if this ticket is vague"
// supplies the judgement the run exists to demonstrate, and what gets measured is the prompt. So it
// describes a facility in the register a tool's own docs would use, and says nothing about this
// ticket or what to expect from it.
//
// AND IT TELLS THE WORKER THE CHECK EXISTS. Hiding a substring check would make this a trap rather
// than a contract. A worker that knows the check is coming has no incentive to paraphrase — which
// is the outcome wanted, not a compliance test to be sprung.
export function preflightContract({ criteria } = {}) {
  const declared = (Array.isArray(criteria) ? criteria : []).filter(
    (c) => c && typeof c.id === 'string' && c.id.trim(),
  );

  if (declared.length === 0) {
    return [
      'This item declares no acceptance criteria — none were read from its body, and none have been',
      'supplied here. Report what you did and how you verified it, as usual.',
      '',
      'Nothing further is required before you begin.',
    ].join('\n');
  }

  const lines = declared.map((c) => `  - \`${c.id}\` — ${String(c.text ?? '').trim()}`).join('\n');

  return [
    'Before you make any change, restate the declared acceptance criteria as JSON in a single fenced',
    '`json` block. These are the criteria, with the ids they will be graded under:',
    '',
    lines,
    '',
    'The shape:',
    '',
    '```json',
    '{',
    '  "criteria": [',
    '    {',
    '      "id": "<one of the ids above>",',
    '      "quote": "<text from the ticket body, exactly as it appears>",',
    '      "confidence": 0.0',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    'Every id above must appear exactly once, and no other id may appear.',
    '',
    '`quote` is checked mechanically as a substring of the ticket body, so it must be verbatim —',
    'character-for-character, apart from line wrapping. `confidence` is a number between 0 and 1',
    'standing for how certain you are that you can satisfy that criterion and demonstrate it.',
    '',
    'Write this block first, then begin the work in the same session.',
  ].join('\n');
}
