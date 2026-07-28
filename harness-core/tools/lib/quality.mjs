// Quality rubric v1 (spec-v8 T0.4 shape): deliberately crude; refine from data.
export function qualityScore({ verifierScores, deliverable }) {
  const check =
    deliverable.completed && deliverable.manifestValid && deliverable.gatesDecided && deliverable.auditWritten
      ? 1
      : 0;
  if (!verifierScores.length) return 0;
  const mean = verifierScores.reduce((a, b) => a + b, 0) / verifierScores.length;
  return Number((mean * check).toFixed(4));
}
