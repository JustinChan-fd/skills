// Dotted-key patching for a v2 telemetry record.
//
// The post-Workflow `patchTelemetryRecord` in SKILL.md splits every dotted key on '.' and
// walks the record one segment per level. That is correct for `tokens.total.input` and wrong
// for `cost.nullReasons.tokens.total.input`, because `nullReasons` is a map whose KEYS
// contain dots — cost.js writes `nullReasons['tokens.total.input'] = '<why>'`, one literal
// key naming the field the reason is about, not three levels of nesting.
//
// Verified against the real python before this module existed. Patching
// `{'tokens.total.input': 812345, 'cost.nullReasons.tokens.total.input': null}` produced:
//
//   "nullReasons": {
//     "tokens.total.input": "subagentTokens not yet patched",   <- stale reason survived
//     "tokens": { "total": {} }                                 <- branch invented on the way down
//   }
//
// Two failures from one wrong split. The reason a field is null stays on a record whose field
// is now populated, and a shape nothing reads is written into the file the dashboard treats as
// authoritative. Neither surfaces: `patchTelemetryRecord` is `try`-swallowed on purpose, so a
// patch that half-works is indistinguishable from one that works.
//
// Fixing this by renaming the keys was rejected. Dotted nullReasons keys are the point — they
// name a field path — and cost.js plus cost.test.js already assert that shape in all three
// skills. The patcher is the thing that has to know which prefixes hold maps.
//
// KEEP IN SYNC: this file is identical in harness-intake, harness-plan, and harness-implement,
// and the SKILL.md python patcher must implement the same split. `telemetry-patch.test.js`
// covers this copy; `skill-patch-parity.test.js` compares the SKILL.md python against it.

/**
 * Record prefixes whose value is a MAP with caller-controlled keys.
 *
 * Everything after one of these is a single literal key, however many dots it contains.
 *
 * - `cost.nullReasons` — keyed by the dotted field path the reason explains.
 * - `agentCount.byModel` — keyed by model ID. No dots in today's IDs, but the key comes from
 *   the runtime, not from us.
 * - `agentCount.byPhase` / `tokens.byPhase` — keyed by phase title, which is free-form text
 *   from a workflow's `meta.phases`; nothing stops one containing a dot.
 * - `tokens.byModel` — keyed by model ID, same reasoning as agentCount.byModel.
 */
export const MAP_VALUED_PREFIXES = [
  'cost.nullReasons',
  'agentCount.byModel',
  'agentCount.byPhase',
  'tokens.byModel',
  'tokens.byPhase',
]

/**
 * Split a dotted patch key into the path to walk and the single key to write at the end.
 *
 * @param {string} key - e.g. 'tokens.total.input' or 'cost.nullReasons.tokens.total.input'
 * @returns {{path: string[], leafKey: string}}
 */
export function splitPatchKey(key) {
  const k = String(key)

  for (const prefix of MAP_VALUED_PREFIXES) {
    // Only a key that reaches INTO the map is special. `cost.nullReasons` itself is an
    // ordinary field on `cost` and must stay replaceable as a whole.
    if (k.startsWith(prefix + '.')) {
      return { path: prefix.split('.'), leafKey: k.slice(prefix.length + 1) }
    }
  }

  const segs = k.split('.')
  return { path: segs.slice(0, -1), leafKey: segs[segs.length - 1] }
}

/**
 * Apply a flat map of dotted-key patches to a record, returning a new record.
 *
 * A `null` value DELETES its key — that is how the caller clears a `nullReasons` entry once
 * the field it explains has been measured. Deletes never create the objects they would delete
 * from; sets do create them, since a record legitimately may not carry `tokens.total` yet.
 * (The old walk vivified on both, which is where the invented branch came from.)
 *
 * @param {object} record
 * @param {Record<string, any>} fields
 * @returns {object} a new record; `record` is not mutated
 */
export function applyPatch(record, fields) {
  const out = JSON.parse(JSON.stringify(record || {}))

  for (const [key, value] of Object.entries(fields || {})) {
    const { path, leafKey } = splitPatchKey(key)
    const deleting = value === null

    let cursor = out
    let reached = true
    for (const seg of path) {
      if (cursor[seg] === undefined || cursor[seg] === null || typeof cursor[seg] !== 'object' || Array.isArray(cursor[seg])) {
        if (deleting) { reached = false; break }
        // A non-object standing where a path segment belongs is replaced rather than walked
        // into: a malformed record must not make the patch throw and lose every other field.
        cursor[seg] = {}
      }
      cursor = cursor[seg]
    }
    if (!reached) continue

    if (deleting) delete cursor[leafKey]
    else cursor[leafKey] = value
  }

  return out
}
