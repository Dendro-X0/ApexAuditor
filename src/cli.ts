import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { exec } from "node:child_process";
import { loadConfig } from "./config.js";
import { runAuditsForConfig } from "./lighthouse-runner.js";
import type {
  ApexBudgets,
  ApexConfig,
  ApexDevice,
  ApexPageConfig,
  ApexThrottlingMethod,
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
  readonly deviceFilter?: ApexDevice;
  readonly throttlingMethodOverride?: ApexThrottlingMethod;
  readonly cpuSlowdownOverride?: number;
  readonly parallelOverride?: number;
  readonly openReport: boolean;
  readonly warmUp: boolean;
  readonly jsonOutput: boolean;
  readonly showParallel: boolean;
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
const INP_GOOD_MS: number = 200;
const INP_WARN_MS: number = 500;

function parseArgs(argv: readonly string[]): CliArgs {
  let configPath: string | undefined;
  let ci: boolean = false;
  let colorMode: CliColorMode = "auto";
  let logLevelOverride: CliLogLevel | undefined;
  let deviceFilter: ApexDevice | undefined;
  let throttlingMethodOverride: ApexThrottlingMethod | undefined;
  let cpuSlowdownOverride: number | undefined;
  let parallelOverride: number | undefined;
  let openReport: boolean = false;
  let warmUp: boolean = false;
  let jsonOutput: boolean = false;
  let showParallel: boolean = false;
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
    } else if (arg === "--mobile-only") {
      if (deviceFilter !== undefined && deviceFilter !== "mobile") {
        throw new Error("Cannot combine --mobile-only and --desktop-only");
      }
      deviceFilter = "mobile";
    } else if (arg === "--desktop-only") {
      if (deviceFilter !== undefined && deviceFilter !== "desktop") {
        throw new Error("Cannot combine --mobile-only and --desktop-only");
      }
      deviceFilter = "desktop";
    } else if (arg === "--throttling" && i + 1 < argv.length) {
      const value: string = argv[i + 1];
      if (value === "simulate" || value === "devtools") {
        throttlingMethodOverride = value;
      } else {
        throw new Error(`Invalid --throttling value: ${value}. Expected "simulate" or "devtools".`);
      }
      i += 1;
    } else if (arg === "--cpu-slowdown" && i + 1 < argv.length) {
      const value: number = parseFloat(argv[i + 1]);
      if (Number.isNaN(value) || value <= 0 || value > 20) {
        throw new Error(`Invalid --cpu-slowdown value: ${argv[i + 1]}. Expected number between 0 and 20.`);
      }
      cpuSlowdownOverride = value;
      i += 1;
    } else if (arg === "--parallel" && i + 1 < argv.length) {
      const value: number = parseInt(argv[i + 1], 10);
      if (Number.isNaN(value) || value < 1 || value > 10) {
        throw new Error(`Invalid --parallel value: ${argv[i + 1]}. Expected integer between 1 and 10.`);
      }
      parallelOverride = value;
      i += 1;
    } else if (arg === "--open") {
      openReport = true;
    } else if (arg === "--warm-up") {
      warmUp = true;
    } else if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--show-parallel") {
      showParallel = true;
    }
  }
  const finalConfigPath: string = configPath ?? "apex.config.json";
  return { configPath: finalConfigPath, ci, colorMode, logLevelOverride, deviceFilter, throttlingMethodOverride, cpuSlowdownOverride, parallelOverride, openReport, warmUp, jsonOutput, showParallel };
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
  const effectiveThrottling: ApexThrottlingMethod | undefined = args.throttlingMethodOverride ?? config.throttlingMethod;
  const effectiveCpuSlowdown: number | undefined = args.cpuSlowdownOverride ?? config.cpuSlowdownMultiplier;
  const effectiveParallel: number | undefined = args.parallelOverride ?? config.parallel;
  const effectiveWarmUp: boolean = args.warmUp || config.warmUp === true;
  const effectiveConfig: ApexConfig = {
    ...config,
    logLevel: effectiveLogLevel,
    throttlingMethod: effectiveThrottling,
    cpuSlowdownMultiplier: effectiveCpuSlowdown,
    parallel: effectiveParallel,
    warmUp: effectiveWarmUp,
  };
  const filteredConfig: ApexConfig = filterConfigDevices(effectiveConfig, args.deviceFilter);
  if (filteredConfig.pages.length === 0) {
    // eslint-disable-next-line no-console
    console.error("No pages remain after applying device filter. Check your config and device flags.");
    process.exitCode = 1;
    return;
  }
  const summary: RunSummary = await runAuditsForConfig({ config: filteredConfig, configPath, showParallel: args.showParallel });
  const outputDir: string = resolve(".apex-auditor");
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  const markdown: string = buildMarkdown(summary);
  await writeFile(resolve(outputDir, "summary.md"), markdown, "utf8");
  const html: string = buildHtmlReport(summary);
  const reportPath: string = resolve(outputDir, "report.html");
  await writeFile(reportPath, html, "utf8");
  // Open HTML report in browser if requested
  if (args.openReport) {
    openInBrowser(reportPath);
  }
  // If JSON output requested, print JSON and exit early
  if (args.jsonOutput) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  // Also echo a compact, colourised table to stdout for quick viewing.
  const useColor: boolean = shouldUseColor(args.ci, args.colorMode);
  const consoleTable: string = buildConsoleTable(summary.results, useColor);
  // eslint-disable-next-line no-console
  console.log(consoleTable);
  printRunMeta(summary.meta, useColor);
  printSummaryStats(summary.results, useColor);
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

