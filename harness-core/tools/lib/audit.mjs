// The flight recorder. Local write failure is FATAL by design (spec §4):
// a run that cannot log does not run.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadSchema, validate } from './validate.mjs';

export class HarnessError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function appendAudit(harnessDir, event) {
  // Callers normally stamp ts themselves (the event's real time); fill it as
  // a safety net so a missing timestamp never costs us the event.
  if (!event.ts) event = { ts: new Date().toISOString(), ...event };
  const errors = validate(loadSchema('audit-entry'), event);
  if (errors.length) throw new HarnessError('invalid_audit_entry', errors.join('; '));
  // Spawn events must name the task_type of the subagent dispatched — the
  // anomalies integrity scan and telemetry both key off it. The schema can't
  // express a per-event-value conditional requirement, so guard it here.
  if (event.event === 'spawn' || event.event === 'spawn_end') {
    const taskType = event.data && event.data.task_type;
    if (typeof taskType !== 'string' || taskType.length === 0) {
      throw new HarnessError('invalid_audit_entry', `${event.event} event requires a non-empty data.task_type`);
    }
  }
  // A spawn_end exists to make a subagent's duration machine-readable, which it
  // is not if wall_ms arrives as a string (or absent, leaving the reader to
  // subtract timestamps again — the exact inference spawn_end removes).
  if (event.event === 'spawn_end') {
    const wallMs = event.data && event.data.wall_ms;
    if (typeof wallMs !== 'number' || !Number.isFinite(wallMs)) {
      throw new HarnessError('invalid_audit_entry', 'spawn_end event requires a finite numeric data.wall_ms');
    }
  }
  try {
    mkdirSync(harnessDir, { recursive: true });
    appendFileSync(join(harnessDir, 'audit.jsonl'), JSON.stringify(event) + '\n');
  } catch (err) {
    throw new HarnessError('logging_unavailable', `audit append failed: ${err.message}`);
  }
}
