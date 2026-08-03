// jira — reading a ticket out of the Atlassian MCP without trusting the model that fetched it.
//
// WHY THE MCP AND NOT AN API TOKEN. The operator has no permission to issue Jira API keys, and
// MEASURED 2026-08-01 the MCP needs none: `claude mcp list` reports atlassian ✔ Connected from a
// bare tool shell, and a headless `claude -p` spawn called `mcp__atlassian__getJiraIssue` and
// returned TARS-1359's real summary with no interactive auth. The OAuth credential is already on
// disk and already scoped. A second credential would be a second thing to leak.
//
// THE ONE THING THIS MODULE MUST NOT DO is believe the model's summary of what it fetched. The
// acceptance criteria of these tickets END IN SHELL COMMANDS — `grep -q "^## Client Routes"
// docs/modules/hasher.md && for p in /hasher; do ...` — and lib/gate.mjs executes those strings
// byte-for-byte. A model relaying a payload through its own output tokens is free to normalise a
// quote, drop a `$`, or tidy a `&&`, and the result is a criterion that fails for a reason no
// worker caused, or worse one that passes because it no longer checks anything. So the payload is
// recovered from the session TRANSCRIPT's `tool_result` — the bytes the MCP actually returned —
// and the model's prose is discarded entirely. `extractPayload` is the seam that enforces it.
//
// WHY THERE IS NO ADF CONVERTER HERE. There was going to be one. MEASURED first: the MCP renders
// markdown SERVER-SIDE when asked (`responseContentFormat: "markdown"`), and the real TARS-1353
// description came back as a markdown string with `## Acceptance Criteria`, `*` list items, and
// every verify command intact inside backticks. Run through the EXISTING
// `extractAcceptanceCriteria` unchanged, it yielded 5 criteria and `problem: null`. A converter
// would have been a second parser of the same tickets, free to disagree with the tested one.
//
// UNTRUSTED CONTENT, precisely. A ticket body is written by whoever opened the ticket. What this
// layer can promise is narrow: the body cannot change which issue was fetched or which repo is
// worked, because both are read from the config before the body exists, and `claude` is invoked
// with an argv array so no shell re-parses it. What the body CAN do is carry instructions to the
// model that later reads it — lib/prompt.mjs's problem, unsolved there too.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FETCH_TOOLS, fetchArgv, extractPayload, issueToItem, isWorkable } from '../lib/jira.mjs';
import { extractAcceptanceCriteria } from '../lib/item.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/jira-tars-1353.md', import.meta.url));
const REAL_MARKDOWN = readFileSync(FIXTURE, 'utf8');

const CONFIG = {
  source: {
    kind: 'jira',
    jira: {
      project: 'TARS',
      epics: ['https://fandango.atlassian.net/browse/TARS-1350'],
      epic_keys: ['TARS-1350'],
      host: 'fandango.atlassian.net',
      statuses: ['To Do'],
    },
  },
};

