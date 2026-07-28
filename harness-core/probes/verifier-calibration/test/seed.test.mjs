import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync as rf } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  branchName,
  createOps,
  cleanupOps,
  dryRun,
  validateNoMainMutation,
  applyEdits,
  runOps,
} from '../lib/seed.mjs';

const DEFECTS = JSON.parse(
  rf(fileURLToPath(new URL('../defects.json', import.meta.url)), 'utf8'),
).defects;

const D1 = DEFECTS.find((d) => d.defect_id === 'D1'); // host b46a24-example-gallery
const D3 = DEFECTS.find((d) => d.defect_id === 'D3'); // host 3d60c8-confirm-dialog-clear

test('branchName is probe/<defect_id>', () => {
  assert.equal(branchName(D1), 'probe/D1');
  assert.equal(branchName({ defect_id: 'D8' }), 'probe/D8');
});

test('createOps cuts the branch from the defect OWN host_branch, not a hardcoded one', () => {
  const ops = createOps(D1);
  const gitOps = ops.filter((o) => o.kind === 'git');
  const checkout = gitOps.find((o) => o.argv[0] === 'checkout' && o.argv.includes('-b'));
  assert.ok(checkout, 'a checkout -b op exists');
  assert.ok(checkout.argv.includes('probe/D1'), 'creates probe/D1');
  assert.ok(
    checkout.argv.includes('harness/b46a24-example-gallery'),
    'bases the new branch on D1.host_branch',
  );
  // A different defect must reference ITS own host branch — proves not hardcoded.
  const ops3 = createOps(D3);
  const checkout3 = ops3
    .filter((o) => o.kind === 'git')
    .find((o) => o.argv[0] === 'checkout' && o.argv.includes('-b'));
  assert.ok(checkout3.argv.includes('harness/3d60c8-confirm-dialog-clear'));
});

test('createOps supports a baseRef override for origin-only host branches', () => {
  const ops = createOps(D3, { baseRef: 'origin/harness/3d60c8-confirm-dialog-clear' });
  const checkout = ops
    .filter((o) => o.kind === 'git')
    .find((o) => o.argv[0] === 'checkout' && o.argv.includes('-b'));
  assert.ok(checkout.argv.includes('origin/harness/3d60c8-confirm-dialog-clear'));
});

test('createOps stages only the defect target files (never `git add -A` / `commit -a`)', () => {
  const ops = createOps(D1);
  const gitOps = ops.filter((o) => o.kind === 'git');
  const add = gitOps.find((o) => o.argv[0] === 'add');
  assert.ok(add, 'an explicit add op exists');
  // must add exactly the declared target files — never -A / . / -a
  assert.deepEqual(add.argv.slice(1).sort(), [...D1.target_files].sort());
  assert.ok(!add.argv.includes('-A') && !add.argv.includes('.'));
  const commit = gitOps.find((o) => o.argv[0] === 'commit');
  assert.ok(commit, 'a commit op exists');
  assert.ok(!commit.argv.includes('-a') && !commit.argv.includes('-am'));
});

test('createOps includes a patch op carrying the defect edits', () => {
  const ops = createOps(D1);
  const patch = ops.find((o) => o.kind === 'patch');
  assert.ok(patch, 'a patch op exists');
  assert.equal(patch.defect_id, 'D1');
  assert.deepEqual(patch.edits, D1.patch);
});

test('cleanupOps deletes the branch locally and never pushes/merges', () => {
  const ops = cleanupOps(D1);
  const del = ops.find((o) => o.kind === 'git' && o.argv[0] === 'branch' && o.argv.includes('-D'));
  assert.ok(del, 'a branch -D op exists');
  assert.ok(del.argv.includes('probe/D1'));
  // Must first leave the probe branch (can't delete the checked-out branch).
  const checkout = ops.find((o) => o.kind === 'git' && o.argv[0] === 'checkout');
  assert.ok(checkout, 'checks out away from the probe branch before deleting it');
});

