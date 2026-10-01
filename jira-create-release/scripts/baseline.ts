// Baseline check for a ticket created by jira-create-release. Pure function: give it the
// `fields` object from getJiraIssue and it returns a list of mismatches (empty = passes).
// Expected values mirror configs/TARS.json; a config-vs-baseline test keeps them in sync.

export interface CheckOptions {
  /** Contents of the skill's VERSION file, e.g. "1.0.2". */
  version: string;
  /** Ticket was created in dev mode (--dev). */
  dev: boolean;
  /** CODE FREEZE transition was run (always true for real runs; opt-in for dev). */
  transitioned: boolean;
  /** Invoking user's Jira accountId, when known. */
  assigneeAccountId?: string;
}

// Fields that must be empty at create time (a human fills them later). A key that is absent
// from `fields` is treated as "not read" and skipped; only a non-empty value is a mismatch.
export const NEVER_FILL = [
  "customfield_14573", "customfield_14574", "customfield_14575", "customfield_14576",
  "customfield_14152", "customfield_14147", "customfield_14146", "customfield_14126",
  "customfield_13504", "customfield_11110", "duedate", "description",
] as const;

export const EXPECTED = {
  component: "webtarsthree",
  releaseType: "Code",
  developmentTeam: "Creative Business Unit III",
  capexOpex: "Opex",
  pii: "NA",
  sreClassification: "SRE Support",
  devLabel: "jira-create-release-dev",
  versionLabelPrefix: "jira-create-release:",
};

const BUILD_ARTIFACT = /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/;
const BROWSE_URL = /^https:\/\/[^/]+\/browse\/[A-Z]+-\d+$/;
const ROLLBACK_LINK = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/;

const optionValue = (v: unknown): string | undefined =>
  v && typeof v === "object" ? ((v as { value?: string }).value ?? (v as { name?: string }).name) : undefined;

export function checkTicketFields(f: Record<string, any>, opts: CheckOptions): string[] {
  const errs: string[] = [];
  const expect = (ok: boolean, msg: string) => { if (!ok) errs.push(msg); };

  // Title and fix version
  const fixVersion: string | undefined = f.fixVersions?.[0]?.name;
  expect(Array.isArray(f.fixVersions) && f.fixVersions.length === 1, "fixVersions must have exactly one entry");
  const titlePrefix = opts.dev ? "[DEV] Release webtarsthree " : "Release webtarsthree ";
  expect(
    typeof f.summary === "string" && !!fixVersion && f.summary === titlePrefix + fixVersion,
    `summary must be "${titlePrefix}<fixVersion>", got "${f.summary}"`,
  );

  // Labels: version stamp always; dev label only in dev mode; nothing CAB-owned
  const labels: string[] = f.labels ?? [];
  expect(labels.includes(EXPECTED.versionLabelPrefix + opts.version), `labels must include ${EXPECTED.versionLabelPrefix}${opts.version}`);
  expect(labels.includes(EXPECTED.devLabel) === opts.dev, opts.dev ? "dev ticket must carry the dev label" : "real ticket must not carry the dev label");
  expect(!labels.includes("cab_ovrd"), "cab_ovrd is CAB-owned and must not be set");
  expect(labels.every((l) => l === EXPECTED.devLabel || l.startsWith(EXPECTED.versionLabelPrefix)), `unexpected labels: ${labels.join(", ")}`);

  // Ownership and status
  expect(!!f.assignee?.accountId, "ticket must be assigned");
  if (opts.assigneeAccountId) expect(f.assignee?.accountId === opts.assigneeAccountId, "assignee must be the invoking user");
  const wantStatus = opts.transitioned ? "Pending Approvals" : "On-Hold";
  expect(f.status?.name === wantStatus, `status must be ${wantStatus}, got ${f.status?.name}`);

  // Component and fixed values
  expect(f.components?.length === 1 && f.components[0].name === EXPECTED.component, `components must be [${EXPECTED.component}]`);
  expect(optionValue(f.customfield_14308) === EXPECTED.releaseType, `Release Type must be ${EXPECTED.releaseType}`);
  expect(f.customfield_14336?.length === 1 && optionValue(f.customfield_14336[0]) === EXPECTED.developmentTeam, `Development Team(s) must be [${EXPECTED.developmentTeam}]`);
  expect(optionValue(f.customfield_14543) === EXPECTED.capexOpex, `Capex/Opex must be ${EXPECTED.capexOpex}`);
  expect(optionValue(f.customfield_14585) === EXPECTED.pii, `PII must be ${EXPECTED.pii}`);
  expect(optionValue(f.customfield_14564) === EXPECTED.sreClassification, `SRE Classification must be ${EXPECTED.sreClassification}`);

  // Derived links
  const rollback: string | undefined = f.customfield_14330?.name;
  expect(!!rollback, "Rollback Version must be set");
  expect(rollback !== fixVersion, "Rollback Version must differ from the version being released");
  expect(BROWSE_URL.test(f.customfield_14332 ?? ""), "Previous Release Issue must be a browse URL");
  expect(/^https?:\/\/\S+$/.test(f.customfield_14331 ?? ""), "Previous Deploy Job must be a bare URL");
  const link = ROLLBACK_LINK.exec(f.customfield_14151 ?? "");
  expect(!!link, "Release Rollback Plan must be a single markdown link [version](url)");
  if (link) {
    expect(link[1] === rollback, "Release Rollback Plan link text must be the rollback version");
    expect(link[2] === f.customfield_14331, "Release Rollback Plan link must point at the Previous Deploy Job URL");
  }
  if (opts.dev) expect(!f.customfield_14154, "dev ticket Build Artifact must be empty");
  else expect(BUILD_ARTIFACT.test(f.customfield_14154 ?? ""), "Build Artifact must be a GitHub Actions run URL");

  // Human-owned fields stay empty
  for (const k of NEVER_FILL) {
    const v = f[k];
    if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)) errs.push(`${k} must be empty at create, got ${JSON.stringify(v)}`);
  }
  return errs;
}
