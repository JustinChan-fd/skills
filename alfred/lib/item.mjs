// item — what `/alfred {PROMPT}` is actually being asked to do.
//
// One argument comes in. It is either a reference to a ticket someone else wrote or a sentence
// the operator wrote, and those are different enough that guessing wrong is expensive in both
// directions: treating a prompt as a ticket fetches nothing and works on an empty body,
// treating a ticket as a prompt works on the URL text and never reads the issue.
//
// THE ONE THING THIS MODULE MUST NOT DO is fill in acceptance criteria. A criterion is not a
// note — it is a bar the run is judged against. Inventing one manufactures a bar nobody set, and
// then either fails a good run against it or (worse) passes a run for satisfying a requirement
// the ticket never made. A prompt therefore carries `acceptance_criteria: []` plus an
// `ac_problem` string saying so, because "none were given" and "none were found" are different
// facts and the record should distinguish them.
//
// THE ENFORCEMENT MOVED, THE RULE DID NOT. lib/gate.mjs used to raise `ac_unmapped` once per
// criterion; that join was deleted 2026-08-03 and no rule now grades criteria individually. The
// criteria still reach the worker's prompt and still set `graded_criteria`/`ungraded_reason` on
// the verdict — so a fabricated one is still a fabricated bar on the record, and is now HARDER
// to catch rather than easier, because nothing downstream tests it against a command.
//
// Like lib/blocked.mjs this is an ENVELOPE: it decides whether a work item
// could be resolved and whether the payload is readable. It does not judge whether the ticket
// is any good. That judgement is the worker's — the standing rule is that a false premise in a
// ticket is a finding, not an obstacle — and a module that pre-screened tickets would take that
// finding away from the place equipped to report it.
//
// UNTRUSTED CONTENT. An issue body is written by whoever opened the issue. The mitigation
// available at THIS layer is narrow and worth stating exactly, because overstating it is how a
// control gets trusted for something it does not do: the body cannot change what this module
// does. It cannot re-point the fetch, pick a different repository, or alter the ref, because
// every one of those is read from the caller's argument and the operator's config before the
// body exists, and `gh` is invoked with an argv array so no shell ever re-parses it. What the
// body CAN do is carry instructions to the model that later reads it. That is lib/prompt.mjs's
// problem and is not fully solved there either.

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { fetchArgv, extractPayload, issueToItem } from './jira.mjs';
import { transcriptPathFor } from './transcript.mjs';

const execFileAsync = promisify(execFile);

// PLAN.md §2.1 step 2 names the file. Exported so the test asserts on the same constant the
// writer uses rather than on a second copy of the string.
export const SOURCE_FILENAME = 'source.json';

const VIEW_FIELDS = 'number,title,body,state,labels,url,author,createdAt,updatedAt';

// The real `gh`, same shape as lib/eval-issue-sync.mjs's `realGh` and for the same reason: an
// argv array, never a shell string, so a ticket body containing backticks or `$(...)` cannot
// be reinterpreted by a shell.
export async function realGh(args) {
  const { stdout } = await execFileAsync('gh', args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

// The real jira fetch. Spawns `claude -p` to reach the Atlassian MCP, then reads the payload out of
// the session TRANSCRIPT rather than out of the model's answer.
//
// WHY THE TRANSCRIPT. The criteria on these tickets end in shell commands that lib/gate.mjs runs
// byte-for-byte. A model relaying a payload through its own output tokens is free to normalise a
// quote or drop a `$`, and the result is a check that fails for a reason no worker caused — or one
// that passes because it no longer checks anything. `extractPayload` reads the `tool_result`, which
// is the bytes the MCP returned. The model's own text is discarded; the prompt asks it to say only
// `DONE` precisely so there is nothing there worth reading.
//
// Injected in tests, like `realGh`, so nothing in the suite touches the network.
export async function realJiraFetch({ config, key, model, cwd = tmpdir() } = {}) {
  const argv = fetchArgv({ config, key, model });
  // `cwd` decides where the transcript lands (transcriptPathFor mirrors claude's own projects-dir
  // layout), and it defaults OUTSIDE the repository. A transcript written under the repo root would
  // be counted as delivered work by the gate's working-tree diff — the same reason the run dir is
  // outside the repo.
  const { stdout } = await execFileAsync('claude', argv, { cwd, maxBuffer: 16 * 1024 * 1024 });

  let meta;
  try {
    meta = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`could not parse the fetch envelope as json: ${err.message}`);
  }
  if (!meta?.session_id) {
    throw new Error('the fetch produced no session_id, so its transcript cannot be located');
  }

  const path = transcriptPathFor({ cwd, sessionId: meta.session_id });
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`could not read the fetch transcript at ${path}: ${err.message}`);
  }
  return extractPayload(text);
}

