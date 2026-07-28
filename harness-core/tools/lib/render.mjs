// Deterministic renderers for driver-authored artifacts that are pure
// template-fill: the GitHub status comment, the PR body, and a discovery
// subagent's brief prompt. These carry NO judgment — every field is supplied
// by the driver (who authors the prose) and this module only assembles the
// invariant shape documented in harness-core/templates/*.md. Keeping the
// assembly here (a zero-token script) instead of hand-composing markdown in
// each phase skill removes an inline formatting step from every run.

const STATUS_EMOJI = { succeeded: '✅', failed: '❌', partial: '⏸' };

// A residue note may arrive as a raw audit event ({ data: { criterion } }) or
// already-flattened ({ criterion }). Read the criterion from either shape.
function noteCriterion(note) {
  return note?.data?.criterion ?? note?.criterion ?? '';
}

// Render the one-per-phase GitHub status comment exactly as documented in
// templates/status-comment.md: heading with phase + status emoji, a
// phase-specific line (Size for intake, Plan for plan, PR for implement), an
// optional Residue line (present only when notes is non-empty), and the Next
// line last. Returns the comment body with no trailing newline.
export function renderStatusComment({
  phase, status, runId,
  size, sizeRationale,
  planUnits, planBlocking,
  prUrl,
  notes = [],
  next,
}) {
  const emoji = STATUS_EMOJI[status] ?? '';
  const lines = [`## harness: ${phase} ${emoji} ${status}`, '', `- **Run:** \`${runId}\``];
  if (phase === 'intake') lines.push(`- **Size:** ${size} — ${sizeRationale}`);
  else if (phase === 'plan') lines.push(`- **Plan:** ${planUnits} units, ${planBlocking} blocking criteria`);
  else if (phase === 'implement') lines.push(`- **PR:** ${prUrl}`);
  if (notes && notes.length) {
    const n = notes.length;
    lines.push(`- **Residue:** ${n} item${n === 1 ? '' : 's'} — ${noteCriterion(notes[0])}`);
  }
  lines.push(`- **Next:** ${next}`);
  return lines.join('\n');
}

// A markdown table cell must not contain a raw pipe or newline, or it breaks
// the column structure. Escape pipes and flatten newlines to spaces.
function cell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

// Render the implement PR body as specified by harness-implement-core step 8
// (the shape originated in the now-deleted harness-implement skill's step 5):
// it opens with `Closes #<issue>` for
// issue-sourced runs (so GitHub auto-closes on merge), renders the
// entry-contract results as a markdown table, lists the landing checklist,
// cites the run id, and appends a `## Advisory residue` section with one
// bullet per residue/defect note — reproducing each note's criterion and
// detail verbatim — ONLY when notes is non-empty (heading and all omitted for
// a clean gate). The driver still authors `summary` (judgment prose); this
// helper only assembles the invariant shape. `changeType` is accepted so a
// single call carries every PR input (it drives the PR *title*, composed by
// the driver, not the body). Returns the body with no trailing newline.
export function renderPrBody({
  changeType,
  issue = null,
  summary = '',
  resultRows = [],
  landingChecklist = [],
  runId,
  notes = [],
}) {
  const sections = [];
  if (issue !== null && issue !== undefined && issue !== '') {
    sections.push(`Closes #${issue}.`);
  }
  sections.push(summary);
  if (resultRows.length) {
    const table = [
      '| Criterion | Tag | Result | Evidence |',
      '| --- | --- | --- | --- |',
      ...resultRows.map((r) => `| ${cell(r.criterion)} | ${cell(r.tag)} | ${cell(r.result)} | ${cell(r.evidence)} |`),
    ].join('\n');
    sections.push(`## Entry-contract results\n\n${table}`);
  }
  if (landingChecklist.length) {
    sections.push(`## Landing checklist\n\n${landingChecklist.map((i) => `- [ ] ${i}`).join('\n')}`);
  }
  sections.push(`Run: \`${runId}\``);
  if (notes && notes.length) {
    const bullets = notes.map((n) => `- **${noteCriterion(n)}** — ${n?.data?.detail ?? n?.detail ?? ''}`).join('\n');
    sections.push(`## Advisory residue\n\n${bullets}`);
  }
  sections.push('🤖 Generated with [Claude Code](https://claude.com/claude-code)');
  return sections.join('\n\n');
}

// Render a validated discovery brief into the Agent-tool prompt text, exactly
// as documented in templates/brief.md: all seven items in order (OBJECTIVE,
// OUTPUT, TOOLS, BOUNDARIES, DONE-WHEN, TIER, REASONING), with the
// needs_decision_directive appended verbatim ONLY when the reasoning budget is
// MINIMAL or MODERATE (a FULL-budget agent is trusted to decide, so it gets no
// stop-on-decision directive). The brief object must already be schema-valid;
// this helper renders, it does not validate. Returns the prompt with no
// trailing newline.
export function renderBrief(brief) {
  const { objective, output, tools, boundaries, done_when, tier, reasoning } = brief;
  const schemaClause = output?.schema ? ` It must validate against the ${output.schema} schema.` : '';
  const lines = [
    `OBJECTIVE: ${objective}`,
    `OUTPUT: Return your result as a single JSON object in your final message — it is your ONLY deliverable. You are read-only and cannot write files; the parent (the single writer) persists it to ${output.path}.${schemaClause}`,
    `TOOLS: You may use: ${tools.allowed.join(', ')}. You must NOT use: ${tools.forbidden.join(', ')}.`,
    'BOUNDARIES:',
    ...boundaries.map((b) => `- ${b}`),
    `DONE-WHEN: ${done_when}`,
    `TIER: You are running as ${tier.level}. Do not reason about, request, or change your own model or budget.`,
    `REASONING: Your reasoning budget is ${reasoning.budget}.`,
  ];
  let out = lines.join('\n');
  if ((reasoning.budget === 'MINIMAL' || reasoning.budget === 'MODERATE') && reasoning.needs_decision_directive) {
    out += '\n' + reasoning.needs_decision_directive;
  }
  return out;
}
