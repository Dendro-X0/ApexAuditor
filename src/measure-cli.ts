import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ApexConfig, ApexDevice } from "./types.js";
import { loadConfig } from "./config.js";
import { runMeasureForConfig } from "./measure-runner.js";
import type { MeasureSummary } from "./measure-types.js";
import { isSpinnerActive, stopSpinner, updateSpinnerMessage } from "./spinner.js";
import { renderPanel } from "./ui/render-panel.js";
import { renderTable } from "./ui/render-table.js";
import { UiTheme } from "./ui/ui-theme.js";

type DeviceFilterFlag = "mobile" | "desktop";

type MeasureArgs = {
  readonly configPath: string;
  readonly deviceFilter?: DeviceFilterFlag;
  readonly parallelOverride?: number;
  readonly timeoutMs?: number;
  readonly screenshots: boolean;
  readonly jsonOutput: boolean;
};

const NO_COLOR: boolean = Boolean(process.env.NO_COLOR) || process.env.CI === "true";
const theme: UiTheme = new UiTheme({ noColor: NO_COLOR });

function buildSummaryLines(summary: MeasureSummary): readonly string[] {
  const combos: number = summary.meta.comboCount;
  if (combos === 0) {
    return ["No measure results."];
  }
  let longTaskCount = 0;
  let longTaskTotalMs = 0;
  let longTaskMaxMs = 0;
  let scriptingTotalMs = 0;
  let scriptingCount = 0;
  let totalRequests = 0;
  let totalBytes = 0;
  let thirdPartyRequests = 0;
  let thirdPartyBytes = 0;
  let cacheHitsApprox = 0;
  let lateScripts = 0;
  for (const r of summary.results) {
    longTaskCount += r.longTasks.count;
    longTaskTotalMs += r.longTasks.totalMs;
    longTaskMaxMs = Math.max(longTaskMaxMs, r.longTasks.maxMs);
    if (r.scriptingDurationMs !== undefined) {
      scriptingTotalMs += r.scriptingDurationMs;
      scriptingCount += 1;
    }
    totalRequests += r.network.totalRequests;
    totalBytes += r.network.totalBytes;
    thirdPartyRequests += r.network.thirdPartyRequests;
    thirdPartyBytes += r.network.thirdPartyBytes;
    cacheHitsApprox += Math.round(r.network.cacheHitRatio * r.network.totalRequests);
    lateScripts += r.network.lateScriptRequests;
  }
  const avgScriptingMs: number = scriptingCount > 0 ? Math.round(scriptingTotalMs / scriptingCount) : 0;
  const cacheHitRatio: number = totalRequests > 0 ? cacheHitsApprox / totalRequests : 0;
  const thirdPartyShare: number = totalRequests > 0 ? thirdPartyRequests / totalRequests : 0;
  const kb: number = Math.round(totalBytes / 1024);
  const thirdPartyPercent: number = Math.round(thirdPartyShare * 100);
  const cacheHitPercent: number = Math.round(cacheHitRatio * 100);
  return [
    theme.bold("Summary"),
    `Combos: ${combos}`,
    `Long tasks: ${longTaskCount} tasks, total ${Math.round(longTaskTotalMs)}ms, max ${Math.round(longTaskMaxMs)}ms`,
    `Scripting: avg ${avgScriptingMs}ms`,
    `Network: ${totalRequests} requests, ${kb} KB; 3P ${thirdPartyRequests} (${thirdPartyPercent}%), cache-hit ${cacheHitPercent}%, late scripts ${lateScripts}`,
  ];
}

