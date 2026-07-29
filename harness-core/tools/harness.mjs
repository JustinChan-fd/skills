#!/usr/bin/env node
// harness-core/tools/harness.mjs
// The deterministic spine's front door. Skills shell out here; the LLM never
// hand-rolls a gate decision, a schema check, or a log write (spec §5).
// Exit codes: 0 ok · 1 validation/decision failure · 2 fatal logging failure.
//
// WHY A SHELLED-OUT SCRIPT, NOT INLINE PROSE (Anthropic docs, retrieved 2026-07-27):
//   SOURCE: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
//     "Executable scripts (fill_form.py, validate.py) that Claude runs using bash,
//      providing deterministic operations without loading their code into context."
//   SOURCE: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
//     "Prefer scripts for deterministic operations: Write validate_form.py rather
//      than asking Claude to generate validation code."
//   SOURCE: https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
//     "Many applications require the deterministic reliability that only code can provide."
// See harness-core/README.md for the full rationale + the network-access note
// (why the Jira MCP, gh, and git all work from a shelled-out Node process).
import { parseArgs } from 'node:util';
import { readFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadSchema, validate } from './lib/validate.mjs';
import { resolveConfig, sizeBudgets, expandHome, resolveProject, loadProjects } from './lib/config.mjs';
import { resolveTarget } from './lib/target.mjs';
import { gateDecision } from './lib/gate.mjs';
import { qualityScore } from './lib/quality.mjs';
import { appendAudit, HarnessError } from './lib/audit.mjs';
import { initRun, readRecord, phaseEnd, finalizeRun, recordObservedTokens, stampTokensDirectional, finalizeTokens } from './lib/record.mjs';
import { collectForRun, backfillDirectional } from './lib/tokens-collect.mjs';
import { preflight } from './lib/preflight.mjs';
import { scanAnomalies } from './lib/anomalies.mjs';
import { scanResidue } from './lib/residue.mjs';
import { loopState } from './lib/loopstate.mjs';
import { syncRun, sweep } from './lib/telemetry.mjs';
import { renderStatusComment, renderPrBody, renderBrief } from './lib/render.mjs';
import { composeLoopLine } from './lib/looprecord.mjs';
import { normalizeJiraIssue } from './lib/jira.mjs';
import { normalizeGithubIssue } from './lib/github.mjs';
import { extractPlanEntries, orderPlansByDeps } from './lib/plan-sequencer.mjs';
import { splitOversizedTasks } from './lib/split-oversized.mjs';

const [subcommand, ...rest] = process.argv.slice(2);

function opts(spec) {
  return parseArgs({ args: rest, options: spec, strict: true }).values;
}

function emit(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  process.exit(code);
}

// Render subcommands print already-assembled markdown/prose to stdout (not a
// JSON envelope) so the driver can pipe it straight into `gh` — one trailing
// newline, no JSON.stringify.
function emitText(str, code = 0) {
  process.stdout.write(str.endsWith('\n') ? str : str + '\n');
  process.exit(code);
}

function telemetryFromConfig() {
  const { user } = resolveConfig();
  if (!user.telemetry?.remote || !user.telemetry?.dir) return null;
  return {
    remote: user.telemetry.remote,
    dir: expandHome(user.telemetry.dir),
    build: user.telemetry.build ?? null,
    commit_identity: user.telemetry.commit_identity ?? null,
  };
}

