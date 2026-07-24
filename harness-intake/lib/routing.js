// Agent routing table for harness-intake.
// Each entry maps a call-site label pattern to its model tier and effort level.
// Identical shape across skills — values differ.
export const ROUTING = {
  // Triage: layer-discover — haiku, low (shell ls only)
  'layer-discover':          { model: 'haiku',  effort: 'low' },
  // Triage: classify — sonnet, high (routing decision)
  'classify':                { model: 'sonnet', effort: 'high' },
  // Triage: AC synthesis — sonnet, medium
  'ac-synth':                { model: 'sonnet', effort: 'medium' },
  // Triage: AC verify (batch) — haiku, low (grep + count)
  'ac-verify':               { model: 'haiku',  effort: 'low' },
  // Triage: phase-C broader grep — haiku, low
  'phase-c':                 { model: 'haiku',  effort: 'low' },
  // Triage: pattern-lock — haiku, low
  'pattern-lock':            { model: 'haiku',  effort: 'low' },
  // Triage: work-intel-merge — sonnet, medium (synthesis)
  'work-intel-merge':        { model: 'sonnet', effort: 'medium' },
  // Research: AC research (per AC grep/read) — haiku, low
  'ac-research':             { model: 'haiku',  effort: 'low' },
  // Research: layer structure — sonnet, medium
  'research:':               { model: 'sonnet', effort: 'medium' },
  // Split Design: grouper (per AC, mechanical grouping) — haiku, low
  'design:grouper':          { model: 'haiku',  effort: 'low' },
  // Split Design: coordinator (final dedup + merge) — opus, high (most expensive, highest-stakes)
  'design:coordinator':      { model: 'opus',   effort: 'high' },
  // Split Design: AC verify — sonnet, medium
  'ac-verify-split':         { model: 'sonnet', effort: 'medium' },
  // Verify: manifest check — sonnet, medium
  'verify-manifest':         { model: 'sonnet', effort: 'medium' },
  // Debrief: audit, timing — haiku, low
  'duration-ms':             { model: 'haiku',  effort: 'low' },
  'audit-write':             { model: 'haiku',  effort: 'low' },
}
