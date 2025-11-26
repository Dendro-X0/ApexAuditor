import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { runAuditsForConfig } from "./lighthouse-runner.js";
import type { RunSummary, PageDeviceSummary, OpportunitySummary } from "./types.js";

interface CliArgs {
  readonly configPath: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let configPath: string | undefined;
  for (let i = 2; i < argv.length; i += 1) {
    const arg: string = argv[i];
    if ((arg === "--config" || arg === "-c") && i + 1 < argv.length) {
      configPath = argv[i + 1];
      i += 1;
    }
  }
  const finalConfigPath: string = configPath ?? "apex.config.json";
  return { configPath: finalConfigPath };
}

/**
 * Runs the ApexAuditor audit CLI.
 *
 * @param argv - The process arguments array.
 */
export async function runAuditCli(argv: readonly string[]): Promise<void> {
  const args: CliArgs = parseArgs(argv);
  const { configPath, config } = await loadConfig({ configPath: args.configPath });
  const summary: RunSummary = await runAuditsForConfig({ config, configPath });
  const outputDir: string = resolve(".apex-auditor");
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  const markdown: string = buildMarkdown(summary.results);
  await writeFile(resolve(outputDir, "summary.md"), markdown, "utf8");
  // Also echo a compact table to stdout for quick viewing.
  // eslint-disable-next-line no-console
  console.log(markdown);
}

function buildMarkdown(results: readonly PageDeviceSummary[]): string {
  const header: string = [
    "| Label | Path | Device | P | A | BP | SEO | LCP (s) | FCP (s) | TBT (ms) | CLS | Error | Top issues |",
    "|-------|------|--------|---|---|----|-----|---------|---------|----------|-----|-------|-----------|",
  ].join("\n");
  const lines: string[] = results.map((result) => buildRow(result));
  return `${header}\n${lines.join("\n")}`;
}

function buildRow(result: PageDeviceSummary): string {
  const scores = result.scores;
  const metrics = result.metrics;
  const lcpSeconds: string = metrics.lcpMs !== undefined ? (metrics.lcpMs / 1000).toFixed(1) : "-";
  const fcpSeconds: string = metrics.fcpMs !== undefined ? (metrics.fcpMs / 1000).toFixed(1) : "-";
  const tbtMs: string = metrics.tbtMs !== undefined ? Math.round(metrics.tbtMs).toString() : "-";
  const cls: string = metrics.cls !== undefined ? metrics.cls.toFixed(3) : "-";
  const issues: string = formatTopIssues(result.opportunities);
  const error: string =
    result.runtimeErrorCode ?? (result.runtimeErrorMessage !== undefined ? result.runtimeErrorMessage : "");
  return `| ${result.label} | ${result.path} | ${result.device} | ${scores.performance ?? "-"} | ${scores.accessibility ?? "-"} | ${scores.bestPractices ?? "-"} | ${scores.seo ?? "-"} | ${lcpSeconds} | ${fcpSeconds} | ${tbtMs} | ${cls} | ${error} | ${issues} |`;
}

function formatTopIssues(opportunities: readonly OpportunitySummary[]): string {
  if (opportunities.length === 0) {
    return "";
  }
  const items: string[] = opportunities.map((opp) => {
    const savingsMs: string = opp.estimatedSavingsMs !== undefined ? `${Math.round(opp.estimatedSavingsMs)}ms` : "";
    const savingsBytes: string = opp.estimatedSavingsBytes !== undefined ? `${Math.round(opp.estimatedSavingsBytes / 1024)}KB` : "";
    const parts: string[] = [savingsMs, savingsBytes].filter((p) => p.length > 0);
    const suffix: string = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    return `${opp.id}${suffix}`;
  });
  return items.join("; ");
}