const flag = (argv, name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

// ---------------------------------------------------------------------------
// The argv. Same discipline as lib/router.mjs: an array, and the fetch is scoped.
// ---------------------------------------------------------------------------

test('the fetch names ONLY the atlassian server — the trusted spawn is not the operator’s whole MCP set', () => {
  // Alfred's fetch is the mirror image of the worker's deny. MEASURED in both directions:
  // `--strict-mcp-config` with no `--mcp-config` made the tool not exist (the worker case), and
  // with a one-server config it resolved and answered. Both flags, or the scoping is a comment.
  const argv = fetchArgv({ config: CONFIG, key: 'TARS-1353' });
  assert.ok(argv.includes('--strict-mcp-config'), 'the fetch inherits every server the operator has');
  const cfg = flag(argv, '--mcp-config');
  assert.ok(cfg, 'no --mcp-config: strict alone would give the fetch nothing to call');
  const parsed = JSON.parse(cfg);
  assert.deepEqual(Object.keys(parsed.mcpServers), ['atlassian']);
});

test('the fetch is allowlisted to READ tools — it cannot write the ticket it is about to grade against', () => {
  // The fetch runs before the worker and is trusted, but "trusted" is not "unrestricted". If the
  // fetch could transition an issue or edit a description, then a prompt-injecting ticket body
  // reaches a tool that rewrites acceptance criteria — and the gate reads those criteria. The
  // allowlist is what makes the read path read-only.
  const argv = fetchArgv({ config: CONFIG, key: 'TARS-1353' });
  const allowed = flag(argv, '--allowedTools').split(',');
  assert.ok(allowed.length > 0);
  for (const tool of allowed) {
    assert.match(tool, /^mcp__atlassian__(get|search)/, `${tool} is not a read-only atlassian tool`);
  }
  // Named explicitly, because a regex that happened to admit `editJiraIssue` would pass above if
  // the tool were called `getOrEditJiraIssue`. These are the two the poll and the fetch need.
  for (const forbidden of [
    'mcp__atlassian__editJiraIssue',
    'mcp__atlassian__transitionJiraIssue',
    'mcp__atlassian__addCommentToJiraIssue',
  ]) {
    assert.ok(!allowed.includes(forbidden), `${forbidden} is reachable from the fetch`);
  }

  // ADDED 2026-08-03: THE ALLOWLIST THE FLAG CARRIES IS THE ONE `FETCH_TOOLS` DECLARES.
  //
  // Every assertion above this line reads `--allowedTools` and checks its SHAPE — a regex, then
  // three names. `FETCH_TOOLS`'s own comment says it is enumerated "so that adding a tool is a
  // visible edit here and the test that asserts read-only-ness has something to check", and that
  // was FALSE when written: no test referenced the constant. The read-only property was checked by
  // a second, independent copy of the rule living in this file.
  //
  // Which is this project's recorded `feedback_mutate_to_prove_a_falsifier` shape — a shared rule
  // NAME is not a shared code path. Without this line `fetchArgv` could stop reading `FETCH_TOOLS`
  // altogether — build its flag from a hardcoded string — and every assertion above would pass.
  //
  // WHAT THIS DOES NOT CATCH, stated because the first version of this comment claimed it did and
  // three mutants proved otherwise. Adding a tool to `FETCH_TOOLS` that the regex above admits
  // (`getVisibleJiraProjects`) does NOT fail this test: the flag is BUILT from the constant, so
  // widening moves both sides together and deepEqual still holds. 24/24 stayed green under exactly
  // that mutant. A silent widening of this security boundary is therefore still unguarded here —
  // the only thing standing between a new `get*` tool and the fetch is the regex, and the regex
  // admits every read-shaped name. Guarding it needs a declared expected SET (the
  // `feedback_denominator_asymmetry` rule: declare the set, never derive it), which is a bigger
  // change than this one and is not smuggled in here.
  //
  // So the precise claim: this asserts the flag and the constant are the SAME source, and nothing
  // more. Mutant that kills it: change the flag to drop `searchJiraIssuesUsingJql` — verified
  // failing, `not ok 2`.
  //
  // deepEqual, not a subset check: the constant is the whole declared surface, so an extra tool in
  // the flag is exactly as much a finding as a missing one.
  assert.deepEqual(
    allowed,
    [...FETCH_TOOLS],
    'the --allowedTools flag and FETCH_TOOLS have diverged: one of them is no longer the source',
  );
});

test('the fetch asks for markdown, which is what makes the existing extractor sufficient', () => {
  // Not a formatting preference. Asking for ADF would mean writing a converter, and a converter
  // is a SECOND parser of the same tickets that is free to disagree with `extractAcceptanceCriteria`.
  const argv = fetchArgv({ config: CONFIG, key: 'TARS-1353' });
  assert.match(flag(argv, '-p'), /markdown/);
  assert.match(flag(argv, '-p'), /TARS-1353/);
});

test('the fetch prompt carries the host from the config, never a hardcoded site', () => {
  const argv = fetchArgv({ config: CONFIG, key: 'TARS-1353' });
  assert.match(flag(argv, '-p'), /fandango\.atlassian\.net/);
  const other = { source: { kind: 'jira', jira: { ...CONFIG.source.jira, host: 'elsewhere.atlassian.net' } } };
  assert.match(flag(fetchArgv({ config: other, key: 'TARS-1' }), '-p'), /elsewhere\.atlassian\.net/);
});

test('a fetch under a non-jira config is refused rather than built', () => {
  // Same rule as loadConfig and resolveItem: refuse, do not guess. A github-configured repo that
  // reached this function is a caller bug, and building an argv for it would spend to find out.
  //
  // THE MESSAGE IS ASSERTED, NOT MERELY THE THROW. Written first as `/jira/i`, this test SURVIVED
  // a mutant that deleted the `kind !== 'jira'` guard outright: execution fell through to the
  // host check, which throws its own error that also contains the word "jira". A `throws` whose
  // pattern matches a DIFFERENT refusal is an unfalsifiable conjunct — it proves something threw,
  // not that the thing under test rejected. So the assertion names the kind that was refused.
  assert.throws(
    () => fetchArgv({ config: { source: { kind: 'github', github: {} } }, key: 'TARS-1' }),
    /source\.kind is "github", not "jira"/,
  );
  // And a github config that DOES carry a jira-shaped host must still be refused, which is the
  // case the fall-through could otherwise satisfy by accident.
  assert.throws(
    () => fetchArgv({
      config: { source: { kind: 'github', github: {}, jira: { host: 'fandango.atlassian.net' } } },
      key: 'TARS-1',
    }),
    /source\.kind is "github", not "jira"/,
  );
});

test('an empty or non-string key is refused — a fetch with no issue spends for nothing', () => {
  for (const bad of ['', '   ', null, undefined, 42]) {
    assert.throws(() => fetchArgv({ config: CONFIG, key: bad }), /key/i);
  }
});

// ---------------------------------------------------------------------------
// extractPayload — the trust boundary. Reads the tool_result, discards the prose.
// ---------------------------------------------------------------------------

// A transcript in the shape node writes it: JSONL, one record per line, the tool_result nested
// under message.content[]. Built from the REAL shape measured at
// ~/.claude/projects/-private-tmp/<session>.jsonl, not invented.
const transcriptWith = (payload, { assistantSays = 'I fetched the ticket.' } = {}) =>
  [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'mcp__atlassian__getJiraIssue', input: {} }] },
    }),
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: [{ type: 'text', text: JSON.stringify(payload) }] }],
      },
    }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: assistantSays }] } }),
  ].join('\n');

