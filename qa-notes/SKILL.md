---
name: qa-notes
description: Generate and publish QA Notes to a Jira ticket from the current branch/PR context
model: anthropic.claude-haiku-4-5-20251001
---

# /qa-notes

Generate human-readable QA testing steps from the current branch and PR, then publish them to the Jira ticket's QA Notes field (`customfield_14226`).

## When to Use

After completing work on a feature branch, before or during code review, when QA notes need to be written to the Jira ticket.

## Arguments

`$ARGUMENTS` — a Jira ticket key (e.g. `TARS-1288`). If omitted, extracts the ticket key from the current branch name (e.g. `TARS-1288-some-slug` → `TARS-1288`).

## Workflow

All context gathering runs silently. Publishes automatically — no confirmation prompt.

### Step 1: Resolve ticket key

```bash
# If $ARGUMENTS is provided, use it directly.
# Otherwise extract from branch name:
BRANCH=$(git branch --show-current)
# Extract ticket key: first segment matching PROJECT-NNN pattern
TICKET=$(echo "$BRANCH" | grep -oE '[A-Z]+-[0-9]+' | head -1)
echo "Ticket: $TICKET"
```

If no ticket key found from arg or branch name, ask the user: "What Jira ticket key should I write QA notes to? (e.g. TARS-1288)"

### Step 2: Gather context (parallel, silent)

Run all of these simultaneously:

**A — Jira ticket:**
```js
getJiraIssue({
  cloudId: "fandango.atlassian.net",
  issueIdOrKey: TICKET,
  fields: ["summary", "description", "status", "assignee", "customfield_14226"],
  responseContentFormat: "markdown"
})
```
Extract: `summary`, `description` (for AC/scope), current `customfield_14226` value (to know if QA notes already exist).

**B — PR body (if exists):**
```bash
gh pr list --head $(git branch --show-current) --json number,url,body,title | head -1
```
Extract: PR `body` (especially its `## QA Notes` section if present), PR `url` for linking.

**C — Changed files and diff summary:**
```bash
# Files changed in commits not yet on master/main
git log origin/master..HEAD --name-only --pretty=format: | sort -u | grep -v '^$'
```
Extract: list of changed files to identify which pages/routes are affected.

**D — Routes touched:**
```bash
# Quick scan of changed client files for route paths
git diff origin/master..HEAD -- 'src/client/**/*.jsx' 'src/client/**/*.js' | grep -E "path=|to=|navigate\(|href=" | head -20
```
Extract: any URL paths referenced in changed code, for building test links.

### Step 3: Synthesize QA Notes

Using the gathered context, generate QA notes in this exact format — matching the TARS-1260 pattern:

```
Manual testing steps:
1. Navigate to `/route/path` (use any valid {entity})
2. {Action — click, search, fill in, select}
3. **Expected:** {what should happen}
4. {Next action}
5. **Expected:** {what should happen}
...
```

**Rules for generating steps:**
- Header is exactly "Manual testing steps:" — no other sections, no preamble
- Each step is one concrete action (navigate, click, type, select, submit)
- After each action that produces a visible result, add a bold "Expected:" step describing what the user should see
- Route paths use inline code: `/customer-service/realms/rt/accounts/{accountId}`
- If the route has a dynamic segment, use `{entityType}` as placeholder with "(use any valid {entity})" note — same style as TARS-1260's "(use any valid movie ID)"
- If the PR body already has a `## QA Notes` section, use it as the primary source and reformat into this template
- Cover each AC item as at least one action+expected pair
- No URL block, no edge cases section, no additional info section — just the numbered steps

### Step 4: Publish to Jira (ADF format)

**CRITICAL: `customfield_14226` requires ADF format. `contentFormat: "markdown"` does NOT work for custom fields. Build ADF JSON manually.**

Convert each line of the QA notes into ADF nodes. Use this pattern:

The ADF structure mirrors TARS-1260 exactly: a bold "Manual testing steps:" paragraph followed by an `orderedList`. Each step is a `listItem`. Steps with "Expected:" results use bold inline marks.

```js
editJiraIssue({
  cloudId: "fandango.atlassian.net",
  issueIdOrKey: TICKET,
  fields: {
    customfield_14226: {
      type: "doc",
      version: 1,
      content: [
        // "Manual testing steps:" header — bold paragraph
        {
          type: "paragraph",
          content: [{ type: "text", text: "Manual testing steps:", marks: [{ type: "strong" }] }]
        },
        // Ordered list — one listItem per step
        {
          type: "orderedList",
          attrs: { order: 1 },
          content: [
            // Plain action step:
            {
              type: "listItem",
              content: [{
                type: "paragraph",
                content: [
                  { type: "text", text: "Navigate to " },
                  { type: "text", text: "`/route/path`", marks: [{ type: "code" }] },
                  { type: "text", text: " (use any valid {entity})" }
                ]
              }]
            },
            // Action step with an "Expected:" result:
            {
              type: "listItem",
              content: [{
                type: "paragraph",
                content: [
                  { type: "text", text: "Expected:", marks: [{ type: "strong" }] },
                  { type: "text", text: " {what the user should see}" }
                ]
              }]
            }
            // ... one listItem per step
          ]
        }
      ]
    },
    // Also set Covered Information Data Inventory to "No Impact"
    customfield_13504: [{ id: "14310" }]
  }
})
```

**Note on inline code in ADF:** To render a route path as inline code (like `` `/route/path` ``), use `marks: [{ type: "code" }]` on the text node containing only the path, flanked by plain text nodes for the surrounding words.

### Step 5: Output

```
✅ QA Notes published to {TICKET}
📋 https://fandango.atlassian.net/browse/{TICKET}

---
Manual testing steps:
1. {step}
2. Expected: {result}
...
```

## Guardrails

- Always write ADF directly — never rely on contentFormat: "markdown" for custom fields
- Always include `customfield_13504: [{ id: "14310" }]` (No Impact) alongside QA notes
- If QA notes already exist on the ticket, show the existing content in the confirmation prompt so the user can decide whether to overwrite
- Use `https://int-webtarsthree.fandango.com` (not localhost) as the base URL — QA tests on the integration environment
- If no PR exists yet, note "Branch not yet pushed as PR" in Additional Info
- If the branch is master/main, warn: "On main branch — ticket key must be provided explicitly"

## Example Output

```
✅ QA Notes published to TARS-1288
📋 https://fandango.atlassian.net/browse/TARS-1288

---
Manual testing steps:
1. Navigate to `/customer-service/realms/rt/accounts/{accountId}` (use any valid RT account ID)
2. In the Official Profile card, click Search next to Celebrity
3. Type a name (e.g. "Jackie Chan") in the search modal — verify results appear
4. Select a result
5. Expected: Celebrity renders as a pill with the celebrity's ID and a remove (×) button
6. Click the remove (×) button
7. Expected: Selection clears
8. Check the Official User checkbox with no celebrity selected, click Save
9. Expected: Profile saves successfully (celebrity is optional)
10. Select a celebrity, add a description, click Save
11. Expected: PUT succeeds and a success toast appears
12. Uncheck Official User
13. Expected: Celebrity and description fields clear automatically
```
