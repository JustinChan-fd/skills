import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseLines,
  detectInvocations,
  extractUsageEntries,
  extractToolCalls,
  extractDispatchResults,
  sessionDirForTranscript,
} from '../lib/transcript.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'session.jsonl');
const lines = parseLines(readFileSync(FIXTURE, 'utf8'));

test('parseLines survives garbage without throwing', () => {
  const out = parseLines('not json\n{"type":"assistant"}\n');
  assert.equal(out.length, 2);
  assert.equal(out[0].__unparseable, true);
  assert.equal(out[1].type, 'assistant');
});

test('detects both slash command and Skill tool invocations', () => {
  const inv = detectInvocations(lines);
  assert.equal(inv.length, 2);
  const slash = inv.find((i) => i.kind === 'slash_command');
  assert.equal(slash.name, '/gh-issue-create');
  assert.equal(slash.args, 'flaky login test');
  const skill = inv.find((i) => i.kind === 'skill_tool');
  assert.equal(skill.name, 'gh-issue-create');
  assert.equal(skill.tool_use_id, 'toolu_skill');
});

test('usage entries are verbatim copies with line identifiers', () => {
  const entries = extractUsageEntries(lines, { source: 'session' });
  assert.equal(entries.length, 2);
  const first = entries[0];
  assert.equal(first.model, 'claude-fable-5');
  assert.equal(first.requestId, 'req_1');
  assert.equal(first.effort, 'xhigh');
  // verbatim: the exact usage object, per-TTL split included
  assert.equal(first.usage.cache_creation.ephemeral_1h_input_tokens, 1500);
  assert.equal(first.usage.iterations.length, 1);
  assert.equal(first.usage.service_tier, 'standard');
});

test('tool calls and dispatch results extracted', () => {
  const calls = extractToolCalls(lines);
  assert.deepEqual(calls.map((c) => c.name), ['Skill']);
  const dispatches = extractDispatchResults(lines);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].toolUseResult.totalTokens, 1234);
});

test('sessionDirForTranscript strips the .jsonl suffix', () => {
  assert.equal(sessionDirForTranscript('/x/projects/p/abc.jsonl'), '/x/projects/p/abc');
  assert.equal(sessionDirForTranscript('/x/notjsonl'), null);
});