const ISSUE = {
  key: 'TARS-1353',
  fields: {
    summary: 'Module runbook: Discovery Hash ID Tool',
    description: REAL_MARKDOWN,
    status: { name: 'To Do' },
    parent: { key: 'TARS-1350', fields: { summary: '2026 TARS webtarsthree Test' } },
    labels: [],
  },
};

test('the payload is read from the tool_result, not from the assistant’s prose', () => {
  // THE POINT OF THE MODULE. The assistant text here is a plausible-looking paraphrase with the
  // criteria "helpfully" tidied — quotes normalised, the `$p` gone. A reader that took the prose
  // would produce criteria the gate cannot run, and would look like it worked.
  const lies = 'Summary: Module runbook. Criteria: grep for ## Client Routes in the hasher doc.';
  const got = extractPayload(transcriptWith(ISSUE, { assistantSays: lies }));
  assert.equal(got.key, 'TARS-1353');
  assert.equal(got.fields.summary, 'Module runbook: Discovery Hash ID Tool');
  assert.ok(!JSON.stringify(got).includes('helpfully'));
  // The description is the FIXTURE's bytes, character for character.
  assert.equal(got.fields.description, REAL_MARKDOWN);
});

test('a search-shaped payload (issues.nodes[]) is unwrapped to the issue', () => {
  // MEASURED: the MCP returned `{"issues":{"nodes":[{...}]}}` for a single-issue getJiraIssue
  // call, not the bare issue. A reader written against the bare shape would have thrown on every
  // real fetch while passing a test built on an invented one.
  const got = extractPayload(transcriptWith({ issues: { nodes: [ISSUE] } }));
  assert.equal(got.key, 'TARS-1353');
  assert.equal(got.fields.description, REAL_MARKDOWN);
});

