import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type RunnerEvidence = {
  readonly kind: "file";
  readonly path: string;
};

type RunnerFinding = {
  readonly title: string;
  readonly severity: "info" | "warn" | "error";
  readonly details: readonly string[];
  readonly evidence: readonly RunnerEvidence[];
};

type RunnerAiReport = {
  readonly schemaVersion: 1;
  readonly runner: string;
  readonly generatedAt: string;
  readonly meta: Record<string, unknown>;
  readonly findings: readonly RunnerFinding[];
};

type QuickAiReport = {
  readonly schemaVersion: 1;
  readonly kind: "quick";
  readonly generatedAt: string;
  readonly meta: Record<string, unknown>;
  readonly runners: readonly RunnerAiReport[];
  readonly findings: readonly RunnerFinding[];
};

type WriteQuickConsolidationParams = {
  readonly outputDir: string;
  readonly generatedAt: string;
  readonly meta: Record<string, unknown>;
  readonly runners: readonly string[];
};

type WriteQuickConsolidationResult = {
  readonly reportMdPath: string;
  readonly aiJsonPath: string;
  readonly aiReport: QuickAiReport;
};

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function isRunnerAiReport(value: unknown): value is RunnerAiReport {
  if (!value || typeof value !== "object") {
    return false;
  }
  const v = value as {
    readonly schemaVersion?: unknown;
    readonly runner?: unknown;
    readonly generatedAt?: unknown;
    readonly meta?: unknown;
    readonly findings?: unknown;
  };
  return v.schemaVersion === 1 && typeof v.runner === "string" && typeof v.generatedAt === "string" && v.meta !== undefined && Array.isArray(v.findings);
}

async function readRunnerAiReport(params: { readonly outputDir: string; readonly runner: string }): Promise<RunnerAiReport | undefined> {
  const path: string = resolve(params.outputDir, `${params.runner}.ai.json`);
  try {
    const raw: string = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw) as unknown;
    if (!isRunnerAiReport(parsed)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function buildMarkdown(params: {
  readonly generatedAt: string;
  readonly aiJsonRelativePath: string;
  readonly includedRunners: readonly string[];
  readonly missingRunners: readonly string[];
  readonly runnerReports: readonly RunnerAiReport[];
}): string {
  const lines: string[] = [];
  lines.push("# ApexAuditor Quick report");
  lines.push("");
  lines.push(`Generated: ${params.generatedAt}`);
  lines.push("");
  lines.push("## Files");
  lines.push("");
  lines.push(`- AI JSON: [${params.aiJsonRelativePath}](${params.aiJsonRelativePath})`);
  lines.push("");
  lines.push("## Coverage");
  lines.push("");
  lines.push(`- Included: ${params.includedRunners.join(", ") || "(none)"}`);
  lines.push(`- Missing: ${params.missingRunners.join(", ") || "(none)"}`);
  lines.push("");
  lines.push("## Findings (by runner)");
  lines.push("");
  for (const r of params.runnerReports) {
    lines.push(`### ${r.runner}`);
    lines.push("");
    if (r.findings.length === 0) {
      lines.push("- (no findings)");
      lines.push("");
      continue;
    }
    for (const f of r.findings) {
      lines.push(`- ${f.severity}: ${f.title}`);
      for (const d of f.details.slice(0, 10)) {
        lines.push(`  - ${d}`);
      }
      const extra: number = Math.max(0, f.details.length - 10);
      if (extra > 0) {
        lines.push(`  - (+${extra} more)`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function consolidateFindings(reports: readonly RunnerAiReport[]): readonly RunnerFinding[] {
  const flattened: RunnerFinding[] = [];
  for (const report of reports) {
    for (const finding of report.findings) {
      flattened.push({
        title: `[${report.runner}] ${finding.title}`,
        severity: finding.severity,
        details: finding.details,
        evidence: finding.evidence,
      });
    }
  }
  return flattened;
}

export async function writeQuickConsolidation(params: WriteQuickConsolidationParams): Promise<WriteQuickConsolidationResult> {
  const expected: readonly string[] = params.runners;
  const loaded: RunnerAiReport[] = [];
  const missing: string[] = [];
  for (const runner of expected) {
    const report: RunnerAiReport | undefined = await readRunnerAiReport({ outputDir: params.outputDir, runner });
    if (report === undefined) {
      missing.push(runner);
    } else {
      loaded.push(report);
    }
  }
  const generatedAt: string = params.generatedAt;
  const aiReport: QuickAiReport = {
    schemaVersion: 1,
    kind: "quick",
    generatedAt,
    meta: { ...params.meta, includedRunners: loaded.map((r) => r.runner), missingRunners: missing },
    runners: loaded,
    findings: consolidateFindings(loaded),
  };
  const reportMdPath: string = resolve(params.outputDir, "quick.report.md");
  const aiJsonPath: string = resolve(params.outputDir, "ai-quick.json");
  const md: string = buildMarkdown({
    generatedAt,
    aiJsonRelativePath: normalizeRelativePath("ai-quick.json"),
    includedRunners: loaded.map((r) => r.runner),
    missingRunners: missing,
    runnerReports: loaded,
  });
  await writeFile(reportMdPath, md, "utf8");
  await writeFile(aiJsonPath, `${safeStringify(aiReport)}\n`, "utf8");
  return { reportMdPath, aiJsonPath, aiReport };
}
