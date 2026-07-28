import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderStatusComment, renderPrBody, renderBrief } from '../tools/lib/render.mjs';

// ---------------------------------------------------------------------------
// u2 — renderStatusComment: reproduces templates/status-comment.md's shape
// (heading with phase+status emoji, phase-specific Run/Size|Plan|PR line,
// Residue line only when notes non-empty, Next line last).
// ---------------------------------------------------------------------------

test('renderStatusComment (intake, with residue): heading emoji, Size line, Residue line, Next last', () => {
  const out = renderStatusComment({
    phase: 'intake',
    status: 'succeeded',
    runId: '2026-07-27T095734Z__skills__intake__issue-7__d1dd9b',
    size: 'L',
    sizeRationale: 'cross-cutting: schema bump plus prose reword',
    notes: [
      { data: { type: 'residue', criterion: 'criterion X unreconciled against constraint', detail: 'plan must resolve' } },
    ],
    next: 'harness-plan runs next against this manifest',
  });
  assert.equal(out,
    '## harness: intake ✅ succeeded\n' +
    '\n' +
    '- **Run:** `2026-07-27T095734Z__skills__intake__issue-7__d1dd9b`\n' +
    '- **Size:** L — cross-cutting: schema bump plus prose reword\n' +
    '- **Residue:** 1 item — criterion X unreconciled against constraint\n' +
    '- **Next:** harness-plan runs next against this manifest');
});

test('renderStatusComment (plan, zero residue): Plan line present, Residue line entirely omitted', () => {
  const out = renderStatusComment({
    phase: 'plan',
    status: 'succeeded',
    runId: '2026-07-27T144858Z__skills__plan__issue-8__48dc87',
    planUnits: 6,
    planBlocking: 4,
    notes: [],
    next: 'harness-implement runs next against this plan',
  });
  assert.equal(out,
    '## harness: plan ✅ succeeded\n' +
    '\n' +
    '- **Run:** `2026-07-27T144858Z__skills__plan__issue-8__48dc87`\n' +
    '- **Plan:** 6 units, 4 blocking criteria\n' +
    '- **Next:** harness-implement runs next against this plan');
  assert.ok(!out.includes('Residue'), 'Residue line must be omitted entirely when notes is empty');
});

