// Run with: node --experimental-strip-types --test scripts/redact.test.ts
// (from jira-create-ticket/). No package.json/dependency needed -- uses
// node:test, built into Node 24+.

import { test } from "node:test";
import assert from "node:assert/strict";
import { redactPII, redactSecrets, redactSensitive, containsSecret } from "./redact.ts";

test("redactPII redacts a bare email address", () => {
  assert.equal(
    redactPII("contact bob@example.com for help"),
    "contact REDACTED_EMAIL for help",
  );
});

test("redactPII leaves text with no email unchanged", () => {
  assert.equal(redactPII("nothing sensitive here"), "nothing sensitive here");
});

test("redactSecrets redacts an API_KEY-named value", () => {
  assert.equal(
    redactSecrets("API_KEY=abc123secretvalue"),
    "API_KEY=REDACTED_SECRET",
  );
});

test("redactSecrets redacts a bare KEY-named value", () => {
  assert.equal(redactSecrets("KEY=abcdefghijklmnop"), "KEY=REDACTED_SECRET");
});

test("redactSecrets does not treat issueIdOrKey as a secret-shaped name", () => {
  const json = '{"issueIdOrKey":"TARS-1301abcdefgh"}';
  assert.equal(redactSecrets(json), json);
});

test("redactSecrets does not redact a lowercase 'key' JSON field (Jira's parent.key)", () => {
  // This is the exact false positive this skill needs guarded against:
  // Step 9's createJiraIssue call sends `parent: {"key": "<EPIC-KEY>"}`
  // for any project requiring an Epic parent (TARS confirmed live).
  const json = '{"parent":{"key":"TARS-1080"}}';
  assert.equal(redactSecrets(json), json);
  assert.equal(containsSecret(json), false);
});

test("redactSecrets redacts a quoted JSON secret field", () => {
  const json = '{"apiToken":"abcdefghijklmnop"}';
  assert.equal(redactSecrets(json), '{"apiToken":"REDACTED_SECRET"}');
});

test("redactSecrets redacts a DATABASE_URL's embedded credentials but keeps the host/path", () => {
  assert.equal(
    redactSecrets("DATABASE_URL=postgres://user:pass@localhost:5432/db"),
    "DATABASE_URL=postgres://REDACTED_SECRET@localhost:5432/db",
  );
});

test("redactSecrets never throws on empty input", () => {
  assert.doesNotThrow(() => redactSecrets(""));
  assert.equal(redactSecrets(""), "");
});

test("containsSecret is false for ordinary ticket-shaped content, including an email needed for repro context", () => {
  const evidence =
    "User jane.doe@example.com cannot log in, gets a 500 on POST /api/login";
  assert.equal(containsSecret(evidence), false);
});

test("containsSecret is true for a pasted .envrc-shaped secret", () => {
  assert.equal(containsSecret("export JIRA_API_TOKEN=abcdefghijklmnop"), true);
});

test("containsSecret is false for a full createJiraIssue-shaped payload with an Epic parent", () => {
  const payload = JSON.stringify({
    cloudId: "fandango.atlassian.net",
    projectKey: "TARS",
    issueTypeName: "Task",
    summary: "Add non-throwing isValidHttpUrl(value) helper",
    description: "### Overview\nUser reports a 500 on login.",
    additional_fields: { labels: ["repo:webtarsthree"], parent: { key: "TARS-1080" } },
  });
  assert.equal(containsSecret(payload), false);
});

test("redactSensitive applies both PII and secret redaction", () => {
  assert.equal(
    redactSensitive("contact bob@example.com, API_KEY=abcdefghijklmnop"),
    "contact REDACTED_EMAIL, API_KEY=REDACTED_SECRET",
  );
});
