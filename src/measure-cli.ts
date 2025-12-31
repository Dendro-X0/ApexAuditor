import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ApexConfig, ApexDevice } from "./types.js";
import { loadConfig } from "./config.js";
import { runMeasureForConfig } from "./measure-runner.js";
import type { MeasureSummary } from "./measure-types.js";

type DeviceFilterFlag = "mobile" | "desktop";

type MeasureArgs = {
  readonly configPath: string;
  readonly deviceFilter?: DeviceFilterFlag;
  readonly parallelOverride?: number;
  readonly timeoutMs?: number;
  readonly jsonOutput: boolean;
};

function printSummary(summary: MeasureSummary): void {
  const combos: number = summary.meta.comboCount;
  if (combos === 0) {
    // eslint-disable-next-line no-console
    console.log("No measure results.");
    return;
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
  // eslint-disable-next-line no-console
  console.log(
    [
      "Summary:",
      `  Combos: ${combos}`,
      `  Long tasks: ${longTaskCount} tasks, total ${Math.round(longTaskTotalMs)}ms, max ${Math.round(longTaskMaxMs)}ms`,
      `  Scripting: avg ${avgScriptingMs}ms`,
      `  Network: ${totalRequests} requests, ${Math.round(totalBytes / 1024)} KB; 3P ${thirdPartyRequests} (${Math.round(thirdPartyShare * 100)}%), cache-hit ${Math.round(cacheHitRatio * 100)}%, late scripts ${lateScripts}`,
    ].join("\n"),
  );
}

function parseArgs(argv: readonly string[]): MeasureArgs {
  let configPath: string | undefined;
  let deviceFilter: DeviceFilterFlag | undefined;
  let parallelOverride: number | undefined;
  let timeoutMs: number | undefined;
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
    } else if (arg === "--json") {
      jsonOutput = true;
    }
  }
  return { configPath: configPath ?? "apex.config.json", deviceFilter, parallelOverride, timeoutMs, jsonOutput };
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

/**
 * Runs the ApexAuditor measure CLI (fast batch metrics, non-Lighthouse).
 *
 * @param argv - The process arguments array.
 */
export async function runMeasureCli(argv: readonly string[]): Promise<void> {
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
  const summary: MeasureSummary = await runMeasureForConfig({
    config: filteredConfig,
    configPath,
    parallelOverride: args.parallelOverride,
    timeoutMs: args.timeoutMs,
    artifactsDir,
  });
  await writeFile(resolve(outputDir, "measure-summary.json"), JSON.stringify(summary, null, 2), "utf8");
  if (args.jsonOutput) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`Measured ${summary.meta.comboCount} combos in ${Math.round(summary.meta.elapsedMs / 1000)}s (avg ${summary.meta.averageComboMs}ms/combo).`);
  // eslint-disable-next-line no-console
  console.log(`Wrote .apex-auditor/measure-summary.json`);
  printSummary(summary);
}
