// Run with: node --experimental-strip-types --test scripts/baseline.test.ts
// (from jira-create-release/). No package.json/dependency needed -- uses node:test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkTicketFields, EXPECTED, NEVER_FILL } from "./baseline.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const golden = () => JSON.parse(read("./fixtures/TARS-1501.fields.json"));
const config = JSON.parse(read("../configs/TARS.json")).Release;
const VERSION = read("../VERSION").trim();
const real = { version: "1.0.2", dev: false, transitioned: true, assigneeAccountId: "5cd20ecadfe2e60fdd10ed30" };

const mutate = (fn: (f: any) => void) => { const f = golden(); fn(f); return f; };
const fails = (f: any, needle: string, opts = real) => {
  const errs = checkTicketFields(f, opts);
  assert.ok(errs.some((e) => e.includes(needle)), `expected an error containing "${needle}", got: ${JSON.stringify(errs)}`);
};

// ---- the golden ticket passes ----

test("TARS-1501 (first end-to-end skill run) satisfies the baseline", () => {
  assert.deepEqual(checkTicketFields(golden(), real), []);
});

// ---- each baseline rule actually fires ----

test("missing version label fails", () => fails(mutate((f) => { f.labels = []; }), "labels must include"));
test("dev label on a real ticket fails", () => fails(mutate((f) => { f.labels.push("jira-create-release-dev"); }), "must not carry the dev label"));
test("cab_ovrd label fails", () => fails(mutate((f) => { f.labels.push("cab_ovrd"); }), "cab_ovrd"));
test("title without the real-run format fails", () => fails(mutate((f) => { f.summary = "[DEV] Release webtarsthree 3.13.23-beta"; }), "summary must be"));
test("two fix versions fail", () => fails(mutate((f) => { f.fixVersions.push({ name: "3.13.22-beta" }); }), "exactly one"));
test("wrong status fails", () => fails(mutate((f) => { f.status.name = "On-Hold"; }), "status must be Pending Approvals"));
test("unassigned fails", () => fails(mutate((f) => { f.assignee = null; }), "must be assigned"));
test("other assignee fails", () => fails(mutate((f) => { f.assignee.accountId = "someone-else"; }), "invoking user"));
test("wrong Release Type fails", () => fails(mutate((f) => { f.customfield_14308 = { value: "Database" }; }), "Release Type"));
test("wrong Development Team fails", () => fails(mutate((f) => { f.customfield_14336 = [{ value: "Other" }]; }), "Development Team"));
test("rollback equal to released version fails", () => fails(mutate((f) => { f.customfield_14330 = { name: "3.13.23-beta" }; }), "must differ"));
test("bare URL in Rollback Plan fails", () => fails(mutate((f) => { f.customfield_14151 = f.customfield_14331; }), "markdown link"));
test("Rollback Plan link text that is not the rollback version fails", () =>
  fails(mutate((f) => { f.customfield_14151 = "[latest](https://ci-jenkins.fandango.com/job/webtarsthree-deploy-project/120/)"; }), "link text"));
test("Rollback Plan pointing at a different URL fails", () =>
  fails(mutate((f) => { f.customfield_14151 = "[3.13.1-beta](https://example.com/other)"; }), "Previous Deploy Job URL"));
test("missing Build Artifact on a real ticket fails", () => fails(mutate((f) => { f.customfield_14154 = null; }), "Build Artifact must be"));
test("description set by the skill fails", () => fails(mutate((f) => { f.description = "text"; }), "description must be empty"));
test("Snyk count filled in fails", () => fails(mutate((f) => { f.customfield_14573 = 3; }), "customfield_14573"));
test("an approver filled in fails", () => fails(mutate((f) => { f.customfield_14146 = { accountId: "x" }; }), "customfield_14146"));
test("due date filled in fails", () => fails(mutate((f) => { f.duedate = "2026-10-06"; }), "duedate"));

// ---- dev mode variant ----

test("a dev ticket passes with the dev rules", () => {
  const f = mutate((x) => {
    x.summary = "[DEV] Release webtarsthree 0.0.0-skilltest";
    x.fixVersions = [{ name: "0.0.0-skilltest" }];
    x.labels = ["jira-create-release:1.0.2", "jira-create-release-dev"];
    x.customfield_14154 = null;
    x.status = { name: "On-Hold" };
  });
  assert.deepEqual(checkTicketFields(f, { ...real, dev: true, transitioned: false }), []);
});

test("a dev ticket with a Build Artifact fails", () => {
  const f = mutate((x) => {
    x.summary = "[DEV] Release webtarsthree 0.0.0-skilltest";
    x.fixVersions = [{ name: "0.0.0-skilltest" }];
    x.labels = ["jira-create-release:1.0.2", "jira-create-release-dev"];
    x.status = { name: "On-Hold" };
  });
  fails(f, "dev ticket Build Artifact", { ...real, dev: true, transitioned: false });
});

// ---- config and skill stay in sync with the baseline ----

test("config defaults match the baseline values", () => {
  assert.equal(config.defaults.fields.customfield_14308.value.value, EXPECTED.releaseType);
  assert.equal(config.defaults.fields.customfield_14336.value[0].value, EXPECTED.developmentTeam);
  assert.deepEqual(Object.keys(config.carryForward.fields).sort(), ["customfield_14543", "customfield_14564", "customfield_14585"]);
});

test("neverFill in the config covers every baseline never-fill field", () => {
  for (const k of NEVER_FILL) {
    if (k === "description") continue; // a Jira system field, not listed in the custom-field map
    assert.ok(k in config.neverFill.fields, `${k} missing from configs/TARS.json neverFill`);
  }
});

test("no field is both filled by the skill and marked never-fill", () => {
  const filled = [...Object.keys(config.defaults.fields), ...Object.keys(config.carryForward.fields), ...Object.keys(config.fields)];
  for (const k of filled) assert.ok(!(k in config.neverFill.fields), `${k} is both filled and never-fill`);
});

test("transition is CODE FREEZE id 21 into Pending Approvals and ready-for-release is the only accepted status", () => {
  assert.equal(config.transition.transitionId, "21");
  assert.equal(config.transition.to, "Pending Approvals");
  assert.deepEqual(config.prereqs.acceptedStatuses, ["Ready for Release"]);
  assert.equal(config.titleTemplate, "Release {repo} {fixVersion}");
});

test("ticket transition goes from Ready for Release to Deployed to STG with id 71", () => {
  assert.equal(config.ticketTransition.transitionId, "71");
  assert.equal(config.ticketTransition.from, config.prereqs.acceptedStatuses[0]);
  assert.equal(config.ticketTransition.to, "Deployed to STG");
});

test("VERSION matches the newest CHANGELOG heading", () => {
  const top = /^## (\d+\.\d+\.\d+)$/m.exec(read("../CHANGELOG.md"));
  assert.ok(top, "CHANGELOG has no version heading");
  assert.equal(top![1], VERSION);
});
