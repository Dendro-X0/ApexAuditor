import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { runAuditsForConfig } from "./lighthouse-runner.js";
import type {
  ApexBudgets,
  ApexConfig,
  ApexDevice,
  CategoryBudgetThresholds,
  MetricBudgetThresholds,
  OpportunitySummary,
  PageDeviceSummary,
  RunSummary,
} from "./types.js";

type CliLogLevel = "silent" | "error" | "info" | "verbose";

type CliColorMode = "auto" | "on" | "off";

interface CliArgs {
  readonly configPath: string;
  readonly ci: boolean;
  readonly colorMode: CliColorMode;
  readonly logLevelOverride?: CliLogLevel;
}

const ANSI_RESET = "\u001B[0m" as const;
const ANSI_RED = "\u001B[31m" as const;
const ANSI_YELLOW = "\u001B[33m" as const;
const ANSI_GREEN = "\u001B[32m" as const;
const ANSI_CYAN = "\u001B[36m" as const;
const ANSI_BLUE = "\u001B[34m" as const;

const LCP_GOOD_MS: number = 2500;
const LCP_WARN_MS: number = 4000;
const FCP_GOOD_MS: number = 1800;
const FCP_WARN_MS: number = 3000;
const TBT_GOOD_MS: number = 200;
const TBT_WARN_MS: number = 600;
const CLS_GOOD: number = 0.1;
const CLS_WARN: number = 0.25;

function parseArgs(argv: readonly string[]): CliArgs {
  let configPath: string | undefined;
  let ci: boolean = false;
  let colorMode: CliColorMode = "auto";
  let logLevelOverride: CliLogLevel | undefined;
  for (let i = 2; i < argv.length; i += 1) {
    const arg: string = argv[i];
    if ((arg === "--config" || arg === "-c") && i + 1 < argv.length) {
      configPath = argv[i + 1];
      i += 1;
    } else if (arg === "--ci") {
      ci = true;
    } else if (arg === "--no-color") {
      colorMode = "off";
    } else if (arg === "--color") {
      colorMode = "on";
    } else if (arg === "--log-level" && i + 1 < argv.length) {
      const value: string = argv[i + 1];
      if (value === "silent" || value === "error" || value === "info" || value === "verbose") {
        logLevelOverride = value;
      } else {
        throw new Error(`Invalid --log-level value: ${value}`);
      }
      i += 1;
    }
  }
  const finalConfigPath: string = configPath ?? "apex.config.json";
  return { configPath: finalConfigPath, ci, colorMode, logLevelOverride };
}

/**
 * Runs the ApexAuditor audit CLI.
 *
 * @param argv - The process arguments array.
 */
export async function runAuditCli(argv: readonly string[]): Promise<void> {
  const args: CliArgs = parseArgs(argv);
  const startTimeMs: number = Date.now();
  const { configPath, config } = await loadConfig({ configPath: args.configPath });
  const effectiveLogLevel: CliLogLevel | undefined = args.logLevelOverride ?? config.logLevel;
  const effectiveConfig: ApexConfig = {
    ...config,
    logLevel: effectiveLogLevel,
  };
  const summary: RunSummary = await runAuditsForConfig({ config: effectiveConfig, configPath });
  const outputDir: string = resolve(".apex-auditor");
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  const markdown: string = buildMarkdown(summary.results);
  await writeFile(resolve(outputDir, "summary.md"), markdown, "utf8");
  // Also echo a compact, colourised table to stdout for quick viewing.
  const useColor: boolean = shouldUseColor(args.ci, args.colorMode);
  const consoleTable: string = buildConsoleTable(summary.results, useColor);
  // eslint-disable-next-line no-console
  console.log(consoleTable);
  printRedIssues(summary.results);
  printCiSummary(args, summary.results, effectiveConfig.budgets);
  printLowestPerformancePages(summary.results, useColor);
  const elapsedMs: number = Date.now() - startTimeMs;
  const elapsedText: string = formatElapsedTime(elapsedMs);
  const elapsedDisplay: string = useColor ? `${ANSI_CYAN}${elapsedText}${ANSI_RESET}` : elapsedText;
  const runsPerTarget: number = effectiveConfig.runs ?? 1;
  const comboCount: number = summary.results.length;
  const totalRuns: number = comboCount * runsPerTarget;
  // eslint-disable-next-line no-console
  console.log(
    `\nCompleted in ${elapsedDisplay} (${comboCount} page/device combinations x ${runsPerTarget} runs = ${totalRuns} Lighthouse runs).`,
  );
}

