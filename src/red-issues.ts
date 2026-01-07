import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type ApexSeverity = "info" | "yellow" | "red";

type EvidencePointer = {
  readonly sourceRelPath: string;
  readonly pointer: string;
  readonly artifactRelPath?: string;
  readonly excerpt?: string;
};

type LedgerIssue = {
  readonly id: string;
  readonly kind: string;
  readonly severity: ApexSeverity;
  readonly title: string;
  readonly summary?: string;
  readonly affected: readonly { readonly label: string; readonly path: string; readonly device: string }[];
  readonly evidence: readonly EvidencePointer[];
};

type LedgerFixPlanStep = {
  readonly title: string;
  readonly issueIds: readonly string[];
  readonly order: number;
  readonly rationale: string;
  readonly verify: string;
};

type AiLedgerMinimal = {
  readonly generatedAt: string;
  readonly issueIndex: Record<string, LedgerIssue>;
  readonly fixPlan: readonly LedgerFixPlanStep[];
};

type IssuesTotals = {
  readonly combos: number;
  readonly redCombos: number;
  readonly yellowCombos: number;
  readonly greenCombos: number;
  readonly runtimeErrors: number;
};

type IssuesIndexMinimal = {
  readonly generatedAt: string;
  readonly targetScore: number;
  readonly totals: IssuesTotals;
};

type RedIssuesReport = {
  readonly schemaVersion: 1;
  readonly kind: "red-issues";
  readonly generatedAt: string;
  readonly meta: {
    readonly outputDir: string;
    readonly sourceGeneratedAt?: string;
    readonly targetScore?: number;
    readonly totals?: IssuesTotals;
  };
  readonly redIssues: readonly {
    readonly id: string;
    readonly title: string;
    readonly summary?: string;
    readonly kind: string;
    readonly affectedCount: number;
    readonly affectedSample: readonly { readonly label: string; readonly path: string; readonly device: string }[];
    readonly evidence: readonly EvidencePointer[];
  }[];
  readonly fixPlan: readonly LedgerFixPlanStep[];
};

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function toRedIssues(ledger: AiLedgerMinimal): readonly RedIssuesReport["redIssues"][number][] {
  const issues: readonly LedgerIssue[] = Object.values(ledger.issueIndex);
  const reds: readonly LedgerIssue[] = issues.filter((i) => i.severity === "red");
  const sorted: readonly LedgerIssue[] = [...reds].sort((a, b) => b.affected.length - a.affected.length);
  return sorted.map((i) => ({
    id: i.id,
    title: i.title,
    summary: i.summary,
    kind: i.kind,
    affectedCount: i.affected.length,
    affectedSample: i.affected.slice(0, 12).map((a) => ({ label: a.label, path: a.path, device: a.device })),
    evidence: i.evidence.slice(0, 8),
  }));
}

function buildMarkdown(report: RedIssuesReport): string {
  const lines: string[] = [];
  lines.push("# Red issues (human-first)");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Key files");
  lines.push("");
  lines.push("- Overview: [overview.md](overview.md)");
  lines.push("- Triage: [triage.md](triage.md)");
  lines.push("- Issues: [issues.json](issues.json)");
  lines.push("- AI ledger: [ai-ledger.json](ai-ledger.json)");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  if (report.meta.totals) {
    const t: IssuesTotals = report.meta.totals;
    lines.push(`- Combos: ${t.combos}`);
    lines.push(`- Red combos: ${t.redCombos}`);
    lines.push(`- Yellow combos: ${t.yellowCombos}`);
    lines.push(`- Green combos: ${t.greenCombos}`);
    lines.push(`- Runtime errors: ${t.runtimeErrors}`);
  }
  if (report.meta.targetScore !== undefined) {
    lines.push(`- Target score: ${report.meta.targetScore}+`);
  }
  lines.push("");
  lines.push("## Fix plan (high-level)");
  lines.push("");
  const sortedFixPlan: readonly LedgerFixPlanStep[] = [...report.fixPlan].sort((a, b) => a.order - b.order);
  for (const step of sortedFixPlan) {
    lines.push(`- ${step.order}. ${step.title}`);
    lines.push(`  - Verify: ${step.verify}`);
  }
  lines.push("");
  lines.push("## Top red issues across the suite");
  lines.push("");
  if (report.redIssues.length === 0) {
    lines.push("No red issues found.");
    lines.push("");
    return `${lines.join("\n")}\n`;
  }
  for (const issue of report.redIssues) {
    lines.push(`### ${issue.title}`);
    lines.push("");
    lines.push(`- Kind: ${issue.kind}`);
    lines.push(`- Affected combos: ${issue.affectedCount}`);
    if (issue.summary) {
      lines.push(`- Summary: ${issue.summary}`);
    }
    lines.push("");
    if (issue.affectedSample.length > 0) {
      lines.push("Sample affected combos:");
      for (const a of issue.affectedSample) {
        lines.push(`- ${a.label} ${a.path} [${a.device}]`);
      }
      lines.push("");
    }
    if (issue.evidence.length > 0) {
      lines.push("Evidence pointers (open issues.json and jump via pointer):");
      for (const e of issue.evidence) {
        const artifact: string = e.artifactRelPath ? ` (${e.artifactRelPath})` : "";
        lines.push(`- ${e.sourceRelPath} :: ${e.pointer}${artifact}`);
      }
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Writes a human-first red issues report derived from the already-generated `issues.json` and `ai-ledger.json` data.
 *
 * @param params - Output directory and the in-memory issues/ledger objects.
 */
export async function writeRedIssuesReport(params: {
  readonly outputDir: string;
  readonly issues: IssuesIndexMinimal;
  readonly ledger: AiLedgerMinimal;
}): Promise<void> {
  const generatedAt: string = new Date().toISOString();
  const report: RedIssuesReport = {
    schemaVersion: 1,
    kind: "red-issues",
    generatedAt,
    meta: {
      outputDir: normalizePath(params.outputDir),
      sourceGeneratedAt: params.issues.generatedAt,
      targetScore: params.issues.targetScore,
      totals: params.issues.totals,
    },
    redIssues: toRedIssues(params.ledger).slice(0, 25),
    fixPlan: params.ledger.fixPlan,
  };
  const mdPath: string = resolve(params.outputDir, "red-issues.md");
  const jsonPath: string = resolve(params.outputDir, "red-issues.json");
  const md: string = buildMarkdown(report);
  await writeFile(mdPath, md, "utf8");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
