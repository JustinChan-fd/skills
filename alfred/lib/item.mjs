// item — what `/alfred {PROMPT}` is actually being asked to do.
//
// One argument comes in. It is either a reference to a ticket someone else wrote or a sentence
// the operator wrote, and those are different enough that guessing wrong is expensive in both
// directions: treating a prompt as a ticket fetches nothing and works on an empty body,
// treating a ticket as a prompt works on the URL text and never reads the issue.
//
// THE ONE THING THIS MODULE MUST NOT DO is fill in acceptance criteria. lib/gate.mjs raises
// `ac_unmapped` once per criterion, so a criterion is not a note — it is a bar the run is
// graded against. Inventing one manufactures a bar nobody set, and then either fails a good
// run against it or (worse) passes a run for satisfying a requirement the ticket never made.
// A prompt therefore carries `acceptance_criteria: []` plus an `ac_problem` string saying so,
// because "none were given" and "none were found" are different facts and the record should
// distinguish them.
//
// Like lib/blocked.mjs and lib/acmap.mjs this is an ENVELOPE: it decides whether a work item
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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

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

// Criteria come from a heading that SAYS acceptance criteria. Harvesting every checkbox in the
// body would promote an author's scratch task list to a graded bar — the same fabrication the
// prompt path refuses, arrived at by being helpful.
const AC_HEADING = /^\s{0,3}#{1,6}\s*acceptance\s+criteri(?:a|on)\s*:?\s*$/i;
const ANY_HEADING = /^\s{0,3}#{1,6}\s+/;
// `- [ ] x`, `- [x] x`, `- x`, `* x`, `+ x`, `1. x`.
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.*)$/;

export function extractAcceptanceCriteria(body) {
  const text = typeof body === 'string' ? body : '';
  if (!text.trim()) {
    return { criteria: [], problem: 'no body, so no acceptance criteria were declared' };
  }

  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => AC_HEADING.test(line));
  if (start === -1) {
    return {
      criteria: [],
      problem: 'no heading declares acceptance criteria, so none were read from the body',
    };
  }

  const texts = [];
  for (const line of lines.slice(start + 1)) {
    // Stop at the next heading of ANY level. Without this the reader runs to the end of the
    // body and swallows whatever list happens to come next — a `## Notes` checklist reads
    // exactly like a criterion once the heading is gone.
    if (ANY_HEADING.test(line)) break;
    const item = LIST_ITEM.exec(line);
    if (!item) continue;
    const value = item[1].trim();
    // An empty `- [ ]` is an unfilled template row, not a requirement. Passing it through
    // would make the gate demand a verification command for nothing.
    if (value) texts.push(value);
  }

  if (texts.length === 0) {
    return {
      criteria: [],
      problem: 'an acceptance-criteria heading is present but lists no criteria',
    };
  }

  // AC1..ACn in body order. The gate's ac_map is keyed by these ids, so the numbering is an
  // interface and not a display detail.
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
export async function resolveItem({ ref, config, runDir, gh = realGh }) {
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
