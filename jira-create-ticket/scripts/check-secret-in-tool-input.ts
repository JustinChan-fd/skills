/**
 * PreToolUse hook checker invoked by
 * `hooks/block-secret-writes.sh` for this skill's three Jira write
 * calls (createJiraIssue, createIssueLink, editJiraIssue -- Steps 9-11
 * of SKILL.md). Reads the hook's stdin JSON payload, scans the whole
 * `tool_input` object for anything `redactSecrets()` would redact, and
 * communicates its verdict purely via exit code -- no stdout, so
 * nothing it prints can itself become a leak channel:
 *
 *   0 -- clean, no secret-shaped content found.
 *   1 -- secret-shaped content found.
 *   2 -- the check itself failed (malformed/non-JSON stdin, unexpected
 *        exception) -- distinct from "found a secret" so the calling
 *        hook script can fail *closed* (deny) on this case too, rather
 *        than silently treating "couldn't tell" the same as "found
 *        nothing".
 *
 * Same shape as research-loop's own scripts/check-secret-in-tool-input.ts
 * (this skill's writes are MCP tool calls, not Bash commands, so there's
 * no `gh`-command-text recognizer needed the way dev-loop's copy has).
 *
 * The untrusted tool_input content is read here purely as JSON *data*
 * (via JSON.parse on a string read from stdin) -- never interpolated
 * into a shell command or a dynamically-built source string. Ticket
 * content this skill writes is adversarially-influenceable (e.g. a
 * linked ticket's own comment text, pulled in via Step 3), and
 * interpolating it into an `-e`-style invocation would let content
 * containing backticks/`${}`/quotes break out of the intended source
 * into arbitrary code execution in this process, which has real
 * credentials in its environment.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { containsSecret } from "./redact.ts";

/**
 * Pure decision function, unit-testable without touching stdin/process.
 * `stdin` is the raw JSON string the hook receives from Claude Code.
 */
export function decideExitCode(stdin: string): 0 | 1 | 2 {
  if (typeof stdin !== "string") return 2;
  if (stdin.trim().length === 0) return 0;

  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch {
    return 2;
  }

  try {
    const toolInput = (payload as Record<string, unknown> | null)?.tool_input;
    if (toolInput === null || toolInput === undefined) return 0;

    const scanned = JSON.stringify(toolInput);
    if (!scanned) return 0;
    return containsSecret(scanned) ? 1 : 0;
  } catch {
    return 2;
  }
}

/**
 * Maps decideExitCode's internal 0|1|2 contract to the actual process
 * exit code, deliberately choosing 3 (not 1) for "secret found". Node's
 * own default exit code for a totally uncaught crash (e.g. a syntax
 * error or a module-load-time throw) is 1 -- if "secret found" also
 * used 1, a completely broken checker script would be indistinguishable
 * from one that correctly found a secret. Using 3 here means *any* other
 * exit code (0 excepted) reliably means "something about the check
 * failed" to the calling hook script, regardless of how it failed.
 */
const PROCESS_EXIT_CODE = { 0: 0, 1: 3, 2: 2 } as const;

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const stdin = Buffer.concat(chunks).toString("utf8");
  process.exit(PROCESS_EXIT_CODE[decideExitCode(stdin)]);
}

/**
 * Only run as a script when invoked directly (not when imported by
 * tests). Compares realpaths, not raw strings: `import.meta.url` is
 * Node's own module identity and is symlink-resolved, but
 * `process.argv[1]` is the literal path the process was invoked with --
 * when that path passes through a symlink (this skill's own
 * `~/.claude/skills` -> `.../Desktop/Repos/skills` link, or macOS's
 * `/tmp` -> `/private/tmp`), the raw-string comparison silently never
 * matches, main() never runs, and the process exits 0 having never read
 * stdin. That failure mode is worse than a crash here: a hook that
 * silently always allows is indistinguishable from one that correctly
 * checked and found nothing clean.
 */
function isRunAsScript(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argvPath);
  } catch {
    return false;
  }
}

if (isRunAsScript()) {
  process.on("uncaughtException", () => process.exit(2));
  process.on("unhandledRejection", () => process.exit(2));
  main().catch(() => process.exit(2));
}
