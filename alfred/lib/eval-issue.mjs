// eval-issue — project a fixture manifest onto a GitHub issue body.
//
// SANDBOX.md §6: `manifest.json` is the only source of truth for ticket text and
// the issue is a projection of it, so drift is impossible — drift gets
// overwritten. Everything here is pure: deciding what to do is separated from
// doing it, which is what makes the sync testable without a network call.
//
// What must NOT be projected: the manifest also declares the planted traps and
// the measured ground truth. The issue is what an arm reads. Copying the whole
// manifest would hand over the answer key.

const AC_HEADING = '## Acceptance criteria';

export function issueTitle(manifest) {
  return manifest.eval_issue.title;
}

export function issueBody(manifest) {
  const { ticket } = manifest;
  const criteria = ticket.acceptance_criteria.map((ac) => `- [ ] ${ac.text}`);

  return [
    ticket.body,
    '',
    AC_HEADING,
    '',
    ...criteria,
    '',
    '---',
    '',
    `_Synthetic evaluation ticket ${ticket.id}, generated from \`${manifest.slug}/manifest.json\`.`,
    'Hand edits to this issue are overwritten on the next sync — change the manifest instead._',
    '',
  ].join('\n');
}

// Decide the single action to take. Returned before anything is executed so a
// caller can print it, gate on it, or dry-run it.
export function planSync({ manifest, existing }) {
  const title = issueTitle(manifest);
  const body = issueBody(manifest);

  if (!existing) return { action: 'create', title, body };

  // Reopening comes first: a closed issue with correct text still can't be
  // worked, and creating a second one would leave two eval issues for one
  // fixture.
  if (existing.state && existing.state.toUpperCase() === 'CLOSED') {
    return { action: 'reopen', number: existing.number, title, body };
  }

  const fields = [];
  if (existing.title !== title) fields.push('title');
  if (!bodiesMatch(existing.body, body)) fields.push('body');

  if (fields.length === 0) return { action: 'noop', number: existing.number };
  return { action: 'edit', number: existing.number, title, body, fields };
}

// GitHub round-trips bodies with CRLF and may append a trailing newline. Those
// are not drift. Anything else is — including whitespace inside a line, which
// could change what an arm reads.
function normalize(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

function bodiesMatch(a, b) {
  return normalize(a) === normalize(b);
}

// The gate that aborts the experiment. A fetched body that disagrees with the
// manifest means the two arms would be reading different tickets, which is how
// experiment 1's fixture got contaminated. A missing issue is a failure, not a
// vacuous pass.
export function verifyBody({ manifest, fetched }) {
  if (!fetched || fetched.body == null) {
    return { ok: false, detail: 'no eval issue body to verify against the manifest' };
  }
  if (!bodiesMatch(fetched.body, issueBody(manifest))) {
    return {
      ok: false,
      detail:
        'the fetched issue body does not match the manifest projection. ' +
        'Re-run sync-eval-issue before starting an arm; do not measure two arms ' +
        'against different tickets.',
    };
  }
  return { ok: true };
}