test('a transcript with no tool_result is refused, not silently empty', () => {
  // The failure mode this prevents: the model answered from memory without calling the tool, and
  // a lenient reader returns an issue with no criteria. Zero criteria means zero objections
  // means a PR that reads verified because nobody could check it.
  const noTool = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'TARS-1353 is a doc ticket.' }] } }),
  ].join('\n');
  assert.throws(() => extractPayload(noTool), /tool_result/i);
});

test('a tool_result that is not json is refused with the reason', () => {
  const bad = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'Error: rate limited' }] }] },
  });
  assert.throws(() => extractPayload(bad), /json|parse/i);
});

test('an MCP error payload is refused rather than turned into an empty ticket', () => {
  const err = transcriptWith({ error: 'Issue does not exist or you do not have permission to see it' });
  assert.throws(() => extractPayload(err), /permission|error/i);
});

test('unparseable transcript LINES are skipped, not fatal — a truncated tail must not lose the payload', () => {
  // Transcripts are appended to by a live process. A half-written final line is normal.
  const text = `${transcriptWith(ISSUE)}\n{"type":"assistant","message":{"rol`;
  assert.equal(extractPayload(text).key, 'TARS-1353');
});

test('the LAST tool_result wins when a fetch retried', () => {
  // A retry leaves both attempts in the transcript. The first may be the error that caused the
  // retry, and reading it would refuse a fetch that in fact succeeded.
  const text = [transcriptWith({ error: 'transient' }), transcriptWith(ISSUE)].join('\n');
  assert.equal(extractPayload(text).key, 'TARS-1353');
});

// ---------------------------------------------------------------------------
// issueToItem — the same item shape lib/run.mjs already consumes, with real criteria.
// ---------------------------------------------------------------------------

test('a real jira issue becomes an item whose criteria are the EXECUTABLE strings', () => {
  // The end-to-end claim, on the real ticket. These are the exact commands lib/gate.mjs will
  // run; a single normalised quote here is a check that fails for a reason no worker caused.
  const item = issueToItem({ issue: ISSUE, config: CONFIG });
  assert.equal(item.id, 'TARS-1353');
  assert.equal(item.source, 'jira');
  assert.equal(item.url, 'https://fandango.atlassian.net/browse/TARS-1353');
  assert.equal(item.epic, 'TARS-1350');
  assert.equal(item.status, 'To Do');
  assert.equal(item.acceptance_criteria.length, 5);
  assert.equal(item.ac_problem, null);
  const texts = item.acceptance_criteria.map((c) => c.text);
  assert.ok(texts[0].includes('grep -q "^## Client Routes" docs/modules/hasher.md'));
  assert.ok(texts[0].includes('for p in /hasher; do grep -q "$p" docs/modules/hasher.md || exit 1; done'));
  assert.ok(texts[4].includes('npm test'));
});

test('the criteria are byte-identical to what the SHARED extractor produces', () => {
  // Not a duplicate of the test above. This one asserts there is no second parser: if this module
  // ever grew its own criteria reader, github and jira tickets would be graded by two different
  // sets of rules and nothing else in the suite would notice.
  const item = issueToItem({ issue: ISSUE, config: CONFIG });
  assert.deepEqual(item.acceptance_criteria, extractAcceptanceCriteria(REAL_MARKDOWN).criteria);
});

