// jira — a ticket out of the Atlassian MCP, without trusting the model that fetched it.
//
// WHY AN MCP AND NOT AN API TOKEN. The operator cannot issue Jira API keys, and MEASURED
// 2026-08-01 none is needed: `claude mcp list` reports atlassian ✔ Connected from a bare tool
// shell, and a headless `claude -p` spawn called `mcp__atlassian__getJiraIssue` and returned a
// real summary with no interactive auth. The OAuth credential is already on disk, already scoped,
// and not ours to copy. A second credential would be a second thing to leak.
//
// THE TRUST BOUNDARY, which is the whole reason this file is not four lines. Alfred spawns
// `claude` to reach the MCP, so a MODEL sits between the issue and us. It must not be allowed to
// paraphrase: these tickets' acceptance criteria end in shell commands — `grep -q "^## Client
// Routes" docs/modules/hasher.md && for p in /hasher; do ...` — and lib/gate.mjs executes them
// byte-for-byte. A normalised quote or a dropped `$` yields a check that fails for a reason no
// worker caused, or one that passes because it no longer checks anything. So the payload is read
// from the session TRANSCRIPT's `tool_result` (the bytes the MCP returned) and the model's prose
// is discarded. `extractPayload` is where that is enforced; nothing else here reads `result`.
//
// WHY THERE IS NO ADF CONVERTER. There was going to be one, and the fixture for it was written
// before it was measured away. The MCP renders markdown SERVER-SIDE on request, and the real
// TARS-1353 description came back as markdown with `## Acceptance Criteria`, `*` items, and every
// verify command intact in backticks — which the EXISTING `extractAcceptanceCriteria` parses
// unchanged (5 criteria, `problem: null`). A converter would have been a second parser of the same
// tickets, free to disagree with the tested one about what a criterion is.
//
// READ-ONLY BY CONSTRUCTION. The fetch is allowlisted to `get`/`search` tools. It is trusted
// relative to the worker, but a ticket body is untrusted input and it reaches a model here: if
// this spawn could call `editJiraIssue`, an injecting body would have a path to rewriting the
// acceptance criteria the gate is about to read. The worker gets the mirror image — bare
// `--strict-mcp-config` with no config at all, so no atlassian tool exists for it (lib/router.mjs).

import { extractAcceptanceCriteria } from './item.mjs';

// One server, inline. Not a path on disk: a file would be a fourth thing to keep in sync with the
// operator's real MCP config, and this URL is the only field that matters. It carries no secret —
// the OAuth credential lives in claude's own store, which is why Alfred never handles it.
const ATLASSIAN_MCP_URL = 'https://mcp.atlassian.com/v1/mcp';

// `get` and `search` only. Enumerated rather than pattern-matched at the call site so that adding
// a tool is a visible edit here and the test that asserts read-only-ness has something to check.
export const FETCH_TOOLS = [
  'mcp__atlassian__getJiraIssue',
  'mcp__atlassian__searchJiraIssuesUsingJql',
];

export function mcpConfigJson() {
  return JSON.stringify({ mcpServers: { atlassian: { type: 'http', url: ATLASSIAN_MCP_URL } } });
}

// The argv for a single-issue fetch. An ARRAY, never a shell string — same rule as lib/router.mjs
// and lib/item.mjs's `gh` call, so an issue key can never be re-parsed by a shell.
//
// `responseContentFormat: "markdown"` is the load-bearing instruction, not a preference: it is
// what makes the shared extractor sufficient and this file converter-free.
export function fetchArgv({ config, key, model } = {}) {
  const kind = config?.source?.kind;
  if (kind !== 'jira') {
    throw new Error(
      `source.kind is ${JSON.stringify(kind ?? null)}, not "jira": refusing to build a jira fetch for a repo that does not track jira`,
    );
  }
  const text = typeof key === 'string' ? key.trim() : '';
  if (!text) {
    throw new Error('no issue key: refusing to build a jira fetch with no key to fetch');
  }
  const host = config.source.jira?.host ?? config.source.jira?.cloud;
  if (!host) {
    // Derived by loadConfig from the epic URLs the operator pasted. Absent means the config was
    // hand-built and skipped validation; guessing a site is the wrong-base defect in a new place.
    throw new Error('source.jira has no host: load the config through loadConfig so it is derived from the epic URLs');
  }

  // The prompt asks for the tool call and nothing else. It deliberately does NOT ask the model to
  // summarise, reformat, or "report" the ticket: whatever it says is thrown away, and inviting a
  // summary would spend output tokens on text no code reads.
  const prompt =
    `Call mcp__atlassian__getJiraIssue with cloudId "${host}", issueIdOrKey "${text}", ` +
    'fields ["summary","description","status","parent","labels","issuetype"], and ' +
    'responseContentFormat "markdown". Then reply with only the word DONE. ' +
    'Do not summarise, quote, or reformat the issue.';

  const argv = [
    '-p', prompt,
    '--strict-mcp-config',
    '--mcp-config', mcpConfigJson(),
    '--allowedTools', FETCH_TOOLS.join(','),
    '--permission-mode', 'bypassPermissions',
    '--output-format', 'json',
  ];
  if (model) argv.push('--model', model);
  return argv;
}

// ---------------------------------------------------------------------------
// The payload, recovered from the transcript rather than from the answer.
// ---------------------------------------------------------------------------

const toolResultsIn = (record) => {
  const content = record?.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b?.type === 'tool_result');
};

const textOf = (block) => {
  const c = block?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
  return '';
};

