// Agent routing table for harness-plan.
// Each entry maps a call-site label pattern to its model tier and effort level.
// Identical shape across skills — values differ.
export const ROUTING = {
  // Intake: sizing decision from ticket text — sonnet, medium reasoning
  'intake':                  { model: 'sonnet', effort: 'medium' },
  // Decompose: architect-level decomposition — opus for L, sonnet for M
  'decompose':               { model: 'opus',   effort: 'high' },
  // Research: per-concern file reading + synthesis — sonnet, medium
  'hp-researcher':           { model: 'sonnet', effort: 'medium' },
  'hp-security':             { model: 'sonnet', effort: 'medium' },
  // Architect: DAG task list from research — sonnet, high (load-bearing)
  'hp-architect':            { model: 'sonnet', effort: 'high' },
  'architect-revision':      { model: 'sonnet', effort: 'medium' },
  // Synthesize: plan doc formatting — sonnet, medium
  'hp-synthesizer':          { model: 'sonnet', effort: 'medium' },
  // Coverage: quality gate — sonnet round 1, haiku round 2+
  'coverage-check':          { model: 'sonnet', effort: 'medium' },
  'gap-fill':                { model: 'sonnet', effort: 'medium' },
  'coverage-integrate':      { model: 'haiku',  effort: 'low' },
  // Return: file writes, git, manifest — haiku, low (mechanical I/O)
  'write-xs-plan':           { model: 'haiku',  effort: 'low' },
  'write-plan':              { model: 'haiku',  effort: 'low' },
  'write-manifest':          { model: 'haiku',  effort: 'low' },
  'verify-files':            { model: 'haiku',  effort: 'low' },
  // Debrief: audit log, timing — haiku, low
  'duration-ms':             { model: 'haiku',  effort: 'low' },
  'audit-write':             { model: 'haiku',  effort: 'low' },
}