function parseArgs(argv: readonly string[]): MeasureArgs {
  let configPath: string | undefined;
  let deviceFilter: DeviceFilterFlag | undefined;
  let parallelOverride: number | undefined;
  let timeoutMs: number | undefined;
  let screenshots = false;
  let jsonOutput: boolean = false;
  for (let i = 2; i < argv.length; i += 1) {
    const arg: string = argv[i];
    if ((arg === "--config" || arg === "-c") && i + 1 < argv.length) {
      configPath = argv[i + 1];
      i += 1;
    } else if (arg === "--mobile-only") {
      deviceFilter = "mobile";
    } else if (arg === "--desktop-only") {
      deviceFilter = "desktop";
    } else if (arg === "--parallel" && i + 1 < argv.length) {
      const value: number = parseInt(argv[i + 1], 10);
      if (Number.isNaN(value) || value < 1 || value > 10) {
        throw new Error(`Invalid --parallel value: ${argv[i + 1]}. Expected integer between 1 and 10.`);
      }
      parallelOverride = value;
      i += 1;
    } else if (arg === "--timeout-ms" && i + 1 < argv.length) {
      const value: number = parseInt(argv[i + 1], 10);
      if (Number.isNaN(value) || value <= 0) {
        throw new Error(`Invalid --timeout-ms value: ${argv[i + 1]}. Expected a positive integer.`);
      }
      timeoutMs = value;
      i += 1;
    } else if (arg === "--screenshots" || arg === "--screenshot") {
      screenshots = true;
    } else if (arg === "--json") {
      jsonOutput = true;
    }
  }
  return { configPath: configPath ?? "apex.config.json", deviceFilter, parallelOverride, timeoutMs, screenshots, jsonOutput };
}

function formatMs(value: number | undefined): string {
  if (value === undefined) {
    return "-";
  }
  return `${Math.round(value)}ms`;
}

function formatKb(bytes: number): string {
  return `${Math.round(bytes / 1024)}KB`;
}

function buildTopSlowTable(summary: MeasureSummary): string {
  const maxRows: number = 10;
  const rows = [...summary.results]
    .map((r) => {
      const loadMs: number | undefined = r.timings.loadMs;
      return { r, loadMs: loadMs ?? Number.POSITIVE_INFINITY };
    })
    .filter((entry) => Number.isFinite(entry.loadMs))
    .sort((a, b) => a.loadMs - b.loadMs)
    .reverse()
    .slice(0, maxRows)
    .map(({ r }) => {
      const err: string = r.runtimeErrorMessage ? theme.red("err") : "";
      return [
        r.label,
        r.path,
        r.device,
        formatMs(r.timings.ttfbMs),
        formatMs(r.timings.loadMs),
        formatMs(r.vitals.lcpMs),
        `${Math.round((r.vitals.cls ?? 0) * 1000) / 1000}`,
        formatKb(r.network.totalBytes),
        `${r.network.totalRequests}`,
        err,
      ] as const;
    });

  if (rows.length === 0) {
    return "";
  }

  return renderTable({
    headers: ["Label", "Path", "Dev", "TTFB", "Load", "LCP", "CLS", "Bytes", "Req", ""],
    rows,
  });
}

function filterConfigDevices(config: ApexConfig, deviceFilter: ApexDevice | undefined): ApexConfig {
  if (!deviceFilter) {
    return config;
  }
  const pages = config.pages
    .map((page) => {
      const devices = page.devices.filter((d) => d === deviceFilter);
      return { path: page.path, label: page.label, devices };
    })
    .filter((p) => p.devices.length > 0);
  return { ...config, pages };
}

function formatEta(etaMs: number): string {
  const seconds: number = Math.max(0, Math.round(etaMs / 1000));
  const minutes: number = Math.floor(seconds / 60);
  const remainingSeconds: number = seconds % 60;
  if (minutes === 0) {
    return `${remainingSeconds}s`;
  }
  return `${minutes}m ${remainingSeconds}s`;
}

function writeProgressLine(message: string): void {
  if (typeof process === "undefined" || !process.stdout || typeof process.stdout.write !== "function") {
    // eslint-disable-next-line no-console
    console.log(message);
    return;
  }
  if (!process.stdout.isTTY) {
    // eslint-disable-next-line no-console
    console.log(message);
    return;
  }
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  process.stdout.write(message);
}

