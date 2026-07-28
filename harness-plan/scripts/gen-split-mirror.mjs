// Regenerate the _splitOversizedTasks inline mirror in workflow.js from lib/split-oversized.js.
//
// Workflow scripts cannot `import`, so the splitter has to exist twice. Retyping a mirror by
// hand is how the two copies drift, and this one rewrites the artifact rather than describing
// it — a divergence means the suite grades a splitter that never ran. So the mirror is
// GENERATED: edit lib/split-oversized.js, run `node scripts/gen-split-mirror.mjs`, and let
// inline-mirror.test.js confirm the result.
//
// Usage: node scripts/gen-split-mirror.mjs   (from the harness-plan directory)

import { readFileSync, writeFileSync } from 'node:fs'

const LIB = new URL('../lib/split-oversized.js', import.meta.url)
const WF = new URL('../workflow.js', import.meta.url)

const BEGIN = '// ── BEGIN GENERATED: _splitOversizedTasks mirror of lib/split-oversized.js ──'
const END = '// ── END GENERATED ──'

/** lib identifier → inline identifier. FILE_CAP maps onto the cap const already in the PURE block. */
const RENAMES = [
  ['splitOversizedTasks', '_splitOversizedTasks'],
  ['scopeCriteria', '_scopeChunkCriteria'],
  ['chunkFiles', '_chunkFilesByDir'],
  ['suffixFor', '_chunkSuffixFor'],
  ['dirOf', '_dirOfPath'],
  ['FILE_CAP', '_FILE_BUDGET_CAP'],
]

let body = readFileSync(LIB, 'utf8')

// Drop the file header (everything before the first declaration) and the FILE_CAP declaration
// itself — the PURE block already owns that number as _FILE_BUDGET_CAP.
body = body.slice(body.indexOf('export const FILE_CAP'))
body = body.replace(/export const FILE_CAP[^\n]*\n/, '')
body = body.replace(/\bexport /g, '')

for (const [from, to] of RENAMES) {
  body = body.replace(new RegExp(`\\b${from}\\b`, 'g'), to)
}

// chunkFiles takes a param named `files`; nothing else needs renaming inside.
const generated = [BEGIN, '//', '// DO NOT EDIT BY HAND — run scripts/gen-split-mirror.mjs.', body.trim(), END].join('\n')

const wf = readFileSync(WF, 'utf8')
let out
if (wf.includes(BEGIN)) {
  const a = wf.indexOf(BEGIN)
  const b = wf.indexOf(END, a) + END.length
  out = wf.slice(0, a) + generated + wf.slice(b)
} else {
  const anchor = wf.indexOf('// ===== END PURE =====')
  if (anchor === -1) throw new Error('no PURE block terminator in workflow.js')
  out = wf.slice(0, anchor) + generated + '\n\n' + wf.slice(anchor)
}
writeFileSync(WF, out)
console.log(`mirror written: ${generated.split('\n').length} lines`)
