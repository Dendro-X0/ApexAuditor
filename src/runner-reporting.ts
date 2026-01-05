import { writeFile } from "node:fs/promises";
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

type RunnerReportWriteParams = {
  readonly outputDir: string;
  readonly runner: string;
  readonly generatedAt: string;
  readonly humanTitle: string;
  readonly humanSummaryLines: readonly string[];
  readonly artifacts: readonly { readonly label: string; readonly relativePath: string }[];
  readonly aiMeta: Record<string, unknown>;
  readonly aiFindings: readonly RunnerFinding[];
};

function buildMarkdown(params: RunnerReportWriteParams): string {
  const lines: string[] = [];
  lines.push(`# ${params.humanTitle}`);
  lines.push("");
  lines.push(`Generated: ${params.generatedAt}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  for (const line of params.humanSummaryLines) {
    lines.push(`- ${line}`);
  }
  lines.push("");
  lines.push("## Files");
  lines.push("");
  for (const a of params.artifacts) {
    lines.push(`- ${a.label}: [${a.relativePath}](${a.relativePath})`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function buildAiReport(params: RunnerReportWriteParams): RunnerAiReport {
  return {
    schemaVersion: 1,
    runner: params.runner,
    generatedAt: params.generatedAt,
    meta: params.aiMeta,
    findings: params.aiFindings,
  };
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export async function writeRunnerReports(params: RunnerReportWriteParams): Promise<{ readonly reportMdPath: string; readonly aiJsonPath: string }> {
  const reportMdPath: string = resolve(params.outputDir, `${params.runner}.report.md`);
  const aiJsonPath: string = resolve(params.outputDir, `${params.runner}.ai.json`);
  const md: string = buildMarkdown({
    ...params,
    artifacts: params.artifacts.map((a) => ({ label: a.label, relativePath: normalizeRelativePath(a.relativePath) })),
    aiMeta: params.aiMeta,
  });
  const ai: RunnerAiReport = buildAiReport(params);
  await writeFile(reportMdPath, md, "utf8");
  await writeFile(aiJsonPath, `${JSON.stringify(ai)}\n`, "utf8");
  return { reportMdPath, aiJsonPath };
}