function buildErrorTable(summary: MeasureSummary): string {
  const rows = summary.results
    .filter((r) => Boolean(r.runtimeErrorMessage))
    .slice(0, 10)
    .map((r) => [r.label, r.path, r.device, theme.red("err")] as const);

  if (rows.length === 0) {
    return "";
  }

  return renderTable({ headers: ["Label", "Path", "Dev", ""], rows });
}

/**
 * Runs the ApexAuditor measure CLI (fast batch metrics, non-Lighthouse).
 *
 * @param argv - The process arguments array.
 */
export async function runMeasureCli(argv: readonly string[], options?: { readonly signal?: AbortSignal }): Promise<void> {
  const args: MeasureArgs = parseArgs(argv);
  const { configPath, config } = await loadConfig({ configPath: args.configPath });
  const filteredConfig: ApexConfig = filterConfigDevices(config, args.deviceFilter);
  if (filteredConfig.pages.length === 0) {
    // eslint-disable-next-line no-console
    console.error("No pages remain after applying device filter.");
    process.exitCode = 1;
    return;
  }
  const outputDir: string = resolve(".apex-auditor");
  const artifactsDir: string = resolve(outputDir, "measure");
  await mkdir(outputDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });

  let lastMessage: string | undefined;
  const summary: MeasureSummary = await runMeasureForConfig({
    config: filteredConfig,
    configPath,
    parallelOverride: args.parallelOverride,
    timeoutMs: args.timeoutMs,
    artifactsDir,
    captureScreenshots: args.screenshots,
    signal: options?.signal,
    onProgress: ({ completed, total, path, device, etaMs }) => {
      const etaText: string = etaMs !== undefined ? ` | ETA ${formatEta(etaMs)}` : "";
      const message: string = `Running measure ${completed}/${total} – ${path} [${device}]${etaText}`;
      if (message !== lastMessage) {
        lastMessage = message;
        if (isSpinnerActive()) {
          const shortEta: string = etaMs !== undefined ? ` ETA ${formatEta(etaMs)}` : "";
          updateSpinnerMessage(`Measure ${completed}/${total}${shortEta}`);
        } else {
          writeProgressLine(message);
        }
      }
      if (process.stdout.isTTY && completed === total) {
        process.stdout.write("\n");
      }
    },
  });
  await writeFile(resolve(outputDir, "measure-summary.json"), JSON.stringify(summary, null, 2), "utf8");
  if (args.jsonOutput) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (isSpinnerActive()) {
    stopSpinner();
  }
  if (typeof process !== "undefined" && process.stdout?.isTTY) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
  }
  const errorCount: number = summary.results.filter((r) => Boolean(r.runtimeErrorMessage)).length;
  const screenshotsText: string = args.screenshots ? "on" : "off";
  const topSlowTable: string = buildTopSlowTable(summary);
  const errorTable: string = buildErrorTable(summary);
  const metaLines: readonly string[] = [
    `Config: ${configPath}`,
    `Combos: ${summary.meta.comboCount}`,
    `Parallel: ${summary.meta.resolvedParallel}`,
    `Elapsed: ${Math.round(summary.meta.elapsedMs / 1000)}s (avg ${summary.meta.averageComboMs}ms/combo)`,
    `Output: .apex-auditor/measure-summary.json`,
    `Screenshots: ${screenshotsText}`,
    `Errors: ${errorCount}`,
  ];
  // eslint-disable-next-line no-console
  console.log(renderPanel({ title: theme.bold("Measure"), lines: [...metaLines, "", ...buildSummaryLines(summary)] }));
  if (topSlowTable.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`\n${theme.bold("Slowest (top 10 by Load)")}`);
    // eslint-disable-next-line no-console
    console.log(topSlowTable);
  }
  if (errorTable.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`\n${theme.bold("Errors (first 10)")}`);
    // eslint-disable-next-line no-console
    console.log(errorTable);
  }
}
