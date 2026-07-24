// USER-BINDING: never auto-decide NEVER_LIST categories regardless of confidence.
export const MAX_PROBE_LOOPS = 2;

export const NEVER_LIST = {
  'irreversible-destructive': ['delete', 'drop table', 'force-push', 'force push', 'prod deploy', 'rm -rf', 'truncate'],
  'security-auth-permission': ['auth', 'permission', 'credential', 'secret', 'token', 'iam', 'acl', 'rbac'],
  'cost-over-threshold':      ['budget exceed', 'over budget', 'cost cap'],
  'public-api-contract':      ['public api', 'breaking change', 'contract change', 'schema migration'],
  'out-of-scope':             ['outside scope', 'unplanned file', 'not in plan'],
  'legal-compliance':         ['license', 'gdpr', 'compliance', 'pii'],
};

export function matchesNeverList(action) {
  const a = String(action).toLowerCase();
  for (const [cat, kws] of Object.entries(NEVER_LIST))
    if (kws.some(k => a.includes(k))) return cat;
  return null;
}

export function makeBarrierRecord({ decision, hinge, options, probes, confidence, blocking }) {
  return {
    decision,
    hinge,
    options:    options    ?? [],
    probes:     probes     ?? [],
    confidence: confidence ?? null,
    blocking:   !!blocking,
  };
}

export function validateBarrierRecord(r) {
  const errors = [];
  for (const k of ['decision', 'hinge']) if (!r?.[k]) errors.push(`missing ${k}`);
  if (typeof r?.blocking !== 'boolean') errors.push('blocking must be boolean');
  return { valid: errors.length === 0, errors };
}