function buildMarkdown(results: readonly PageDeviceSummary[]): string {
  const header: string = [
    "| Label | Path | Device | P | A | BP | SEO | LCP (s) | FCP (s) | TBT (ms) | CLS | Error | Top issues |",
    "|-------|------|--------|---|---|----|-----|---------|---------|----------|-----|-------|-----------|",
  ].join("\n");
  const lines: string[] = results.map((result) => buildRow(result));
  return `${header}\n${lines.join("\n")}`;
}

function buildConsoleTable(results: readonly PageDeviceSummary[], useColor: boolean): string {
  const header: string = [
    "| Label | Path | Device | P | A | BP | SEO | LCP (s) | FCP (s) | TBT (ms) | CLS |",
    "|-------|------|--------|---|---|----|-----|---------|---------|----------|-----|",
  ].join("\n");
  const rows: string[] = results.map((result) => buildConsoleRow(result, useColor));
  return `${header}\n${rows.join("\n")}`;
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

function buildConsoleRow(result: PageDeviceSummary, useColor: boolean): string {
  const scoreLine: string = buildConsoleScoreLine(result, useColor);
  const metricsLine: string = buildConsoleMetricsLine(result, useColor);
  const errorLine: string = buildConsoleErrorLine(result, useColor);
  const issuesLine: string = buildConsoleIssuesLine(result);
  const lines: string[] = [scoreLine, metricsLine];
  if (errorLine.length > 0) {
    lines.push(errorLine);
  }
  if (issuesLine.length > 0) {
    lines.push(issuesLine);
  }
  return lines.join("\n");
}

function buildConsoleScoreLine(result: PageDeviceSummary, useColor: boolean): string {
  const scores = result.scores;
  const performanceText: string = colourScore(scores.performance, useColor);
  const accessibilityText: string = colourScore(scores.accessibility, useColor);
  const bestPracticesText: string = colourScore(scores.bestPractices, useColor);
  const seoText: string = colourScore(scores.seo, useColor);
  const deviceText: string = formatDeviceLabel(result.device, useColor);
  return `| ${result.label} | ${result.path} | ${deviceText} | ${performanceText} | ${accessibilityText} | ${bestPracticesText} | ${seoText} |  |  |  |  |`;
}

function buildConsoleMetricsLine(result: PageDeviceSummary, useColor: boolean): string {
  const metrics = result.metrics;
  const lcpText: string = formatMetricSeconds(metrics.lcpMs, LCP_GOOD_MS, LCP_WARN_MS, useColor);
  const fcpText: string = formatMetricSeconds(metrics.fcpMs, FCP_GOOD_MS, FCP_WARN_MS, useColor);
  const tbtText: string = formatMetricMilliseconds(metrics.tbtMs, TBT_GOOD_MS, TBT_WARN_MS, useColor);
  const clsText: string = formatMetricRatio(metrics.cls, CLS_GOOD, CLS_WARN, useColor);
  return `|  |  |  |  |  |  |  | ${lcpText} | ${fcpText} | ${tbtText} | ${clsText} |`;
}

function buildConsoleErrorLine(result: PageDeviceSummary, useColor: boolean): string {
  const errorCode: string | undefined = result.runtimeErrorCode;
  const errorMessage: string | undefined = result.runtimeErrorMessage;
  if (!errorCode && !errorMessage) {
    return "";
  }
  const errorText: string = errorCode ?? errorMessage ?? "";
  const prefix: string = useColor ? `${ANSI_RED}↳ Error:${ANSI_RESET}` : "↳ Error:";
  return `  ${prefix} ${errorText}`;
}

function buildConsoleIssuesLine(result: PageDeviceSummary): string {
  const issues: string = formatTopIssues(result.opportunities);
  if (issues.length === 0) {
    return "";
  }
  return `  ↳ Top issues: ${issues}`;
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

function formatMetricSeconds(
  valueMs: number | undefined,
  goodThresholdMs: number,
  warnThresholdMs: number,
  useColor: boolean,
): string {
  if (valueMs === undefined) {
    return "-";
  }
  const seconds: number = valueMs / 1000;
  const text: string = `${seconds.toFixed(1)}s`;
  if (!useColor) {
    return text;
  }
  const colour: string = selectColourForThreshold(valueMs, goodThresholdMs, warnThresholdMs);
  return `${colour}${text}${ANSI_RESET}`;
}

function formatMetricMilliseconds(
  valueMs: number | undefined,
  goodThresholdMs: number,
  warnThresholdMs: number,
  useColor: boolean,
): string {
  if (valueMs === undefined) {
    return "-";
  }
  const rounded: number = Math.round(valueMs);
  const text: string = `${rounded}ms`;
  if (!useColor) {
    return text;
  }
  const colour: string = selectColourForThreshold(valueMs, goodThresholdMs, warnThresholdMs);
  return `${colour}${text}${ANSI_RESET}`;
}

function formatMetricRatio(
  value: number | undefined,
  goodThreshold: number,
  warnThreshold: number,
  useColor: boolean,
): string {
  if (value === undefined) {
    return "-";
  }
  const text: string = value.toFixed(3);
  if (!useColor) {
    return text;
  }
  const colour: string = selectColourForThreshold(value, goodThreshold, warnThreshold);
  return `${colour}${text}${ANSI_RESET}`;
}

function selectColourForThreshold(value: number, goodThreshold: number, warnThreshold: number): string {
  if (value <= goodThreshold) {
    return ANSI_GREEN;
  }
  if (value <= warnThreshold) {
    return ANSI_YELLOW;
  }
  return ANSI_RED;
}

function formatDeviceLabel(device: ApexDevice, useColor: boolean): string {
  if (!useColor) {
    return device;
  }
  const colour: string = device === "mobile" ? ANSI_CYAN : ANSI_BLUE;
  return `${colour}${device}${ANSI_RESET}`;
}

function colourScore(score: number | undefined, useColor: boolean): string {
  if (score === undefined) {
    return "-";
  }
  const value: number = score;
  const text: string = value.toString();
  if (!useColor) {
    return text;
  }
  let colour: string;
  if (value < 50) {
    colour = ANSI_RED;
  } else if (value < 90) {
    colour = ANSI_YELLOW;
  } else {
    colour = ANSI_GREEN;
  }
  return `${colour}${text}${ANSI_RESET}`;
}

function isRedScore(score: number | undefined): boolean {
  return typeof score === "number" && score < 50;
}

function printRedIssues(results: readonly PageDeviceSummary[]): void {
  const redResults: PageDeviceSummary[] = results.filter((result) => {
    const scores = result.scores;
    return (
      isRedScore(scores.performance) ||
      isRedScore(scores.accessibility) ||
      isRedScore(scores.bestPractices) ||
      isRedScore(scores.seo)
    );
  });
  if (redResults.length === 0) {
    return;
  }
  // eslint-disable-next-line no-console
  console.log("\nRed issues (scores below 50):");
  for (const result of redResults) {
    const scores = result.scores;
    const badParts: string[] = [];
    if (isRedScore(scores.performance)) {
      badParts.push(`P:${scores.performance}`);
    }
    if (isRedScore(scores.accessibility)) {
      badParts.push(`A:${scores.accessibility}`);
    }
    if (isRedScore(scores.bestPractices)) {
      badParts.push(`BP:${scores.bestPractices}`);
    }
    if (isRedScore(scores.seo)) {
      badParts.push(`SEO:${scores.seo}`);
    }
    const issues: string = formatTopIssues(result.opportunities);
    // eslint-disable-next-line no-console
    console.log(`- ${result.label} ${result.path} [${result.device}] – ${badParts.join(", ")} – ${issues}`);
  }
}

function shouldUseColor(ci: boolean, colorMode: CliColorMode): boolean {
  if (colorMode === "on") {
    return true;
  }
  if (colorMode === "off") {
    return false;
  }
  if (ci) {
    return false;
  }
  return typeof process !== "undefined" && Boolean(process.stdout && process.stdout.isTTY);
}

interface BudgetViolation {
  readonly pageLabel: string;
  readonly path: string;
  readonly device: ApexDevice;
  readonly kind: "category" | "metric";
  readonly id: string;
  readonly value: number;
  readonly limit: number;
}

function printCiSummary(args: CliArgs, results: readonly PageDeviceSummary[], budgets: ApexBudgets | undefined): void {
  if (!args.ci) {
    return;
  }
  if (!budgets) {
    // eslint-disable-next-line no-console
    console.log("\nCI mode: no budgets configured. Skipping threshold checks.");
    return;
  }
  const violations: BudgetViolation[] = collectBudgetViolations(results, budgets);
  if (violations.length === 0) {
    // eslint-disable-next-line no-console
    console.log("\nCI budgets PASSED.");
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`\nCI budgets FAILED (${violations.length} violations):`);
  for (const violation of violations) {
    // eslint-disable-next-line no-console
    console.log(
      `- ${violation.pageLabel} ${violation.path} [${violation.device}] – ${violation.kind} ${violation.id}: ${violation.value} vs limit ${violation.limit}`,
    );
  }
  process.exitCode = 1;
}

function collectBudgetViolations(
  results: readonly PageDeviceSummary[],
  budgets: ApexBudgets,
): BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  for (const result of results) {
    if (budgets.categories) {
      collectCategoryViolations(result, budgets.categories, violations);
    }
    if (budgets.metrics) {
      collectMetricViolations(result, budgets.metrics, violations);
    }
  }
  return violations;
}

function collectCategoryViolations(
  result: PageDeviceSummary,
  categories: CategoryBudgetThresholds,
  allViolations: BudgetViolation[],
): void {
  const scores = result.scores;
  addCategoryViolation("performance", scores.performance, categories.performance, result, allViolations);
  addCategoryViolation("accessibility", scores.accessibility, categories.accessibility, result, allViolations);
  addCategoryViolation("bestPractices", scores.bestPractices, categories.bestPractices, result, allViolations);
  addCategoryViolation("seo", scores.seo, categories.seo, result, allViolations);
}

function addCategoryViolation(
  id: string,
  actual: number | undefined,
  limit: number | undefined,
  result: PageDeviceSummary,
  allViolations: BudgetViolation[],
): void {
  if (limit === undefined || actual === undefined) {
    return;
  }
  if (actual >= limit) {
    return;
  }
  allViolations.push({
    pageLabel: result.label,
    path: result.path,
    device: result.device,
    kind: "category",
    id,
    value: actual,
    limit,
  });
}

function formatElapsedTime(elapsedMs: number): string {
  const totalSeconds: number = Math.round(elapsedMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes: number = Math.floor(totalSeconds / 60);
  const remainingSeconds: number = totalSeconds % 60;
  if (remainingSeconds === 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${remainingSeconds}s`;
}

function printLowestPerformancePages(results: readonly PageDeviceSummary[], useColor: boolean): void {
  const entries: { readonly result: PageDeviceSummary; readonly performance: number | undefined }[] = results.map(
    (result) => ({
      result,
      performance: result.scores.performance,
    }),
  );
  const definedEntries: { readonly result: PageDeviceSummary; readonly performance: number }[] = entries
    .filter((entry): entry is { readonly result: PageDeviceSummary; readonly performance: number } => {
      return typeof entry.performance === "number";
    })
    .sort((a, b) => a.performance - b.performance);
  const limit: number = 5;
  const worst: { readonly result: PageDeviceSummary; readonly performance: number }[] = definedEntries.slice(0, limit);
  if (worst.length === 0) {
    return;
  }
  // eslint-disable-next-line no-console
  console.log("\nLowest Performance pages:");
  for (const entry of worst) {
    const perfText: string = colourScore(entry.performance, useColor);
    const label: string = entry.result.label;
    const path: string = entry.result.path;
    const device: ApexDevice = entry.result.device;
    // eslint-disable-next-line no-console
    console.log(`- ${label} ${path} [${device}] P:${perfText}`);
  }
}

function collectMetricViolations(
  result: PageDeviceSummary,
  metricsBudgets: MetricBudgetThresholds,
  allViolations: BudgetViolation[],
): void {
  const metrics = result.metrics;
  addMetricViolation("lcpMs", metrics.lcpMs, metricsBudgets.lcpMs, result, allViolations);
  addMetricViolation("fcpMs", metrics.fcpMs, metricsBudgets.fcpMs, result, allViolations);
  addMetricViolation("tbtMs", metrics.tbtMs, metricsBudgets.tbtMs, result, allViolations);
  addMetricViolation("cls", metrics.cls, metricsBudgets.cls, result, allViolations);
}

function addMetricViolation(
  id: string,
  actual: number | undefined,
  limit: number | undefined,
  result: PageDeviceSummary,
  allViolations: BudgetViolation[],
): void {
  if (limit === undefined || actual === undefined) {
    return;
  }
  if (actual <= limit) {
    return;
  }
  allViolations.push({
    pageLabel: result.label,
    path: result.path,
    device: result.device,
    kind: "metric",
    id,
    value: actual,
    limit,
  });
}
