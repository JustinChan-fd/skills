// lint — zero-dependency style checker for this repo.
//
// Usage: node tools/lint.mjs
// Exit 1 if any error is found. Warnings alone exit 0.

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const RULES = {
  requireHeader: {
    severity: 'error',
    message: 'file must open with a one-line comment describing it',
  },
  noVar: {
    severity: 'error',
    message: 'use let or const instead of var',
  },
  noTrailingWhitespace: {
    severity: 'error',
    message: 'trailing whitespace',
  },
  noTabs: {
    severity: 'error',
    message: 'indent with spaces, not tabs',
  },
  noConsole: {
    severity: 'error',
    message: 'console.log is not allowed outside tools/',
  },
  preferSingleQuotes: {
    severity: 'warning',
    message: 'prefer single-quoted strings',
  },
};

// \x22 is the double-quote character. Writing it as an escape keeps this rule
// from matching its own source line, which would make the linter permanently
// report one warning against itself.
const DOUBLE_QUOTED = /\x22[^\x22]*\x22/;

function finding(file, line, rule) {
  return {
    file,
    line,
    rule,
    severity: RULES[rule].severity,
    message: RULES[rule].message,
  };
}

export function lintSource(file, source) {
  const found = [];
  const lines = source.split('\n');
  const inTools = file.split('/').includes('tools');

  if (!/^\s*(\/\/|\/\*)/.test(lines[0] ?? '')) {
    found.push(finding(file, 1, 'requireHeader'));
  }

  lines.forEach((text, index) => {
    const line = index + 1;

    if (/(?:^|[^.\w$])var\s+[A-Za-z_$]/.test(text)) {
      found.push(finding(file, line, 'noVar'));
    }
    if (/[ \t]+$/.test(text)) {
      found.push(finding(file, line, 'noTrailingWhitespace'));
    }
    if (/^\s*\t/.test(text)) {
      found.push(finding(file, line, 'noTabs'));
    }
    if (!inTools && /\bconsole\.log\s*\(/.test(text)) {
      found.push(finding(file, line, 'noConsole'));
    }
    if (DOUBLE_QUOTED.test(text) && !/^\s*(\/\/|\*)/.test(text)) {
      found.push(finding(file, line, 'preferSingleQuotes'));
    }
  });

  return found.sort((a, b) => a.line - b.line);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function formatReport(fileCount, findings) {
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;

  const body = findings.map(
    (f) => `${f.file}:${f.line}  ${f.severity}  ${f.rule}  ${f.message}`,
  );

  return [
    ...body,
    ...(body.length ? [''] : []),
    `Checked ${fileCount} files`,
    `Found ${plural(errors, 'error')}, ${plural(warnings, 'warning')}`,
    '',
  ].join('\n');
}

const SKIP_DIRS = new Set(['node_modules', '.git']);

async function collect(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collect(full, out);
    } else if (/\.(?:js|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

async function main() {
  const files = (await collect(ROOT)).sort();
  const findings = [];
  for (const full of files) {
    const rel = relative(ROOT, full);
    findings.push(...lintSource(rel, await readFile(full, 'utf8')));
  }
  process.stdout.write(formatReport(files.length, findings));
  const errors = findings.filter((f) => f.severity === 'error').length;
  process.exitCode = errors > 0 ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith('lint.mjs')) {
  await main();
}
