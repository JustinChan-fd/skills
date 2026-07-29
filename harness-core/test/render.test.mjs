import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderStatusComment, renderPrBody, renderBrief, renderQaNotesAdf } from '../tools/lib/render.mjs';

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
// u3 — renderPrBody: opens with Closes #<issue> for issue-sourced runs, then
// the push-branch-shaped `## Changes` / `## QA Notes` sections, then the
// harness audit trail folded into a single <details> block (entry-contract
// table, landing checklist, and advisory residue — the last only when notes is
// non-empty).
// ---------------------------------------------------------------------------

test('renderPrBody (issue-sourced, with residue): exact assembled shape', () => {
  const out = renderPrBody({
    changeType: 'perf',
    issue: 8,
    summary: 'Demoted 5 inline steps to scripts.',
    changes: ['Demote step 5 to a script', 'Delete the inline fallback'],
    qaNotes: ['Run `harness-loop` once', '**Expected:** no inline formatting step'],
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
    '## Changes\n' +
    '\n' +
    '- Demote step 5 to a script\n' +
    '- Delete the inline fallback\n' +
    '\n' +
    '## QA Notes\n' +
    '\n' +
    'Manual testing steps:\n' +
    '\n' +
    '1. Run `harness-loop` once\n' +
    '2. **Expected:** no inline formatting step\n' +
    '\n' +
    '<details>\n' +
    '<summary>Harness verification detail</summary>\n' +
    '\n' +
    '**Entry-contract results**\n' +
    '\n' +
    '| Criterion | Tag | Result | Evidence |\n' +
    '| --- | --- | --- | --- |\n' +
    '| Inventory exists | advisory | pass | spec grep |\n' +
    '| No routing.json changes | blocking | pass | git diff empty |\n' +
    '\n' +
    '**Landing checklist**\n' +
    '\n' +
    '- [ ] Confirm Closes-#8 closed the issue on merge\n' +
    '- [ ] Run harness-loop once to exercise scripts\n' +
    '\n' +
    '**Advisory residue**\n' +
    '\n' +
    '- **criterion A** — detail A verbatim\n' +
    '\n' +
    '</details>\n' +
    '\n' +
    'Run: `RID8`\n' +
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
  assert.match(out, /\*\*Advisory residue\*\*\n\n- \*\*crit 1\*\* — detail 1\n- \*\*crit 2\*\* — detail 2\n/);
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
// push-branch template parity. The PR body must reproduce the shape in
// push-branch/SKILL.md "Format Requirements": a `## Changes` section of flat
// bullets, then a `## QA Notes` section of numbered manual steps. That skill
// bans subsections and "Files Changed"-style headings in the human-facing
// body, so the harness's own audit trail (entry-contract table, landing
// checklist, advisory residue) moves inside ONE collapsed <details> block
// below QA Notes — kept, because it is the gate's evidence, but not competing
// with the reviewer-facing summary.
//
// `## QA Notes` is load-bearing beyond formatting: push-branch's Jira Cleanup
// parses that exact heading out of the PR body to build the ADF for
// customfield_14226. A rename here silently breaks the ticket write-back.
// ---------------------------------------------------------------------------

test('renderPrBody: renders a ## Changes section of flat bullets from changes[]', () => {
  const out = renderPrBody({
    issue: 'TARS-1272', summary: 's',
    changes: ['Add the guide', 'Correct two ticket claims', 'Zero changes under src/'],
    qaNotes: ['Open the guide'],
    resultRows: [], landingChecklist: [], runId: 'r', notes: [],
  });
  assert.match(out, /## Changes\n\n- Add the guide\n- Correct two ticket claims\n- Zero changes under src\/\n/);
});

test('renderPrBody: renders ## QA Notes as a numbered list under the push-branch preamble', () => {
  const out = renderPrBody({
    issue: 'TARS-1272', summary: 's',
    changes: ['c'],
    qaNotes: ['Check out the branch', 'Run the suite', 'Expected: 96 cases pass'],
    resultRows: [], landingChecklist: [], runId: 'r', notes: [],
  });
  assert.match(
    out,
    /## QA Notes\n\nManual testing steps:\n\n1\. Check out the branch\n2\. Run the suite\n3\. Expected: 96 cases pass\n/,
  );
});

test('renderPrBody: Changes precedes QA Notes, and both precede the audit trail', () => {
  const out = renderPrBody({
    issue: 'TARS-1272', summary: 's',
    changes: ['c'], qaNotes: ['q'],
    resultRows: [{ criterion: 'c1', tag: 'blocking', result: 'pass', evidence: 'e' }],
    landingChecklist: ['land'], runId: 'r', notes: [],
  });
  assert.ok(out.indexOf('## Changes') < out.indexOf('## QA Notes'), 'Changes must precede QA Notes');
  assert.ok(out.indexOf('## QA Notes') < out.indexOf('<details>'), 'QA Notes must precede the audit trail');
});

test('renderPrBody: audit trail is wrapped in ONE collapsed <details> block, not top-level headings', () => {
  const out = renderPrBody({
    issue: 'TARS-1272', summary: 's', changes: ['c'], qaNotes: ['q'],
    resultRows: [{ criterion: 'c1', tag: 'blocking', result: 'pass', evidence: 'ev' }],
    landingChecklist: ['land it'], runId: 'RID',
    notes: [{ data: { criterion: 'crit', detail: 'det' } }],
  });
  // push-branch bans competing top-level sections in the body.
  assert.ok(!/\n## Entry-contract results/.test(out), 'entry-contract must not be a top-level heading');
  assert.ok(!/\n## Landing checklist/.test(out), 'landing checklist must not be a top-level heading');
  assert.ok(!/\n## Advisory residue/.test(out), 'advisory residue must not be a top-level heading');
  // ...but the evidence itself is preserved, inside exactly one details block.
  assert.equal(out.match(/<details>/g).length, 1, 'exactly one details block');
  assert.match(out, /<summary>Harness verification detail<\/summary>/);
  assert.match(out, /\| c1 \| blocking \| pass \| ev \|/);
  assert.match(out, /- \[ \] land it/);
  assert.match(out, /- \*\*crit\*\* — det/);
  assert.match(out, /<\/details>/);
});

test('renderPrBody: omits the details block entirely when there is no audit trail to show', () => {
  const out = renderPrBody({
    issue: 'TARS-1272', summary: 's', changes: ['c'], qaNotes: ['q'],
    resultRows: [], landingChecklist: [], runId: 'r', notes: [],
  });
  assert.ok(!out.includes('<details>'), 'no empty details block');
  assert.match(out, /Run: `r`/, 'run id still cited');
});

test('renderPrBody: omits Changes and QA Notes headings when the driver supplied neither', () => {
  // Backward compatibility: existing callers pass neither field. They must keep
  // working rather than emit two empty headings.
  const out = renderPrBody({
    issue: 8, summary: 'just prose',
    resultRows: [{ criterion: 'c', tag: 'blocking', result: 'pass', evidence: 'e' }],
    landingChecklist: [], runId: 'r', notes: [],
  });
  assert.ok(!out.includes('## Changes'), 'no empty Changes heading');
  assert.ok(!out.includes('## QA Notes'), 'no empty QA Notes heading');
});

test('renderPrBody: QA Notes survive a pipe or newline without breaking the numbered list', () => {
  const out = renderPrBody({
    issue: 8, summary: 's', changes: ['c'],
    qaNotes: ['Run `a | b`', 'Expected:\nsecond line'],
    resultRows: [], landingChecklist: [], runId: 'r', notes: [],
  });
  assert.match(out, /1\. Run `a \| b`\n2\. Expected: second line\n/);
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

// ---------------------------------------------------------------------------
// u5 — renderQaNotesAdf: the QA-notes array becomes the Atlassian Document
// Format payload for Jira customfield_14226, matching push-branch's Jira
// Cleanup sub-step A byte for byte. This is Jira-only: GitHub-sourced runs get
// their QA notes from the PR body and never call this.
//
// Deterministic string→ADF assembly, so it belongs in a script rather than
// being hand-composed inline by the driver each run.
// ---------------------------------------------------------------------------

test('renderQaNotesAdf: doc/version/strong-preamble/orderedList envelope', () => {
  const adf = renderQaNotesAdf({ qaNotes: ['first step'], prUrl: 'https://x/1' });
  assert.equal(adf.type, 'doc');
  assert.equal(adf.version, 1);
  assert.deepEqual(adf.content[0], {
    type: 'paragraph',
    content: [{ type: 'text', text: 'Manual testing steps:', marks: [{ type: 'strong' }] }],
  });
  assert.equal(adf.content[1].type, 'orderedList');
  assert.deepEqual(adf.content[1].attrs, { order: 1 });
});

test('renderQaNotesAdf: one listItem per step, plain text', () => {
  const adf = renderQaNotesAdf({ qaNotes: ['step one', 'step two'], prUrl: 'https://x/1' });
  const items = adf.content[1].content;
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    type: 'listItem',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'step one' }] }],
  });
  assert.deepEqual(items[1].content[0].content, [{ type: 'text', text: 'step two' }]);
});

test('renderQaNotesAdf: an Expected: step splits into a strong label plus the rest', () => {
  const adf = renderQaNotesAdf({ qaNotes: ['Expected: all 3 files pass'], prUrl: 'https://x/1' });
  assert.deepEqual(adf.content[1].content[0].content[0].content, [
    { type: 'text', text: 'Expected:', marks: [{ type: 'strong' }] },
    { type: 'text', text: ' all 3 files pass' },
  ]);
});

test('renderQaNotesAdf: markdown-bolded **Expected:** is recognised and the asterisks stripped', () => {
  // The PR body writes `**Expected:** ...`; ADF carries emphasis as marks, so
  // the literal asterisks must not survive into the ticket field.
  const adf = renderQaNotesAdf({ qaNotes: ['**Expected:** 96 cases pass'], prUrl: 'https://x/1' });
  assert.deepEqual(adf.content[1].content[0].content[0].content, [
    { type: 'text', text: 'Expected:', marks: [{ type: 'strong' }] },
    { type: 'text', text: ' 96 cases pass' },
  ]);
});

test('renderQaNotesAdf: a step that merely mentions expected mid-sentence stays plain', () => {
  const adf = renderQaNotesAdf({ qaNotes: ['Confirm the expected: output matches'], prUrl: 'https://x/1' });
  assert.deepEqual(adf.content[1].content[0].content[0].content, [
    { type: 'text', text: 'Confirm the expected: output matches' },
  ]);
});

test('renderQaNotesAdf: no steps falls back to a bare See PR paragraph', () => {
  const adf = renderQaNotesAdf({ qaNotes: [], prUrl: 'https://github.com/o/r/pull/349' });
  assert.deepEqual(adf, {
    type: 'doc',
    version: 1,
    content: [{
      type: 'paragraph',
      content: [{ type: 'text', text: 'See PR: https://github.com/o/r/pull/349' }],
    }],
  });
});

test('renderQaNotesAdf: blank and whitespace-only steps are dropped, not emitted as empty items', () => {
  // An empty ADF text node is invalid and Jira rejects the whole request, so a
  // sloppy --qa-notes array must not be able to fail the ticket write-back.
  const adf = renderQaNotesAdf({ qaNotes: ['real step', '', '   '], prUrl: 'https://x/1' });
  assert.equal(adf.content[1].content.length, 1);
});

test('renderQaNotesAdf: all-blank steps degrade to the See PR fallback', () => {
  const adf = renderQaNotesAdf({ qaNotes: ['', '  '], prUrl: 'https://x/9' });
  assert.equal(adf.content.length, 1);
  assert.equal(adf.content[0].content[0].text, 'See PR: https://x/9');
});

test('renderQaNotesAdf: a step containing a newline is flattened into one paragraph', () => {
  const adf = renderQaNotesAdf({ qaNotes: ['line one\nline two'], prUrl: 'https://x/1' });
  assert.deepEqual(adf.content[1].content[0].content[0].content, [
    { type: 'text', text: 'line one line two' },
  ]);
});
