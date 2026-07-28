// Spec-v8 §6 gate table, mechanical. Blocking = correctness/security/data
// loss/build-breaking; everything else is advisory (the verifier tags them).
// Advisory fast-open: a high-scoring round with only advisory failures opens
// immediately with residue — measured runs showed a full fresh-context
// verifier round being burned to fix a cosmetic nit, at every phase.
export function gateDecision({ result, rounds, cap, delta = null, plateauThreshold = 0.05, score = null, advisoryOpenScore = null }) {
  if (result === 'pass') return { decision: 'open', record: null };
  if (result === 'advisory-fail') {
    if (score !== null && advisoryOpenScore !== null && score >= advisoryOpenScore) {
      return { decision: 'open', record: 'residue' };
    }
    if (delta !== null && delta < plateauThreshold) return { decision: 'open', record: 'residue' };
    if (rounds < cap) return { decision: 'revise', record: null };
    return { decision: 'open', record: 'defect' };
  }
  if (result === 'blocking-fail') {
    if (rounds < cap) return { decision: 'revise', record: null };
    return { decision: 'shut', record: 'escalation' };
  }
  throw new Error(`unknown gate result: ${result}`);
}