test('HARD: no create/patch/cleanup op for ANY defect ever names main or pushes/merges', () => {
  for (const d of DEFECTS) {
    const all = [...createOps(d), ...cleanupOps(d)];
    // validateNoMainMutation must not throw for the legitimate sequences.
    assert.equal(validateNoMainMutation(all), true, `${d.defect_id} sequence is clean`);
    for (const op of all) {
      if (op.kind !== 'git') continue;
      const joined = op.argv.join(' ');
      assert.ok(op.argv[0] !== 'push', `${d.defect_id}: no push`);
      assert.ok(op.argv[0] !== 'merge', `${d.defect_id}: no merge`);
      assert.ok(!/\bmain\b/.test(joined), `${d.defect_id}: no main target in "${joined}"`);
      assert.ok(!/\bmaster\b/.test(joined), `${d.defect_id}: no master target`);
      assert.ok(!/\bpush\b|\bmerge\b/.test(joined), `${d.defect_id}: no push/merge verb`);
    }
  }
});

test('validateNoMainMutation THROWS on an injected push/merge/main op', () => {
  assert.throws(() => validateNoMainMutation([{ kind: 'git', argv: ['push', 'origin', 'probe/D1'] }]), /push/i);
  assert.throws(() => validateNoMainMutation([{ kind: 'git', argv: ['merge', 'probe/D1'] }]), /merge/i);
  assert.throws(() => validateNoMainMutation([{ kind: 'git', argv: ['checkout', 'main'] }]), /main/i);
  assert.throws(
    () => validateNoMainMutation([{ kind: 'git', argv: ['branch', '-D', 'main'] }]),
    /main/i,
  );
});

test('dryRun returns the full ordered op list for all 8 defects WITHOUT executing anything', () => {
  const plan = dryRun(DEFECTS);
  assert.equal(plan.length, 8);
  assert.equal(plan[0].defect_id, 'D1');
  assert.equal(plan[0].branch, 'probe/D1');
  assert.ok(Array.isArray(plan[0].create) && plan[0].create.length > 0);
  assert.ok(Array.isArray(plan[0].cleanup) && plan[0].cleanup.length > 0);
  // Whole plan must be main-mutation-free.
  for (const entry of plan) {
    assert.equal(validateNoMainMutation([...entry.create, ...entry.cleanup]), true);
  }
});

test('applyEdits: append op concatenates text', () => {
  const out = applyEdits('hello', [{ op: 'append', text: '\nworld' }]);
  assert.equal(out, 'hello\nworld');
});

test('applyEdits: replace op swaps an exact unique substring', () => {
  const out = applyEdits('a = 1;\nb = 2;', [{ op: 'replace', find: 'b = 2;', replace: 'b = 3;' }]);
  assert.equal(out, 'a = 1;\nb = 3;');
});

test('applyEdits: replace throws if the find string is absent (fail-loud, never silent no-op)', () => {
  assert.throws(() => applyEdits('abc', [{ op: 'replace', find: 'xyz', replace: 'q' }]), /not found/i);
});

test('runOps drives an injected executor and never touches a real checkout', () => {
  const calls = [];
  const executor = {
    runGit: (argv) => calls.push(['git', ...argv]),
    applyPatch: (op) => calls.push(['patch', op.defect_id]),
  };
  runOps(createOps(D1), executor);
  assert.ok(calls.some((c) => c[0] === 'git' && c[1] === 'checkout'));
  assert.ok(calls.some((c) => c[0] === 'patch' && c[1] === 'D1'));
});

test('runOps applyPatch integration: real file edit via a temp dir (mkdtemp fixture style)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-seed-'));
  try {
    const file = join(dir, 'sample.ts');
    writeFileSync(file, 'const x = 1;\n');
    const executor = {
      runGit: () => {},
      applyPatch: (op) => {
        for (const target of op.target_files) {
          const p = join(dir, target);
          writeFileSync(p, applyEdits(readFileSync(p, 'utf8'), op.edits));
        }
      },
    };
    const fakeDefect = {
      defect_id: 'DX',
      host_branch: 'harness/x',
      target_files: ['sample.ts'],
      patch: [{ op: 'append', text: 'const y = 2;\n' }],
    };
    runOps(createOps(fakeDefect), executor);
    assert.equal(readFileSync(file, 'utf8'), 'const x = 1;\nconst y = 2;\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
