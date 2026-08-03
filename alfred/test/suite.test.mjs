// suite — the version stamp on the rubric+fixture pair, and the tripwire that keeps
// the stamp honest.
//
// WHY THIS EXISTS. `docs/eval-readiness/2026-07-30-scorecard.md` §4 scored
// "suite versioned; results tagged" as FAIL: `LC_ALL=C grep -n "suite_version"` over
// both manifests exited 1, and `EXPERIMENT-2-RESULTS.md` carries no model id, no config
// sha, and no run date. Arm A's $0.617 was measured on sonnet-4-6, the seats moved to
// sonnet-5 the same day, and nothing in the results file records which model produced
// which number. Arm C's result will be the first artifact anyone diffs a later run
// against, so the stamp has to exist before that run, not after it.
//
// WHY A DECLARED STRING IS NOT ENOUGH. A hand-maintained version is exactly the shape
// that has already drifted three times in this project's four days (scorecard §9): a
// doc asserting its own freshness is what made the staleness invisible. So the declared
// version is paired with a DIGEST over the member files, and one test below fails when
// a member moves without a bump. The declared string is what gets stamped on a result
// — readable, diffable. The digest is the only reason to believe the string.
//
// THE DIGEST IS DELIBERATELY OVER-SENSITIVE. It covers whole file bytes, so a
// comment-only edit to `score.mjs` bumps it even though no verdict changed. That is the
// intended bias, and it is the project's standing asymmetry applied to comparability: a
// false bump costs one line in a config file, a missed bump silently rebases the
// history and makes a trend line lie. Same shape as "a zero cost is plottable and
// false, which is worse than a hole." Do not "improve" this by hashing only the code.
//
// WHAT IS NOT A MEMBER, and why the exclusion is load-bearing: `lib/gate.mjs`. The gate
// is the system under test, not the thing doing the testing. If every Alfred
// improvement bumped the suite version, no before/after comparison could ever be made
// on a constant suite — the version would move with the subject, which is precisely the
// failure `752f3b0` committed by moving the model and 278 lines of its own tests in one
// commit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  SUITE_MEMBERS,
  loadSuiteConfig,
  extractSection,
  readMembers,
  digestOf,
  computeSuiteDigest,
  verifySuiteDigest,
  suiteStamp,
  stampProblems,
} from '../lib/suite.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// A stamp's `at` is always the record's own timestamp, never `now()` — the same rule
// `priceTokens` follows, for the same reason: a function that consults the wall clock
// re-prices the same historical record differently tomorrow.
const AT = '2026-07-30T18:00:00.000Z';