function filterConfigDevices(config: ApexConfig, deviceFilter: ApexDevice | undefined): ApexConfig {
  if (deviceFilter === undefined) {
    return config;
  }
  const filteredPages: ApexPageConfig[] = config.pages
    .map((page) => filterPageDevices(page, deviceFilter))
    .filter((page): page is ApexPageConfig => page !== undefined);
  return {
    ...config,
    pages: filteredPages,
  };
}

function filterPageDevices(page: ApexPageConfig, deviceFilter: ApexDevice): ApexPageConfig | undefined {
  const devices: readonly ApexDevice[] = page.devices.filter((device) => device === deviceFilter);
  if (devices.length === 0) {
    return undefined;
  }
  return {
    ...page,
    devices,
  };
}

function buildMarkdown(summary: RunSummary): string {
  const meta = summary.meta;
  const metaTable: string = [
    "| Field | Value |",
    "|-------|-------|",
    `| Config | ${meta.configPath} |`,
    `| Resolved parallel | ${meta.resolvedParallel} |`,
    `| Warm-up | ${meta.warmUp ? "yes" : "no"} |`,
    `| Throttling | ${meta.throttlingMethod} |`,
    `| CPU slowdown | ${meta.cpuSlowdownMultiplier} |`,
    `| Combos | ${meta.comboCount} |`,
    `| Runs per combo | ${meta.runsPerCombo} |`,
    `| Total steps | ${meta.totalSteps} |`,
    `| Started | ${meta.startedAt} |`,
    `| Completed | ${meta.completedAt} |`,
    `| Elapsed | ${formatElapsedTime(meta.elapsedMs)} |`,
    `| Avg per step | ${formatElapsedTime(meta.averageStepMs)} |`,
  ].join("\n");
  const header: string = [
    "| Label | Path | Device | P | A | BP | SEO | LCP (s) | FCP (s) | TBT (ms) | CLS | INP (ms) | Error | Top issues |",
    "|-------|------|--------|---|---|----|-----|---------|---------|----------|-----|----------|-------|-----------|",
  ].join("\n");
  const lines: string[] = summary.results.map((result) => buildRow(result));
  return `${metaTable}\n\n${header}\n${lines.join("\n")}`;
}

