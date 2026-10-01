// Run with: node --experimental-strip-types --test scripts/bulk-transition.test.ts
// (from jira-create-release/). Uses a fake Jira; makes no network calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bulkTransition, loadCreds, parseRc, type Creds, type Opts } from "./bulk-transition.ts";

const creds: Creds = { baseUrl: "https://example.atlassian.net", email: "a@b.c", token: "tok" };
const KEYS = ["T-1", "T-2", "T-3"];
const opts: Opts = { keys: KEYS, transitionId: "71", toStatus: "Deployed to STG", pollIntervalMs: 1, pollTimeoutMs: 5 };

interface Fake {
  precheck?: any;                 // body for GET /bulk/issues/transition
  precheckStatus?: number;
  canaryStatus?: number;          // POST /issue/T-1/transitions
  statusAfterCanary?: string;
  submitStatus?: number;
  taskSequence?: any[];           // successive GET /bulk/queue bodies
  finalStatus?: Record<string, string>;
  failedById?: Record<string, string[]>;
}
const offered = (keys = KEYS, id = 71, to = "Deployed to STG") => ({
  availableTransitions: [{ issues: keys, isTransitionsFiltered: false, transitions: [{ transitionId: id, transitionName: "Deployed", to: { statusName: to } }] }],
});

function fakeJira(f: Fake) {
  const calls: string[] = [];
  const idOf = (k: string) => String(100 + Number(k.split("-")[1]));
  let polls = 0;
  const reply = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body), { status });
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const path = url.replace(creds.baseUrl, "");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (method === "GET" && path.startsWith("/rest/api/3/bulk/issues/transition")) return reply(f.precheckStatus ?? 200, f.precheck ?? offered());
    if (method === "POST" && /\/issue\/T-1\/transitions$/.test(path)) return reply(f.canaryStatus ?? 204);
    if (method === "GET" && /\/issue\/T-\d+\?fields=status/.test(path)) {
      const k = /issue\/(T-\d+)/.exec(path)![1];
      const canaryDone = calls.some((c) => c.startsWith("POST") && c.includes("/issue/T-1/transitions"));
      const status = f.finalStatus?.[k] ?? (k === "T-1" && canaryDone ? f.statusAfterCanary ?? "Deployed to STG" : "Ready for Release");
      return reply(200, { id: idOf(k), key: k, fields: { status: { name: status } } });
    }
    if (method === "POST" && path === "/rest/api/3/bulk/issues/transition") return reply(f.submitStatus ?? 201, { taskId: "9" });
    if (method === "GET" && path === "/rest/api/3/bulk/queue/9") {
      const seq = f.taskSequence ?? [{ status: "COMPLETE", failedAccessibleIssues: f.failedById ?? {} }];
      return reply(200, seq[Math.min(polls++, seq.length - 1)]);
    }
    return reply(404, "unexpected " + method + " " + path);
  }) as typeof fetch;
  return { fetch: fakeFetch, calls, sleep: async () => {} };
}
const run = (f: Fake, o: Opts = opts) => { const j = fakeJira(f); return bulkTransition(creds, o, j).then((r) => ({ r, calls: j.calls })); };
const wrote = (calls: string[]) => calls.filter((c) => c.startsWith("POST"));

test("happy path: canary first, one bulk request for the rest, all verified", async () => {
  const { r, calls } = await run({ finalStatus: { "T-1": "Deployed to STG", "T-2": "Deployed to STG", "T-3": "Deployed to STG" } });
  assert.equal(r.ok, true); assert.equal(r.exitCode, 0); assert.equal(r.wrote, true);
  assert.deepEqual(r.moved.sort(), KEYS); assert.deepEqual(r.failed, []);
  assert.deepEqual(r.canary, { key: "T-1", status: "Deployed to STG" });
  assert.equal(wrote(calls).length, 2);                       // one canary + one bulk, never one per ticket
  assert.ok(calls.indexOf("POST /rest/api/3/issue/T-1/transitions") < calls.indexOf("POST /rest/api/3/bulk/issues/transition"));
});