// A bare URL, `owner/repo#N`, or `#N` — and nothing else. Anchored at both ends with only
// surrounding whitespace tolerated, because the anchoring IS the classification: a URL with
// prose around it is a prompt that cites an issue, and the prose carries instructions the
// issue does not. Routing that to the issue would silently discard the operator's actual
// request, which is the failure mode that looks most like success.
const URL_ONLY = /^\s*https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\/?\s*$/;
const SLUG_ONLY = /^\s*([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)#(\d+)\s*$/;
const NUMBER_ONLY = /^\s*#(\d+)\s*$/;

// Is this ticket-SHAPED? Answerable from the string alone, with no config, which is what makes
// it usable before the config's source kind has been consulted. Without this the diagnosis
// order inverts: a jira-configured repo handed `#4` would be refused for "no github owner
// declared" — true, unhelpful, and pointing at the config line the operator should NOT change.
const looksLikeIssueRef = (text) =>
  URL_ONLY.test(text) || SLUG_ONLY.test(text) || NUMBER_ONLY.test(text);

export function classifyRef(ref, { config } = {}) {
  const text = typeof ref === 'string' ? ref : '';

  const url = URL_ONLY.exec(text);
  if (url) return { kind: 'github', owner: url[1], repo: url[2], number: Number(url[3]) };

  const slug = SLUG_ONLY.exec(text);
  if (slug) return { kind: 'github', owner: slug[1], repo: slug[2], number: Number(slug[3]) };

  const bare = NUMBER_ONLY.exec(text);
  if (bare) {
    // A bare `#N` has no repository in it, so the config must supply one. Throwing here rather
    // than defaulting follows loadConfig's rule: a guessed repository is the TARS-1271
    // wrong-base defect in a different place, and it is silent.
    const gh = config?.source?.github ?? {};
    if (!gh.owner || !gh.repo) {
      throw new Error(
        `ref "${text.trim()}" names no repository and config declares no source.github.owner/repo`,
      );
    }
    return { kind: 'github', owner: gh.owner, repo: gh.repo, number: Number(bare[1]) };
  }

  return { kind: 'prompt', owner: null, repo: null, number: null };
}

// Criteria come from a heading that DECLARES REQUIREMENTS. Harvesting every checkbox in the
// body would promote an author's scratch task list to a graded bar — the same fabrication the
// prompt path refuses, arrived at by being helpful.
//
// WIDENED FOR B1.1, AND THE MEASUREMENT THAT FORCED IT. This was a single pattern matching a
// literal "acceptance criteria". On jarvis GitHub issue #7 the six criteria live under
// `## Details`, so the real run recorded `ac_count: 0`, `graded_criteria: 0`,
// `ungraded_reason: "none were declared"` — the gate's AC-grading half was structurally blind
// while the worker had, unprompted, built a thorough 7-item ac-map by hand. That run scored FAIL
// only because of an unrelated false positive (`evidence_weakened`, fixed in A3). Had that not
// fired, a run grading ZERO criteria would have passed silently. A regex that does exactly what
// it says and still leaves the grader blind on a real ticket is the defect.
//
// AN ALLOWLIST, NOT A LOOSENING. Widening trades false negatives for false positives, and a
// false positive here is worse in kind: grading `## Out of scope` would fail every run for not
// doing work the ticket says not to do, and grading `## Notes` would demand a verification
// command for an advisory suggestion. So the set is enumerated and every heading outside it
// still declares nothing — `test/item.test.mjs`'s "a non-criteria heading still declares
// nothing" is the falsifier that keeps this honest.
const AC_HEADINGS = [
  /^acceptance\s+criteri(?:a|on)$/,
  /^acceptance$/,
  // The heading the measured defect was hiding under.
  /^details?$/,
  /^requirements?$/,
  /^scope$/,
  /^what\s+to\s+do$/,
  /^definitions?\s+of\s+done$/,
  /^dod$/,
  /^tasks?$/,
  /^checklists?$/,
];
const HEADING_LINE = /^\s{0,3}#{1,6}\s*(.+?)\s*$/;
const ANY_HEADING = /^\s{0,3}#{1,6}\s+/;
// `- [ ] x`, `- [x] x`, `- x`, `* x`, `+ x`, `1. x`.
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.*)$/;