test('the whole raw payload is kept, including fields this module never reads', () => {
  // PLAN.md §2.1: harness-core persisted a one-line excerpt and no run there is replayable. A
  // record trimmed to today's code cannot answer tomorrow's question.
  const item = issueToItem({ issue: ISSUE, config: CONFIG });
  assert.equal(item.raw.fields.parent.fields.summary, '2026 TARS webtarsthree Test');
});

test('a description-less ticket yields NO criteria and says why — none are invented', () => {
  // The rule lib/item.mjs states and this must not diverge from: the gate raises `ac_unmapped`
  // per criterion, so a fabricated criterion is a bar nobody set.
  const bare = { key: 'TARS-9', fields: { summary: 'x', status: { name: 'To Do' }, description: null } };
  const item = issueToItem({ issue: bare, config: CONFIG });
  assert.deepEqual(item.acceptance_criteria, []);
  assert.match(item.ac_problem, /no body|no acceptance criteria/i);
});

test('an issue with no parent has epic null rather than a guess', () => {
  const orphan = { key: 'TARS-9', fields: { summary: 'x', status: { name: 'To Do' }, description: 'y' } };
  assert.equal(issueToItem({ issue: orphan, config: CONFIG }).epic, null);
});

// ---------------------------------------------------------------------------
// isWorkable — the poll's filter. Deterministic, no model involved.
// ---------------------------------------------------------------------------

test('a To Do ticket under the configured epic is workable', () => {
  assert.equal(isWorkable({ issue: ISSUE, config: CONFIG }).workable, true);
});

test('a ticket in an unlisted status is NOT workable, and the reason names the status', () => {
  // Picking up an In Progress or Done ticket redoes work someone already shipped — and under
  // `delivery.never_merge` it opens a second PR against the same file.
  for (const name of ['In Progress', 'Done', 'Blocked']) {
    const other = { ...ISSUE, fields: { ...ISSUE.fields, status: { name } } };
    const got = isWorkable({ issue: other, config: CONFIG });
    assert.equal(got.workable, false, `${name} was treated as workable`);
    assert.match(got.reason, new RegExp(name));
  }
});

test('a ticket under a DIFFERENT epic is not workable', () => {
  // The epic is the operator's scope statement. A TARS ticket outside it is someone else's work.
  const foreign = { ...ISSUE, fields: { ...ISSUE.fields, parent: { key: 'TARS-9999' } } };
  const got = isWorkable({ issue: foreign, config: CONFIG });
  assert.equal(got.workable, false);
  assert.match(got.reason, /TARS-9999|epic/);
});

test('the blocked label makes a ticket unworkable — a tick must not retry what it already gave up on', () => {
  // The blocked-item policy: comment, label, skip on later ticks. Without this the loop spends
  // the full price on the same refusal every 30 minutes.
  const blocked = { ...ISSUE, fields: { ...ISSUE.fields, labels: ['alfred:blocked'] } };
  const got = isWorkable({ issue: blocked, config: CONFIG });
  assert.equal(got.workable, false);
  assert.match(got.reason, /blocked/);
});

test('a workable ticket is the FALSIFIER for every filter above', () => {
  // Without this, `isWorkable` returning false for everything satisfies all four tests and the
  // poll silently never works anything — a loop that appears to patrol and does nothing.
  const got = isWorkable({ issue: ISSUE, config: CONFIG });
  assert.equal(got.workable, true);
  assert.equal(got.reason, null);
});

test('with no statuses declared, status does not filter — but the epic still does', () => {
  // `statuses` is optional in the schema. Absent must mean "any status", not "none".
  const cfg = { source: { kind: 'jira', jira: { ...CONFIG.source.jira, statuses: undefined } } };
  const inProgress = { ...ISSUE, fields: { ...ISSUE.fields, status: { name: 'In Progress' } } };
  assert.equal(isWorkable({ issue: inProgress, config: cfg }).workable, true);
  const foreign = { ...inProgress, fields: { ...inProgress.fields, parent: { key: 'TARS-9999' } } };
  assert.equal(isWorkable({ issue: foreign, config: cfg }).workable, false);
});
