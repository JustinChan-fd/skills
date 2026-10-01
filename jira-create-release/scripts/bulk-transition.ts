// Move a list of Jira issues through one workflow transition: pre-check, canary, one bulk
// request, task polling, then a direct read of every issue. One process, no model turns.
//
//   node --experimental-strip-types scripts/bulk-transition.ts \
//     --keys TARS-1,TARS-2 --transition 71 --to "Deployed to STG" [--notify] [--dry-run]
//
// Prints one JSON object (Result) on stdout. Exit codes:
//   0 all moved   1 some failed   2 aborted (pre-check or canary; see `wrote`)
//   3 no credentials   4 bad usage
// Credentials: JIRA_EMAIL, JIRA_API_TOKEN, JIRA_BASE_URL from the environment, else the same
// three `export` lines in ~/.zshrc. They are never printed or logged.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export interface Creds { baseUrl: string; email: string; token: string }
export interface Opts {
  keys: string[];
  transitionId: string;
  toStatus: string;
  notify?: boolean;
  dryRun?: boolean;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}
export interface Deps { fetch: typeof fetch; sleep: (ms: number) => Promise<void> }
export interface Result {
  ok: boolean;
  exitCode: 0 | 1 | 2;
  wrote: boolean;
  dryRun: boolean;
  canary?: { key: string; status: string };
  taskId?: string;
  taskStatus?: string;
  moved: string[];
  failed: { key: string; reason: string }[];
  aborted?: string;
  notes: string[];
}

const NAMES = ["JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_BASE_URL"] as const;
const TERMINAL = new Set(["COMPLETE", "FAILED", "CANCELLED", "DEAD"]);
const KEY = /^[A-Z][A-Z0-9]+-\d+$/;

export function parseRc(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of NAMES) {
    const m = new RegExp(`^\\s*(?:export\\s+)?${name}=(?:"([^"]*)"|'([^']*)'|(\\S*))\\s*$`, "m").exec(text);
    const v = m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
    if (v) out[name] = v;
  }
  return out;
}

export function loadCreds(env: Record<string, string | undefined>, rcText = ""): Creds | null {
  const rc = parseRc(rcText);
  const get = (n: string) => env[n] || rc[n] || "";
  const email = get("JIRA_EMAIL"), token = get("JIRA_API_TOKEN"), baseUrl = get("JIRA_BASE_URL");
  return email && token && baseUrl ? { email, token, baseUrl: baseUrl.replace(/\/+$/, "") } : null;
}

