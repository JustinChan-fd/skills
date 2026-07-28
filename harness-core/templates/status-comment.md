# GitHub status comment (issue-sourced runs only)

Post with: `gh issue comment <n> --body "..."` after each phase ends.
One compact comment per phase, exactly this shape:

    ## harness: <phase> <✅ succeeded | ❌ failed | ⏸ partial>

    - **Run:** `<run-id>`
    - **Size:** <S|M|L> — <one-line rationale>            (intake only)
    - **Plan:** <n> units, <n> blocking criteria           (plan only)
    - **PR:** <url>                                        (implement only)
    - **Residue:** <n> item(s) — <short summary>           (omit line when 0)
    - **Next:** <what happens next, or why the run stopped>

The **Residue** line comes after the phase-specific Plan/PR line and before
Next. Populate it from THIS run's own recorded `residue`/`defect` notes (the
u1 shape — the same notes the phase driver just wrote this run, no
`audit.jsonl` re-scan needed): `<n>` is their count and `<short summary>` is a
one-line gist (e.g. the first note's `data.criterion`). **Omit the line
entirely when this run recorded zero residue/defect notes** — never a
`- **Residue:** 0 items` line.

Never post more than one comment per phase per run. Skip entirely when the
run's source is not an issue.
