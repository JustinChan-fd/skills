// Tests for the sandbox fixture's own linter (fixtures/sandbox-a/files/tools/lint.mjs).
//
// The linter is the fixture's verification gate: it is what an arm runs to check
// AC #3, and what the eval's ground truth is measured with. So its verdict has to
// be deterministic and its exit codes have to mean what SANDBOX.md says they mean.
//
// It is stored as lint.mjs (not .src) because `tools/` is not swept by
// `node --test` — only dirs named `test` are. Verified in fixture-layout.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lintSource, formatReport, RULES } from '../fixtures/sandbox-a/files/tools/lint.mjs';

// --- individual rules ---

test('flags a var declaration as an error', () => {
  const found = lintSource('src/x.js', '// x\nvar a = 1;\n');
  assert.deepEqual(found.map((f) => f.rule), ['noVar']);
  assert.equal(found[0].severity, 'error');
  assert.equal(found[0].line, 2);
});

test('does not flag let or const', () => {
  const found = lintSource('src/x.js', '// x\nlet a = 1;\nconst b = 2;\n');
  assert.deepEqual(found, []);
});

test('does not flag the substring var inside an identifier', () => {
  const found = lintSource('src/x.js', '// x\nconst variant = 1;\nlet avars = 2;\n');
  assert.deepEqual(found, []);
});

test('flags trailing whitespace as an error', () => {
  const found = lintSource('src/x.js', '// x\nconst a = 1;   \n');
  assert.deepEqual(found.map((f) => f.rule), ['noTrailingWhitespace']);
  assert.equal(found[0].line, 2);
});

test('flags a tab-indented line as an error', () => {
  const found = lintSource('src/x.js', '// x\nif (a) {\n\treturn 1;\n}\n');
  assert.deepEqual(found.map((f) => f.rule), ['noTabs']);
  assert.equal(found[0].line, 3);
});

// Single-quoted on purpose: a double-quoted argument would also trip
// preferSingleQuotes, and then the assertion would not be about noConsole.
test('flags console.log outside tools/ as an error', () => {
  const found = lintSource('src/x.js', "// x\nconsole.log('hi');\n");
  assert.deepEqual(found.map((f) => f.rule), ['noConsole']);
});

test('allows console.log inside tools/ — the linter itself needs it', () => {
  const found = lintSource('tools/lint.mjs', "// x\nconsole.log('hi');\n");
  assert.deepEqual(found, []);
});

test('flags a missing one-line file header as an error', () => {
  const found = lintSource('src/x.js', 'const a = 1;\n');
  assert.deepEqual(found.map((f) => f.rule), ['requireHeader']);
  assert.equal(found[0].line, 1);
});

test('accepts a header comment as the first line', () => {
  const found = lintSource('src/x.js', '// what this file does\nconst a = 1;\n');
  assert.deepEqual(found, []);
});

test('reports a double-quoted string as a WARNING, not an error', () => {
  const found = lintSource('src/x.js', '// x\nconst a = "hi";\n');
  assert.deepEqual(found.map((f) => f.rule), ['preferSingleQuotes']);
  assert.equal(found[0].severity, 'warning');
});

test('every rule declares a severity of either error or warning', () => {
  for (const [name, rule] of Object.entries(RULES)) {
    assert.ok(['error', 'warning'].includes(rule.severity), `${name}: ${rule.severity}`);
  }
});

test('a file can report several findings, ordered by line', () => {
  const found = lintSource('src/x.js', 'var a = 1;\nconst b = 2;   \n');
  assert.deepEqual(found.map((f) => f.line), [1, 1, 2]);
});

// --- report shape: biome-like, so ground truth reads the same way as 1339's ---

test('formatReport ends with the biome-shaped summary lines', () => {
  const out = formatReport(9, [
    { file: 'src/x.js', line: 2, rule: 'noVar', severity: 'error', message: 'm' },
    { file: 'src/y.js', line: 3, rule: 'preferSingleQuotes', severity: 'warning', message: 'm' },
  ]);
  const lines = out.trimEnd().split('\n');
  assert.equal(lines.at(-2), 'Checked 9 files');
  assert.equal(lines.at(-1), 'Found 1 error, 1 warning');
});

test('formatReport pluralizes counts correctly', () => {
  const out = formatReport(9, [
    { file: 'a.js', line: 1, rule: 'noVar', severity: 'error', message: 'm' },
    { file: 'b.js', line: 1, rule: 'noVar', severity: 'error', message: 'm' },
    { file: 'c.js', line: 1, rule: 'preferSingleQuotes', severity: 'warning', message: 'm' },
    { file: 'd.js', line: 1, rule: 'preferSingleQuotes', severity: 'warning', message: 'm' },
  ]);
  assert.match(out, /Found 2 errors, 2 warnings/);
});

test('formatReport says 0 errors when the tree is clean', () => {
  const out = formatReport(9, []);
  assert.match(out, /Found 0 errors, 0 warnings/);
});

test('formatReport names the file and line of every finding', () => {
  const out = formatReport(1, [
    { file: 'src/x.js', line: 7, rule: 'noVar', severity: 'error', message: 'use let or const' },
  ]);
  assert.match(out, /src\/x\.js:7/);
  assert.match(out, /noVar/);
  assert.match(out, /use let or const/);
});
