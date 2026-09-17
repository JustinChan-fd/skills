/**
 * Secret detection for jira-create-ticket's own writes (createJiraIssue,
 * createIssueLink, editJiraIssue). Copied from research-loop's/dev-loop's
 * src/redact.ts (both pipeline repos deliberately keep their own copy in
 * sync rather than share one module -- see docs/future-enhancements.md's
 * "shared redact module" entry for the plan to stop duplicating this a
 * third time). Only `containsSecret()` is used by this skill's hook;
 * `redactPII()`/`redactSensitive()` are kept for parity with the source
 * copies and because a future terminal/log use here isn't ruled out, but
 * nothing in this skill calls them today.
 *
 * Pure, defensive: never throws, and a string with nothing to redact is
 * returned unchanged.
 */

import { homedir } from "node:os";

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export function redactPII(text: string): string {
  const home = homedir();
  let result = home ? text.replaceAll(home, "~") : text;
  result = result.replace(EMAIL_PATTERN, "REDACTED_EMAIL");
  return result;
}

/**
 * Name fragment shared by every env-var name this module treats as
 * secret-shaped -- deliberately broad (matches CLIENT_SECRET, API_KEY,
 * JIRA_API_TOKEN, PRIVATE_KEY, etc.) since a false positive here just
 * redacts a value that wasn't actually sensitive, while a false negative
 * leaks a real credential. That said, this pattern is NOT a bare `KEY`
 * wildcard -- an earlier draft used one and it matched `issueIdOrKey`,
 * a field present on essentially every Jira MCP tool call/response, which
 * would make `containsSecret()` (used by the PreToolUse hook, see
 * scripts/check-secret-in-tool-input.ts) deny every single legitimate
 * Jira write. For `redactSecrets()`'s own use (turning a value into
 * REDACTED_SECRET) an over-broad match is cheap; for `containsSecret()`'s
 * use (denying a whole tool call) it is not, so `KEY` here is deliberately
 * anchored to compound forms and a small explicit set of common
 * standalone names, not left as an unanchored substring match.
 *
 * The bare `KEY` alternative is intentionally its own case-sensitive,
 * uppercase-only anchor (`BARE_KEY_PATTERN` below), not folded into the
 * shared `/i` flag the rest of this pattern uses: matching it case-
 * insensitively caught ordinary lowercase JSON `"key"` fields too --
 * e.g. Jira's `parent: {"key": "TARS-1080"}`, which every Epic-linked
 * issue create sends (this skill's own Step 9, "parent" field) and which
 * is not a secret. `KEY=...` (the real env-var shape this alternative
 * targets) is conventionally uppercase, so anchoring it to case preserves
 * the original detection while dropping the false positive -- this exact
 * bug was hit live via research-loop's own createJiraIssue call and fixed
 * there first (see that repo's CHANGELOG.md, 2026-09-17); this copy
 * starts from the fixed version.
 */
const SECRET_NAME_PATTERN = new RegExp(
  "SECRET|TOKEN|API[_-]?KEY|PASSWORD|PASSWD|PRIVATE[_-]?KEY|CREDENTIAL|ACCESS[_-]?KEY|AUTH|SIGNING[_-]?KEY|ACCOUNT[_-]?KEY|ROLE[_-]?KEY|ENCRYPTION[_-]?KEY|DSN|CONNECTION[_-]?STRING|CONN[_-]?STR|DATABASE[_-]?URL|DB[_-]?URL|URI|COOKIE|SESSION",
  "i",
);
const BARE_KEY_PATTERN = /^KEY$/;

function isSecretShapedName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name) || BARE_KEY_PATTERN.test(name);
}

/**
 * `NAME="value"` / `export NAME="value"` -- env-style, quoted. The value
 * group requires a real closing quote (JSON/shell-escape aware, so an
 * escaped `\"` inside the value doesn't terminate the match early) --
 * critical so a value containing a comma or brace is captured whole
 * instead of leaving a truncated remainder.
 */
const ENV_QUOTED_PATTERN =
  /((?:export\s+)?\b([A-Za-z][A-Za-z0-9_]*)\s*=\s*)"((?:[^"\\]|\\.)*)"/g;

/** `NAME=value` / `export NAME=value` -- env-style, unquoted. Excludes
 * `{`/`[` so this can never wander into a following nested value's
 * opening delimiter. Unlike the JSON variant below, comma is *not*
 * excluded here -- shell `NAME=value` text has no comma-as-delimiter
 * convention, so excluding it only truncates a value that legitimately
 * contains one (e.g. `TOKEN=abcdefgh,ijklmnop`), leaking the remainder
 * unredacted. */
