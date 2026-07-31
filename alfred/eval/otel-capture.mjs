// otel-capture — re-run the OTel capture that left a confounder unseparated.
//
// WHAT THIS ANSWERS. On 2026-07-30 one `claude -p` through the Bedrock gateway reported
// FOUR model ids for ONE session: the `api_request` log said `claude-haiku-4-5-20251001`
// while three other fields said `sonney`, and the single reported cost of $0.291135
// reconciles to **opus-5 $5/$25 to seven decimals** while naming haiku. Two explanations
// were live and the run could not distinguish them:
//
//   H1  the `"model": "sonney"` typo in ~/.claude/settings.json was the whole story
//   H2  Bedrock-style ids miss Claude Code's internal price table regardless of the typo
//
// The typo is now fixed. This script re-runs the capture so the two come apart. It is a
// DIAGNOSTIC, not part of a run: nothing here is imported by lib/, and Alfred never calls it.
//
// WHY IT IS PRE-REGISTERED. The prediction below is printed BEFORE the run and compared
// after, because a hypothesis written while reading the result is not a hypothesis. This is
// the same discipline `docs/EXPERIMENT-2.md` applies to the arms.
//
// SHARPER HYPOTHESIS THAN "THE TYPO DID IT". The 2026-07-30 record also carried
// `contextWindow: 200000` and `maxOutputTokens: 32000`, which match NEITHER sonnet-5
// (1M/128k) nor haiku-4-5. So Claude Code did not merely mislabel a known model — it
// failed to recognize `sonney` at all and fell back to defaults, and the default rate
// table it fell back to appears to be the most expensive one. If that is right, H2 is the
// real risk and it survives the typo fix: ANY id Claude Code cannot resolve prices high.
// A gateway that renames a model is then a silent cost-inflation surface, and
// `cost_usd_micros` is not merely unreliable, it is unreliable in the expensive direction.
//
// USAGE
//   node eval/otel-capture.mjs                 # capture + report
//   node eval/otel-capture.mjs --dry-run       # print the plan and the env block, run nothing
//
// MUST BE RUN FROM A SHELL THAT POST-DATES THE .zshrc FIX. A pre-restart process inherits
// ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic.claude-sonnet-4-6, which would stamp the very
// field under test with a stale value. The script refuses to run in that case rather than
// producing a number that reads clean and is not.

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 43188;
const DRY = process.argv.includes('--dry-run');

// The prompt. Deliberately trivial, deterministic and single-turn: this measures the
// TELEMETRY PATH, not the model's ability. A prompt that makes the model think would add
// output-token variance to the one number we are trying to reconcile against a rate table.
// It must also not read a file or call a tool — a tool call would add an `api_request`
// record and change the payload shape being compared against 2026-07-30's six payloads.
const PROMPT = 'Reply with exactly the word: ack. No punctuation, no explanation.';

// ---------------------------------------------------------------------------
// The content flags that must stay unset. Standing rule, and the reason is on the tin:
// OTEL_LOG_RAW_API_BODIES writes the entire conversation history, and its `file:<dir>`
// form writes untruncated bodies to disk. A capture that leaks a transcript is worse than
// no capture, so this is a hard refusal rather than a warning.
const FORBIDDEN = [
  'OTEL_LOG_USER_PROMPTS',
  'OTEL_LOG_ASSISTANT_RESPONSES',
  'OTEL_LOG_TOOL_DETAILS',
  'OTEL_LOG_TOOL_CONTENT',
  'OTEL_LOG_RAW_API_BODIES',
];

export function contentFlagViolations(env) {
  return FORBIDDEN.filter((k) => {
    const v = env[k];
    // Present-and-falsy is fine; present-and-truthy is the leak. `absent` is the norm.
    return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
  });
}

