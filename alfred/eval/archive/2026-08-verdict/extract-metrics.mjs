#!/usr/bin/env node
// Standalone metrics extractor — the "harness-core as a post-run plugin" prototype.
//
// Takes any claude -p --output-format stream-json --verbose transcript (Alfred's worker.log,
// or a plain single-agent run's) and produces the SAME deterministic record.json shape via
// alfred/lib/report.mjs's recordForRun/buildRecord — regardless of which harness, if any,
// produced the transcript. This is what lets the Alfred arm and the single-agent arm of the
// jarvis#7 experiment be graded on identical terms rather than trusting either run's own
// self-reported audit log.
//
// Usage: node extract-metrics.mjs --worker-log <path> --cwd <path> --session-id <id> [--label x]
//
// --cwd is the directory the claude process was run from (used to derive the transcript path
// under ~/.claude/projects/<slug>/<session-id>.jsonl) — NOT the worker log's path itself.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { recordForRun } from '/Users/206618626@bwt3.com/Desktop/Repos/skills/alfred/lib/report.mjs';

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--worker-log') out.workerLog = argv[++i];
    else if (a === '--cwd') out.cwd = argv[++i];
    else if (a === '--session-id') out.sessionId = argv[++i];
    else if (a === '--label') out.label = argv[++i];
    else if (a === '--out') out.out = argv[++i];
  }
  return out;
}

const args = parseArgv(process.argv.slice(2));
if (!args.workerLog || !args.cwd) {
  console.error('usage: extract-metrics.mjs --worker-log <path> --cwd <path> [--session-id <id>] [--label x] [--out <path>]');
  process.exit(2);
}

const workerLog = readFileSync(resolve(args.workerLog), 'utf8');
const record = recordForRun({
  workerLog,
  cwd: resolve(args.cwd),
  session: { id: args.sessionId ?? null, run_id: args.label ?? null, repo: args.label ?? null },
});

const summary = {
  label: args.label ?? null,
  ok: record.ok,
  error: record.error,
  num_turns_note: 'record.tokens.lines is a raw JSONL line count, NOT num_turns — pull num_turns from the transcript\'s own final result line separately',
  session_id: record.session.id,
  cost_total_usd: record.cost.total_usd,
  cost_vendor_usd: record.cost.vendor_usd,
  tokens_lines: record.tokens.lines,
  tokens_skipped: record.tokens.skipped,
  by_model: record.tokens.by_model,
  subagent_count: record.subagents.length,
  gaps: record.gaps,
};

console.log(JSON.stringify(summary, null, 2));
if (args.out) writeFileSync(resolve(args.out), JSON.stringify(record, null, 2));