function buildHtmlReport(summary: RunSummary): string {
  const results = summary.results;
  const meta = summary.meta;
  const timestamp: string = new Date().toISOString();
  const rows: string = results.map((result) => buildHtmlRow(result)).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ApexAuditor Report</title>
  <style>
    :root { --green: #0cce6b; --yellow: #ffa400; --red: #ff4e42; --bg: #1a1a2e; --card: #16213e; --text: #eee; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); padding: 2rem; }
    h1 { margin-bottom: 0.5rem; }
    .meta { color: #888; margin-bottom: 2rem; font-size: 0.9rem; }
    .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .meta-card { background: #16213e; border-radius: 10px; padding: 1rem; border: 1px solid #23304f; }
    .meta-label { font-size: 0.8rem; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.04em; }
    .meta-value { font-size: 1rem; font-weight: 600; color: #e5e7eb; }
    .cards { display: grid; gap: 1.5rem; }
    .card { background: var(--card); border-radius: 12px; padding: 1.5rem; }
    .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; border-bottom: 1px solid #333; padding-bottom: 1rem; }
    .card-title { font-size: 1.1rem; font-weight: 600; }
    .device-badge { font-size: 0.75rem; padding: 0.25rem 0.5rem; border-radius: 4px; background: #333; }
    .device-badge.mobile { background: #0891b2; }
    .device-badge.desktop { background: #7c3aed; }
    .scores { display: flex; gap: 1rem; margin-bottom: 1rem; }
    .score-item { text-align: center; flex: 1; }
    .score-circle { width: 60px; height: 60px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.25rem; font-weight: bold; margin: 0 auto 0.5rem; border: 3px solid; }
    .score-circle.green { border-color: var(--green); color: var(--green); }
    .score-circle.yellow { border-color: var(--yellow); color: var(--yellow); }
    .score-circle.red { border-color: var(--red); color: var(--red); }
    .score-label { font-size: 0.75rem; color: #888; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 1rem; }
    .metric { background: #1a1a2e; padding: 0.75rem; border-radius: 8px; text-align: center; }
    .metric-value { font-size: 1.1rem; font-weight: 600; }
    .metric-value.green { color: var(--green); }
    .metric-value.yellow { color: var(--yellow); }
    .metric-value.red { color: var(--red); }
    .metric-label { font-size: 0.7rem; color: #888; margin-top: 0.25rem; }
    .issues { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #333; }
    .issues-title { font-size: 0.8rem; color: #888; margin-bottom: 0.5rem; }
    .issue { font-size: 0.85rem; color: #ccc; padding: 0.25rem 0; }
  </style>
</head>
<body>
  <h1>ApexAuditor Report</h1>
  <p class="meta">Generated: ${timestamp}</p>
  <div class="meta-grid">
    ${buildMetaCard("Config", escapeHtml(meta.configPath))}
    ${buildMetaCard("Resolved parallel", meta.resolvedParallel.toString())}
    ${buildMetaCard("Warm-up", meta.warmUp ? "Yes" : "No")}
    ${buildMetaCard("Throttling", meta.throttlingMethod)}
    ${buildMetaCard("CPU slowdown", meta.cpuSlowdownMultiplier.toString())}
    ${buildMetaCard("Combos", meta.comboCount.toString())}
    ${buildMetaCard("Runs per combo", meta.runsPerCombo.toString())}
    ${buildMetaCard("Total steps", meta.totalSteps.toString())}
    ${buildMetaCard("Elapsed", formatElapsedTime(meta.elapsedMs))}
    ${buildMetaCard("Avg / step", formatElapsedTime(meta.averageStepMs))}
    ${buildMetaCard("Started", meta.startedAt)}
    ${buildMetaCard("Completed", meta.completedAt)}
  </div>
  <div class="cards">
${rows}
  </div>
</body>
</html>`;
}

function buildHtmlRow(result: PageDeviceSummary): string {
  const scores = result.scores;
  const metrics = result.metrics;
  const lcpSeconds: string = metrics.lcpMs !== undefined ? (metrics.lcpMs / 1000).toFixed(1) + "s" : "-";
  const fcpSeconds: string = metrics.fcpMs !== undefined ? (metrics.fcpMs / 1000).toFixed(1) + "s" : "-";
  const tbtMs: string = metrics.tbtMs !== undefined ? Math.round(metrics.tbtMs) + "ms" : "-";
  const clsVal: string = metrics.cls !== undefined ? metrics.cls.toFixed(3) : "-";
  const inpMs: string = metrics.inpMs !== undefined ? Math.round(metrics.inpMs) + "ms" : "-";
  const issues: string = result.opportunities.slice(0, 3).map((o) => 
    `<div class="issue">${escapeHtml(o.title)}${o.estimatedSavingsMs ? ` (${Math.round(o.estimatedSavingsMs)}ms)` : ""}</div>`
  ).join("");
  return `    <div class="card">
      <div class="card-header">
        <div class="card-title">${escapeHtml(result.label)} <span style="color:#888">${escapeHtml(result.path)}</span></div>
        <span class="device-badge ${result.device}">${result.device}</span>
      </div>
      <div class="scores">
        ${buildScoreCircle("P", scores.performance)}
        ${buildScoreCircle("A", scores.accessibility)}
        ${buildScoreCircle("BP", scores.bestPractices)}
        ${buildScoreCircle("SEO", scores.seo)}
      </div>
      <div class="metrics">
        ${buildMetricBox("LCP", lcpSeconds, getMetricClass(metrics.lcpMs, 2500, 4000))}
        ${buildMetricBox("FCP", fcpSeconds, getMetricClass(metrics.fcpMs, 1800, 3000))}
        ${buildMetricBox("TBT", tbtMs, getMetricClass(metrics.tbtMs, 200, 600))}
        ${buildMetricBox("CLS", clsVal, getMetricClass(metrics.cls, 0.1, 0.25))}
        ${buildMetricBox("INP", inpMs, getMetricClass(metrics.inpMs, 200, 500))}
      </div>
      ${issues ? `<div class="issues"><div class="issues-title">Top Issues</div>${issues}</div>` : ""}
    </div>`;
}

function buildScoreCircle(label: string, score: number | undefined): string {
  const value: string = score !== undefined ? score.toString() : "-";
  const colorClass: string = score === undefined ? "" : score >= 90 ? "green" : score >= 50 ? "yellow" : "red";
  return `<div class="score-item"><div class="score-circle ${colorClass}">${value}</div><div class="score-label">${label}</div></div>`;
}

function buildMetricBox(label: string, value: string, colorClass: string): string {
  return `<div class="metric"><div class="metric-value ${colorClass}">${value}</div><div class="metric-label">${label}</div></div>`;
}

function buildMetaCard(label: string, value: string): string {
  return `<div class="meta-card"><div class="meta-label">${escapeHtml(label)}</div><div class="meta-value">${escapeHtml(value)}</div></div>`;
}

function printRunMeta(meta: RunSummary["meta"], useColor: boolean): void {
  const rows: { readonly label: string; readonly value: string }[] = [
    { label: "Resolved parallel", value: meta.resolvedParallel.toString() },
    { label: "Warm-up", value: meta.warmUp ? "Yes" : "No" },
    { label: "Throttling", value: meta.throttlingMethod },
    { label: "CPU slowdown", value: meta.cpuSlowdownMultiplier.toString() },
    { label: "Combos", value: meta.comboCount.toString() },
    { label: "Runs per combo", value: meta.runsPerCombo.toString() },
    { label: "Total steps", value: meta.totalSteps.toString() },
    { label: "Elapsed", value: formatElapsedTime(meta.elapsedMs) },
    { label: "Avg / step", value: formatElapsedTime(meta.averageStepMs) },
  ];
  const padLabel = (label: string): string => label.padEnd(16, " ");
  // eslint-disable-next-line no-console
  console.log("\nMeta:");
  for (const row of rows) {
    const value: string = useColor ? `${ANSI_CYAN}${row.value}${ANSI_RESET}` : row.value;
    // eslint-disable-next-line no-console
    console.log(`  ${padLabel(row.label)} ${value}`);
  }
}

function getMetricClass(value: number | undefined, good: number, warn: number): string {
  if (value === undefined) return "";
  return value <= good ? "green" : value <= warn ? "yellow" : "red";
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildConsoleTable(results: readonly PageDeviceSummary[], useColor: boolean): string {
  const header: string = [
    "| Label | Path | Device | P | A | BP | SEO |",
    "|-------|------|--------|---|---|----|-----|",
  ].join("\n");
  const rows: string[] = [];
  let previousKey: string | undefined;
  for (const result of results) {
    const key: string = `${result.label}:::${result.path}`;
    if (previousKey !== undefined && key !== previousKey) {
      rows.push("");
    }
    rows.push(buildConsoleRow(result, useColor));
    previousKey = key;
  }
  return `${header}\n${rows.join("\n")}`;
}

function buildRow(result: PageDeviceSummary): string {
  const scores = result.scores;
  const metrics = result.metrics;
  const lcpSeconds: string = metrics.lcpMs !== undefined ? (metrics.lcpMs / 1000).toFixed(1) : "-";
  const fcpSeconds: string = metrics.fcpMs !== undefined ? (metrics.fcpMs / 1000).toFixed(1) : "-";
  const tbtMs: string = metrics.tbtMs !== undefined ? Math.round(metrics.tbtMs).toString() : "-";
  const cls: string = metrics.cls !== undefined ? metrics.cls.toFixed(3) : "-";
  const inpMs: string = metrics.inpMs !== undefined ? Math.round(metrics.inpMs).toString() : "-";
  const issues: string = formatTopIssues(result.opportunities);
  const error: string =
    result.runtimeErrorCode ?? (result.runtimeErrorMessage !== undefined ? result.runtimeErrorMessage : "");
  return `| ${result.label} | ${result.path} | ${result.device} | ${scores.performance ?? "-"} | ${scores.accessibility ?? "-"} | ${scores.bestPractices ?? "-"} | ${scores.seo ?? "-"} | ${lcpSeconds} | ${fcpSeconds} | ${tbtMs} | ${cls} | ${inpMs} | ${error} | ${issues} |`;
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
  return `| ${result.label} | ${result.path} | ${deviceText} | ${performanceText} | ${accessibilityText} | ${bestPracticesText} | ${seoText} |`;
}

function buildConsoleMetricsLine(result: PageDeviceSummary, useColor: boolean): string {
  const metrics = result.metrics;
  const lcpText: string = formatMetricSeconds(metrics.lcpMs, LCP_GOOD_MS, LCP_WARN_MS, useColor);
  const fcpText: string = formatMetricSeconds(metrics.fcpMs, FCP_GOOD_MS, FCP_WARN_MS, useColor);
  const tbtText: string = formatMetricMilliseconds(metrics.tbtMs, TBT_GOOD_MS, TBT_WARN_MS, useColor);
  const clsText: string = formatMetricRatio(metrics.cls, CLS_GOOD, CLS_WARN, useColor);
  const inpText: string = formatMetricMilliseconds(metrics.inpMs, INP_GOOD_MS, INP_WARN_MS, useColor);
  const parts: string[] = [`LCP ${lcpText}`, `FCP ${fcpText}`, `TBT ${tbtText}`, `CLS ${clsText}`, `INP ${inpText}`];
  return `  ↳ Metrics: ${parts.join("  |  ")}`;
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
  const meaningful: OpportunitySummary[] = opportunities.filter((opp) => hasMeaningfulSavings(opp));
  const source: readonly OpportunitySummary[] = meaningful.length > 0 ? meaningful : opportunities;
  const sorted: OpportunitySummary[] = [...source].sort(compareOpportunitiesByImpact);
  const limit: number = 2;
  const top: OpportunitySummary[] = sorted.slice(0, limit);
  const items: string[] = top.map((opp) => formatOpportunityLabel(opp));
  return items.join("; ");
}

function hasMeaningfulSavings(opportunity: OpportunitySummary): boolean {
  const savingsMs: number = opportunity.estimatedSavingsMs ?? 0;
  const savingsBytes: number = opportunity.estimatedSavingsBytes ?? 0;
  return savingsMs > 0 || savingsBytes > 0;
}

function compareOpportunitiesByImpact(a: OpportunitySummary, b: OpportunitySummary): number {
  const aMs: number = a.estimatedSavingsMs ?? 0;
  const bMs: number = b.estimatedSavingsMs ?? 0;
  if (aMs !== bMs) {
    return bMs - aMs;
  }
  const aBytes: number = a.estimatedSavingsBytes ?? 0;
  const bBytes: number = b.estimatedSavingsBytes ?? 0;
  return bBytes - aBytes;
}

function formatOpportunityLabel(opportunity: OpportunitySummary): string {
  const savingsMs: string =
    opportunity.estimatedSavingsMs !== undefined ? `${Math.round(opportunity.estimatedSavingsMs)}ms` : "";
  const savingsBytes: string =
    opportunity.estimatedSavingsBytes !== undefined
      ? `${Math.round(opportunity.estimatedSavingsBytes / 1024)}KB`
      : "";
  const parts: string[] = [savingsMs, savingsBytes].filter((part) => part.length > 0);
  const suffix: string = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `${opportunity.id}${suffix}`;
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

function printSummaryStats(results: readonly PageDeviceSummary[], useColor: boolean): void {
  if (results.length === 0) return;
  
  const scores = {
    performance: results.map((r) => r.scores.performance).filter((s): s is number => s !== undefined),
    accessibility: results.map((r) => r.scores.accessibility).filter((s): s is number => s !== undefined),
    bestPractices: results.map((r) => r.scores.bestPractices).filter((s): s is number => s !== undefined),
    seo: results.map((r) => r.scores.seo).filter((s): s is number => s !== undefined),
  };

  const avg = (arr: number[]): number => arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
  const countGreen = (arr: number[]): number => arr.filter((s) => s >= 90).length;
  const countYellow = (arr: number[]): number => arr.filter((s) => s >= 50 && s < 90).length;
  const countRed = (arr: number[]): number => arr.filter((s) => s < 50).length;

  const avgP = avg(scores.performance);
  const avgA = avg(scores.accessibility);
  const avgBP = avg(scores.bestPractices);
  const avgSEO = avg(scores.seo);

  const greenCount = countGreen(scores.performance) + countGreen(scores.accessibility) + countGreen(scores.bestPractices) + countGreen(scores.seo);
  const yellowCount = countYellow(scores.performance) + countYellow(scores.accessibility) + countYellow(scores.bestPractices) + countYellow(scores.seo);
  const redCount = countRed(scores.performance) + countRed(scores.accessibility) + countRed(scores.bestPractices) + countRed(scores.seo);
  const totalScores = greenCount + yellowCount + redCount;

  const formatAvg = (val: number): string => {
    if (!useColor) return val.toString();
    const color = val >= 90 ? ANSI_GREEN : val >= 50 ? ANSI_YELLOW : ANSI_RED;
    return `${color}${val}${ANSI_RESET}`;
  };

  // eslint-disable-next-line no-console
  console.log(`\n📊 Summary: Avg P:${formatAvg(avgP)} A:${formatAvg(avgA)} BP:${formatAvg(avgBP)} SEO:${formatAvg(avgSEO)}`);
  
  const greenText = useColor ? `${ANSI_GREEN}${greenCount}${ANSI_RESET}` : greenCount.toString();
  const yellowText = useColor ? `${ANSI_YELLOW}${yellowCount}${ANSI_RESET}` : yellowCount.toString();
  const redText = useColor ? `${ANSI_RED}${redCount}${ANSI_RESET}` : redCount.toString();
  // eslint-disable-next-line no-console
  console.log(`   Scores: ${greenText} green (90+) | ${yellowText} yellow (50-89) | ${redText} red (<50) of ${totalScores} total`);
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
  addMetricViolation("inpMs", metrics.inpMs, metricsBudgets.inpMs, result, allViolations);
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

function openInBrowser(filePath: string): void {
  const platform = process.platform;
  let command: string;
  if (platform === "win32") {
    command = `start "" "${filePath}"`;
  } else if (platform === "darwin") {
    command = `open "${filePath}"`;
  } else {
    command = `xdg-open "${filePath}"`;
  }
  exec(command, (error) => {
    if (error) {
      // eslint-disable-next-line no-console
      console.error(`Could not open report: ${error.message}`);
    }
  });
}
