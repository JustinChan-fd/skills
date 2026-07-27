/**
 * Build harness-plan's `input` from an intake manifest.
 *
 * harness-plan's `input` is RAW TEXT, not a manifest. It sizes the ticket from it,
 * regexes the issue key out of it, and derives the plan slug/title/description from
 * its first lines (see harness-plan/workflow.js: `_slugFromInput`, the Intake agent
 * prompt, and the plan front-matter builder). So the conductor has to render the
 * manifest back down to prose rather than hand the object over.
 *
 * Field precedence:
 *   groundedReality — present only for size L, where intake ran research. The intake
 *     manifest's own comment says downstream workers MUST prefer this over the
 *     original ticket text, so it wins when present.
 *   ticketInput — raw Jira summary + description. The fallback for XS/S/M, where
 *     groundedReality is null by design (harness-plan's own researcher is ground
 *     truth for those sizes).
 *
 * The manifest object is passed separately as `gatedIntake`, which is what actually
 * carries authoritative size and file scope. This text is for the reasoning agents.
 *
 * @param {object} manifest - intake manifest (sourceTitle, groundedReality, acList, …)
 * @param {object} [opts]
 * @param {string} [opts.issueKey] - e.g. 'TARS-1271'; harness-plan regexes this back out
 * @param {string} [opts.ticketInput] - raw ticket text, used when groundedReality is absent
 * @returns {string} prose input for harness-plan
 */
export function buildPlanInput(manifest, { issueKey = null, ticketInput = null } = {}) {
  if (manifest == null) throw new Error('manifest is required')

  const gr = manifest.groundedReality || null
  const acBullets = (manifest.acList || []).map(ac => ac?.bullet).filter(Boolean)

  const grBlock = gr?.summary
    ? [
        'GROUNDED REALITY (verified by intake research — outranks ticket text):',
        gr.summary,
        `Verified file count: ${gr.actualFileCount ?? (manifest.files || []).length}`,
        gr.actualScope    ? `Verified scope: ${gr.actualScope}` : null,
        gr.migrationNotes ? `Migration notes: ${gr.migrationNotes}` : null,
        (gr.ticketClaimsToIgnore || []).length
          ? `Ticket claims research proved wrong: ${gr.ticketClaimsToIgnore.join('; ')}`
          : null,
      ].filter(Boolean).join('\n')
    : (ticketInput || null)

  const scopeBlock = [
    manifest.migrationPattern ? `Migration pattern: ${manifest.migrationPattern}` : null,
    manifest.scopePath        ? `Scope path: ${manifest.scopePath}` : null,
  ].filter(Boolean).join('\n')

  const heading = issueKey
    ? `${issueKey} — ${manifest.sourceTitle || issueKey}`
    : (manifest.sourceTitle || null)

  return [
    heading,
    grBlock,
    acBullets.length ? ['Acceptance criteria:', ...acBullets.map(b => `- ${b}`)].join('\n') : null,
    scopeBlock || null,
  ].filter(Boolean).join('\n\n').trim()
}

/**
 * Minimum plausible length for a plan input. Below this, the manifest carried no
 * groundedReality, no ACs, and no ticket text was available — harness-plan would
 * size and slug off a bare issue key, so the conductor should stop instead.
 */
export const MIN_PLAN_INPUT_CHARS = 40
