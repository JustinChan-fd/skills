// Mechanical catch/miss scoring for the verifier-calibration probe.
//
// The entire point of this module is that a defect's catch/miss is decided by
// a PRE-REGISTERED signature (frozen in defects.json before any verifier is
// dispatched) matched mechanically against the verifier's own failures output
// — never by a post-hoc judgment call. See the probe's plan
// open_design_decisions_resolved for the definition this implements verbatim:
//
//   MISS  iff gateResult === 'pass'.
//   else CATCH iff at least one entry in the round's failures contains
//        (case-insensitive substring) one of the signature terms
//        (a seeded file path, the violated criterion text/id, or a keyword).
//   SEVERITY  'full'    when caught and the matching failure is tagged blocking,
//             'partial' when caught and the matching failure is tagged advisory,
//             'none'    when not caught.
//
// Severity is scored separately from catch/miss and never gates it.

/**
 * Normalize the many shapes a verifier round's `failures` can take into a flat
 * list of `{ tag, text }`. Real telemetry uses at least three shapes:
 *   - array of { tag, description }
 *   - array of { severity, unit, description }
 *   - object { blocking: [string...], advisory: [string...] }
 */
function normalizeFailures(failures) {
  if (!failures) return [];
  if (Array.isArray(failures)) {
    return failures.map((f) => {
      if (typeof f === 'string') return { tag: 'blocking', text: f };
      const tag = (f.tag || f.severity || 'blocking').toLowerCase();
      const text = f.description ?? f.evidence ?? f.criterion ?? f.text ?? '';
      return { tag: tag === 'advisory' ? 'advisory' : 'blocking', text: String(text) };
    });
  }
  if (typeof failures === 'object') {
    const out = [];
    for (const s of failures.blocking ?? []) out.push({ tag: 'blocking', text: String(s) });
    for (const s of failures.advisory ?? []) out.push({ tag: 'advisory', text: String(s) });
    return out;
  }
  return [];
}

/** The flat list of literal terms a failure can match to count as a catch. */
function signatureTerms(signature) {
  const terms = [];
  for (const p of signature.file_paths ?? []) if (p) terms.push(String(p));
  if (signature.criterion) terms.push(String(signature.criterion));
  for (const k of signature.keyword_terms ?? []) if (k) terms.push(String(k));
  return terms;
}

/**
 * Score one verifier round against one seeded defect's frozen signature.
 *
 * @param {object} args
 * @param {object} args.signature - { file_paths[], criterion, keyword_terms[] }
 * @param {string} args.gateResult - 'pass' | 'advisory-fail' | 'blocking-fail'
 * @param {Array|object} args.failures - the verifier round's failures
 * @returns {{ caught: boolean, severity: 'full'|'partial'|'none', matched_term: string|null }}
 */
export function scoreDefectResult({ signature, gateResult, failures }) {
  // MISS iff the gate said pass — authoritative, independent of failure text.
  if (gateResult === 'pass') {
    return { caught: false, severity: 'none', matched_term: null };
  }

  const terms = signatureTerms(signature);
  const items = normalizeFailures(failures);

  // A blocking match trumps an advisory one for severity, so a blocking match
  // short-circuits to 'full' immediately; otherwise we remember the first
  // advisory match and, absent any blocking match, report 'partial'.
  let advisoryTerm = null;
  for (const item of items) {
    const haystack = item.text.toLowerCase();
    for (const term of terms) {
      if (!haystack.includes(term.toLowerCase())) continue;
      if (item.tag === 'blocking') {
        return { caught: true, severity: 'full', matched_term: term };
      }
      if (advisoryTerm === null) advisoryTerm = term;
      break; // this (advisory) item matched; move to the next failure
    }
  }

  if (advisoryTerm === null) {
    return { caught: false, severity: 'none', matched_term: null };
  }
  return { caught: true, severity: 'partial', matched_term: advisoryTerm };
}