// A SELF-LABELLED criterion line: `AC1: ...`, `AC2 - ...`, `AC3. ...`, optionally bulleted.
// This is the ONE fallback for a body with no recognised heading, and it is different in kind
// from a bare checkbox: the author wrote the letters A and C and a number, so nothing is being
// inferred about their intent. Anchored at line start and requiring a separator, because a
// substring match would harvest `MAC1:` and prose that mentions AC1 mid-sentence.
const AC_PREFIXED = /^\s*(?:[-*+]\s*)?AC\s?\d+\s*[:.)\-–]\s*(.+?)\s*$/i;

function isAcHeading(line) {
  const heading = HEADING_LINE.exec(line);
  if (!heading) return false;
  // Trailing colons and surrounding emphasis are formatting, not meaning: `**Details:**` is the
  // same heading as `Details`. Normalised before matching so the allowlist stays readable.
  const label = heading[1].toLowerCase().replace(/[*_`]/g, '').replace(/\s*:+\s*$/, '').trim();
  return AC_HEADINGS.some((pattern) => pattern.test(label));
}

// The list items directly under one heading, stopping at the next heading of ANY level.
// Without that stop the reader runs to the end of the body and swallows whatever list comes
// next — a `## Notes` checklist reads exactly like a criterion once the heading is gone.
function itemsUnder(lines, start) {
  const texts = [];
  for (const line of lines.slice(start + 1)) {
    if (ANY_HEADING.test(line)) break;
    const item = LIST_ITEM.exec(line);
    if (!item) continue;
    const value = item[1].trim();
    // An empty `- [ ]` is an unfilled template row, not a requirement. Passing it through
    // would make the gate demand a verification command for nothing.
    if (value) texts.push(value);
  }
  return texts;
}

export function extractAcceptanceCriteria(body) {
  const text = typeof body === 'string' ? body : '';
  if (!text.trim()) {
    return { criteria: [], problem: 'no body, so no acceptance criteria were declared' };
  }

  const lines = text.split(/\r?\n/);

  // EVERY candidate heading, not the first. A ticket whose `## Summary` is prose and whose
  // `## Details` carries the list would otherwise read Summary's zero items and report
  // "heading present but lists no criteria" — a different wrong answer, equally silent. The
  // real jarvis#7 body has exactly that shape, which is why this is a loop.
  const candidates = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (isAcHeading(lines[i])) candidates.push(i);
  }

  let texts = [];
  for (const start of candidates) {
    texts = itemsUnder(lines, start);
    if (texts.length > 0) break;
  }

  // THE FALLBACK, and it is deliberately narrow. Only reached when no recognised heading
  // produced items, and it only accepts SELF-LABELLED `AC\d` lines. The plan for this step also
  // asked for bare `- [ ]` lines to count when no heading matches; that is NOT built, because
  // it inverts this module's founding falsifier — a headless checkbox list is an author's
  // scratch list, and promoting it mints a criterion the gate then demands a command for. A
  // fabricated bar is worse than no bar. Declining is recorded here rather than silently.
  if (texts.length === 0) {
    for (const line of lines) {
      const labelled = AC_PREFIXED.exec(line);
      if (labelled && labelled[1].trim()) texts.push(labelled[1].trim());
    }
  }

  if (texts.length === 0) {
    return {
      criteria: [],
      problem:
        candidates.length > 0
          ? 'an acceptance-criteria heading is present but lists no criteria'
          : 'no heading declares acceptance criteria, so none were read from the body',
    };
  }

  // AC1..ACn in body order, RENUMBERED rather than carrying the author's own numbering. The
  // gate's ac_map is keyed by these ids, so `AC7:`/`AC3:` in a body must not mint AC7 and AC3 —
  // the numbering is an interface, not a display detail.
  return { criteria: texts.map((t, i) => ({ id: `AC${i + 1}`, text: t })), problem: null };
}

// The raw payload on disk, before anything reads it. PLAN.md §2.1 calls this non-negotiable and
// a bug fix rather than a feature: harness-core persisted a one-line `source.excerpt` and
// nothing else, so no run there is replayable. The whole payload is kept, including fields this
// module never reads, because a record trimmed to today's code cannot answer tomorrow's
// question.
export function writeSource({ runDir, ref, item }) {
  mkdirSync(runDir, { recursive: true });
  const record = {
    kind: 'alfred-source',
    version: 1,
    ref: typeof ref === 'string' ? ref : null,
    source: item.source,
    id: item.id,
    raw: item.raw ?? null,
  };
  const path = join(runDir, SOURCE_FILENAME);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

// Returns `{ok, item, error}` and does not throw. A ref that cannot be resolved is a RESULT —
// "the operator asked for something that isn't there" — and throwing would turn that reading
// into a crash inside whatever is scoring or looping over the run. Same reasoning as
// readMarker/readAcMap.
// A jira key, anchored. `TARS-1353` and nothing else — the project part is compared against the
// config below rather than accepted from the string, so a jira-shaped ref for another product is
// refused instead of fetched.
const JIRA_KEY_ONLY = /^\s*([A-Z][A-Z0-9_]*)-(\d+)\s*$/;

// A jira BROWSE URL, which is the ref an operator actually holds: it is what the Jira UI puts on
// the clipboard, and the github path has accepted an issue URL from the start. Refusing it meant
// the one shape you have in hand was the one shape that exited 2, so every invocation had to be
// retyped into a bare key by hand.
//
// STILL ANCHORED, and still a key alone. A browse URL carries exactly one issue and no room for a
// qualifier, so accepting it does not reopen the scope-expansion hole JIRA_KEY_ONLY closes —
// `.../browse/TARS-1353 but only the docs part` is not a URL and is still refused. The `?query` is
// dropped because a URL copied from a focused comment or a board carries one, and the scheme is
// optional because a pasted host-only URL is the same ticket.
//
// THE HOST IS CAPTURED, NOT IGNORED, and checked against the config below. A URL from another
// Atlassian site is either a typo or a different product's ticket; fetching it would work this
// repository's tree against a foreign specification.
const JIRA_BROWSE_URL =
  /^\s*(?:https?:\/\/)?([a-z0-9.-]+\.atlassian\.net)\/browse\/([A-Z][A-Z0-9_]*)-(\d+)(?:[?#]\S*)?\s*$/i;

export async function resolveItem({ ref, config, runDir, gh = realGh, jiraFetch = realJiraFetch }) {
  const text = typeof ref === 'string' ? ref.trim() : '';
  if (!text) return { ok: false, item: null, error: 'nothing to work on: the ref is empty' };
  if (!config) return { ok: false, item: null, error: 'no config: cannot resolve a work item against an unstated repository' };

  // ONE PLACE ANSWERS "IS THIS SOURCE SUPPORTED", and it answers before the ref's shape is
  // resolved. `github` is the only implemented kind, so under any other kind there is no ref
  // that CAN be resolved — which makes this a property of the config, not of the string.
  //
  // WHY THE BLANKET REFUSAL RATHER THAN A SHAPE CHECK. Until this, only github-SHAPED refs were
  // caught here. A jira key fell past `looksLikeIssueRef` (which knows three github shapes and
  // nothing else) into the prompt path, and MEASURED, `resolveItem({ref:'TARS-1351', config:
  // <a jira config that validates>})` returned `ok: true`, `source: "prompt"`,
  // `acceptance_criteria: []`. The run then spends money and the gate has nothing to grade: its
  // verdict is a conjunction over findings, so zero criteria means zero objections means a PR
  // that reads verified because nobody could check it. A config that declares an unimplemented
  // source must refuse EVERY ref, not silently reinterpret the operator's ticket key as prose.
  //
  // The message still splits on shape, because the two operators need different next steps: one
  // pasted a github URL into a jira-tracked repo, the other is waiting on a source that is not
  // built. Neither should be told to add a `source.github` block to a config that is correct.
  const kind = config.source?.kind;

  // JIRA. Implemented via lib/jira.mjs — an MCP fetch through a `claude -p` spawn, whose payload is
  // read from the session transcript rather than from the model's prose. See that file for why.
  //
  // THE REFUSALS BELOW ARE NARROWER THAN THE ONE THEY REPLACED but protect the same thing. The old
  // blanket refusal existed because MEASURED, `TARS-1351` fell past `looksLikeIssueRef` (which
  // knows three github shapes and nothing else) into the prompt path and returned `ok: true`,
  // `source: "prompt"`, `acceptance_criteria: []` — a run that spends and cannot be graded, since
  // the gate's verdict is a conjunction over findings and no criteria means nothing objected. Only
  // an anchored jira key now escapes that refusal, and it escapes into a real fetch.
  if (kind === 'jira') {
    // A BROWSE URL FIRST, and its host is checked before its key. A foreign site is refused here
    // rather than falling through to the project check, because the project can match on a site
    // that is not ours — `TARS-1353` may well exist on someone else's Atlassian tenant, and the
    // diagnostic an operator needs names the host they pasted, not the project.
    const url = JIRA_BROWSE_URL.exec(text);
    let key = null;
    if (url) {
      const host = config.source.jira?.host ?? config.source.jira?.cloud ?? null;
      if (host && url[1].toLowerCase() !== String(host).toLowerCase()) {
        return {
          ok: false,
          item: null,
          error: `ref "${text}" is on ${url[1]} but this config's jira host is ${host}; ` +
            'refusing to resolve a ticket from a different Atlassian site',
        };
      }
      key = [url[0], url[2], url[3]];
    } else {
      key = JIRA_KEY_ONLY.exec(text);
    }
    if (!key) {
      const detail = looksLikeIssueRef(text)
        ? `ref "${text}" is a github issue reference but config declares source.kind "jira"`
        : `ref "${text}" is not a jira issue key like TARS-1353, and config declares source.kind ` +
          `"jira" — refusing rather than treating it as a prompt with no acceptance criteria, ` +
          `which would spend on a run the gate cannot grade`;
      return { ok: false, item: null, error: detail };
    }

    // The PROJECT is checked against the config, not taken from the ref. `PROJ-1` is jira-shaped
    // and belongs to someone else's product; fetching it would work this repository's tree against
    // a foreign ticket, and resolveBase would pick a base from a rule that never matched. Checked
    // BEFORE the fetch so a foreign key costs nothing.
    const project = config.source.jira?.project ?? null;
    if (project && key[1] !== project) {
      return {
        ok: false,
        item: null,
        error: `ref "${text}" is in project ${key[1]} but config declares project ${project}; ` +
          'refusing to resolve a ticket outside the configured project',
      };
    }

    const wanted = `${key[1]}-${key[2]}`;
    let issue;
    try {
      issue = await jiraFetch({ config, key: wanted });
    } catch (err) {
      // A failed fetch is a refusal, not a thin item — same rule as the gh path. Handing back a
      // shell with an empty body would put a worker to work on a ticket nobody read.
      return { ok: false, item: null, error: `could not fetch ${wanted}: ${err.message}` };
    }

    // THE FETCH IS MODEL-MEDIATED, so the key that came back is verified against the key that was
    // asked for. Trusting the ref while holding another ticket's body would grade the run against
    // criteria for an issue the operator never named.
    if (issue?.key !== wanted) {
      return {
        ok: false,
        item: null,
        error: `asked for ${wanted} but the fetch returned ${issue?.key ?? 'no key'}; refusing to ` +
          'grade a run against another ticket’s acceptance criteria',
      };
    }

    let item;
    try {
      item = issueToItem({ issue, config });
    } catch (err) {
      return { ok: false, item: null, error: `could not read ${wanted}: ${err.message}` };
    }

    try {
      writeSource({ runDir, ref: text, item });
    } catch (err) {
      return { ok: false, item: null, error: `could not write ${SOURCE_FILENAME}: ${err.message}` };
    }
    return { ok: true, item, error: null };
  }

  if (kind !== 'github') {
    const detail = looksLikeIssueRef(text)
      ? `ref "${text}" is a github issue reference but config declares source.kind "${kind}"`
      : `config declares source.kind "${kind}", which is not yet implemented, so no ref can be ` +
        `resolved against it — refusing rather than treating "${text}" as a prompt with no ` +
        `acceptance criteria, which would spend on a run the gate cannot grade`;
    return { ok: false, item: null, error: detail };
  }

  let classified;
  try {
    classified = classifyRef(text, { config });
  } catch (err) {
    return { ok: false, item: null, error: err.message };
  }

  if (classified.kind === 'prompt') {
    const item = {
      id: 'prompt',
      source: 'prompt',
      title: text,
      body: text,
      url: null,
      acceptance_criteria: [],
      // Said out loud rather than left as an empty array to be read however the reader likes.
      ac_problem: 'prompt-sourced work item: no acceptance criteria were given, and none were invented',
      raw: null,
    };
    try {
      writeSource({ runDir, ref: text, item });
    } catch (err) {
      return { ok: false, item: null, error: `could not write ${SOURCE_FILENAME}: ${err.message}` };
    }
    return { ok: true, item, error: null };
  }

  // `source.kind` was checked above, before the owner was resolved and before the ref's shape
  // was classified, so by here the config is known to declare github. There is no second check:
  // two places answering "is this source supported" is how they come to disagree, and the
  // disagreement showed up exactly as predicted — the shape-gated version let a jira config
  // through to the prompt path.

  // The config's declared repository is the only one in scope. An operator who genuinely
  // tracks issues elsewhere says so in the config; a pasted URL must not be able to point the
  // run at another repository's ticket while the worker edits this repository's tree.
  const declared = config.source?.github ?? {};
  const wanted = `${classified.owner}/${classified.repo}`;
  const allowed = declared.owner && declared.repo ? `${declared.owner}/${declared.repo}` : null;
  if (!allowed) {
    return { ok: false, item: null, error: 'config declares no source.github.owner/repo, so no issue ref is in scope' };
  }
  if (wanted.toLowerCase() !== allowed.toLowerCase()) {
    return {
      ok: false,
      item: null,
      error: `ref names ${wanted} but config declares ${allowed}; refusing to resolve a ticket outside the configured repository`,
    };
  }

  let stdout;
  try {
    stdout = await gh([
      'issue', 'view', String(classified.number),
      '--repo', allowed,
      '--json', VIEW_FIELDS,
    ]);
  } catch (err) {
    // A failed fetch is a refusal, not a thin item. Handing back a shell with an empty body
    // would put a worker to work on a ticket nobody read.
    return { ok: false, item: null, error: `could not fetch ${wanted}#${classified.number}: ${err.message}` };
  }

  let raw;
  try {
    raw = JSON.parse(stdout);
  } catch (err) {
    return { ok: false, item: null, error: `could not parse the issue payload as json: ${err.message}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, item: null, error: 'could not parse the issue payload: expected a json object' };
  }

  const ac = extractAcceptanceCriteria(raw.body);
  const item = {
    id: `${allowed}#${classified.number}`,
    source: 'github',
    title: typeof raw.title === 'string' ? raw.title : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    url: typeof raw.url === 'string' ? raw.url : null,
    acceptance_criteria: ac.criteria,
    ac_problem: ac.problem,
    raw,
  };

  try {
    writeSource({ runDir, ref: text, item });
  } catch (err) {
    // The payload is in memory and the guarantee is that it is on DISK, so a write failure
    // fails the resolution. Returning ok with a note would mean the run is not replayable
    // while the record says it is.
    return { ok: false, item: null, error: `could not write ${SOURCE_FILENAME}: ${err.message}` };
  }

  return { ok: true, item, error: null };
}