// Is this shell one that post-dates the .zshrc fix? The tell is the seat env: a tool shell
// in a pre-fix session inherits the old sonnet id from its parent `claude` process and
// cannot see the corrected file, because a non-interactive zsh sources no startup file.
export function staleSeatEnv(env) {
  const problems = [];
  const sonnet = env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  const opus = env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  if (sonnet !== undefined && sonnet !== 'anthropic.claude-sonnet-5') {
    problems.push(`ANTHROPIC_DEFAULT_SONNET_MODEL=${JSON.stringify(sonnet)} (want anthropic.claude-sonnet-5)`);
  }
  if (opus === undefined || opus === '') {
    problems.push('ANTHROPIC_DEFAULT_OPUS_MODEL is absent — the pre-fix .zshrc never exported it');
  } else if (opus !== 'anthropic.claude-opus-5') {
    problems.push(`ANTHROPIC_DEFAULT_OPUS_MODEL=${JSON.stringify(opus)} (want anthropic.claude-opus-5)`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Rate reconciliation. Which table, if any, explains the reported dollar figure?
//
// `at`-never-`now()`: these are the list rates as of the 2026-07-30 seat move, named here
// rather than imported from lib/prices.mjs ON PURPOSE. This script's job is to check
// whether an EXTERNAL price table agrees with ours; importing ours would make the
// comparison circular — the classic shape of a test that cannot fail.
const TABLES = Object.freeze({
  'opus-5 $5/$25': { in: 5, out: 25 },
  'sonnet-5 $3/$15': { in: 3, out: 15 },
  'sonnet-5 intro $2/$10': { in: 2, out: 10 },
  'haiku-4-5 $1/$5': { in: 1, out: 5 },
});

// 5-minute cache writes bill at 1.25x input. Cache reads bill at 0.1x.
export function reconcile({ inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens }) {
  const out = [];
  for (const [label, r] of Object.entries(TABLES)) {
    const usd =
      (inputTokens * r.in) / 1e6 +
      (outputTokens * r.out) / 1e6 +
      (cacheCreationInputTokens * r.in * 1.25) / 1e6 +
      (cacheReadInputTokens * r.in * 0.1) / 1e6;
    out.push({ label, usd });
  }
  return out;
}

// Pull every `model` attribute out of an OTLP/JSON payload, tagged with where it came from,
// so the four sources can be laid side by side instead of summarized.
export function modelIdsFromOtlp(payload, kind) {
  const found = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, path));
      return;
    }
    if (node === null || typeof node !== 'object') return;
    // An OTLP attribute list: [{key, value:{stringValue}}, ...]
    if (Array.isArray(node.attributes)) {
      const named = node.attributes.find((a) => a?.key === 'model');
      if (named) {
        const v = named.value ?? {};
        const raw = v.stringValue ?? v.intValue ?? v.doubleValue ?? JSON.stringify(v);
        found.push({ kind, where: node.name ?? path, model: String(raw) });
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'attributes') continue;
      walk(v, node.name ?? k);
    }
  };
  walk(payload, kind);
  return found;
}