test('the suite version and digest are declared in config/suite.json', () => {
  const cfg = loadSuiteConfig();
  // Follows prices.json's convention rather than inventing a second one.
  assert.match(cfg.version, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  assert.match(cfg.digest, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(cfg.members) && cfg.members.length > 0);
});

test('the declared digest matches the members on disk — editing a member without bumping fails here', () => {
  const check = verifySuiteDigest();
  assert.equal(
    check.drifted,
    false,
    `config/suite.json declares digest ${check.declared} but the members on disk hash to ` +
      `${check.computed}. A member changed and the version was not bumped. Bump ` +
      `config/suite.json's version AND digest, or revert the member.`,
  );
  assert.equal(check.ok, true);
});

test('a missing rubric anchor throws rather than hashing an empty section', () => {
  // The green-and-blind shape, which this project has now hit six times. If a heading
  // is renamed and extraction quietly returns '', the digest stays stable and the
  // tripwire reports clean while covering nothing.
  const doc = '# Doc\n\n## 2. Rubric\n\n### Axis 9 — renamed\n\nbody\n';
  assert.throws(
    () => extractSection(doc, 'Axis 1 — did the arm handle the ambiguity?'),
    /not found/i,
  );
  // And the happy path returns the body, not just the heading.
  const got = extractSection(doc, 'Axis 9 — renamed');
  assert.match(got, /body/);
});

test('a section stops at the next heading of the same or higher level', () => {
  const doc = ['## A', 'a-body', '### A1', 'a1-body', '## B', 'b-body', ''].join('\n');
  const a1 = extractSection(doc, 'A1');
  assert.match(a1, /a1-body/);
  assert.doesNotMatch(a1, /b-body/);
  assert.doesNotMatch(a1, /a-body/);

  const a = extractSection(doc, 'A');
  // A `###` nested under `##` belongs to it; the next `##` does not.
  assert.match(a, /a1-body/);
  assert.doesNotMatch(a, /b-body/);
});

test('the digest changes when any single member changes', () => {
  const base = [
    { path: 'x', section: null, bytes: 'one' },
    { path: 'y', section: null, bytes: 'two' },
  ];
  const d0 = digestOf(base);

  for (let i = 0; i < base.length; i += 1) {
    const altered = base.map((m, j) => (i === j ? { ...m, bytes: `${m.bytes} edited` } : m));
    assert.notEqual(digestOf(altered), d0, `changing member ${base[i].path} did not move the digest`);
  }

  // A path rename is a change too: the same bytes under a different name is a
  // different suite, because the stamp is a claim about which files were read.
  assert.notEqual(digestOf([{ ...base[0], path: 'x2' }, base[1]]), d0);
});

test('the digest is a pure function of member content, not of read order', () => {
  const a = { path: 'a', section: null, bytes: 'aa' };
  const b = { path: 'b', section: 'S', bytes: 'bb' };
  // Order is normalized inside, so a directory listing that comes back shuffled
  // cannot produce two digests for one suite.
  assert.equal(digestOf([a, b]), digestOf([b, a]));
  // Same call twice, same answer.
  assert.equal(digestOf([a, b]), digestOf([a, b]));
});

test('the gate is deliberately not a suite member — the system under test cannot version its own rubric', () => {
  const paths = SUITE_MEMBERS.map((m) => m.path);
  assert.ok(!paths.includes('lib/gate.mjs'), 'gate.mjs must not be a suite member');
  // The members that must be there, because they are what a score means.
  assert.ok(paths.includes('lib/score.mjs'));
  assert.ok(paths.includes('fixtures/sandbox-a/manifest.json'));
  assert.ok(paths.includes('fixtures/sandbox-b/manifest.json'));
  assert.ok(paths.includes('docs/EXPERIMENT-2.md'));
  // And the exclusion is documented in the config, not just in a test.
  assert.match(loadSuiteConfig().not_members.gate, /under test/i);
});

test("arm C's pass bar is a suite member — the bar that decides a score cannot be silently editable", () => {
  // FOUND BEFORE THE RUN, not after. §4.1 holds the sentence that decides whether arm C
  // passed ("declined AND filed a blocked marker with a closed-set reason code"). It was
  // NOT a member, so that sentence could be reworded after seeing the result with the
  // digest unchanged and every test green — the exact failure the suite stamp exists to
  // prevent, sitting on the one section it most needed to cover.
  //
  // The three sections already covered are the axis scales and the prediction. A pass bar
  // is the same kind of object and belongs with them.
  const armC = SUITE_MEMBERS.filter((m) => /pass bar/i.test(m.section ?? ''));
  assert.equal(armC.length, 1, "§4.1's pass bar must be exactly one suite member");
  assert.equal(armC[0].path, 'docs/EXPERIMENT-2.md');

  // And the section must actually be extractable, since extractSection throws on a missing
  // anchor and readMembers is where that would surface.
  const bytes = readMembers().find((m) => m.section === armC[0].section)?.bytes ?? '';
  assert.ok(bytes.length > 0);
  // The three marker states are what the bar rests on. A restatement that dropped the
  // absent/invalid distinction would leave a reasoned decline and a total miss recording
  // identically, which is the inference sandbox-b's manifest pre-registers.
  assert.match(bytes, /absent/i);
  assert.match(bytes, /invalid/i);
  // The narrow claim a pass licenses, stated in the bar rather than in a results file
  // written after the number is known.
  assert.match(bytes, /when told it exists|narrow claim/i);
  // And the recorded comparability gap: arm A's exact prompt was never captured.
  assert.match(bytes, /arm A's (exact )?prompt|prompt was never/i);
});

test('every declared member is readable and non-empty', () => {
  const members = readMembers();
  assert.equal(members.length, SUITE_MEMBERS.length);
  for (const m of members) {
    assert.ok(m.bytes.length > 0, `${m.path}${m.section ? ` §${m.section}` : ''} read empty`);
  }
});

test('a stamp carries suite version, digest, model, config sha, and the record own timestamp', () => {
  const stamp = suiteStamp({ model: 'claude-sonnet-5', config_sha: 'abc1234', at: AT });
  assert.equal(stamp.suite_version, loadSuiteConfig().version);
  assert.equal(stamp.suite_digest, computeSuiteDigest());
  assert.equal(stamp.model, 'claude-sonnet-5');
  assert.equal(stamp.config_sha, 'abc1234');
  assert.equal(stamp.at, AT);
});

test('suiteStamp refuses to default the model or the timestamp', () => {
  // A stamp that fills in its own blanks is a stamp that lies. `config_sha` is
  // allowed to be an explicit null — a run with no config file is a real case — but
  // the model and the time are never inferred.
  assert.throws(() => suiteStamp({ at: AT }), /model/i);
  assert.throws(() => suiteStamp({ model: 'claude-sonnet-5' }), /at/i);
  assert.throws(() => suiteStamp({ model: '', at: AT }), /model/i);
  assert.doesNotThrow(() => suiteStamp({ model: 'claude-sonnet-5', at: AT, config_sha: null }));
});

test('an unstamped record is rejected', () => {
  // The point of the task: an unstamped run fails rather than quietly joining the
  // history. Reported as a list of reasons, never thrown — a stamp problem must not
  // fail the run being reported on.
  assert.deepEqual(stampProblems(null).length > 0, true);
  assert.deepEqual(stampProblems({}).length > 0, true);
  const problems = stampProblems({ suite: {} });
  assert.ok(problems.some((p) => /suite_version/.test(p)));
  assert.ok(problems.some((p) => /suite_digest/.test(p)));
  assert.ok(problems.some((p) => /model/.test(p)));
  assert.ok(problems.some((p) => /\bat\b/.test(p)));
  // A fully stamped record has nothing to report.
  const good = { suite: suiteStamp({ model: 'claude-sonnet-5', at: AT, config_sha: null }) };
  assert.deepEqual(stampProblems(good), []);
});

test('a record stamped with a stale suite digest is rejected', () => {
  const stale = {
    suite: {
      ...suiteStamp({ model: 'claude-sonnet-5', at: AT, config_sha: null }),
      suite_digest: 'f'.repeat(64),
    },
  };
  const problems = stampProblems(stale);
  assert.ok(
    problems.some((p) => /digest/.test(p)),
    'a digest that does not match the suite on disk must be named',
  );
});

test('stampProblems never throws on a malformed record', () => {
  for (const bad of [undefined, null, 0, '', 'x', [], { suite: 'nope' }, { suite: [] }, { suite: { at: 5 } }]) {
    assert.doesNotThrow(() => stampProblems(bad), `threw on ${JSON.stringify(bad) ?? String(bad)}`);
    assert.ok(Array.isArray(stampProblems(bad)));
  }
});

test('the additive-only policy is written down and names what to do when a fixture is wrong', () => {
  // A policy nothing enforces is scorecard §9's drift signal waiting to fire. This
  // asserts the section exists and covers the case the task singled out: not what to
  // do when a fixture is incomplete (add), but when it is WRONG.
  const sandbox = readFileSync(join(ROOT, 'docs/SANDBOX.md'), 'utf8');
  const policy = extractSection(sandbox, 'Additive-only: fixtures grow, they do not get edited');
  assert.match(policy, /wrong/i);
  assert.match(policy, /suite_version|suite version/i);
  // The saturation case: a case everything passes is DEMOTED to a regression floor,
  // never deleted. sandbox-a is already that, and the pattern should read as intended
  // rather than accidental.
  assert.match(policy, /demot/i);
  assert.match(policy, /sandbox-a/);
});
