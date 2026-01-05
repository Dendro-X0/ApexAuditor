import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import type { ApexConfig, ApexDevice } from "./types.js";
import { runMeasureCli } from "./measure-cli.js";
import { runHeadersCli } from "./headers-cli.js";
import { runLinksCli } from "./links-cli.js";
import { runBundleCli } from "./bundle-cli.js";
import { runAccessibilityAudit } from "./accessibility.js";
import type { AxeResult, AxeSummary, AxeViolation } from "./accessibility-types.js";
import { writeRunnerReports } from "./runner-reporting.js";
import { writeQuickConsolidation } from "./quick-consolidation.js";
import { writeArtifactsNavigation } from "./artifacts-navigation.js";

type QuickDeviceFilter = ApexDevice | undefined;

type QuickArgs = {
  readonly configPath: string;
  readonly projectRoot: string;
  readonly deviceFilter: QuickDeviceFilter;
  readonly measureParallel?: number;
  readonly measureTimeoutMs?: number;
  readonly headersParallel?: number;
  readonly headersTimeoutMs?: number;
  readonly linksParallel?: number;
  readonly linksTimeoutMs?: number;
  readonly linksMaxUrls?: number;
  readonly bundleTop?: number;
  readonly accessibilityParallel?: number;
  readonly accessibilityTimeoutMs?: number;
  readonly jsonOutput: boolean;
};

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

const DEFAULT_LINKS_MAX_URLS: number = 200;