async function api(c: Creds, d: Deps, method: string, path: string, body?: unknown) {
  const res = await d.fetch(c.baseUrl + path, {
    method,
    headers: {
      Authorization: "Basic " + Buffer.from(`${c.email}:${c.token}`).toString("base64"),
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, json, text: text.slice(0, 200) };
}

export async function bulkTransition(c: Creds, o: Opts, d: Deps): Promise<Result> {
  const r: Result = { ok: false, exitCode: 2, wrote: false, dryRun: !!o.dryRun, moved: [], failed: [], notes: [] };
  const abort = (why: string): Result => { r.aborted = why; return r; };
  const keys = [...new Set(o.keys)];
  if (keys.length === 0) return abort("no keys given");

  // 1. Pre-check (read only): every key must be offered this exact transition, to the expected status.
  const pre = await api(c, d, "GET", `/rest/api/3/bulk/issues/transition?issueIdsOrKeys=${keys.join(",")}`);
  if (pre.status !== 200) return abort(`pre-check failed: HTTP ${pre.status} ${pre.text}`);
  if (pre.json?.startingAfter || pre.json?.endingBefore) {
    return abort("pre-check response is paginated; refusing to continue on a partial view");
  }
  const covered = new Set<string>();
  const bad: string[] = [];
  for (const g of pre.json?.availableTransitions ?? []) {
    const t = (g.transitions ?? []).find((x: any) => String(x.transitionId) === o.transitionId);
    const ok = !!t && t.to?.statusName === o.toStatus;
    for (const k of g.issues ?? []) { covered.add(k); if (!ok) bad.push(k); }
  }
  const missing = keys.filter((k) => !covered.has(k));
  if (bad.length || missing.length) {
    return abort(
      `transition ${o.transitionId} -> "${o.toStatus}" is not offered for: ` +
        [...bad, ...missing.map((k) => `${k} (not returned)`)].join(", "),
    );
  }
  if (o.dryRun) {
    r.notes.push(`dry run: pre-check passed for ${keys.length} issues; would canary ${keys[0]} then bulk ${keys.length - 1}`);
    r.ok = true; r.exitCode = 0;
    return r;
  }

  // 2. Canary: move one issue alone and confirm its new status before touching the rest.
  const canary = keys[0];
  const one = await api(c, d, "POST", `/rest/api/3/issue/${canary}/transitions`, { transition: { id: o.transitionId } });
  if (one.status !== 204) return abort(`canary ${canary} transition failed: HTTP ${one.status} ${one.text}`);
  r.wrote = true;
  const after = await api(c, d, "GET", `/rest/api/3/issue/${canary}?fields=status`);
  const canaryStatus: string = after.json?.fields?.status?.name ?? "?";
  r.canary = { key: canary, status: canaryStatus };
  if (canaryStatus !== o.toStatus) {
    return abort(`canary ${canary} is "${canaryStatus}", expected "${o.toStatus}"; the other ${keys.length - 1} were not touched`);
  }

  // 3. Everything else in one bulk request, then poll the task.
  const rest = keys.slice(1);
  if (rest.length) {
    const sub = await api(c, d, "POST", "/rest/api/3/bulk/issues/transition", {
      bulkTransitionInputs: [{ selectedIssueIdsOrKeys: rest, transitionId: o.transitionId }],
      sendBulkNotification: !!o.notify,
    });
    if (sub.status !== 201 || !sub.json?.taskId) {
      return abort(`bulk submit failed: HTTP ${sub.status} ${sub.text}; only the canary ${canary} moved`);
    }
    r.taskId = String(sub.json.taskId);
    const interval = o.pollIntervalMs ?? 2000;
    const polls = Math.max(1, Math.ceil((o.pollTimeoutMs ?? 120000) / interval));
    let task: any;
    for (let i = 0; i < polls; i++) {
      task = (await api(c, d, "GET", `/rest/api/3/bulk/queue/${r.taskId}`)).json;
      r.taskStatus = task?.status;
      if (task && TERMINAL.has(task.status)) break;
      await d.sleep(interval);
    }
    if (!task || !TERMINAL.has(task.status)) {
      r.taskStatus = "TIMEOUT";
      r.notes.push(`task ${r.taskId} did not finish in time; the per-issue check below shows the real state`);
    }
    (r as any)._failedById = task?.failedAccessibleIssues ?? {};
  }

  // 4. Verify by reading every issue directly (search results lag behind writes).
  const reads = await Promise.all(keys.map(async (k) => {
    const g = await api(c, d, "GET", `/rest/api/3/issue/${k}?fields=status`);
    return { key: k, id: String(g.json?.id ?? ""), status: g.json?.fields?.status?.name as string | undefined, http: g.status };
  }));
  const byId: Record<string, string[]> = (r as any)._failedById ?? {};
  delete (r as any)._failedById;
  for (const x of reads) {
    if (x.status === o.toStatus) r.moved.push(x.key);
    else r.failed.push({
      key: x.key,
      reason: byId[x.id]?.join("; ") || (x.status ? `status is "${x.status}", expected "${o.toStatus}"` : `could not read issue (HTTP ${x.http})`),
    });
  }
  r.ok = r.failed.length === 0;
  r.exitCode = r.ok ? 0 : 1;
  return r;
}

function parseArgs(argv: string[]): Opts | string {
  const o: Opts = { keys: [], transitionId: "", toStatus: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keys") o.keys = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--transition") o.transitionId = argv[++i] ?? "";
    else if (a === "--to") o.toStatus = argv[++i] ?? "";
    else if (a === "--notify") o.notify = true;
    else if (a === "--dry-run") o.dryRun = true;
    else return `unknown argument: ${a}`;
  }
  if (!o.keys.length) return "--keys is required";
  const badKey = o.keys.find((k) => !KEY.test(k));
  if (badKey) return `not an issue key: ${badKey}`;
  if (!/^\d+$/.test(o.transitionId)) return "--transition must be a numeric id";
  if (!o.toStatus) return "--to (expected target status name) is required";
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (typeof opts === "string") { console.error(opts); process.exit(4); }
  let rc = "";
  try { rc = readFileSync(`${homedir()}/.zshrc`, "utf8"); } catch { /* no rc file */ }
  const creds = loadCreds(process.env, rc);
  if (!creds) {
    console.error("JIRA_EMAIL, JIRA_API_TOKEN and JIRA_BASE_URL are not set (env or ~/.zshrc)");
    process.exit(3);
  }
  const res = await bulkTransition(creds, opts, { fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.exitCode);
}

if (import.meta.main) main();