test('renderStatusComment (implement): PR line and failed emoji', () => {
  const out = renderStatusComment({
    phase: 'implement',
    status: 'failed',
    runId: 'run-x',
    prUrl: 'https://github.com/o/r/pull/9',
    notes: [],
    next: 'blocked at verifier cap',
  });
  assert.match(out, /^## harness: implement ❌ failed\n/);
  assert.match(out, /\n- \*\*PR:\*\* https:\/\/github\.com\/o\/r\/pull\/9\n/);
  assert.match(out, /\n- \*\*Next:\*\* blocked at verifier cap$/);
});

test('renderStatusComment (partial status): ⏸ emoji', () => {
  const out = renderStatusComment({
    phase: 'implement', status: 'partial', runId: 'r', prUrl: 'u', notes: [], next: 'n',
  });
  assert.match(out, /^## harness: implement ⏸ partial\n/);
});

test('renderStatusComment: multiple residue notes pluralize "items" and summarize the first note', () => {
  const out = renderStatusComment({
    phase: 'plan', status: 'succeeded', runId: 'r', planUnits: 2, planBlocking: 1,
    notes: [
      { data: { criterion: 'first criterion', detail: 'd1' } },
      { data: { criterion: 'second criterion', detail: 'd2' } },
    ],
    next: 'n',
  });
  assert.match(out, /\n- \*\*Residue:\*\* 2 items — first criterion\n/);
});

test('renderStatusComment: accepts flat {criterion,detail} note shape too', () => {
  const out = renderStatusComment({
    phase: 'plan', status: 'succeeded', runId: 'r', planUnits: 1, planBlocking: 0,
    notes: [{ criterion: 'flat crit', detail: 'flat detail' }],
    next: 'n',
  });
  assert.match(out, /\n- \*\*Residue:\*\* 1 item — flat crit\n/);
});

// ---------------------------------------------------------------------------
// u3 — renderPrBody: opens with Closes #<issue> for issue-sourced runs,
// renders the entry-contract results as a table, and includes a
// '## Advisory residue' section only when notes is non-empty.
// ---------------------------------------------------------------------------

test('renderPrBody (issue-sourced, with residue): exact assembled shape', () => {
  const out = renderPrBody({
    changeType: 'perf',
    issue: 8,
    summary: 'Demoted 5 inline steps to scripts.',
    resultRows: [
      { criterion: 'Inventory exists', tag: 'advisory', result: 'pass', evidence: 'spec grep' },
      { criterion: 'No routing.json changes', tag: 'blocking', result: 'pass', evidence: 'git diff empty' },
    ],
    landingChecklist: [
      'Confirm Closes-#8 closed the issue on merge',
      'Run harness-loop once to exercise scripts',
    ],
    runId: 'RID8',
    notes: [{ data: { criterion: 'criterion A', detail: 'detail A verbatim' } }],
  });
  assert.equal(out,
    'Closes #8.\n' +
    '\n' +
    'Demoted 5 inline steps to scripts.\n' +
    '\n' +
    '## Entry-contract results\n' +
    '\n' +
    '| Criterion | Tag | Result | Evidence |\n' +
    '| --- | --- | --- | --- |\n' +
    '| Inventory exists | advisory | pass | spec grep |\n' +
    '| No routing.json changes | blocking | pass | git diff empty |\n' +
    '\n' +
    '## Landing checklist\n' +
    '\n' +
    '- [ ] Confirm Closes-#8 closed the issue on merge\n' +
    '- [ ] Run harness-loop once to exercise scripts\n' +
    '\n' +
    'Run: `RID8`\n' +
    '\n' +
    '## Advisory residue\n' +
    '\n' +
    '- **criterion A** — detail A verbatim\n' +
    '\n' +
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)');
});

test('renderPrBody: opens with "Closes #<issue>" for issue-sourced runs', () => {
  const out = renderPrBody({
    issue: 42, summary: 's', resultRows: [{ criterion: 'c', tag: 'blocking', result: 'pass', evidence: 'e' }],
    landingChecklist: [], runId: 'r', notes: [],
  });
  assert.match(out, /^Closes #42\.\n/);
});

test('renderPrBody: omits the Advisory residue heading entirely when notes is empty', () => {
  const out = renderPrBody({
    issue: 8, summary: 's', resultRows: [{ criterion: 'c', tag: 'blocking', result: 'pass', evidence: 'e' }],
    landingChecklist: ['x'], runId: 'r', notes: [],
  });
  assert.ok(!out.includes('Advisory residue'), 'Advisory residue heading must be omitted when notes is empty');
  assert.match(out, /🤖 Generated with \[Claude Code\]/);
});

test('renderPrBody: renders one Advisory-residue bullet per note, verbatim criterion + detail', () => {
  const out = renderPrBody({
    issue: 8, summary: 's', resultRows: [{ criterion: 'c', tag: 'blocking', result: 'pass', evidence: 'e' }],
    landingChecklist: [], runId: 'r',
    notes: [
      { data: { criterion: 'crit 1', detail: 'detail 1' } },
      { criterion: 'crit 2', detail: 'detail 2' },
    ],
  });
  assert.match(out, /## Advisory residue\n\n- \*\*crit 1\*\* — detail 1\n- \*\*crit 2\*\* — detail 2\n/);
});

test('renderPrBody: escapes pipe characters in table cells so the table stays intact', () => {
  const out = renderPrBody({
    issue: 8, summary: 's',
    resultRows: [{ criterion: 'a | b', tag: 'blocking', result: 'pass', evidence: 'x | y' }],
    landingChecklist: [], runId: 'r', notes: [],
  });
  assert.match(out, /\| a \\\| b \| blocking \| pass \| x \\\| y \|/);
});

test('renderPrBody: non-issue-sourced run omits the Closes line', () => {
  const out = renderPrBody({
    issue: null, summary: 'adhoc summary',
    resultRows: [{ criterion: 'c', tag: 'blocking', result: 'pass', evidence: 'e' }],
    landingChecklist: [], runId: 'r', notes: [],
  });
  assert.ok(!out.includes('Closes #'), 'no Closes line without an issue');
  assert.match(out, /^adhoc summary\n/);
});

// ---------------------------------------------------------------------------
// u4 — renderBrief: reproduces templates/brief.md's exact seven-item shape
// from a validated brief-schema JSON object, appending the
// needs_decision_directive verbatim only for MINIMAL/MODERATE budgets.
// ---------------------------------------------------------------------------

const DIRECTIVE = 'If you hit a decision this brief does not cover, DO NOT deliberate or guess. Include this object in your final report, then stop immediately.';

test('renderBrief (MINIMAL budget, no output schema): exact seven-item shape + directive appended', () => {
  const out = renderBrief({
    objective: 'Inventory the steps',
    output: { path: 'findings/discovery-1.json', schema: null },
    tools: { allowed: ['Read', 'Grep', 'Glob'], forbidden: ['Edit', 'Write'] },
    boundaries: ['Read-only: do not modify any file', 'Scope limited to named steps'],
    done_when: 'A one-paragraph-per-item report is returned',
    tier: { level: 'LOW', model: 'haiku' },
    reasoning: { budget: 'MINIMAL', needs_decision_directive: DIRECTIVE },
    schema_version: '1.0.0',
  });
  assert.equal(out,
    'OBJECTIVE: Inventory the steps\n' +
    'OUTPUT: Return your result as a single JSON object in your final message — it is your ONLY deliverable. You are read-only and cannot write files; the parent (the single writer) persists it to findings/discovery-1.json.\n' +
    'TOOLS: You may use: Read, Grep, Glob. You must NOT use: Edit, Write.\n' +
    'BOUNDARIES:\n' +
    '- Read-only: do not modify any file\n' +
    '- Scope limited to named steps\n' +
    'DONE-WHEN: A one-paragraph-per-item report is returned\n' +
    'TIER: You are running as LOW. Do not reason about, request, or change your own model or budget.\n' +
    'REASONING: Your reasoning budget is MINIMAL.\n' +
    DIRECTIVE);
});

test('renderBrief (FULL budget): no directive appended', () => {
  const out = renderBrief({
    objective: 'Deep synthesis',
    output: { path: 'findings/x.json', schema: null },
    tools: { allowed: ['Read'], forbidden: ['Write'] },
    boundaries: ['b1'],
    done_when: 'done',
    tier: { level: 'MID', model: 'sonnet' },
    reasoning: { budget: 'FULL', needs_decision_directive: DIRECTIVE },
    schema_version: '1.0.0',
  });
  assert.ok(out.endsWith('REASONING: Your reasoning budget is FULL.'), 'FULL budget must not append the directive');
  assert.ok(!out.includes(DIRECTIVE));
});

test('renderBrief (MODERATE budget): directive appended', () => {
  const out = renderBrief({
    objective: 'o', output: { path: 'p', schema: null },
    tools: { allowed: ['Read'], forbidden: ['Write'] }, boundaries: ['b'],
    done_when: 'd', tier: { level: 'MID', model: 'sonnet' },
    reasoning: { budget: 'MODERATE', needs_decision_directive: DIRECTIVE },
  });
  assert.ok(out.endsWith(DIRECTIVE), 'MODERATE budget must append the directive verbatim');
});

test('renderBrief: output.schema present appends the validate clause to the OUTPUT line', () => {
  const out = renderBrief({
    objective: 'o', output: { path: 'findings/nd.json', schema: 'needs-decision' },
    tools: { allowed: ['Read'], forbidden: ['Write'] }, boundaries: ['b'],
    done_when: 'd', tier: { level: 'LOW', model: 'haiku' },
    reasoning: { budget: 'FULL' },
  });
  assert.match(out, /persists it to findings\/nd\.json\. It must validate against the needs-decision schema\.\n/);
});
