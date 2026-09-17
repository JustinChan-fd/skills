// Run with: node --experimental-strip-types --test scripts/check-secret-in-tool-input.test.ts
// (from jira-create-ticket/). Mirrors research-loop's own
// test/check-secret-in-tool-input.test.ts coverage shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decideExitCode } from "./check-secret-in-tool-input.ts";

test("exits 0 for a clean createJiraIssue payload with an Epic parent (the false-positive regression)", () => {
  const stdin = JSON.stringify({
    tool_name: "mcp__atlassian__createJiraIssue",
    tool_input: {
      projectKey: "TARS",
      summary: "Add isValidHttpUrl helper",
      description: "### Overview\nUser jane.doe@example.com cannot log in.",
      additional_fields: { labels: ["repo:webtarsthree"], parent: { key: "TARS-1080" } },
    },
  });
  assert.equal(decideExitCode(stdin), 0);
});

test("exits 1 for a secret-shaped value in createJiraIssue's description", () => {
  const stdin = JSON.stringify({
    tool_name: "mcp__atlassian__createJiraIssue",
    tool_input: {
      projectKey: "CR",
      summary: "Bug report",
      description: "Found CLIENT_SECRET=abcdefghijklmnop hardcoded in config.py",
    },
  });
  assert.equal(decideExitCode(stdin), 1);
});

test("exits 1 for a secret-shaped value in editJiraIssue's fields", () => {
  const stdin = JSON.stringify({
    tool_name: "mcp__atlassian__editJiraIssue",
    tool_input: {
      issueIdOrKey: "TARS-1465",
      fields: { labels: ["jira-ticket-create:1.2.0"] , description: "SIGNING_KEY=abcdefghijklmnop"},
    },
  });
  assert.equal(decideExitCode(stdin), 1);
});

test("exits 1 for a secret-shaped value in createIssueLink's comment", () => {
  const stdin = JSON.stringify({
    tool_name: "mcp__atlassian__createIssueLink",
    tool_input: { inwardIssue: "TARS-1", outwardIssue: "TARS-2", comment: "API_KEY=abcdefghijklmnop" },
  });
  assert.equal(decideExitCode(stdin), 1);
});

test("exits 0 for editJiraIssue setting only the version/repo labels", () => {
  const stdin = JSON.stringify({
    tool_name: "mcp__atlassian__editJiraIssue",
    tool_input: {
      issueIdOrKey: "TARS-1465",
      fields: { labels: ["jira-ticket-create:1.2.0", "repo:webtarsthree"] },
    },
  });
  assert.equal(decideExitCode(stdin), 0);
});

test("exits 0 for empty stdin", () => {
  assert.equal(decideExitCode(""), 0);
});

test("exits 2 for malformed JSON", () => {
  assert.equal(decideExitCode("{not json"), 2);
});

test("exits 0 when tool_input is missing entirely", () => {
  assert.equal(decideExitCode(JSON.stringify({ tool_name: "mcp__atlassian__createJiraIssue" })), 0);
});
