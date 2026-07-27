/**
 * Extract the plans array from a plan manifest object.
 * @param {object} manifest - parsed plan manifest JSON
 * @returns {Array} plans[]
 */
export function extractPlanEntries(manifest) {
  if (manifest == null) throw new Error('manifest is required')
  return manifest.plans || []
}

/**
 * The path to hand harness-implement for one plan entry, relative to repoPath.
 *
 * Prefers the MARKDOWN path. harness-implement derives the JSON companion itself
 * (`planPath.replace(/\.md$/, '.json')`) and keeps the .md as its fallback when the
 * JSON is missing or malformed. Passing jsonPath makes both resolve to the same
 * .json file, so that fallback can never fire.
 *
 * @param {object} plan - { id, path, jsonPath, dependsOn }
 * @returns {string} repo-relative plan path
 * @throws if the entry carries neither path
 */
export function planPathFor(plan) {
  if (plan == null) throw new Error('plan entry is required')
  const p = plan.path || plan.jsonPath
  if (!p) throw new Error(`Plan "${plan.id ?? '(no id)'}" has neither path nor jsonPath`)
  return p
}

/**
 * Topological sort of plan entries by dependsOn.
 * Plans with no deps come first; later plans wait for their deps.
 * Input order is preserved for plans at the same level (stable).
 *
 * @param {Array} plans - [{ id, jsonPath, dependsOn: string[] }, ...]
 * @returns {Array} same plan objects in safe execution order
 * @throws if a dep id is not found or a cycle is detected
 */
export function orderPlansByDeps(plans) {
  if (!plans.length) return []

  const byId = Object.fromEntries(plans.map(p => [p.id, p]))

  // Validate all dep ids exist
  for (const p of plans) {
    for (const dep of (p.dependsOn || [])) {
      if (!byId[dep]) throw new Error(`Plan "${p.id}" depends on unknown id "${dep}"`)
    }
  }

  // Kahn's algorithm — stable (preserves input order at each level)
  const inDegree = Object.fromEntries(plans.map(p => [p.id, 0]))
  const dependents = Object.fromEntries(plans.map(p => [p.id, []]))

  for (const p of plans) {
    for (const dep of (p.dependsOn || [])) {
      inDegree[p.id]++
      dependents[dep].push(p.id)
    }
  }

  // Queue seeded in input order for stability
  const queue = plans.filter(p => inDegree[p.id] === 0)
  const result = []

  while (queue.length) {
    const node = queue.shift()
    result.push(node)
    for (const depId of dependents[node.id]) {
      inDegree[depId]--
      if (inDegree[depId] === 0) {
        // Insert at back but preserve relative input order among newly-ready nodes
        const readyNode = byId[depId]
        queue.push(readyNode)
      }
    }
  }

  if (result.length !== plans.length) {
    throw new Error('Circular dependency detected in plan manifest dependsOn graph')
  }

  return result
}