const ENV_UNQUOTED_PATTERN = /((?:export\s+)?\b([A-Za-z][A-Za-z0-9_]*)\s*=\s*)([^\s;}\]{"]+)/g;

/** JSON `"name": "value"` -- quoted, same closing-quote/escape rule as above. */
const JSON_QUOTED_PATTERN =
  /("([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*)"((?:[^"\\]|\\.)*)"/g;

/** JSON `"name": value` -- unquoted (number/bool), same `{`/`[` exclusion. */
const JSON_UNQUOTED_PATTERN = /("([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*)([^\s,}\]{"]+)/g;

const AWS_KEY_PATTERN = /AKIA[0-9A-Z]{16}/g;
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/**
 * Bare-token format backstops: recognizable by shape alone, no NAME=
 * prefix needed. Target the highest-frequency "secret pasted in prose
 * with no key name nearby" shape.
 */
const STRIPE_KEY_PATTERN = /\b(?:sk|rk|pk)_live_[A-Za-z0-9]{16,}\b/g;
const GITHUB_TOKEN_PATTERN = /\bgh[oprsu]_[A-Za-z0-9]{16,}\b/g;
const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g;

/**
 * `scheme://user:password@host` -- catches credentials embedded in a
 * connection string/DSN (e.g. DATABASE_URL, MONGO_URI), which carries a
 * password without the var *name* itself ever matching SECRET_NAME_PATTERN.
 * Redacts only the `user:password@` segment, keeping the rest of the URL
 * (host/port/path) intact.
 */
const URL_CREDENTIAL_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/g;

const MIN_ENV_VALUE_LENGTH = 8;
const MIN_PATTERN_VALUE_LENGTH = 6;

/** Matches a value that's itself a URL (`scheme://...`). */
const URL_SHAPED_VALUE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Builds a replacer for one of the four NAME_VALUE patterns above.
 * `quoted` controls both the true/false/number skip (only meaningful for
 * an unquoted JSON value) and whether the replacement re-wraps in quotes.
 */
function makeNameValueRedactor(quoted: boolean) {
  return (match: string, prefix: string, name: string, value: string): string => {
    if (!isSecretShapedName(name)) return match;
    if (!quoted) {
      if (value === "true" || value === "false") return match;
      if (/^-?\d+(\.\d+)?$/.test(value)) return match;
    }
    if (value.length < MIN_PATTERN_VALUE_LENGTH) return match;
    if (URL_SHAPED_VALUE.test(value)) return match;
    return quoted ? `${prefix}"REDACTED_SECRET"` : `${prefix}REDACTED_SECRET`;
  };
}

/**
 * Redacts secret-shaped values (API keys, tokens, passwords, credentials)
 * from any string. Two layers: a known-value pass (secrets this process's
 * own env holds), and a name/format pattern pass (catches secrets that
 * never touched this process's env, e.g. pasted `.envrc` content). Pure,
 * defensive: never throws, and a string with nothing to redact is
 * returned unchanged.
 */
export function redactSecrets(text: string): string {
  if (typeof text !== "string") return "";
  let result = text;

  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < MIN_ENV_VALUE_LENGTH) continue;
    if (!isSecretShapedName(name)) continue;
    result = result.split(value).join("REDACTED_SECRET");
  }

  // Quoted patterns run first: once a value is replaced with
  // "REDACTED_SECRET", the character right after `:`/`=` is a quote,
  // which the unquoted patterns' value class explicitly excludes -- so
  // they can never re-match an already-redacted quoted value.
  result = result.replace(JSON_QUOTED_PATTERN, makeNameValueRedactor(true));
  result = result.replace(ENV_QUOTED_PATTERN, makeNameValueRedactor(true));
  result = result.replace(JSON_UNQUOTED_PATTERN, makeNameValueRedactor(false));
  result = result.replace(ENV_UNQUOTED_PATTERN, makeNameValueRedactor(false));

  result = result.replace(AWS_KEY_PATTERN, "REDACTED_SECRET");
  result = result.replace(JWT_PATTERN, "REDACTED_SECRET");
  result = result.replace(STRIPE_KEY_PATTERN, "REDACTED_SECRET");
  result = result.replace(GITHUB_TOKEN_PATTERN, "REDACTED_SECRET");
  result = result.replace(SLACK_TOKEN_PATTERN, "REDACTED_SECRET");
  result = result.replace(URL_CREDENTIAL_PATTERN, "$1REDACTED_SECRET@");

  return result;
}

/**
 * Boolean check reusing `redactSecrets`'s own patterns -- true if `text`
 * contains anything `redactSecrets` would redact, false otherwise. This
 * is what `hooks/block-secret-writes.sh` (via
 * `scripts/check-secret-in-tool-input.ts`) uses to decide whether to deny
 * a Jira write, so this is intentionally the *same* detection logic as
 * `redactSecrets`, not a second, drifting reimplementation. Pure,
 * defensive: never throws, and returns false rather than throwing when
 * there's nothing to check.
 */
export function containsSecret(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return redactSecrets(text) !== text;
}

/**
 * The single funnel callers outside this module should use: PII redaction
 * followed by secret redaction.
 */
export function redactSensitive(text: string): string {
  return redactSecrets(redactPII(text));
}