// ---------------------------------------------------------------------------
function envBlock(outDir, runId) {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${PORT}`,
    // Short intervals so both signals flush before the process exits. The 2026-07-30
    // capture got six payloads because the run outlived the default interval; a shorter
    // prompt might not, and a missing metrics payload would look like "no disagreement".
    OTEL_METRIC_EXPORT_INTERVAL: '2000',
    OTEL_LOGS_EXPORT_INTERVAL: '2000',
    // The join key, per-process. This is exactly why these vars never go in .zshrc: a
    // global run_id is either stale or unbounded-cardinality, and both poison a collector.
    OTEL_RESOURCE_ATTRIBUTES: `harness.run_id=${runId},harness.arm=diagnostic,harness.purpose=otel-model-id-reconfirm`,
    OTEL_SERVICE_NAME: 'alfred-otel-capture',
  };
}

function main() {
  const stamp = process.env.OTEL_CAPTURE_STAMP ?? 'unstamped';
  const runId = `otelcap-${stamp}`;
  // Default OUTSIDE the repo. Capture artifacts are diagnostic scratch — OTLP bodies, a
  // stdout dump, a listener — and nothing here is evidence worth committing. Writing them
  // into the working tree would leave untracked files that `.gitignore` does not cover, and
  // the telemetry sink has already taught this lesson once: `syncRun`'s `git add -A` absorbs
  // whatever happens to be lying around. Override with OTEL_CAPTURE_DIR to keep a run.
  const outDir =
    process.env.OTEL_CAPTURE_DIR ??
    join(process.env.CLAUDE_JOB_DIR ?? process.env.TMPDIR ?? '/tmp', `otel-capture-${stamp}`);
  const block = envBlock(outDir, runId);

  console.log('=== PRE-REGISTERED PREDICTION (written before the run, compared after) ===');
  console.log(`
BASELINE, 2026-07-30, session 14171034-fc61-4932-881f-dd10b6293aa6:
  api_request log ...... claude-haiku-4-5-20251001
  cost.usage metric .... sonney
  token.usage metric ... sonney
  result.json .......... sonney   (canonicalModel sonney, ctx 200000, maxOut 32000)
  reported cost ........ $0.291135  == opus-5 $5/$25 exactly, on 4642/264/0/41812

PREDICTIONS, each independently falsifiable:

  P1  All four sources now agree on ONE id, and it contains "sonnet".
      If they still disagree, the typo was NOT the cause and the disagreement is
      structural in the Bedrock path. That is the finding that matters.

  P2  The reported cost reconciles to the sonnet-5 table, not the opus-5 table.
      If it still prices to opus-5 while naming sonnet, then H2 holds: an id Claude Code
      cannot resolve prices HIGH, and cost_usd_micros is wrong in the expensive
      direction. gaps.mjs's "disagreement detector, never the cost source" rule is then
      permanent, not provisional.

  P3  contextWindow reports 1000000 and maxOutputTokens 128000.
      200000/32000 would mean the id is STILL unresolved and defaults are still being
      substituted — the sharper reading of the original finding, and the one that makes
      this a live risk for arm C rather than a closed curiosity.

  P1 and P2 can dissociate. Agreeing ids with an opus-priced figure is possible and would
  be the worst case: it looks fixed and bills wrong.
`);

  const violations = contentFlagViolations(process.env);
  if (violations.length > 0) {
    console.error(`REFUSING TO RUN. Content-capture flags are set: ${violations.join(', ')}.`);
    console.error('These write prompt/response/tool content — RAW_API_BODIES writes the whole');
    console.error('conversation history to disk. Unset them and re-run.');
    process.exit(2);
  }

  const stale = staleSeatEnv(process.env);
  if (stale.length > 0) {
    console.error('REFUSING TO RUN — this shell pre-dates the .zshrc fix:');
    for (const p of stale) console.error(`  - ${p}`);
    console.error('');
    console.error('A non-interactive zsh sources no startup file, so this process inherits its');
    console.error('parent claude process\'s snapshot and cannot see the corrected .zshrc. Running');
    console.error('here would stamp the very field under test with a stale value.');
    console.error('');
    console.error('FIX: restart Claude Code (or run this from a fresh terminal), then re-run.');
    console.error('Verify with:  zsh -i -l -c \'echo $ANTHROPIC_DEFAULT_SONNET_MODEL\'');
    process.exit(3);
  }

  console.log('=== ENV BLOCK (per-process, never .zshrc) ===');
  for (const [k, v] of Object.entries(block)) console.log(`  ${k}=${v}`);
  console.log(`\n=== PROMPT ===\n  ${PROMPT}\n`);
  console.log(`=== OUT DIR ===\n  ${outDir}\n`);

  if (DRY) {
    console.log('--dry-run: nothing executed.');
    return;
  }

  mkdirSync(outDir, { recursive: true });

  const listenerPath = join(outDir, 'listener.mjs');
  writeFileSync(listenerPath, LISTENER_SRC);

  const listener = spawn(process.execPath, [listenerPath, String(PORT), outDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  listener.stderr.on('data', (d) => process.stderr.write(`[listener] ${d}`));

  // Give the listener a moment to bind. A busy port means a previous capture is still
  // running; the listener will exit and the run would silently export to nowhere.
  const waited = spawnSync(process.execPath, [
    '-e',
    `const t=Date.now();while(Date.now()-t<1200);`,
  ]);
  if (waited.status !== 0) console.error('warning: listener settle step returned nonzero');

  console.log('=== RUNNING (one cheap single-turn prompt) ===');
  const res = spawnSync('claude', ['-p', PROMPT, '--output-format', 'json'], {
    env: { ...process.env, ...block },
    encoding: 'utf8',
    timeout: 180_000,
  });

  writeFileSync(join(outDir, 'stdout.json'), res.stdout ?? '');
  writeFileSync(join(outDir, 'stderr.txt'), res.stderr ?? '');

  // Let the exporters flush past the 2s interval before killing the listener.
  spawnSync(process.execPath, ['-e', `const t=Date.now();while(Date.now()-t<4000);`]);
  listener.kill('SIGTERM');

  report(outDir, res);
}

function report(outDir, res) {
  console.log('\n=== OBSERVED ===');
  console.log(`claude exit=${res.status} signal=${res.signal ?? 'none'}`);

  let result = null;
  try {
    result = JSON.parse(readFileSync(join(outDir, 'stdout.json'), 'utf8'));
  } catch {
    console.log('could not parse --output-format json stdout; see stdout.json / stderr.txt');
  }

  const sources = [];

  if (result?.modelUsage) {
    for (const [key, u] of Object.entries(result.modelUsage)) {
      sources.push({ kind: 'result.json modelUsage', where: 'key', model: key });
      if (u.canonicalModel) {
        sources.push({ kind: 'result.json', where: 'canonicalModel', model: u.canonicalModel });
      }
      console.log(`\nresult.json modelUsage["${key}"]:`);
      console.log(`  tokens in/out/cacheRead/cacheWrite = ${u.inputTokens}/${u.outputTokens}/${u.cacheReadInputTokens}/${u.cacheCreationInputTokens}`);
      console.log(`  costUSD ......... ${u.costUSD}`);
      console.log(`  contextWindow ... ${u.contextWindow}   (P3 wants 1000000)`);
      console.log(`  maxOutputTokens . ${u.maxOutputTokens}  (P3 wants 128000)`);

      console.log('\n  cost reconciliation against external rate tables:');
      const rows = reconcile({
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        cacheCreationInputTokens: u.cacheCreationInputTokens ?? 0,
        cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
      });
      for (const r of rows) {
        const hit = Math.abs(r.usd - (u.costUSD ?? -1)) < 1e-7 ? '  <== MATCHES REPORTED' : '';
        console.log(`    ${r.label.padEnd(24)} $${r.usd.toFixed(7)}${hit}`);
      }
    }
  }

  // The OTLP payloads the listener caught.
  const bodies = existsSync(outDir)
    ? readdirSync(outDir).filter((f) => f.startsWith('body-') && f.endsWith('.bin')).sort()
    : [];
  console.log(`\nOTLP payloads captured: ${bodies.length}`);
  let index = [];
  try {
    index = readFileSync(join(outDir, 'index.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  } catch { /* index may be absent if the listener never bound */ }

  for (const f of bodies) {
    const meta = index.find((r) => r.n === Number(f.slice(5, 8)));
    const kind = meta?.path ?? f;
    try {
      const payload = JSON.parse(readFileSync(join(outDir, f), 'utf8'));
      for (const m of modelIdsFromOtlp(payload, kind)) sources.push(m);
    } catch {
      console.log(`  ${f}: not JSON (protobuf?) — cannot extract model ids`);
    }
  }

  console.log('\n=== EVERY MODEL ID, BY SOURCE (P1) ===');
  if (sources.length === 0) {
    console.log('  NONE FOUND. That is itself a result: either telemetry did not export or');
    console.log('  the payload shape changed. Do not read it as agreement.');
  }
  for (const s of sources) console.log(`  ${s.kind.padEnd(28)} ${String(s.where).padEnd(22)} ${s.model}`);

  const distinct = [...new Set(sources.map((s) => s.model))];
  console.log(`\n  distinct ids = ${distinct.length}: ${JSON.stringify(distinct)}`);
  console.log(
    distinct.length === 1
      ? '  P1 HOLDS if that id names sonnet — the typo explained the disagreement.'
      : '  P1 FAILS — the disagreement is structural, not the typo. This is the finding.',
  );

  writeFileSync(
    join(outDir, 'capture-record.json'),
    JSON.stringify(
      {
        purpose: 'otel model-id + cost reconciliation, re-run after the sonney typo fix',
        claude_exit: res.status,
        distinct_model_ids: distinct,
        sources,
        result_usage: result?.usage ?? null,
        result_model_usage: result?.modelUsage ?? null,
        total_cost_usd: result?.total_cost_usd ?? null,
        session_id: result?.session_id ?? null,
        otlp_payloads: index,
        baseline_2026_07_30: {
          distinct_model_ids: ['claude-haiku-4-5-20251001', 'sonney'],
          cost_usd: 0.291135,
          reconciled_to: 'opus-5 $5/$25',
          context_window: 200000,
          max_output_tokens: 32000,
        },
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`\nrecord written: ${join(outDir, 'capture-record.json')}`);
}

// Kept inline so the capture is one file with no sibling to go missing. Node built-ins
// only, binds 127.0.0.1, writes to disk, nothing leaves the machine.
const LISTENER_SRC = `import { createServer } from 'node:http';
import { writeFileSync, appendFileSync } from 'node:fs';

const PORT = Number(process.argv[2] ?? 43188);
const OUT = process.argv[3] ?? '.';
let n = 0;

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    n += 1;
    const ct = req.headers['content-type'] ?? 'none';
    writeFileSync(\\\`\\\${OUT}/body-\\\${String(n).padStart(3, '0')}.bin\\\`, body);
    appendFileSync(
      \\\`\\\${OUT}/index.jsonl\\\`,
      JSON.stringify({ n, path: req.url, content_type: ct, bytes: body.length }) + '\\\\n',
    );
    res.writeHead(200, {
      'content-type': ct.includes('json') ? 'application/json' : 'application/x-protobuf',
    });
    res.end(ct.includes('json') ? '{}' : '');
  });
});

server.listen(PORT, '127.0.0.1', () => {
  appendFileSync(\\\`\\\${OUT}/index.jsonl\\\`, JSON.stringify({ listening: PORT }) + '\\\\n');
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
`;

// Only run when invoked directly, so the pure functions above stay testable.
if (import.meta.url === `file://${process.argv[1]}`) main();