// Throws rather than returning a shell. Every failure here means "we do not have the ticket", and
// a lenient reader would hand back an issue with no criteria — zero criteria means zero objections
// from the gate, which is a PR that reads verified because nobody could check it.
export function extractPayload(transcriptText) {
  const text = typeof transcriptText === 'string' ? transcriptText : '';
  const found = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // A transcript is appended to by a live process, so a half-written final line is normal
      // rather than exceptional. Skipping is not leniency about the PAYLOAD: a truncated tail
      // must not lose a tool_result that arrived intact three lines earlier.
      continue;
    }
    for (const block of toolResultsIn(record)) found.push(block);
  }

  if (found.length === 0) {
    throw new Error(
      'no tool_result in the transcript: the fetch produced no MCP call, so there is no ticket — ' +
      'refusing rather than returning an issue with no acceptance criteria',
    );
  }

  // The LAST one. A retry leaves the failed attempt in the transcript too, and reading the first
  // would refuse a fetch that in fact succeeded.
  const raw = textOf(found[found.length - 1]);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`could not parse the tool_result as json: ${err.message}: ${raw.slice(0, 200)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('could not parse the tool_result: expected a json object');
  }

  // MEASURED: a single-issue getJiraIssue came back as `{"issues":{"nodes":[{...}]}}`, not as the
  // bare issue. Both shapes are accepted because the wrapper is the server's choice, not ours.
  const issue = Array.isArray(parsed.issues?.nodes) ? parsed.issues.nodes[0] : parsed;

  if (!issue || typeof issue !== 'object') {
    throw new Error('the tool_result carried no issue');
  }
  // An MCP error is a json object too, and it has no `key`. Checked before the shape test so the
  // message the operator sees is the server's own reason rather than "expected a key".
  if (issue.error || issue.errorMessages) {
    const reason = issue.error ?? JSON.stringify(issue.errorMessages);
    throw new Error(`the MCP returned an error instead of an issue: ${reason}`);
  }
  if (typeof issue.key !== 'string') {
    throw new Error('the tool_result carried no issue key');
  }
  return issue;
}

// ---------------------------------------------------------------------------
// The item. Same shape lib/run.mjs already consumes from the github path.
// ---------------------------------------------------------------------------

export function issueToItem({ issue, config } = {}) {
  if (!issue || typeof issue !== 'object') throw new Error('no issue to convert');
  const fields = issue.fields ?? {};
  const host = config?.source?.jira?.host ?? config?.source?.jira?.cloud ?? null;

  // The SHARED extractor, deliberately. Not a jira-specific reader: two parsers of the same
  // tickets would grade github and jira work against different rules, and nothing in the suite
  // would notice them diverging.
  const ac = extractAcceptanceCriteria(fields.description);

  return {
    id: issue.key,
    source: 'jira',
    title: typeof fields.summary === 'string' ? fields.summary : '',
    body: typeof fields.description === 'string' ? fields.description : '',
    url: host ? `https://${host}/browse/${issue.key}` : null,
    // `parent` is how a jira Epic link arrives on a company-managed project — measured on
    // TARS-1353, whose parent is TARS-1350. Null rather than a guess when absent: resolveBase
    // reads this, and a wrong epic picks a wrong base branch.
    epic: typeof fields.parent?.key === 'string' ? fields.parent.key : null,
    status: typeof fields.status?.name === 'string' ? fields.status.name : null,
    labels: Array.isArray(fields.labels) ? fields.labels : [],
    acceptance_criteria: ac.criteria,
    ac_problem: ac.problem,
    // The WHOLE payload, including fields nothing here reads. PLAN.md §2.1: harness-core kept a
    // one-line excerpt and no run there is replayable.
    raw: issue,
  };
}

// ---------------------------------------------------------------------------
// The poll's filter. Deterministic — no model decides what is workable.
// ---------------------------------------------------------------------------

export const BLOCKED_LABEL = 'alfred:blocked';

// Returns `{workable, reason}`. The reason is the whole diagnostic for a tick that did nothing,
// so it names the value that failed rather than the rule that rejected it.
export function isWorkable({ issue, config } = {}) {
  const fields = issue?.fields ?? {};
  const jira = config?.source?.jira ?? {};

  const label = config?.loop?.blocked_label ?? BLOCKED_LABEL;
  const labels = Array.isArray(fields.labels) ? fields.labels : [];
  if (labels.includes(label)) {
    // The blocked-item policy: comment, label, skip on later ticks. Without this the loop pays
    // full price to reach the same refusal every poll interval.
    return { workable: false, reason: `${issue?.key ?? 'the issue'} carries ${label}, so a previous tick already gave up on it` };
  }

  const epics = Array.isArray(jira.epic_keys) ? jira.epic_keys : [];
  if (epics.length > 0) {
    const epic = fields.parent?.key ?? null;
    if (!epic || !epics.includes(epic)) {
      return {
        workable: false,
        reason: `epic is ${epic ?? 'unset'}, and this config polls ${epics.join(', ')}`,
      };
    }
  }

  // ABSENT MEANS ANY, not none. `statuses` is optional in the schema, and a filter that rejected
  // everything when unset would be a poll that silently never works anything — the loop that
  // appears to patrol and does nothing.
  const statuses = Array.isArray(jira.statuses) ? jira.statuses : null;
  if (statuses) {
    const status = fields.status?.name ?? null;
    if (!status || !statuses.includes(status)) {
      return {
        workable: false,
        reason: `status is ${status ?? 'unset'}, and this config works ${statuses.join(', ')}`,
      };
    }
  }

  return { workable: true, reason: null };
}