// Collect directional token sums for a run and stamp them onto record.json
// (additive — never touches tokens_by_tier / tokens_observed). On any
// degradation (garbage/missing transcript, unrecognized model id) it still
// stamps a complete:false tokens_directional with the format version, and
// writes an estimated-with-note audit event (data.estimated:true, detected by
// anomalies.mjs's isEstimatedTokensNote). Returns a summary.
function collectAndStamp(v, routing) {
  const runDir = v['run-dir'];
  const record = readRecord(runDir);
  const now = new Date();
  const sessionId = v['session-id'] ?? process.env.CLAUDE_CODE_SESSION_ID ?? null;
  // Default a phase run to subtree collection. The old default (standalone
  // newest-mtime top-level transcript) cannot find harness tokens at all: the
  // orchestrator is idle while a phase runs, so 100% of the spend is in
  // <session>/subagents/agent-*.jsonl. An explicit --mode or --transcript still
  // wins, which keeps backfill and hand invocations on their existing paths.
  const mode = v.mode ?? (v.transcript ? undefined : 'subtree');
  const { tokens_directional, note, source, via } = collectForRun({
    transcript: v.transcript,
    mode,
    subagentsDir: v['subagents-dir'],
    projectDir: v['project-dir'],
    cwd: v.cwd ?? process.cwd(),
    sessionId,
    // Exact identity when the orchestrator knew it (record-observed-tokens
    // --agent-id); otherwise the fingerprint or all-drivers path.
    agentId: v['agent-id'] ?? null,
    // Explicit --start/--end override the record's own run window (the default).
    start: v.start ?? record.started_at ?? null,
    end: v.end ?? record.ended_at ?? now.toISOString(),
    gapCapMs: v['gap-cap-ms'] !== undefined ? Number(v['gap-cap-ms']) : undefined,
    modelTierMap: routing.model_id_to_tier ?? {},
    // The Agent-tool subagent_tokens tag, when an orchestrator recorded one — the
    // fingerprint discoverSubagentForRun matches a transcript's peak_context
    // against. Absent on a plain phase run, which degrades to all-drivers.
    observedTotal: record.tokens_observed?.total ?? null,
    now,
  });
  stampTokensDirectional({ runDir, tokensDirectional: tokens_directional });
  if (note) {
    appendAudit(dirname(dirname(runDir)), {
      ts: now.toISOString(),
      run_id: record.run_id,
      event: 'note',
      data: { type: 'tokens', estimated: true, complete: false, reason: note.code, detail: note.detail },
    });
  }
  return { complete: tokens_directional.complete, degraded: !!note, source, via };
}

const TOKENS_COLLECT_OPTS = {
  transcript: { type: 'string' }, mode: { type: 'string' },
  'subagents-dir': { type: 'string' }, 'project-dir': { type: 'string' },
  cwd: { type: 'string' }, 'gap-cap-ms': { type: 'string' },
  start: { type: 'string' }, end: { type: 'string' },
  'agent-id': { type: 'string' }, 'session-id': { type: 'string' },
};

