import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeArtifactsNavigation } from "./artifacts-navigation.js";

type ApexSeverity = "info" | "yellow" | "red";

type RunnerEvidence = {
  readonly sourceRelPath: string;
  readonly pointer: string;
  readonly artifactRelPath?: string;
  readonly excerpt?: string;
};

type AiLedgerIssue = {
  readonly id: string;
  readonly kind: string;
  readonly severity: ApexSeverity;
  readonly title: string;
  readonly summary: string;
  readonly affected: readonly { readonly label: string; readonly path: string; readonly device: string }[];
  readonly evidence: readonly RunnerEvidence[];
};

type AiLedger = {
  readonly generatedAt: string;
  readonly issueIndex: Record<string, AiLedgerIssue>;
  readonly fixPlan: readonly { readonly title: string; readonly issueIds: readonly string[]; readonly order: number; readonly rationale: string; readonly verify: string }[];
};

type IssuesFile = {
  readonly generatedAt: string;
  readonly targetScore: number;
  readonly totals: {
    readonly combos: number;
    readonly redCombos: number;
    readonly yellowCombos: number;
    readonly greenCombos: number;
    readonly runtimeErrors: number;
  };
  readonly topIssues: readonly { readonly id: string; readonly title: string; readonly count: number; readonly totalMs: number }[];
  readonly failing: readonly {
    readonly label: string;
    readonly path: string;
    readonly device: string;
    readonly performance: number;
    readonly accessibility: number;
    readonly bestPractices: number;
    readonly seo: number;
    readonly artifactBaseName: string;
    readonly topOpportunities: readonly { readonly id: string; readonly title: string; readonly estimatedSavingsMs: number; readonly estimatedSavingsBytes?: number }[];
  }[];
};

type GlobalRedReport = {
  readonly schemaVersion: 1;
  readonly kind: "global-red";
  readonly generatedAt: string;
  readonly meta: {
    readonly outputDir: string;
    readonly sourceGeneratedAt?: string;
    readonly targetScore?: number;
    readonly totals?: IssuesFile["totals"];
  };
  readonly redIssues: readonly {
    readonly id: string;
    readonly title: string;
    readonly summary: string;
    readonly kind: string;
    readonly affectedCount: number;
    readonly affectedSample: readonly { readonly label: string; readonly path: string; readonly device: string }[];
    readonly evidence: readonly RunnerEvidence[];
  }[];
  readonly fixPlan: AiLedger["fixPlan"];
};

function parseArgs(argv: readonly string[]): { readonly outputDir: string } {
  let outputDir: string = resolve(".apex-auditor");
  for (let i: number = 2; i < argv.length; i += 1) {
    const arg: string = argv[i] ?? "";
    if ((arg === "--dir" || arg === "--output-dir") && i + 1 < argv.length) {
      outputDir = resolve(argv[i + 1] ?? outputDir);
      i += 1;
    }
  }
  return { outputDir };
}