test("the bulk request carries only the remaining keys, the transition id and notifications off", async () => {
  const j = fakeJira({ finalStatus: { "T-1": "Deployed to STG", "T-2": "Deployed to STG", "T-3": "Deployed to STG" } });
  let body: any;
  const inner = j.fetch;
  const spy = (async (u: string, i?: RequestInit) => { if (i?.method === "POST" && u.endsWith("/bulk/issues/transition")) body = JSON.parse(String(i.body)); return inner(u, i); }) as typeof fetch;
  await bulkTransition(creds, opts, { fetch: spy, sleep: j.sleep });
  assert.deepEqual(body, { bulkTransitionInputs: [{ selectedIssueIdsOrKeys: ["T-2", "T-3"], transitionId: "71" }], sendBulkNotification: false });
});

test("dry run passes the pre-check and writes nothing", async () => {
  const { r, calls } = await run({}, { ...opts, dryRun: true });
  assert.equal(r.ok, true); assert.equal(r.wrote, false); assert.equal(wrote(calls).length, 0);
});

test("transition not offered for one issue aborts before any write", async () => {
  const pre = { availableTransitions: [
    { issues: ["T-1", "T-2"], transitions: [{ transitionId: 71, to: { statusName: "Deployed to STG" } }] },
    { issues: ["T-3"], transitions: [{ transitionId: 41, to: { statusName: "Blocked" } }] },
  ] };
  const { r, calls } = await run({ precheck: pre });
  assert.equal(r.ok, false); assert.equal(r.exitCode, 2); assert.equal(r.wrote, false);
  assert.match(r.aborted!, /T-3/); assert.equal(wrote(calls).length, 0);
});

test("same transition id leading to a different status aborts", async () => {
  const { r, calls } = await run({ precheck: offered(KEYS, 71, "Done") });
  assert.equal(r.exitCode, 2); assert.match(r.aborted!, /not offered/); assert.equal(wrote(calls).length, 0);
});

test("a key the pre-check never returns aborts before any write", async () => {
  const { r, calls } = await run({ precheck: offered(["T-1", "T-2"]) });
  assert.match(r.aborted!, /T-3 \(not returned\)/); assert.equal(wrote(calls).length, 0);
});

test("pre-check HTTP error aborts; nothing written", async () => {
  const { r, calls } = await run({ precheckStatus: 403 });
  assert.equal(r.exitCode, 2); assert.match(r.aborted!, /403/); assert.equal(wrote(calls).length, 0);
});

test("a paginated pre-check is refused rather than trusted", async () => {
  const { r, calls } = await run({ precheck: { ...offered(), startingAfter: "abc" } });
  assert.match(r.aborted!, /paginated/); assert.equal(wrote(calls).length, 0);
});

test("bad canary status stops the run: one write, the rest untouched", async () => {
  const { r, calls } = await run({ statusAfterCanary: "Blocked" });
  assert.equal(r.exitCode, 2); assert.equal(r.wrote, true);
  assert.match(r.aborted!, /canary T-1 is "Blocked".*other 2 were not touched/);
  assert.equal(wrote(calls).length, 1);
  assert.ok(!calls.includes("POST /rest/api/3/bulk/issues/transition"));
});

test("canary HTTP failure stops the run before the bulk request", async () => {
  const { r, calls } = await run({ canaryStatus: 400 });
  assert.equal(r.exitCode, 2); assert.equal(r.wrote, false); assert.ok(!calls.includes("POST /rest/api/3/bulk/issues/transition"));
});

test("rejected bulk submit reports that only the canary moved", async () => {
  const { r } = await run({ submitStatus: 403 });
  assert.equal(r.exitCode, 2); assert.equal(r.wrote, true); assert.match(r.aborted!, /only the canary T-1 moved/);
});

test("a ticket that fails inside the task is reported with its reason, the others still count as moved", async () => {
  const { r } = await run({
    finalStatus: { "T-1": "Deployed to STG", "T-2": "Deployed to STG", "T-3": "Ready for Release" },
    failedById: { "103": ["Transition requires a resolution"] },
  });
  assert.equal(r.ok, false); assert.equal(r.exitCode, 1);
  assert.deepEqual(r.moved.sort(), ["T-1", "T-2"]);
  assert.deepEqual(r.failed, [{ key: "T-3", reason: "Transition requires a resolution" }]);
});