try {
  switch (subcommand) {
    case 'init-run': {
      const v = opts({
        target: { type: 'string' }, repo: { type: 'string' }, kind: { type: 'string' },
        source: { type: 'string' }, issue: { type: 'string' }, branch: { type: 'string' },
        'routing-policy': { type: 'string' },
        // v2 graft: parent-loop association, cross-phase correlation, provenance.
        'parent-run-id': { type: 'string' },
        'correlation-id': { type: 'string' }, 'repo-path': { type: 'string' },
        'skills-commit': { type: 'string' },
      });
      const { runId, runDir } = initRun({
        targetDir: v.target, repo: v.repo, kind: v.kind,
        // Auto-lowercase the source so callers can pass 'issue-PROJ-1' and it
        // round-trips cleanly through the run-id stem regex (which is lowercase-only).
        // The real Jira key rides in --issue untouched; the source is just a slug.
        source: v.source?.toLowerCase() ?? v.source,
        issue: v.issue ?? null, branch: v.branch ?? null,
        routingPolicy: v['routing-policy'] ?? null,
        parentRunId: v['parent-run-id'] ?? null,
        correlationId: v['correlation-id'] ?? null,
        repoPath: v['repo-path'] ?? null,
        skillsCommit: v['skills-commit'] ?? null,
      });
      emit({ run_id: runId, run_dir: runDir });
    }
    case 'resolve-project': {
      const v = opts({ issue: { type: 'string' } });
      const project = resolveProject(v.issue);
      if (!project) emit({ error: `no project mapping for issue key: ${v.issue ?? '(none)'}` }, 1);
      emit(project);
    }
    case 'resolve-target': {
      // Deterministic target + work-item routing. The calling skill extracts
      // loose hints from free-form invocation text; every DECISION lives here,
      // composed from user.json + projects.json so those files stay the single
      // source of truth. A named-but-unresolvable hint exits 1 rather than
      // falling back to defaultRepo: silently ticking a repo the user did not
      // name is the worst available outcome.
      const v = opts({ hint: { type: 'string' }, item: { type: 'string' }, cwd: { type: 'string' } });
      const { user } = resolveConfig();
      const { projects, defaultCloudId } = loadProjects();
      const r = resolveTarget({
        hint: v.hint,
        item: v.item,
        cwd: v.cwd ?? process.cwd(),
        user,
        projects,
        defaultCloudId,
      });
      if (!r.ok) emit({ error: `${r.error.code}: ${r.error.detail ?? ''}`.trim() }, 1);
      emit(r.target);
    }
    case 'jira-normalize': {
      // Normalize a saved getJiraIssue response into the neutral intake shape.
      // Fetch-once-to-disk: intake writes the raw response, then this reads it,
      // so plan/implement never re-hit Jira (they read the manifest). A
      // malformed issue exits 1 rather than fabricating a shape.
      const v = opts({ file: { type: 'string' } });
      const normalized = normalizeJiraIssue(JSON.parse(readFileSync(v.file, 'utf8')));
      emit(normalized);
    }
    case 'github-normalize': {
      // Normalize a saved `gh issue view --json number,title,body,labels`
      // response into the SAME neutral intake shape jira-normalize produces, so
      // downstream phases are source-agnostic. Fetch-once-to-disk, same as Jira:
      // intake writes the raw response, this reads it, plan/implement read the
      // manifest. --repo is the repo slug, used as project_key. A malformed
      // issue exits 1 rather than fabricating a shape.
      const v = opts({ file: { type: 'string' }, repo: { type: 'string' } });
      const normalized = normalizeGithubIssue(JSON.parse(readFileSync(v.file, 'utf8')), { repoSlug: v.repo ?? null });
      emit(normalized);
    }
    case 'plan-order': {
      // Topologically order a plan manifest's plans[] by dependsOn (Kahn,
      // stable). Exits 1 on an unknown dep id or a cycle — the plan skill must
      // not proceed with an unorderable plan set.
      const v = opts({ manifest: { type: 'string' } });
      const plans = extractPlanEntries(JSON.parse(readFileSync(v.manifest, 'utf8')));
      emit({ order: orderPlansByDeps(plans) });
    }
    case 'split-tasks': {
      // Split any unit whose locations[] exceeds the per-task cap into same-group parallel
      // siblings (directory-coherent chunks) so implement lands them as one commit without one
      // agent grinding 100 files serially. Keys are the plan schema's (`units`, `locations`):
      // this read was `plan.tasks` against a schema that has no `tasks`, so the command
      // returned an empty array for every plan.json it was ever given.
      const v = opts({ plan: { type: 'string' }, cap: { type: 'string' } });
      const plan = JSON.parse(readFileSync(v.plan, 'utf8'));
      const units = splitOversizedTasks(plan.units ?? [], v.cap !== undefined ? Number(v.cap) : undefined);
      emit({ units });
    }
    case 'validate': {
      const v = opts({ schema: { type: 'string' }, file: { type: 'string' } });
      const errors = validate(loadSchema(v.schema), JSON.parse(readFileSync(v.file, 'utf8')));
      emit({ valid: errors.length === 0, errors }, errors.length ? 1 : 0);
    }
    case 'audit': {
      const v = opts({ target: { type: 'string' }, event: { type: 'string' } });
      appendAudit(join(v.target, '.harness'), JSON.parse(v.event));
      emit({ ok: true });
    }
    case 'gate': {
      const v = opts({
        size: { type: 'string' }, rounds: { type: 'string' }, result: { type: 'string' }, delta: { type: 'string' },
        score: { type: 'string' },
      });
      const { routing } = resolveConfig();
      const decision = gateDecision({
        result: v.result,
        rounds: Number(v.rounds),
        cap: sizeBudgets(routing, v.size).revision_cap,
        delta: v.delta !== undefined ? Number(v.delta) : null,
        plateauThreshold: routing.plateau_threshold,
        score: v.score !== undefined ? Number(v.score) : null,
        advisoryOpenScore: routing.advisory_open_score ?? null,
      });
      emit(decision, decision.decision === 'shut' ? 1 : 0);
    }
    case 'phase-end': {
      const v = opts({
        'run-dir': { type: 'string' }, phase: { type: 'string' }, status: { type: 'string' },
        rounds: { type: 'string' }, score: { type: 'string' }, size: { type: 'string' },
        ...TOKENS_COLLECT_OPTS,
      });
      phaseEnd({
        runDir: v['run-dir'], phase: v.phase, status: v.status,
        rounds: v.rounds !== undefined ? Number(v.rounds) : null,
        score: v.score !== undefined ? Number(v.score) : null,
        size: v.size ?? null,
      });
      // Persist directional tokens incrementally at phase-end too, so a crash
      // before run-end still leaves this phase's collection on disk. Best-effort:
      // token enrichment must never fail a phase-end.
      try {
        const { routing } = resolveConfig();
        collectAndStamp(v, routing);
      } catch {
        /* enrichment is best-effort; the phase already ended successfully */
      }
      emit(readRecord(v['run-dir']));
    }
    case 'run-end': {
      const v = opts({
        target: { type: 'string' }, 'run-dir': { type: 'string' }, status: { type: 'string' },
        'reason-code': { type: 'string' }, 'reason-detail': { type: 'string' },
        'tokens-by-tier': { type: 'string' },
        // v2 graft: active time, per-model/per-phase agent counts, per-skill metrics.
        'active-ms': { type: 'string' }, 'agent-count': { type: 'string' },
        'skill-metrics': { type: 'string' },
        ...TOKENS_COLLECT_OPTS,
      });
      const reason = v['reason-code']
        ? { code: v['reason-code'], detail: v['reason-detail'] ?? '', phase: null, agent: null }
        : null;
      const { routing, user } = resolveConfig();
      finalizeRun({
        runDir: v['run-dir'], status: v.status, reason,
        tokensByTier: v['tokens-by-tier'] ? JSON.parse(v['tokens-by-tier']) : null,
        billingMode: user.billing_mode ?? null,
        priceTableVersion: routing.price_table?.version ?? null,
        activeMs: v['active-ms'] !== undefined ? Number(v['active-ms']) : null,
        agentCount: v['agent-count'] ? JSON.parse(v['agent-count']) : null,
        skillMetrics: v['skill-metrics'] ? JSON.parse(v['skill-metrics']) : null,
      });
      // Final directional-token collection, before the sync, so the synced copy
      // carries the sums. Best-effort: never fail run-end over enrichment.
      try {
        collectAndStamp(v, routing);
      } catch {
        /* enrichment is best-effort; the run already finalized */
      }
      const telemetry = telemetryFromConfig();
      const sync = syncRun({ runDir: v['run-dir'], telemetry });
      const swept = telemetry ? sweep({ targetDir: v.target, telemetry }).swept : [];
      emit({ status: v.status, synced: sync.synced, swept });
    }
    case 'render-status-comment': {
      const v = opts({
        phase: { type: 'string' }, status: { type: 'string' }, 'run-id': { type: 'string' },
        size: { type: 'string' }, 'size-rationale': { type: 'string' },
        'plan-units': { type: 'string' }, 'plan-blocking': { type: 'string' },
        'pr-url': { type: 'string' }, notes: { type: 'string' }, next: { type: 'string' },
      });
      emitText(renderStatusComment({
        phase: v.phase, status: v.status, runId: v['run-id'],
        size: v.size, sizeRationale: v['size-rationale'],
        planUnits: v['plan-units'], planBlocking: v['plan-blocking'],
        prUrl: v['pr-url'],
        notes: v.notes ? JSON.parse(v.notes) : [],
        next: v.next,
      }));
    }
    case 'render-pr-body': {
      const v = opts({
        'change-type': { type: 'string' }, issue: { type: 'string' }, summary: { type: 'string' },
        'result-rows': { type: 'string' }, landing: { type: 'string' }, 'run-id': { type: 'string' },
        notes: { type: 'string' },
      });
      emitText(renderPrBody({
        changeType: v['change-type'],
        issue: v.issue ?? null,
        summary: v.summary ?? '',
        resultRows: v['result-rows'] ? JSON.parse(v['result-rows']) : [],
        landingChecklist: v.landing ? JSON.parse(v.landing) : [],
        runId: v['run-id'],
        notes: v.notes ? JSON.parse(v.notes) : [],
      }));
    }
    case 'tokens-finalize': {
      const v = opts({ tier: { type: 'string', multiple: true } });
      const observations = (v.tier ?? []).map((spec) => {
        const [tier, rest = ''] = spec.split('=');
        const [amountStr, flag] = rest.split(':');
        return { tier, amount: Number(amountStr), estimated: flag === 'estimated' };
      });
      const { tokens_by_tier, note } = finalizeTokens(observations);
      // The tokens note is emitted only when the driver actually spawned
      // subagents (≥1 observation) — a run with no spawns writes no note.
      const out = { tokens_by_tier };
      if (observations.length) out.tokens_note = note;
      emit(out);
    }
    case 'render-brief': {
      const v = opts({ file: { type: 'string' } });
      const brief = JSON.parse(readFileSync(v.file, 'utf8'));
      const errors = validate(loadSchema('brief'), brief);
      if (errors.length) emit({ valid: false, errors }, 1);
      emitText(renderBrief(brief));
    }
    case 'loop-record': {
      const v = opts({
        target: { type: 'string' }, issue: { type: 'string' }, actions: { type: 'string' },
        outcome: { type: 'string' }, 'pr-url': { type: 'string' }, 'anomalies-scan': { type: 'string' },
        'phase-run': { type: 'string', multiple: true }, ts: { type: 'string' },
      });
      const phaseRuns = (v['phase-run'] ?? []).map((spec) => {
        const idx = spec.indexOf('=');
        return { phase: spec.slice(0, idx), runDir: spec.slice(idx + 1) };
      });
      const line = composeLoopLine({
        // Keep the issue verbatim — a Jira key (TARS-1271) must survive into the
        // loop.jsonl line, not be coerced to NaN. A numeric GitHub issue stays a
        // numeric string, which is fine for the log.
        issue: v.issue ?? null,
        actions: v.actions ? JSON.parse(v.actions) : [],
        outcome: v.outcome,
        prUrl: v['pr-url'] ?? null,
        anomaliesScanPath: v['anomalies-scan'],
        phaseRuns,
        ts: v.ts ?? new Date().toISOString(),
      });
      appendFileSync(join(v.target, '.harness', 'loop.jsonl'), JSON.stringify(line) + '\n');
      emit(line);
    }
    case 'record-observed-tokens': {
      const v = opts({
        'run-dir': { type: 'string' }, total: { type: 'string' }, tier: { type: 'string' },
        source: { type: 'string' }, ...TOKENS_COLLECT_OPTS,
      });
      const record = recordObservedTokens({
        runDir: v['run-dir'],
        total: Number(v.total),
        tier: v.tier,
        source: v.source ?? 'agent_tool_usage_tag',
      });
      // The orchestrator is the ONLY party that knows which agent ran this phase:
      // the Agent-tool dispatch result carries `agentId`, and a subagent's own env
      // does not (its CLAUDE_CODE_SESSION_ID is the parent's). So this is the one
      // call site that can attribute exactly. The driver already stamped
      // best-effort at its own run-end; this overwrites it with authoritative sums.
      // Best-effort: never fail the cost update over enrichment, and never clobber
      // a good stamp with an empty one (stampTokensDirectional guards that).
      let recollected = false;
      let via = null;
      if (v['agent-id']) {
        try {
          const { routing } = resolveConfig();
          const summary = collectAndStamp(v, routing);
          recollected = true;
          via = summary.via ?? null;
        } catch {
          /* enrichment only; tokens_observed is already written */
        }
      }
      const telemetry = telemetryFromConfig();
      const sync = syncRun({ runDir: v['run-dir'], telemetry });
      emit({
        status: record.status,
        tokens_by_tier: record.tokens_by_tier,
        tokens_observed: record.tokens_observed,
        directional_recollected: recollected,
        via,
        synced: sync.synced,
      });
    }
    case 'tokens-collect': {
      const v = opts({ 'run-dir': { type: 'string' }, target: { type: 'string' }, ...TOKENS_COLLECT_OPTS });
      const { routing } = resolveConfig();
      const summary = collectAndStamp(v, routing);
      const record = readRecord(v['run-dir']);
      emit({ ok: true, ...summary, tokens_directional: record.tokens_directional });
    }
    case 'backfill-directional': {
      const v = opts({
        'run-dir': { type: 'string' },
        'subagents-dir': { type: 'string' },
        start: { type: 'string' },
        end: { type: 'string' },
      });
      if (!v['run-dir'] || !v['subagents-dir']) {
        emit({ error: 'backfill-directional requires --run-dir and --subagents-dir' }, 1);
      }
      const { routing } = resolveConfig();
      const bfResult = backfillDirectional({
        runDir: v['run-dir'],
        subagentsDir: v['subagents-dir'],
        start: v.start,
        end: v.end,
        modelTierMap: routing.model_id_to_tier ?? {},
        now: new Date(),
      });
      if (!bfResult.ok) {
        emit({ ok: true, status: 'unresolved', reason: bfResult.error });
      }
      // Stamp the result onto record.json (additive — never touches tokens_observed).
      stampTokensDirectional({ runDir: v['run-dir'], tokensDirectional: bfResult.tokens_directional });
      const telemetry = telemetryFromConfig();
      syncRun({ runDir: v['run-dir'], telemetry });
      emit({ ok: true, status: 'resolved', by_model: bfResult.tokens_directional.by_model, source: bfResult.source });
    }
    case 'preflight': {
      const v = opts({ phase: { type: 'string' }, 'run-dir': { type: 'string' } });
      const r = preflight({ phase: v.phase, runDir: v['run-dir'] });
      emit(r, r.ok ? 0 : 1);
    }
    case 'anomalies': {
      const v = opts({ dir: { type: 'string' }, repo: { type: 'string' }, limit: { type: 'string' } });
      const { user, routing } = resolveConfig();
      const dir = v.dir ? expandHome(v.dir) : user.telemetry?.dir ? expandHome(user.telemetry.dir) : null;
      if (!dir) emit({ error: 'no telemetry dir: pass --dir or configure telemetry.dir in user.json' }, 1);
      const r = scanAnomalies({
        dir,
        repo: v.repo ?? null,
        limit: v.limit !== undefined ? Number(v.limit) : null,
        routing,
      });
      emit(r, r.ok ? 0 : 1);
    }
    case 'residue-scan': {
      const v = opts({ target: { type: 'string' }, issue: { type: 'string' } });
      const auditPath = join(v.target, '.harness', 'audit.jsonl');
      // Pass the issue verbatim (Jira key or numeric) — scanResidue normalizes
      // it against the run-id's parsed issue (case-insensitive), so no coercion.
      const items = scanResidue({ auditPath, issue: v.issue });
      emit({ items }); // exit 0 always — an empty result is a valid outcome
    }
    case 'loop-state': {
      const v = opts({ target: { type: 'string' }, issue: { type: 'string' } });
      emit(loopState({ targetDir: v.target, issue: v.issue }));
    }
    case 'quality': {
      const v = opts({ 'run-dir': { type: 'string' } });
      const record = readRecord(v['run-dir']);
      const auditPath = join(v['run-dir'], '..', '..', 'audit.jsonl');
      let auditWritten = false;
      try {
        auditWritten = readFileSync(auditPath, 'utf8').includes(record.run_id);
      } catch {
        auditWritten = false;
      }
      let manifestValid = false;
      try {
        manifestValid = validate(loadSchema('manifest'), JSON.parse(readFileSync(join(v['run-dir'], 'manifest.json'), 'utf8'))).length === 0;
      } catch {
        manifestValid = false;
      }
      const score = qualityScore({
        verifierScores: record.phases.map((p) => p.verifier_score).filter((s) => s !== null),
        deliverable: {
          completed: record.status === 'succeeded',
          manifestValid,
          gatesDecided: record.phases.length > 0,
          auditWritten,
        },
      });
      emit({ score });
    }
    case 'config': {
      emit(resolveConfig());
    }
    case 'sweep': {
      const v = opts({ target: { type: 'string' } });
      emit(sweep({ targetDir: v.target, telemetry: telemetryFromConfig() }));
    }
    default:
      emit({
        error: `unknown subcommand: ${subcommand ?? '(none)'}`,
        usage: {
          'init-run': '--target <path> --repo <slug> --kind intake|plan|implement --source issue-<n>|adhoc|file [--issue <n>] [--branch <b>] [--parent-run-id <id>] [--correlation-id <id>] [--repo-path <path>] [--skills-commit <sha>]',
          'resolve-project': '--issue <KEY-n>  (map a Jira issue key prefix to { repoPath, cloudId } from config/projects.json; exit 1 if unknown)',
          'resolve-target': '[--hint <alias|JIRA-KEY|path>] [--item <n|#n|KEY-n>] [--cwd <path>]  (resolve a free-form repo/work-item hint to { alias, path, issue_source, github, cloud_id, project_key, pinned_issue, resolved_from } from user.json + projects.json; a named-but-unresolvable hint exits 1 instead of falling back to defaultRepo)',
          'jira-normalize': '--file <issue.json>  (normalize a saved getJiraIssue response into the neutral intake shape {key,summary,description,issue_type,change_type,parent_key,project_key,input}; exit 1 if malformed)',
          'github-normalize': '--file <issue.json> [--repo <slug>]  (normalize a saved `gh issue view --json number,title,body,labels` response into the SAME neutral intake shape as jira-normalize; --repo becomes project_key; exit 1 if malformed)',
          'plan-order': '--manifest <plan-manifest.json>  (topologically order plans[] by dependsOn; { order:[...] }; exit 1 on cycle/unknown dep)',
          'split-tasks': '--plan <plan.json> [--cap N]   split oversized units by locations[]',
          validate: '--schema <name> --file <path>',
          audit: '--target <path> --event <json>  (ts auto-stamped if omitted)',
          gate: '--size S|M|L --rounds <n> --result pass|advisory-fail|blocking-fail [--score <0..1>] [--delta <n>]',
          preflight: '--phase intake|plan --run-dir <dir>  (deterministic checks; run before spawning a verifier)',
          anomalies: '[--dir <telemetry-clone>] [--repo <slug>] [--limit <n>]  (red-flag scan over recent records; exit 1 on findings)',
          'loop-state': '--target <path> --issue <n>  (next pipeline action for an issue: intake|plan|implement|done + stranded run)',
          'residue-scan': '--target <path> --issue <n>  (u1-shaped residue/defect notes for an issue from <target>/.harness/audit.jsonl; { items: [...] }, exit 0 even when empty)',
          'phase-end': '--run-dir <dir> --phase <p> --status <s> [--rounds n] [--score x] [--size S|M|L]',
          'run-end': '--target <path> --run-dir <dir> --status <s> [--reason-code c --reason-detail d] [--tokens-by-tier json]',
          'render-status-comment': '--phase <p> --status <s> --run-id <id> --next <text> [--size <S|M|L> --size-rationale <text>] [--plan-units <n> --plan-blocking <n>] [--pr-url <url>] [--notes <json-array>]  (print the templates/status-comment.md comment body to stdout)',
          'render-pr-body': '--issue <n> --summary <text> --run-id <id> [--change-type <t>] [--result-rows <json>] [--landing <json>] [--notes <json>]  (print the implement PR body — Closes-#, entry-contract table, landing checklist, run id, Advisory-residue section — to stdout)',
          'render-brief': '--file <path>  (validate a brief JSON against the brief schema and print the rendered seven-item Agent-tool prompt to stdout)',
          'tokens-finalize': '--tier <TIER>=<amount>[:estimated] [--tier ...]  (sum per-tier subagent-token observations; print { tokens_by_tier, tokens_note } — the note carries estimated:true when any observation is :estimated)',
          'loop-record': '--target <path> --issue <n> --actions <json> --outcome <s> --anomalies-scan <path> [--pr-url <url>] [--phase-run <phase>=<run_dir> ...] [--ts <iso>]  (compose one tick\'s loop.jsonl line from the anomalies scan + each dispatched run\'s tokens_observed, and append it to <target>/.harness/loop.jsonl)',
          'record-observed-tokens': '--run-dir <dir> --total <n> --tier LOW|MID|HIGH [--source <str>]  (add an externally-observed token total ALONGSIDE a finalized run\'s own tokens_by_tier — additive, never overwrites; re-syncs telemetry)',
          'tokens-collect': '--run-dir <dir> [--transcript <path>] [--mode loop|standalone] [--subagents-dir <dir>] [--project-dir <dir>] [--cwd <str>] [--gap-cap-ms <n>]  (parse a transcript and stamp additive tokens_directional onto record.json; degrades to estimated-with-note, exit 0, never crashes)',
          'backfill-directional': '--run-dir <dir> --subagents-dir <dir> [--start <iso>] [--end <iso>]  (backfill tokens_directional.by_model from a subagent transcript; exit 0 always, status resolved|unresolved)',
          quality: '--run-dir <dir>',
          config: '(no flags)',
          sweep: '--target <path>',
        },
      }, 1);
  }
} catch (err) {
  const code = err instanceof HarnessError && err.code === 'logging_unavailable' ? 2 : 1;
  emit({ error: err.message, code: err.code ?? null }, code);
}