async function readJson<T extends object>(absolutePath: string): Promise<T> {
  const raw: string = await readFile(absolutePath, "utf8");
  const parsed: unknown = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid JSON file: ${absolutePath}`);
  }
  return parsed as T;
}

function buildMarkdown(params: { readonly report: GlobalRedReport; readonly aiJsonRelPath: string }): string {
  const lines: string[] = [];
  lines.push("# ApexAuditor Global Red Report");
  lines.push("");
  lines.push(`Generated: ${params.report.generatedAt}`);
  lines.push("");
  lines.push("## Files");
  lines.push("");
  lines.push(`- AI JSON: [${params.aiJsonRelPath}](${params.aiJsonRelPath})`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  if (params.report.meta.totals) {
    const t = params.report.meta.totals;
    lines.push(`- Combos: ${t.combos}`);
    lines.push(`- Red combos: ${t.redCombos}`);
    lines.push(`- Yellow combos: ${t.yellowCombos}`);
    lines.push(`- Green combos: ${t.greenCombos}`);
    lines.push(`- Runtime errors: ${t.runtimeErrors}`);
  }
  if (params.report.meta.targetScore !== undefined) {
    lines.push(`- Target score: ${params.report.meta.targetScore}+`);
  }
  lines.push("");
  lines.push("## Fix plan (high-level)");
  lines.push("");
  const sortedFixPlan: readonly GlobalRedReport["fixPlan"][number][] = [...params.report.fixPlan].sort(
    (a: GlobalRedReport["fixPlan"][number], b: GlobalRedReport["fixPlan"][number]) => a.order - b.order,
  );
  for (const step of sortedFixPlan) {
    lines.push(`- ${step.order}. ${step.title}`);
    lines.push(`  - Issue IDs: ${step.issueIds.join(", ")}`);
    lines.push(`  - Verify: ${step.verify}`);
  }
  lines.push("");
  lines.push("## Red issues across the suite");
  lines.push("");
  for (const issue of params.report.redIssues) {
    lines.push(`### ${issue.title}`);
    lines.push("");
    lines.push(`- ID: ${issue.id}`);
    lines.push(`- Kind: ${issue.kind}`);
    lines.push(`- Affected combos: ${issue.affectedCount}`);
    lines.push("");
    if (issue.affectedSample.length > 0) {
      lines.push("Top affected (sample):");
      for (const a of issue.affectedSample) {
        lines.push(`- ${a.label} ${a.path} [${a.device}]`);
      }
      lines.push("");
    }
    if (issue.evidence.length > 0) {
      lines.push("Evidence pointers:");
      for (const e of issue.evidence.slice(0, 8)) {
        const artifact: string = e.artifactRelPath ? ` (${e.artifactRelPath})` : "";
        lines.push(`- ${e.sourceRelPath} :: ${e.pointer}${artifact}`);
      }
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function toRedIssues(ledger: AiLedger): readonly GlobalRedReport["redIssues"][number][] {
  const issues: readonly AiLedgerIssue[] = Object.values(ledger.issueIndex);
  const reds: readonly AiLedgerIssue[] = issues.filter((i) => i.severity === "red");
  const sorted: readonly AiLedgerIssue[] = [...reds].sort((a: AiLedgerIssue, b: AiLedgerIssue) => b.affected.length - a.affected.length);
  return sorted.map((i: AiLedgerIssue) => {
      const sample = i.affected.slice(0, 12).map((a) => ({ label: a.label, path: a.path, device: a.device }));
      return {
        id: i.id,
        title: i.title,
        summary: i.summary,
        kind: i.kind,
        affectedCount: i.affected.length,
        affectedSample: sample,
        evidence: i.evidence,
      };
    });
}

export async function runReportCli(argv: readonly string[]): Promise<void> {
  const args: { readonly outputDir: string } = parseArgs(argv);
  const issuesPath: string = resolve(args.outputDir, "issues.json");
  const ledgerPath: string = resolve(args.outputDir, "ai-ledger.json");
  const issues: IssuesFile = await readJson<IssuesFile>(issuesPath);
  const ledger: AiLedger = await readJson<AiLedger>(ledgerPath);
  const generatedAt: string = new Date().toISOString();
  const report: GlobalRedReport = {
    schemaVersion: 1,
    kind: "global-red",
    generatedAt,
    meta: {
      outputDir: normalizePath(args.outputDir),
      sourceGeneratedAt: issues.generatedAt,
      targetScore: issues.targetScore,
      totals: issues.totals,
    },
    redIssues: toRedIssues(ledger),
    fixPlan: ledger.fixPlan,
  };
  const mdPath: string = resolve(args.outputDir, "global-red.report.md");
  const aiPath: string = resolve(args.outputDir, "ai-global-red.json");
  const md: string = buildMarkdown({ report, aiJsonRelPath: normalizePath("ai-global-red.json") });
  await writeFile(mdPath, md, "utf8");
  await writeFile(aiPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeArtifactsNavigation({ outputDir: args.outputDir });
}
