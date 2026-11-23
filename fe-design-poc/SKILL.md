---
name: fe-design-poc
description: Use when the user runs /fe-design-poc or asks for a quick shareable HTML design POC, mockup, or set of UI options/variations for a page or component in the current repo (often with a Jira ticket) to get design answers without Figma
version: 1.0.0
---

# fe-design-poc

Build one self-contained HTML file that shows **options** for a UI decision inside a faithful copy of the target repo's app chrome, at the repo's real window widths. It's a quick way to get answers, not a Figma replacement.

**Output:** `~/Desktop/poc-<kebab-slug>.html`, local only. Don't publish an Artifact, upload to Jira, or touch the repo unless the user asks.

## 1. Research first (before saying anything)

Read the target repo. The POC must look like the real app, not an approximation.

| Find | Where to look | Record |
|---|---|---|
| Ticket context | Jira MCP `getJiraIssue` if a key/URL was given | Problem, AC, attachments |
| The page/component being changed | Its JSX/TSX **and** CSS (grep for the route or name) | Layout, copy, class names, data shape |
| App chrome | Global header/nav/sidebar, or the page's own header if there's no global bar | Rebuild whatever is actually on screen; delete template chrome that doesn't exist |
| Tokens and buttons | Shared CSS vars, button/input styles, icon set | Hex values + source file paths |
| Reusable components | `src/**/components` | What each option would reuse |
| Overlap | Existing features that already do part of the ask (e.g. a Clone next to a requested Duplicate) | Raise it in the checklist and in a note |
| Window widths | `grep -rhoE '@media[^{]*' <src> \| sort \| uniq -c \| sort -rn` + any breakpoint constants/Tailwind config | The 3–5 most used widths, with file refs |
| Dark mode | `grep -rlE 'prefers-color-scheme\|data-theme\|\.dark\b' <src>`: count only code pages actually use | yes/no + where |

Under zsh, quote every pattern and never pass an unquoted `--include=*.css`, because an unmatched glob aborts the command. If a search errors, re-run it before concluding "not found".
| Repo rules | CLAUDE.md / AGENTS.md / docs | Off-limits systems (e.g. a design system not yet adopted) |

## 2. Gate: one checklist, then run solo

After research, if any item below is still unknown, send **one** message: a checkbox list of only the missing items, each with your best guess pre-filled, then stop. If nothing is missing, build without asking.

- [ ] **Target**: which page/component (route or file). If the user's name for it doesn't match a real page, give your mapping as the guess
- [ ] **Decision**: what question the options answer
- [ ] **Options**: 2+ candidate approaches (propose them; user may accept)
- [ ] **Ticket**: Jira key or "none"
- [ ] **States** worth showing (empty / filled / loading / error), if any

Once answered, run to completion with no further questions.

## 3. Build: copy `template.html` and fill every slot

`template.html` (next to this file) is the contract. The finished page has, in order:

1. **Intro**: h1 = feature name. If a ticket was given, the ticket key is a link to it in the h1. Then 1–2 sentences: the problem today and what this POC decides. Nothing more.
2. **Sticky controls**:
   - **Options**: always ≥2, as pills (`.seg2`, 2–5 options) or a `<select>` (6+). Use labels that name the difference ("Option cards", "Dropdown"), not "A/B".
   - **Window width**: buttons that resize the `.frame`. The source is printed beside the label. Use the repo breakpoints from step 1 (e.g. `from repo @media: 1024, 768, 480`). If none were found, use `standard fallback`: desktop 1440, laptop 1280, tablet 768, mobile 390.
   - **States**, if any.
   - **Theme (Light/Dark)**: only if the repo has dark mode in use. Otherwise omit the control and any dark tokens.
3. **Frame**: the app's real chrome and page, rebuilt from repo CSS with copied hex values and the repo's own copy and class names. Responsive rules inside the frame use `@container app (...)` at the repo's breakpoints, so the width buttons actually reflow it.
4. **Notes** cards: tradeoffs per option, where each window width came from (file:line or "standard fallback"), and which existing repo components/classes each option reuses, with paths.
5. **Footer**: `Sample data. Made with <a href="https://github.com/JustinChan-fd/skills/tree/main/fe-design-poc">fe-design-poc</a> v<version>`. Read the version from this skill's `VERSION` file, which always matches the frontmatter.

Copy stays in the end user's language, in sentence case. Label sample data as sample. No invented features the app doesn't have; if an option needs something new, say so in its tradeoff note.

## 4. Verify, then report

- Screenshot every option at the widest and narrowest widths: `python3 scripts/shots.py <poc.html> /tmp/<slug>-shots <shots.json>` (see the script docstring; Chrome renders ≥500px only, and the script warns). Look at the PNGs and fix overflow or broken layouts.
- Check that every `{{…}}` slot is gone: `grep -c '{{' <poc.html>` must be 0.
- Report: the file path, the options shown, the widths and their source, whether dark mode was included and why, and any guesses.

## Common mistakes

| Mistake | Fix |
|---|---|
| Styling from memory or AI_CONTEXT summaries | Open the actual page's JSX + CSS and copy values |
| "Resize your browser" instead of width buttons | Width control resizing `.frame` + `@container` rules |
| Widths with no stated source | Source printed beside the control and in a note |
| Asking "what kind of POC?" before researching | Research, then a pre-filled checklist of only the gaps |
| Dark mode because it's nice | Only when the repo ships it in used code |
| One design, no alternatives | ≥2 options, named by their difference |
| Ticket in the report but not on the page | Ticket link in the h1 |