test("a ticket whose status is wrong with no task error still fails, with the status in the reason", async () => {
  const { r } = await run({ finalStatus: { "T-1": "Deployed to STG", "T-2": "Deployed to STG", "T-3": "Blocked" } });
  assert.equal(r.exitCode, 1); assert.match(r.failed[0].reason, /status is "Blocked"/);
});

test("task that never finishes is flagged as a timeout and judged by the per-issue read", async () => {
  const { r } = await run({ taskSequence: [{ status: "RUNNING" }], finalStatus: { "T-1": "Deployed to STG", "T-2": "Deployed to STG", "T-3": "Deployed to STG" } });
  assert.equal(r.taskStatus, "TIMEOUT"); assert.equal(r.ok, true);
  assert.ok(r.notes.some((n) => /did not finish/.test(n)));
});

test("polls until the task reaches a terminal status", async () => {
  const { r, calls } = await run({ taskSequence: [{ status: "ENQUEUED" }, { status: "RUNNING" }, { status: "COMPLETE" }], finalStatus: { "T-1": "Deployed to STG", "T-2": "Deployed to STG", "T-3": "Deployed to STG" } }, { ...opts, pollTimeoutMs: 50 });
  assert.equal(r.taskStatus, "COMPLETE"); assert.equal(calls.filter((c) => c.includes("/bulk/queue/")).length, 3);
});

test("duplicate keys are collapsed; empty input aborts", async () => {
  const dup = await run({ finalStatus: { "T-1": "Deployed to STG", "T-2": "Deployed to STG", "T-3": "Deployed to STG" } }, { ...opts, keys: ["T-1", "T-2", "T-3", "T-1"] });
  assert.equal(dup.r.moved.length, 3);
  const none = await run({}, { ...opts, keys: [] });
  assert.equal(none.r.exitCode, 2); assert.match(none.r.aborted!, /no keys/);
});

test("single key: canary only, no bulk request", async () => {
  const { r, calls } = await run({ precheck: offered(["T-1"]), finalStatus: { "T-1": "Deployed to STG" } }, { ...opts, keys: ["T-1"] });
  assert.equal(r.ok, true); assert.ok(!calls.includes("POST /rest/api/3/bulk/issues/transition"));
});

// ---- credentials ----

test("parseRc reads quoted, single-quoted and bare export lines and ignores empty values", () => {
  const rc = `export PATH=/x\nexport JIRA_EMAIL="me@x.com"\nexport JIRA_API_TOKEN='abc=def'\nJIRA_BASE_URL=https://x.atlassian.net\n`;
  assert.deepEqual(parseRc(rc), { JIRA_EMAIL: "me@x.com", JIRA_API_TOKEN: "abc=def", JIRA_BASE_URL: "https://x.atlassian.net" });
  assert.deepEqual(parseRc('export JIRA_EMAIL=""\n'), {});
});

test("loadCreds prefers the environment, falls back to the rc file, returns null when incomplete", () => {
  const rc = 'export JIRA_EMAIL="rc@x.com"\nexport JIRA_API_TOKEN="rctok"\nexport JIRA_BASE_URL="https://x.atlassian.net/"\n';
  assert.deepEqual(loadCreds({}, rc), { email: "rc@x.com", token: "rctok", baseUrl: "https://x.atlassian.net" });
  assert.equal(loadCreds({ JIRA_EMAIL: "env@x.com" }, rc)!.email, "env@x.com");
  assert.equal(loadCreds({}, 'export JIRA_EMAIL="a"\n'), null);
});

test("credentials never appear in a result", async () => {
  const { r } = await run({ finalStatus: { "T-1": "Deployed to STG", "T-2": "Deployed to STG", "T-3": "Deployed to STG" } });
  const text = JSON.stringify(r);
  assert.ok(!text.includes(creds.token) && !text.includes(creds.email));
});
