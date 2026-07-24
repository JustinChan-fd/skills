// Agent routing table for harness-implement.
// Each entry maps a call-site label pattern to its model tier and effort level.
// Identical shape across skills — values differ.
export const ROUTING = {
  // Load: plan + toolbelt reads — haiku, low (pure I/O)
  'load-plan':               { model: 'haiku',  effort: 'low' },
  'toolbelt:rules':          { model: 'haiku',  effort: 'low' },
  'toolbelt:styling':        { model: 'haiku',  effort: 'low' },
  'toolbelt:testing':        { model: 'haiku',  effort: 'low' },
  'toolbelt:tooling':        { model: 'haiku',  effort: 'low' },
  // Worktree: git setup — haiku, low
  'worktree-setup':          { model: 'haiku',  effort: 'low' },
  // Implement: developer — sonnet, high (core code-writing)
  'hi-developer':            { model: 'sonnet', effort: 'high' },
  'tdd-green':               { model: 'haiku',  effort: 'low' },
  'diff':                    { model: 'haiku',  effort: 'low' },
  // Code review: per-task diff — haiku, low (mechanical check)
  'cr-':                     { model: 'haiku',  effort: 'low' },
  // Commit: git — haiku, low
  'commit-':                 { model: 'haiku',  effort: 'low' },
  // Verify: npm test + tsc — haiku, low
  'verify':                  { model: 'haiku',  effort: 'low' },
  // Review: spec-compliance + security — sonnet, high (quality gates)
  'spec-compliance':         { model: 'sonnet', effort: 'high' },
  'security-review':         { model: 'sonnet', effort: 'high' },
  'scope-drift':             { model: 'sonnet', effort: 'medium' },
  // File review: batch haiku — low
  'file-review-':            { model: 'haiku',  effort: 'low' },
  // Fix + recheck: developer + review — sonnet/haiku
  'fix-':                    { model: 'sonnet', effort: 'high' },
  'recheck-':                { model: 'haiku',  effort: 'low' },
  'fix-commit':              { model: 'haiku',  effort: 'low' },
  'verify-commit':           { model: 'haiku',  effort: 'low' },
  // Return: PR body — haiku, low
  'pr-body':                 { model: 'haiku',  effort: 'low' },
  // Debrief: audit, timing — haiku, low
  'duration-ms':             { model: 'haiku',  effort: 'low' },
  'audit-write':             { model: 'haiku',  effort: 'low' },
}
