#!/usr/bin/env node
// Idempotent installer: wires hooks/skill-run-logger.mjs into a Claude Code
// settings file for the three events that mark the end of a run.
//
//   node skill-observability/install.mjs            -> ~/.claude/settings.json
//   node skill-observability/install.mjs --project  -> ./.claude/settings.json
//   node skill-observability/install.mjs --dry-run  -> print result, write nothing
//
// Stop        = normal end of turn (skill completed)
// StopFailure = turn ended with an error (rate limit, auth, API failure)
// SessionEnd  = session terminated (interrupt / exit / clear)
// The same logger handles all three, so success, failure, and early exit are
// captured through the identical code path — the record only differs in
// computed.outcome.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOGGER = join(HERE, 'hooks', 'skill-run-logger.mjs');
const EVENTS = ['Stop', 'StopFailure', 'SessionEnd'];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const settingsPath = args.includes('--project')
  ? join(process.cwd(), '.claude', 'settings.json')
  : join(homedir(), '.claude', 'settings.json');

let settings = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (err) {
    console.error(`refusing to touch unparseable settings file ${settingsPath}: ${err.message}`);
    process.exit(1);
  }
}

settings.hooks ??= {};
const command = `node ${LOGGER}`;
let changed = false;

for (const event of EVENTS) {
  settings.hooks[event] ??= [];
  const already = settings.hooks[event].some((group) =>
    (group.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes('skill-run-logger.mjs')),
  );
  if (already) continue;
  settings.hooks[event].push({ matcher: '', hooks: [{ type: 'command', command, timeout: 30 }] });
  changed = true;
}

if (!changed) {
  console.log(`already installed in ${settingsPath} — nothing to do`);
  process.exit(0);
}

if (dryRun) {
  console.log(JSON.stringify(settings, null, 2));
  process.exit(0);
}

mkdirSync(dirname(settingsPath), { recursive: true });
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log(`installed Stop/StopFailure/SessionEnd hooks -> ${settingsPath}`);
console.log(`logger: ${LOGGER}`);
console.log(`logs:   ${process.env.SKILL_OBS_DIR || join(homedir(), '.claude', 'skill-runs')}`);