function parsePositiveInt(value: string, flag: string): number {
  const parsed: number = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${flag} value: ${value}`);
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): QuickArgs {
  let configPath: string = "apex.config.json";
  let projectRoot: string = process.cwd();
  let deviceFilter: QuickDeviceFilter;
  let measureParallel: number | undefined;
  let measureTimeoutMs: number | undefined;
  let headersParallel: number | undefined;
  let headersTimeoutMs: number | undefined;
  let linksParallel: number | undefined;
  let linksTimeoutMs: number | undefined;
  let linksMaxUrls: number | undefined;
  let bundleTop: number | undefined;
  let accessibilityParallel: number | undefined;
  let accessibilityTimeoutMs: number | undefined;
  let jsonOutput: boolean = false;
  for (let i: number = 2; i < argv.length; i += 1) {
    const arg: string = argv[i] ?? "";
    if ((arg === "--config" || arg === "-c") && i + 1 < argv.length) {
      configPath = argv[i + 1] ?? configPath;
      i += 1;
      continue;
    }
    if ((arg === "--project-root" || arg === "--root") && i + 1 < argv.length) {
      projectRoot = argv[i + 1] ?? projectRoot;
      i += 1;
      continue;
    }
    if (arg === "--mobile-only") {
      deviceFilter = "mobile";
      continue;
    }
    if (arg === "--desktop-only") {
      deviceFilter = "desktop";
      continue;
    }
    if (arg === "--measure-parallel" && i + 1 < argv.length) {
      measureParallel = parsePositiveInt(argv[i + 1] ?? "", "--measure-parallel");
      i += 1;
      continue;
    }
    if (arg === "--measure-timeout-ms" && i + 1 < argv.length) {
      measureTimeoutMs = parsePositiveInt(argv[i + 1] ?? "", "--measure-timeout-ms");
      i += 1;
      continue;
    }
    if (arg === "--headers-parallel" && i + 1 < argv.length) {
      headersParallel = parsePositiveInt(argv[i + 1] ?? "", "--headers-parallel");
      i += 1;
      continue;
    }
    if (arg === "--headers-timeout-ms" && i + 1 < argv.length) {
      headersTimeoutMs = parsePositiveInt(argv[i + 1] ?? "", "--headers-timeout-ms");
      i += 1;
      continue;
    }
    if (arg === "--links-parallel" && i + 1 < argv.length) {
      linksParallel = parsePositiveInt(argv[i + 1] ?? "", "--links-parallel");
      i += 1;
      continue;
    }
    if (arg === "--links-timeout-ms" && i + 1 < argv.length) {
      linksTimeoutMs = parsePositiveInt(argv[i + 1] ?? "", "--links-timeout-ms");
      i += 1;
      continue;
    }
    if (arg === "--links-max-urls" && i + 1 < argv.length) {
      linksMaxUrls = parsePositiveInt(argv[i + 1] ?? "", "--links-max-urls");
      i += 1;
      continue;
    }
    if (arg === "--bundle-top" && i + 1 < argv.length) {
      bundleTop = parsePositiveInt(argv[i + 1] ?? "", "--bundle-top");
      i += 1;
      continue;
    }
    if (arg === "--accessibility-parallel" && i + 1 < argv.length) {
      accessibilityParallel = parsePositiveInt(argv[i + 1] ?? "", "--accessibility-parallel");
      i += 1;
      continue;
    }
    if (arg === "--accessibility-timeout-ms" && i + 1 < argv.length) {
      accessibilityTimeoutMs = parsePositiveInt(argv[i + 1] ?? "", "--accessibility-timeout-ms");
      i += 1;
      continue;
    }
    if (arg === "--json") {
      jsonOutput = true;
      continue;
    }
  }
  return {
    configPath,
    projectRoot,
    deviceFilter,
    measureParallel,
    measureTimeoutMs,
    headersParallel,
    headersTimeoutMs,
    linksParallel,
    linksTimeoutMs,
    linksMaxUrls,
    bundleTop,
    accessibilityParallel,
    accessibilityTimeoutMs,
    jsonOutput,
  };
}

function filterConfigDevices(config: ApexConfig, deviceFilter: QuickDeviceFilter): ApexConfig {
  if (!deviceFilter) {
    return config;
  }
  const pages = config.pages
    .map((page) => {
      const devices: readonly ApexDevice[] = page.devices.filter((d) => d === deviceFilter);
      return { path: page.path, label: page.label, devices };
    })
    .filter((p) => p.devices.length > 0);
  return { ...config, pages };
}

function selectTopViolations(result: AxeResult, limit: number): readonly AxeViolation[] {
  const impactRank: Record<string, number> = { critical: 1, serious: 2, moderate: 3, minor: 4 };
  return [...result.violations]
    .sort((a, b) => {
      const rankA: number = impactRank[a.impact ?? ""] ?? 5;
      const rankB: number = impactRank[b.impact ?? ""] ?? 5;
      if (rankA !== rankB) {
        return rankA - rankB;
      }
      return b.nodes.length - a.nodes.length;
    })
    .slice(0, limit);
}

function buildAccessibilityFindings(summary: AxeSummary): readonly RunnerFinding[] {
  const evidence: readonly RunnerEvidence[] = [{ kind: "file", path: ".apex-auditor/accessibility-summary.json" }] as const;
  const counts: { critical: number; serious: number; moderate: number; minor: number } = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  let errored: number = 0;
  for (const result of summary.results) {
    if (result.runtimeErrorMessage) {
      errored += 1;
      continue;
    }
    for (const violation of result.violations) {
      const impact: string | undefined = violation.impact;
      if (impact === "critical") counts.critical += 1;
      else if (impact === "serious") counts.serious += 1;
      else if (impact === "moderate") counts.moderate += 1;
      else if (impact === "minor") counts.minor += 1;
    }
  }
  const findings: RunnerFinding[] = [];
  findings.push({
    title: "Impact counts",
    severity: counts.critical > 0 || counts.serious > 0 ? "error" : "info",
    details: [
      `critical: ${counts.critical}`,
      `serious: ${counts.serious}`,
      `moderate: ${counts.moderate}`,
      `minor: ${counts.minor}`,
      `errored: ${errored}/${summary.results.length}`,
    ],
    evidence,
  });
  const top: readonly AxeResult[] = [...summary.results]
    .filter((r) => !r.runtimeErrorMessage)
    .sort((a, b) => b.violations.length - a.violations.length)
    .slice(0, 5);
  if (top.length > 0) {
    const details: string[] = [];
    for (const r of top) {
      const sample: readonly AxeViolation[] = selectTopViolations(r, 3);
      const sampleTitles: readonly string[] = sample.map((v) => v.help ?? v.id);
      details.push(`${r.label} ${r.path} [${r.device}] – ${r.violations.length} violations: ${sampleTitles.join(" | ")}`);
    }
    findings.push({ title: "Worst pages (top 5 by violation count)", severity: "warn", details, evidence });
  }
  const erroredPages: readonly AxeResult[] = summary.results
    .filter((r) => typeof r.runtimeErrorMessage === "string" && r.runtimeErrorMessage.length > 0)
    .slice(0, 10);
  if (erroredPages.length > 0) {
    findings.push({
      title: "Errored pages",
      severity: "error",
      details: erroredPages.map((r) => `${r.label} ${r.path} [${r.device}] – ${r.runtimeErrorMessage ?? ""}`),
      evidence,
    });
  }
  return findings;
}

function buildCliArgs(params: { readonly base: readonly string[]; readonly flag: string; readonly value: string | undefined }): readonly string[] {
  if (!params.value) {
    return params.base;
  }
  return [...params.base, params.flag, params.value];
}

function buildDeviceArgs(deviceFilter: QuickDeviceFilter): readonly string[] {
  if (deviceFilter === "mobile") {
    return ["--mobile-only"];
  }
  if (deviceFilter === "desktop") {
    return ["--desktop-only"];
  }
  return [];
}

async function runAccessibilityPass(params: {
  readonly outputDir: string;
  readonly configPath: string;
  readonly config: ApexConfig;
  readonly parallelOverride?: number;
  readonly timeoutMs?: number;
}): Promise<AxeSummary> {
  const artifactsDir: string = resolve(params.outputDir, "accessibility");
  const summary: AxeSummary = await runAccessibilityAudit({
    config: params.config,
    configPath: params.configPath,
    parallelOverride: params.parallelOverride,
    timeoutMs: params.timeoutMs,
    artifactsDir,
  });
  await writeFile(resolve(params.outputDir, "accessibility-summary.json"), JSON.stringify(summary, null, 2), "utf8");
  await writeRunnerReports({
    outputDir: params.outputDir,
    runner: "accessibility",
    generatedAt: new Date().toISOString(),
    humanTitle: "ApexAuditor Accessibility report",
    humanSummaryLines: [`Combos: ${summary.meta.comboCount}`, `Elapsed: ${Math.round(summary.meta.elapsedMs / 1000)}s`],
    artifacts: [
      { label: "Accessibility summary (JSON)", relativePath: "accessibility-summary.json" },
      { label: "Accessibility artifacts", relativePath: "accessibility/" },
    ],
    aiMeta: { configPath: params.configPath, comboCount: summary.meta.comboCount, elapsedMs: summary.meta.elapsedMs },
    aiFindings: buildAccessibilityFindings(summary),
  });
  return summary;
}

export async function runQuickCli(argv: readonly string[]): Promise<void> {
  const args: QuickArgs = parseArgs(argv);
  const outputDir: string = resolve(".apex-auditor");
  await mkdir(outputDir, { recursive: true });
  const { configPath, config }: { readonly configPath: string; readonly config: ApexConfig } = await loadConfig({ configPath: args.configPath });
  const filteredConfig: ApexConfig = filterConfigDevices(config, args.deviceFilter);
  const deviceArgs: readonly string[] = buildDeviceArgs(args.deviceFilter);
  let measureArgv: readonly string[] = ["node", "apex-auditor", "--config", configPath, ...deviceArgs];
  measureArgv = buildCliArgs({ base: measureArgv, flag: "--parallel", value: args.measureParallel?.toString() });
  measureArgv = buildCliArgs({ base: measureArgv, flag: "--timeout-ms", value: args.measureTimeoutMs?.toString() });
  await runMeasureCli(measureArgv);
  let headersArgv: readonly string[] = ["node", "apex-auditor", "--config", configPath];
  headersArgv = buildCliArgs({ base: headersArgv, flag: "--parallel", value: args.headersParallel?.toString() });
  headersArgv = buildCliArgs({ base: headersArgv, flag: "--timeout-ms", value: args.headersTimeoutMs?.toString() });
  await runHeadersCli(headersArgv);
  let linksArgv: readonly string[] = ["node", "apex-auditor", "--config", configPath];
  linksArgv = buildCliArgs({ base: linksArgv, flag: "--parallel", value: args.linksParallel?.toString() });
  linksArgv = buildCliArgs({ base: linksArgv, flag: "--timeout-ms", value: args.linksTimeoutMs?.toString() });
  linksArgv = buildCliArgs({ base: linksArgv, flag: "--max-urls", value: (args.linksMaxUrls ?? DEFAULT_LINKS_MAX_URLS).toString() });
  await runLinksCli(linksArgv);
  let bundleArgv: readonly string[] = ["node", "apex-auditor", "--project-root", args.projectRoot];
  bundleArgv = buildCliArgs({ base: bundleArgv, flag: "--top", value: args.bundleTop?.toString() });
  await runBundleCli(bundleArgv);
  await runAccessibilityPass({
    outputDir,
    configPath,
    config: filteredConfig,
    parallelOverride: args.accessibilityParallel,
    timeoutMs: args.accessibilityTimeoutMs,
  });
  const nowIso: string = new Date().toISOString();
  const consolidated = await writeQuickConsolidation({
    outputDir,
    generatedAt: nowIso,
    meta: { configPath, projectRoot: args.projectRoot },
    runners: ["measure", "headers", "links", "bundle", "accessibility"],
  });
  await writeArtifactsNavigation({ outputDir });
  if (args.jsonOutput) {
    process.stdout.write(`${JSON.stringify(consolidated.aiReport, null, 2)}\n`);
  }
}
