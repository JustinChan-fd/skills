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

// A numbered QA step is one list item, so a raw newline inside it would split
// the list. Flatten newlines; leave pipes alone (a step is prose, not a cell,
// and `git log --oneline | head` must survive verbatim).
function step(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ');
}

// Render the implement PR body. The reviewer-facing shape is the one specified
// by push-branch/SKILL.md "Format Requirements", so a harness PR is
// indistinguishable from a hand-pushed one: `Closes #<issue>` for
// issue-sourced runs (GitHub auto-closes on merge), the driver's summary, then
// `## Changes` (flat bullets) and `## QA Notes` (numbered manual steps).
//
// `## QA Notes` is load-bearing beyond formatting: the Jira cleanup step parses
// that exact heading back out of the PR body to build the ADF for
// customfield_14226. Renaming it silently breaks the ticket write-back.
//
// push-branch bans competing top-level sections in the body, but the harness
// has evidence a human pusher does not: the entry-contract table, the landing
// checklist, and advisory residue. Those move into ONE collapsed <details>
// block below QA Notes — preserved for audit, folded away from review. The
// block is omitted entirely when there is nothing to put in it.
//
// The driver authors every judgment field (`summary`, `changes`, `qaNotes`);
// this helper only assembles the invariant shape. `changeType` is accepted so a
// single call carries every PR input (it drives the PR *title*, composed by the
// driver, not the body). Returns the body with no trailing newline.
export function renderPrBody({
  changeType,
  issue = null,
  summary = '',
  changes = [],
  qaNotes = [],
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
  if (changes.length) {
    sections.push(`## Changes\n\n${changes.map((c) => `- ${c}`).join('\n')}`);
  }
  if (qaNotes.length) {
    const steps = qaNotes.map((q, i) => `${i + 1}. ${step(q)}`).join('\n');
    sections.push(`## QA Notes\n\nManual testing steps:\n\n${steps}`);
  }

  const detail = [];
  if (resultRows.length) {
    const table = [
      '| Criterion | Tag | Result | Evidence |',
      '| --- | --- | --- | --- |',
      ...resultRows.map((r) => `| ${cell(r.criterion)} | ${cell(r.tag)} | ${cell(r.result)} | ${cell(r.evidence)} |`),
    ].join('\n');
    detail.push(`**Entry-contract results**\n\n${table}`);
  }
  if (landingChecklist.length) {
    detail.push(`**Landing checklist**\n\n${landingChecklist.map((i) => `- [ ] ${i}`).join('\n')}`);
  }
  if (notes && notes.length) {
    const bullets = notes.map((n) => `- **${noteCriterion(n)}** — ${n?.data?.detail ?? n?.detail ?? ''}`).join('\n');
    detail.push(`**Advisory residue**\n\n${bullets}`);
  }
  if (detail.length) {
    sections.push(`<details>\n<summary>Harness verification detail</summary>\n\n${detail.join('\n\n')}\n\n</details>`);
  }

  sections.push(`Run: \`${runId}\``);
  sections.push('🤖 Generated with [Claude Code](https://claude.com/claude-code)');
  return sections.join('\n\n');
}

// Build the Atlassian Document Format payload for a Jira ticket's QA Notes
// field (customfield_14226), reproducing push-branch/SKILL.md's Jira Cleanup
// sub-step A: a bold "Manual testing steps:" paragraph followed by an ordered
// list, one item per step, with an `Expected:`-prefixed step split into a
// strong label plus the remainder.
//
// This takes the SAME `qaNotes` array the driver already passed to
// renderPrBody, so the ticket and the PR cannot drift. push-branch re-parses
// its own PR body because the body is its only artifact; the harness holds the
// array, so there is nothing to parse back out.
//
// Jira-only: a github-sourced run's QA notes live in the PR body and never
// reach this function. Falls back to a bare `See PR: <url>` paragraph when
// there are no usable steps — an empty ADF text node is invalid and would make
// Jira reject the whole transition.
export function renderQaNotesAdf({ qaNotes = [], prUrl = '' }) {
  const steps = qaNotes.map((q) => step(q).trim()).filter((q) => q !== '');
  if (!steps.length) {
    return {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: `See PR: ${prUrl}` }] }],
    };
  }
  // The PR body writes the label as markdown (`**Expected:**`); ADF carries
  // emphasis as marks, so the literal asterisks must not survive into the
  // ticket. Anchored at the start so a mid-sentence "expected:" stays plain.
  const EXPECTED = /^(?:\*\*)?(Expected:)(?:\*\*)?(.*)$/;
  const items = steps.map((text) => {
    const m = text.match(EXPECTED);
    const content = m
      ? [
          { type: 'text', text: m[1], marks: [{ type: 'strong' }] },
          { type: 'text', text: m[2] },
        ]
      : [{ type: 'text', text }];
    return { type: 'listItem', content: [{ type: 'paragraph', content }] };
  });
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Manual testing steps:', marks: [{ type: 'strong' }] }],
      },
      { type: 'orderedList', attrs: { order: 1 }, content: items },
    ],
  };
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
