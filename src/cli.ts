import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { exec } from "node:child_process";
import { loadConfig } from "./config.js";
import type { AxeResult, AxeSummary, AxeViolation } from "./accessibility-types.js";
import { runAccessibilityAudit } from "./accessibility.js";
import { startSpinner, stopSpinner, updateSpinnerMessage } from "./spinner.js";
import { runAuditsForConfig } from "./lighthouse-runner.js";
import { postJsonWebhook } from "./webhooks.js";
import { renderPanel } from "./ui/render-panel.js";
import { renderTable } from "./ui/render-table.js";
import { UiTheme } from "./ui/ui-theme.js";
import type {
  ApexCategory,
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

type CliColorMode = "auto" | "always" | "never";

async function runCommand(command: string, cwd: string): Promise<string> {
  return await new Promise<string>((resolveCommand, rejectCommand) => {
    exec(command, { cwd }, (error, stdout, stderr) => {
      if (error) {
        rejectCommand(new Error(stderr.trim() || error.message));
        return;
      }
      resolveCommand(stdout);
    });
  });
}

interface CliArgs {
  readonly configPath: string;
  readonly ci: boolean;
  readonly failOnBudget: boolean;
  readonly colorMode: CliColorMode;
  readonly logLevelOverride: CliLogLevel | undefined;
  readonly deviceFilter: ApexDevice | undefined;
  readonly throttlingMethodOverride: ApexThrottlingMethod | undefined;
  readonly cpuSlowdownOverride: number | undefined;
  readonly parallelOverride: number | undefined;
  readonly auditTimeoutMsOverride: number | undefined;
  readonly plan: boolean;
  readonly yes: boolean;
  readonly maxSteps: number | undefined;
  readonly maxCombos: number | undefined;
  readonly stable: boolean;
  readonly openReport: boolean;
  readonly warmUp: boolean;
  readonly incremental: boolean;
  readonly buildId: string | undefined;
  readonly runsOverride: number | undefined;
  readonly quick: boolean;
  readonly accurate: boolean;
  readonly jsonOutput: boolean;
  readonly showParallel: boolean;
  readonly fast: boolean;
  readonly overview: boolean;
  readonly overviewCombos: number | undefined;
  readonly regressionsOnly: boolean;
  readonly changedOnly: boolean;
  readonly rerunFailing: boolean;
  readonly accessibilityPass: boolean;
  readonly webhookUrl: string | undefined;
  readonly webhookAlways: boolean;
}

function colorScore(score: number | undefined, theme: UiTheme): string {
  if (score === undefined) {
    return "-";
  }
  if (score >= 90) {
    return theme.green(score.toString());
  }
  if (score >= 50) {
    return theme.yellow(score.toString());
  }
  return theme.red(score.toString());
}

function colorDevice(device: ApexDevice, theme: UiTheme): string {
  return device === "mobile" ? theme.cyan("mobile") : theme.magenta("desktop");
}

type SummaryPanelParams = {
  readonly results: readonly PageDeviceSummary[];
  readonly useColor: boolean;
  readonly regressionsOnly: boolean;
  readonly previousSummary?: RunSummary;
};

type RegressionLine = {
  readonly label: string;
  readonly path: string;
  readonly device: ApexDevice;
  readonly previousP: number;
  readonly currentP: number;
  readonly deltaP: number;
};

type BudgetViolationLine = {
  readonly pageLabel: string;
  readonly path: string;
  readonly device: ApexDevice;
  readonly kind: "category" | "metric";
  readonly id: string;
  readonly value: number;
  readonly limit: number;
};

type ShareableExport = {
  readonly generatedAt: string;
  readonly regressions: readonly RegressionLine[];
  readonly topIssues: readonly { readonly title: string; readonly count: number; readonly totalMs: number }[];
  readonly deepAuditTargets: readonly { readonly label: string; readonly path: string; readonly device: ApexDevice; readonly score: number }[];
  readonly suggestedCommands: readonly string[];
  readonly budgets?: ApexBudgets;
  readonly budgetViolations: readonly BudgetViolationLine[];
  readonly budgetPassed: boolean;
};

type AxeImpactCounts = {
  readonly critical: number;
  readonly serious: number;
  readonly moderate: number;
  readonly minor: number;
};

type AccessibilitySummary = {
  readonly impactCounts: AxeImpactCounts;
  readonly errored: number;
  readonly total: number;
};

type WebhookPayload = {
  readonly type: "apex-auditor";
  readonly buildId?: string;
  readonly elapsedMs: number;
  readonly regressions: readonly RegressionLine[];
  readonly budget: {
    readonly passed: boolean;
    readonly violations: number;
  };
  readonly accessibility?: {
    readonly critical: number;
    readonly serious: number;
    readonly moderate: number;
    readonly minor: number;
    readonly errored: number;
    readonly total: number;
  };
  readonly links?: {
    readonly reportHtml?: string;
    readonly exportJson?: string;
    readonly accessibilitySummary?: string;
  };
};

function buildWebhookPayload(params: {
  readonly current: RunSummary;
  readonly previous: RunSummary | undefined;
  readonly budgetViolations: readonly BudgetViolation[];
  readonly accessibility?: AccessibilitySummary;
  readonly reportPath: string;
  readonly exportPath: string;
  readonly accessibilityPath?: string;
}): WebhookPayload {
  const regressions: readonly RegressionLine[] = collectRegressions(params.previous, params.current);
  const budgetPassed: boolean = params.budgetViolations.length === 0;
  return {
    type: "apex-auditor",
    buildId: params.current.meta.buildId,
    elapsedMs: params.current.meta.elapsedMs,
    regressions,
    budget: {
      passed: budgetPassed,
      violations: params.budgetViolations.length,
    },
    accessibility:
      params.accessibility === undefined
        ? undefined
        : {
            critical: params.accessibility.impactCounts.critical,
            serious: params.accessibility.impactCounts.serious,
            moderate: params.accessibility.impactCounts.moderate,
            minor: params.accessibility.impactCounts.minor,
            errored: params.accessibility.errored,
            total: params.accessibility.total,
          },
    links: {
      reportHtml: params.reportPath,
      exportJson: params.exportPath,
      accessibilitySummary: params.accessibilityPath,
    },
  };
}

function shouldSendWebhook(regressions: readonly RegressionLine[], budgetViolations: readonly BudgetViolation[]): boolean {
  return regressions.length > 0 || budgetViolations.length > 0;
}

function summariseAccessibility(results: AxeSummary): AccessibilitySummary {
  const counts: { critical: number; serious: number; moderate: number; minor: number } = {
    critical: 0,
    serious: 0,
    moderate: 0,
    minor: 0,
  };
  let errored = 0;
  for (const result of results.results) {
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
  return { impactCounts: { ...counts }, errored, total: results.results.length };
}

function buildAccessibilityPanel(summary: AccessibilitySummary, useColor: boolean): string {
  const theme: UiTheme = new UiTheme({ noColor: !useColor });
  const headers: readonly string[] = ["Impact", "Count"];
  const rows: string[][] = [
    ["critical", summary.impactCounts.critical.toString()],
    ["serious", summary.impactCounts.serious.toString()],
    ["moderate", summary.impactCounts.moderate.toString()],
    ["minor", summary.impactCounts.minor.toString()],
  ];
  const table: string = renderTable({ headers, rows });
  const metaLines: string[] = [
    `${theme.bold("Total combos")}: ${summary.total}`,
    `${theme.bold("Errored combos")}: ${summary.errored}`,
  ];
  return `${table}\n${metaLines.join("\n")}`;
}

function buildSectionIndex(useColor: boolean): string {
  const theme: UiTheme = new UiTheme({ noColor: !useColor });
  const lines: string[] = [
    `${theme.bold("Sections")}:`,
    `  1) Effective settings`,
    `  2) Meta`,
    `  3) Stats`,
    `  4) Changes`,
    `  5) Summary`,
    `  6) Issues`,
    `  7) Top fixes`,
    `  8) Lowest performance`,
    `  9) Export (regressions/issues)`,
  ];
  return lines.join("\n");
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
      const nodesA: number = a.nodes.length;
      const nodesB: number = b.nodes.length;
      return nodesB - nodesA;
    })
    .slice(0, limit);
}

function buildAccessibilityIssuesPanel(results: readonly AxeResult[], useColor: boolean): string {
  const theme: UiTheme = new UiTheme({ noColor: !useColor });
  if (results.length === 0) {
    return renderPanel({ title: theme.bold("Accessibility (top issues)"), lines: [theme.dim("No accessibility results.")] });
  }
  const lines: string[] = [];
  for (const result of results) {
    lines.push(`${theme.bold(`${result.label} ${result.path} [${result.device}]`)}`);
    if (result.runtimeErrorMessage) {
      lines.push(`- ${theme.red("Error")}: ${result.runtimeErrorMessage}`);
      continue;
    }
    const tops: readonly AxeViolation[] = selectTopViolations(result, 3);
    if (tops.length === 0) {
      lines.push(theme.dim("- No violations found"));
      continue;
    }
    for (const violation of tops) {
      const impact: string = violation.impact ? `${violation.impact}: ` : "";
      const title: string = violation.help ?? violation.id;
      const targetSample: string = violation.nodes[0]?.target?.[0] ?? "";
      const detail: string = targetSample ? ` (${targetSample})` : "";
      lines.push(`- ${impact}${title}${detail}`);
    }
  }
  return renderPanel({ title: theme.bold("Accessibility (top issues)"), lines });
}

function severityBackground(score: number | undefined): string {
  if (score === undefined) {
    return "";
  }
  if (score >= 90) {
    return "";
  }
  if (score >= 50) {
    return "";
  }
  return "";
}

function applyRowBackground(row: readonly string[], score: number | undefined, useColor: boolean): readonly string[] {
  const bg: string = severityBackground(score);
  if (!useColor || bg === "") {
    return row;
  }
  return row;
}

function formatDelta(curr: number | undefined, prev: number | undefined, theme: UiTheme): string {
  if (curr === undefined || prev === undefined) {
    return "-";
  }
  const delta: number = curr - prev;
  if (delta === 0) {
    return theme.dim("0");
  }
  const text: string = delta > 0 ? `+${delta}` : `${delta}`;
  return delta > 0 ? theme.green(text) : theme.red(text);
}

function buildSummaryPanel(params: SummaryPanelParams): string {
  const theme: UiTheme = new UiTheme({ noColor: !params.useColor });
  const hasPrev: boolean = params.previousSummary !== undefined;
  const headers: readonly string[] = params.useColor
    ? [
        theme.bold("Label"),
        theme.bold("Path"),
        theme.bold("Device"),
        theme.green("P"),
        hasPrev ? theme.cyan("ΔP") : "",
        theme.cyan("A"),
        theme.magenta("BP"),
        theme.yellow("SEO"),
      ].filter((h) => h !== "")
    : ["Label", "Path", "Device", "P", ...(hasPrev ? ["ΔP"] : []), "A", "BP", "SEO"];
  const prevMap: Map<string, PageDeviceSummary> | undefined =
    params.previousSummary !== undefined
      ? new Map(params.previousSummary.results.map((r) => [`${r.label}:::${r.path}:::${r.device}`, r]))
      : undefined;
  const filtered: readonly PageDeviceSummary[] = params.regressionsOnly && prevMap !== undefined
    ? params.results.filter((r) => {
        const key: string = `${r.label}:::${r.path}:::${r.device}`;
        const prev: PageDeviceSummary | undefined = prevMap.get(key);
        const prevScore: number | undefined = prev?.scores.performance;
        const currScore: number | undefined = r.scores.performance;
        return prevScore !== undefined && currScore !== undefined && currScore < prevScore;
      })
    : params.results;
  const rows: readonly (readonly string[])[] = filtered.map((r) => {
    const scores = r.scores;
    const prevScore: number | undefined = prevMap?.get(`${r.label}:::${r.path}:::${r.device}`)?.scores.performance;
    const baseRow: readonly string[] = [
      r.label,
      r.path,
      colorDevice(r.device, theme),
      colorScore(scores.performance, theme),
      ...(hasPrev ? [formatDelta(scores.performance, prevScore, theme)] : []),
      colorScore(scores.accessibility, theme),
      colorScore(scores.bestPractices, theme),
      colorScore(scores.seo, theme),
    ];
    return applyRowBackground(baseRow, scores.performance, params.useColor);
  });
  return renderTable({ headers, rows });
}

function collectRegressions(previous: RunSummary | undefined, current: RunSummary): readonly RegressionLine[] {
  if (previous === undefined) {
    return [];
  }
  const prevMap: Map<string, PageDeviceSummary> = new Map(
    previous.results.map((r) => [`${r.label}:::${r.path}:::${r.device}`, r] as const),
  );
  const lines: RegressionLine[] = [];
  for (const r of current.results) {
    const key: string = `${r.label}:::${r.path}:::${r.device}`;
    const prev: PageDeviceSummary | undefined = prevMap.get(key);
    if (prev?.scores.performance !== undefined && r.scores.performance !== undefined) {
      const delta: number = r.scores.performance - prev.scores.performance;
      if (delta < 0) {
        lines.push({
          label: r.label,
          path: r.path,
          device: r.device,
          previousP: prev.scores.performance,
          currentP: r.scores.performance,
          deltaP: delta,
        });
      }
    }
  }
  return lines.sort((a, b) => a.deltaP - b.deltaP).slice(0, 10);
}

function collectDeepAuditTargets(results: readonly PageDeviceSummary[]): readonly {
  readonly label: string;
  readonly path: string;
  readonly device: ApexDevice;
  readonly score: number;
}[] {
  return [...results]
    .sort((a, b) => (a.scores.performance ?? 101) - (b.scores.performance ?? 101))
    .slice(0, 5)
    .map((r) => ({
      label: r.label,
      path: r.path,
      device: r.device,
      score: r.scores.performance ?? 0,
    }));
}

function collectTopIssues(results: readonly PageDeviceSummary[]): readonly {
  readonly title: string;
  readonly count: number;
  readonly totalMs: number;
}[] {
  const counts: Map<string, { readonly title: string; count: number; totalMs: number }> = new Map();
  for (const r of results) {
    for (const opp of r.opportunities) {
      const existing = counts.get(opp.title);
      if (existing) {
        existing.count += 1;
        existing.totalMs += opp.estimatedSavingsMs ?? 0;
      } else {
        counts.set(opp.title, { title: opp.title, count: 1, totalMs: opp.estimatedSavingsMs ?? 0 });
      }
    }
  }
  return [...counts.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, 5);
}

function buildSuggestedCommands(configPath: string, targets: readonly { readonly path: string; readonly device: ApexDevice }[]): readonly string[] {
  return targets.map((t) => `pnpm tsx src/bin.ts --config ${configPath} --${t.device}-only --open-report # focus on ${t.path}`);
}

function buildShareableExport(params: {
  readonly configPath: string;
  readonly previousSummary: RunSummary | undefined;
  readonly current: RunSummary;
  readonly budgets: ApexBudgets | undefined;
}): ShareableExport {
  const regressions: readonly RegressionLine[] = collectRegressions(params.previousSummary, params.current);
  const deepAuditTargets = collectDeepAuditTargets(params.current.results);
  const suggestedCommands: readonly string[] = buildSuggestedCommands(
    params.configPath,
    deepAuditTargets.map((t) => ({ path: t.path, device: t.device })),
  );
  const budgetViolations: readonly BudgetViolationLine[] =
    params.budgets === undefined
      ? []
      : collectBudgetViolations(params.current.results, params.budgets).map((v) => ({
          pageLabel: v.pageLabel,
          path: v.path,
          device: v.device,
          kind: v.kind,
          id: v.id,
          value: v.value,
          limit: v.limit,
        }));
  return {
    generatedAt: new Date().toISOString(),
    regressions,
    topIssues: collectTopIssues(params.current.results),
    deepAuditTargets,
    suggestedCommands,
    budgets: params.budgets,
    budgetViolations,
    budgetPassed: budgetViolations.length === 0,
  };
}

function buildExportPanel(params: { readonly exportPath: string; readonly useColor: boolean; readonly share: ShareableExport }): string {
  const theme: UiTheme = new UiTheme({ noColor: !params.useColor });
  const lines: string[] = [];

  const width: number = 80;
  const divider = (): void => {
    lines.push(theme.dim("─".repeat(width)));
  };
  const formBorder = (label: string): { readonly top: string; readonly bottom: string } => {
    const labelText: string = ` ${label} `;
    const remaining: number = Math.max(width - labelText.length - 2, 0);
    const bar: string = "─".repeat(remaining);
    return {
      top: theme.dim(`┌${labelText}${bar}`),
      bottom: theme.dim(`└${"─".repeat(width - 1)}`),
    };
  };

  lines.push(theme.bold("Export"));
  lines.push(theme.dim(`Path: ${params.exportPath}`));
  lines.push(theme.dim(`Generated: ${params.share.generatedAt}`));
  divider();

  // Budgets
  if (params.share.budgets !== undefined) {
    const statusText: string = params.share.budgetPassed ? theme.green("passed") : theme.red("failed");
    lines.push(`${theme.bold("Budgets")} ${statusText}`);
    const thresholdRows: (readonly string[])[] = [];
    const categories = params.share.budgets.categories;
    if (categories !== undefined) {
      if (categories.performance !== undefined) thresholdRows.push(["category", "performance", `${categories.performance}`]);
      if (categories.accessibility !== undefined) thresholdRows.push(["category", "accessibility", `${categories.accessibility}`]);
      if (categories.bestPractices !== undefined) thresholdRows.push(["category", "bestPractices", `${categories.bestPractices}`]);
      if (categories.seo !== undefined) thresholdRows.push(["category", "seo", `${categories.seo}`]);
    }
    const metrics = params.share.budgets.metrics;
    if (metrics !== undefined) {
      if (metrics.lcpMs !== undefined) thresholdRows.push(["metric", "lcpMs", `${metrics.lcpMs}ms`]);
      if (metrics.fcpMs !== undefined) thresholdRows.push(["metric", "fcpMs", `${metrics.fcpMs}ms`]);
      if (metrics.tbtMs !== undefined) thresholdRows.push(["metric", "tbtMs", `${metrics.tbtMs}ms`]);
      if (metrics.cls !== undefined) thresholdRows.push(["metric", "cls", `${metrics.cls}`]);
      if (metrics.inpMs !== undefined) thresholdRows.push(["metric", "inpMs", `${metrics.inpMs}ms`]);
    }
    if (thresholdRows.length > 0) {
      lines.push(
        renderTable({
          headers: ["Type", "Id", "Limit"],
          rows: thresholdRows,
        }),
      );
    }
    if (params.share.budgetViolations.length > 0) {
      lines.push(theme.bold("Violations"));
      params.share.budgetViolations.forEach((v) => {
        const valueText: string = v.kind === "category" ? `${Math.round(v.value)}` : `${Math.round(v.value)}ms`;
        const limitText: string = v.kind === "category" ? `${Math.round(v.limit)}` : `${Math.round(v.limit)}ms`;
        lines.push(
          `${v.pageLabel} ${v.path} [${colorDevice(v.device, theme)}] – ${v.kind} ${v.id}: ${valueText} vs limit ${limitText}`,
        );
      });
    } else {
      lines.push(theme.dim("No violations."));
    }
    divider();
  }

  // Regressions
  lines.push(`${theme.bold("Regressions")} ${theme.dim("(top 10 by ΔP)")}`);
  if (params.share.regressions.length === 0) {
    lines.push(theme.green("No regressions detected."));
  } else {
    const regressionRows: readonly (readonly string[])[] = params.share.regressions.map((r) => [
      r.label,
      r.path,
      colorDevice(r.device, theme),
      colorScore(r.currentP, theme),
      r.deltaP >= 0 ? theme.green(`+${r.deltaP}`) : theme.red(String(r.deltaP)),
      String(r.previousP),
    ]);
    lines.push(
      renderTable({
        headers: ["Label", "Path", "Device", "P", "ΔP", "Prev P"],
        rows: regressionRows,
      }),
    );
  }
  divider();

  // Deep audit targets
  lines.push(`${theme.bold("Deep audit targets")} ${theme.dim("(worst 5 by P)")}`);
  const deepRows: readonly (readonly string[])[] = params.share.deepAuditTargets.map((t) => [
    t.label,
    t.path,
    colorDevice(t.device, theme),
    colorScore(t.score, theme),
  ]);
  lines.push(
    renderTable({
      headers: ["Label", "Path", "Device", "P"],
      rows: deepRows,
    }),
  );
  divider();

  // Suggested commands
  lines.push(`${theme.bold("Suggested commands")} ${theme.dim("(copy/paste ready)")}`);
  if (params.share.suggestedCommands.length === 0) {
    lines.push(theme.dim("No suggestions available."));
  } else {
    const box = formBorder("Copy/paste");
    lines.push(box.top);
    params.share.suggestedCommands.forEach((cmd, index) => {
      const prefix: string = `${String(index + 1).padStart(2, "0")}.`;
      lines.push(`${theme.dim("│")} ${theme.dim(prefix)} ${cmd}`);
    });
    lines.push(box.bottom);
  }

  return lines.join("\n");
}

function buildIssuesPanel(results: readonly PageDeviceSummary[], useColor: boolean): string {
  const theme: UiTheme = new UiTheme({ noColor: !useColor });
  const reds = results.filter((r) => (r.scores.performance ?? 100) < 50);
  if (reds.length === 0) {
    return renderPanel({ title: theme.bold("Issues"), lines: [theme.green("No red issues.")] });
  }
  const lines: string[] = reds.map((r) => {
    const top = r.opportunities[0];
    const issue: string = top ? `${top.title}${top.estimatedSavingsMs ? ` (${Math.round(top.estimatedSavingsMs)}ms)` : ""}` : "No top issue reported";
    const perfText: string = colorScore(r.scores.performance, theme);
    const deviceText: string = colorDevice(r.device, theme);
    return `${r.label} ${r.path} [${deviceText}] – P:${perfText} – ${issue}`;
  });
  return renderPanel({ title: theme.bold("Issues"), lines });
}

function buildTopFixesPanel(results: readonly PageDeviceSummary[], useColor: boolean): string {
  const theme: UiTheme = new UiTheme({ noColor: !useColor });
  const opportunityCounts: Map<string, { readonly title: string; count: number; totalMs: number }> = new Map();
  for (const r of results) {
    for (const opp of r.opportunities) {
      const existing = opportunityCounts.get(opp.title);
      if (existing) {
        existing.count += 1;
        existing.totalMs += opp.estimatedSavingsMs ?? 0;
      } else {
        opportunityCounts.set(opp.title, { title: opp.title, count: 1, totalMs: opp.estimatedSavingsMs ?? 0 });
      }
    }
  }
  const sorted = [...opportunityCounts.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, 5);
  if (sorted.length === 0) {
    return renderPanel({ title: theme.bold("Top fixes"), lines: [theme.dim("No opportunities collected.")] });
  }
  const lines: string[] = sorted.map((o) => `- ${theme.cyan(o.title)} (seen on ${o.count} pages) (${Math.round(o.totalMs)}ms)`);
  return renderPanel({ title: theme.bold("Top fixes"), lines });
}

function buildLowestPerformancePanel(results: readonly PageDeviceSummary[], useColor: boolean): string {
  const theme: UiTheme = new UiTheme({ noColor: !useColor });
  const sorted = [...results].sort((a, b) => (a.scores.performance ?? 101) - (b.scores.performance ?? 101)).slice(0, 5);
  const lines: string[] = sorted.map((r) => {
    const perfText: string = colorScore(r.scores.performance, theme);
    const deviceText: string = colorDevice(r.device, theme);
    return `${r.label} ${r.path} [${deviceText}] P:${perfText}`;
  });
  return renderPanel({ title: theme.bold("Lowest performance"), lines });
}

function buildBudgetsPanel(params: {
  readonly budgets: ApexBudgets | undefined;
  readonly violations: readonly BudgetViolation[];
  readonly useColor: boolean;
}): string | undefined {
  if (params.budgets === undefined) {
    return undefined;
  }
  const theme: UiTheme = new UiTheme({ noColor: !params.useColor });
  if (params.violations.length === 0) {
    return renderPanel({ title: theme.bold("Budgets"), lines: [theme.green("All budgets passed.")] });
  }
  const lines: string[] = params.violations.map((v) => {
    const valueText: string = v.kind === "category" ? `${Math.round(v.value)}` : `${Math.round(v.value)}ms`;
    const limitText: string = v.kind === "category" ? `${Math.round(v.limit)}` : `${Math.round(v.limit)}ms`;
    return `${v.pageLabel} ${v.path} [${v.device}] – ${v.kind} ${v.id}: ${valueText} vs limit ${limitText}`;
  });
  return renderPanel({ title: theme.bold("Budgets"), lines });
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

const DEFAULT_MAX_STEPS: number = 120;
const DEFAULT_MAX_COMBOS: number = 60;
const DEFAULT_OVERVIEW_MAX_COMBOS: number = 10;

async function confirmLargeRun(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }
  const wasRaw: boolean | undefined = (process.stdin as unknown as { readonly isRaw?: boolean }).isRaw;
  process.stdin.setRawMode?.(true);
  process.stdin.setEncoding("utf8");
  process.stdout.write(message);
  return await new Promise<boolean>((resolve) => {
    const onData = (chunk: Buffer | string): void => {
      process.stdin.setRawMode?.(Boolean(wasRaw));
      process.stdin.pause();
      const raw: string = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const first: string | undefined = raw.trim().charAt(0);
      const yes: boolean = first === "y" || first === "Y";
      process.stdout.write("\n");
      resolve(yes);
    };
    process.stdin.once("data", onData);
    process.stdin.resume();
  });
}

function parseArgs(argv: readonly string[]): CliArgs {
  let configPath: string | undefined;
  let ci: boolean = false;
  let failOnBudget: boolean = false;
  let colorMode: CliColorMode = "auto";
  let logLevelOverride: CliLogLevel | undefined;
  let deviceFilter: ApexDevice | undefined;
  let throttlingMethodOverride: ApexThrottlingMethod | undefined;
  let cpuSlowdownOverride: number | undefined;
  let parallelOverride: number | undefined;
  let auditTimeoutMsOverride: number | undefined;
  let plan = false;
  let yes = false;
  let maxSteps: number | undefined;
  let maxCombos: number | undefined;
  let stable = false;
  let openReport = false;
  let warmUp = false;
  let incremental = false;
  let buildId: string | undefined;
  let runsOverride: number | undefined;
  let quick = false;
  let accurate = false;
  let jsonOutput = false;
  let showParallel = false;
  let fast = false;
  let overview = false;
  let overviewCombos: number | undefined;
  let regressionsOnly = false;
  let changedOnly = false;
  let rerunFailing = false;
  let accessibilityPass = false;
  let webhookUrl: string | undefined;
  let webhookAlways = false;
  for (let i = 2; i < argv.length; i += 1) {
    const arg: string = argv[i];
    if ((arg === "--config" || arg === "-c") && i + 1 < argv.length) {
      configPath = argv[i + 1];
      i += 1;
    } else if (arg === "--ci") {
      ci = true;
    } else if (arg === "--fail-on-budget") {
      failOnBudget = true;
    } else if (arg === "--no-color") {
      colorMode = "never";
    } else if (arg === "--color") {
      colorMode = "always";
    } else if (arg === "--log-level" && i + 1 < argv.length) {
      const value: string = argv[i + 1];
      if (value === "silent" || value === "error" || value === "info" || value === "verbose") {
        logLevelOverride = value;
      } else {
        throw new Error(`Unknown argument: ${arg}`);
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
    } else if (arg === "--audit-timeout-ms" && i + 1 < argv.length) {
      const value: number = parseInt(argv[i + 1], 10);
      if (Number.isNaN(value) || value <= 0) {
        throw new Error(`Invalid --audit-timeout-ms value: ${argv[i + 1]}. Expected a positive integer (milliseconds).`);
      }
      auditTimeoutMsOverride = value;
      i += 1;
    } else if (arg === "--plan") {
      plan = true;
    } else if (arg === "--regressions-only") {
      regressionsOnly = true;
    } else if (arg === "--changed-only") {
      changedOnly = true;
    } else if (arg === "--rerun-failing") {
      rerunFailing = true;
    } else if (arg === "--accessibility-pass") {
      accessibilityPass = true;
    } else if (arg === "--webhook-url" && i + 1 < argv.length) {
      webhookUrl = argv[i + 1];
      i += 1;
    } else if (arg === "--webhook-always") {
      webhookAlways = true;
    } else if (arg === "--max-steps" && i + 1 < argv.length) {
      const value: number = parseInt(argv[i + 1], 10);
      if (Number.isNaN(value) || value <= 0) {
        throw new Error(`Invalid --max-steps value: ${argv[i + 1]}. Expected a positive integer.`);
      }
      maxSteps = value;
      i += 1;
    } else if (arg === "--max-combos" && i + 1 < argv.length) {
      const value: number = parseInt(argv[i + 1], 10);
      if (Number.isNaN(value) || value <= 0) {
        throw new Error(`Invalid --max-combos value: ${argv[i + 1]}. Expected a positive integer.`);
      }
      maxCombos = value;
      i += 1;
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else if (arg.startsWith("--parallel=")) {
      parallelOverride = Number(arg.split("=")[1]);
      if (Number.isNaN(parallelOverride)) {
        parallelOverride = undefined;
      }
    } else if (arg === "--stable") {
      stable = true;
    } else if (arg === "--open" || arg === "--open-report") {
      openReport = true;
    } else if (arg === "--warm-up") {
      warmUp = true;
    } else if (arg === "--incremental") {
      incremental = true;
    } else if (arg === "--build-id" && i + 1 < argv.length) {
      buildId = argv[i + 1];
      i += 1;
    } else if (arg === "--runs" && i + 1 < argv.length) {
      const value: number = parseInt(argv[i + 1], 10);
      if (Number.isNaN(value) || value !== 1) {
        throw new Error(
          `Multi-run mode is no longer supported. Received --runs ${argv[i + 1]}. ` +
            "Run the same command multiple times instead (more stable).",
        );
      }
      runsOverride = value;
      i += 1;
    } else if (arg === "--overview-combos" && i + 1 < argv.length) {
      const value: number = parseInt(argv[i + 1], 10);
      if (Number.isNaN(value) || value <= 0 || value > 200) {
        throw new Error(`Invalid --overview-combos value: ${argv[i + 1]}. Expected integer between 1 and 200.`);
      }
      overviewCombos = value;
      i += 1;
    } else if (arg === "--quick") {
      quick = true;
    } else if (arg === "--accurate") {
      accurate = true;
    } else if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--show-parallel") {
      showParallel = true;
    } else if (arg === "--fast") {
      fast = true;
    } else if (arg === "--overview") {
      overview = true;
    }
  }
  const presetCount: number = [fast, quick, accurate, overview].filter((flag) => flag).length;
  if (presetCount > 1) {
    throw new Error("Choose only one preset: --overview, --fast, --quick, or --accurate");
  }
  const finalConfigPath: string = configPath ?? "apex.config.json";
  return {
    configPath: finalConfigPath,
    ci,
    failOnBudget,
    colorMode,
    logLevelOverride,
    deviceFilter,
    throttlingMethodOverride,
    cpuSlowdownOverride,
    parallelOverride,
    auditTimeoutMsOverride,
    plan,
    yes,
    maxSteps,
    maxCombos,
    stable,
    openReport,
    warmUp,
    incremental,
    buildId,
    runsOverride,
    quick,
    accurate,
    jsonOutput,
    showParallel,
    fast,
    overview,
    overviewCombos,
    regressionsOnly,
    changedOnly,
    rerunFailing,
    accessibilityPass,
    webhookUrl,
    webhookAlways,
  };
}

function printPlan(params: {
  readonly configPath: string;
  readonly resolvedConfig: ApexConfig;
  readonly plannedCombos: number;
  readonly plannedSteps: number;
  readonly sampled: boolean;
  readonly sampledCombos: number;
  readonly maxCombos: number;
  readonly maxSteps: number;
  readonly useColor: boolean;
}): void {
  const lines: string[] = [];
  lines.push(`Config: ${params.configPath}`);
  lines.push(`Parallel: ${params.resolvedConfig.parallel ?? "auto"}`);
  lines.push(`Throttling: ${params.resolvedConfig.throttlingMethod ?? "simulate"}`);
  lines.push(`CPU slowdown: ${params.resolvedConfig.cpuSlowdownMultiplier ?? 4}`);
  lines.push(`Warm-up: ${params.resolvedConfig.warmUp === true ? "yes" : "no"}`);
  lines.push(`Incremental: ${params.resolvedConfig.incremental === true ? "yes" : "no"}`);
  lines.push(`Build ID: ${params.resolvedConfig.buildId ?? "-"}`);
  lines.push(`Runs per combo: 1`);
  lines.push(`Planned combos: ${params.plannedCombos}`);
  lines.push(`Planned Lighthouse runs (steps): ${params.plannedSteps}`);
  if (params.sampled) {
    lines.push(`Overview sampling: yes (${params.sampledCombos} combos)`);
  }
  lines.push(`Guardrails: combos<=${params.maxCombos}, steps<=${params.maxSteps}`);
  printSectionHeader("Plan", params.useColor);
  printDivider();
  // eslint-disable-next-line no-console
  console.log(boxifyWithSeparators(lines));
  printDivider();
}

function sampleConfigForOverview(config: ApexConfig, maxCombos: number): { readonly config: ApexConfig; readonly sampled: boolean; readonly sampledCombos: number } {
  const nextPages: ApexPageConfig[] = [];
  let combos = 0;
  for (const page of config.pages) {
    if (combos >= maxCombos) {
      break;
    }
    const remaining: number = maxCombos - combos;
    const devices: ApexDevice[] = page.devices.slice(0, remaining);
    if (devices.length === 0) {
      continue;
    }
    nextPages.push({ ...page, devices });
    combos += devices.length;
  }
  const sampled: boolean = combos < config.pages.reduce((acc, p) => acc + p.devices.length, 0);
  return { config: { ...config, pages: nextPages }, sampled, sampledCombos: combos };
}

async function resolveAutoBuildId(configPath: string): Promise<string | undefined> {
  const startDir: string = dirname(configPath);
  const tryReadText = async (absolutePath: string): Promise<string | undefined> => {
    try {
      const raw: string = await readFile(absolutePath, "utf8");
      const trimmed: string = raw.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    } catch {
      return undefined;
    }
  };
  const findUp = async (relativePath: string): Promise<string | undefined> => {
    let currentDir: string = startDir;
    while (true) {
      const candidate: string = resolve(currentDir, relativePath);
      const value: string | undefined = await tryReadText(candidate);
      if (value !== undefined) {
        return value;
      }
      const parent: string = dirname(currentDir);
      if (parent === currentDir) {
        return undefined;
      }
      currentDir = parent;
    }
  };
  const nextBuildId: string | undefined = await findUp(".next/BUILD_ID");
  if (nextBuildId !== undefined) {
    return `next:${nextBuildId}`;
  }
  const gitHead: string | undefined = await findUp(".git/HEAD");
  if (gitHead === undefined) {
    return undefined;
  }
  if (gitHead.startsWith("ref:")) {
    const refPath: string = gitHead.replace("ref:", "").trim();
    const refValue: string | undefined = await findUp(`.git/${refPath}`);
    return refValue !== undefined ? `git:${refValue}` : undefined;
  }
  return `git:${gitHead}`;
}

async function loadPreviousSummary(): Promise<RunSummary | undefined> {
  const previousPath: string = resolve(".apex-auditor", "summary.json");
  try {
    const raw: string = await readFile(previousPath, "utf8");
    const parsed: unknown = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    return parsed as RunSummary;
  } catch {
    return undefined;
  }
}

type AvgScores = {
  readonly performance: number;
  readonly accessibility: number;
  readonly bestPractices: number;
  readonly seo: number;
};

function computeAvgScores(results: readonly PageDeviceSummary[]): AvgScores {
  const sums = results.reduce(
    (acc, r) => {
      return {
        performance: acc.performance + (r.scores.performance ?? 0),
        accessibility: acc.accessibility + (r.scores.accessibility ?? 0),
        bestPractices: acc.bestPractices + (r.scores.bestPractices ?? 0),
        seo: acc.seo + (r.scores.seo ?? 0),
        count: acc.count + 1,
      };
    },
    { performance: 0, accessibility: 0, bestPractices: 0, seo: 0, count: 0 },
  );
  const count: number = Math.max(1, sums.count);
  return {
    performance: Math.round(sums.performance / count),
    accessibility: Math.round(sums.accessibility / count),
    bestPractices: Math.round(sums.bestPractices / count),
    seo: Math.round(sums.seo / count),
  };
}

function buildEffectiveSettingsPanel(params: { readonly configPath: string; readonly config: ApexConfig; readonly useColor: boolean }): string {
  const theme: UiTheme = new UiTheme({ noColor: !params.useColor });
  const buildIdText: string = params.config.buildId ?? "-";
  const throttlingText: string = params.config.throttlingMethod ?? "simulate";
  const cpuText: string = String(params.config.cpuSlowdownMultiplier ?? 4);
  const parallelText: string = String(params.config.parallel ?? 4);
  const warmUpText: string = params.config.warmUp ? "yes" : "no";
  const incrementalText: string = params.config.incremental ? "on" : "off";
  const lines: string[] = [];
  lines.push(`${theme.dim("Config")}: ${params.configPath}`);
  lines.push(`${theme.dim("Build ID")}: ${buildIdText}`);
  lines.push(`${theme.dim("Incremental")}: ${incrementalText}`);
  lines.push(`${theme.dim("Warm-up")}: ${warmUpText}`);
  lines.push(`${theme.dim("Throttling")}: ${throttlingText}`);
  lines.push(`${theme.dim("CPU slowdown")}: ${cpuText}`);
  lines.push(`${theme.dim("Parallel")}: ${parallelText}`);
  return renderPanel({ title: theme.bold("Effective settings"), lines });
}

function buildMetaPanel(meta: RunSummary["meta"], useColor: boolean): string {
  const theme: UiTheme = new UiTheme({ noColor: !useColor });
  const cacheSummary: string = meta.incremental
    ? `${meta.executedCombos} executed / ${meta.cachedCombos} cached (steps: ${meta.executedSteps}/${meta.cachedSteps})`
    : "No";
  const lines: string[] = [
    `${theme.dim("Build ID")}: ${meta.buildId ?? "-"}`,
    `${theme.dim("Incremental")}: ${meta.incremental ? "Yes" : "No"}`,
    `${theme.dim("Resolved parallel")}: ${meta.resolvedParallel}`,
    `${theme.dim("Warm-up")}: ${meta.warmUp ? "Yes" : "No"}`,
    `${theme.dim("Throttling")}: ${meta.throttlingMethod}`,
    `${theme.dim("CPU slowdown")}: ${meta.cpuSlowdownMultiplier}`,
    `${theme.dim("Combos")}: ${meta.comboCount}`,
    `${theme.dim("Cache")}: ${cacheSummary}`,
    `${theme.dim("Runs per combo")}: ${meta.runsPerCombo}`,
    `${theme.dim("Total steps")}: ${meta.totalSteps}`,
    `${theme.dim("Elapsed")}: ${formatElapsedTime(meta.elapsedMs)}`,
    `${theme.dim("Avg / step")}: ${formatElapsedTime(meta.averageStepMs)}`,
  ];
  return renderPanel({ title: theme.bold("Meta"), lines });
}

function buildStatsPanel(results: readonly PageDeviceSummary[], useColor: boolean): string {
  const theme: UiTheme = new UiTheme({ noColor: !useColor });
  let pSum = 0;
  let aSum = 0;
  let bpSum = 0;
  let seoSum = 0;
  let count = 0;
  let green = 0;
  let yellow = 0;
  let red = 0;
  for (const r of results) {
    const p = r.scores.performance;
    if (p !== undefined) {
      count += 1;
      pSum += p;
      if (p >= 90) {
        green += 1;
      } else if (p >= 50) {
        yellow += 1;
      } else {
        red += 1;
      }
    }
    if (r.scores.accessibility !== undefined) aSum += r.scores.accessibility;
    if (r.scores.bestPractices !== undefined) bpSum += r.scores.bestPractices;
    if (r.scores.seo !== undefined) seoSum += r.scores.seo;
  }
  const avgP = count > 0 ? Math.round(pSum / count) : 0;
  const avgA = results.length > 0 ? Math.round(aSum / results.length) : 0;
  const avgBP = results.length > 0 ? Math.round(bpSum / results.length) : 0;
  const avgSEO = results.length > 0 ? Math.round(seoSum / results.length) : 0;
  const lines: string[] = [
    `${theme.dim("Summary")}: Avg P:${avgP} A:${avgA} BP:${avgBP} SEO:${avgSEO}`,
    `${theme.dim("Scores")}: ${theme.green(`${green} green (90+)`)} | ${theme.yellow(`${yellow} yellow (50-89)`)} | ${theme.red(`${red} red (<50)`)} of ${count} total`,
  ];
  return renderPanel({ title: theme.bold("Stats"), lines });
}

type ChangeLine = {
  readonly key: string;
  readonly label: string;
  readonly path: string;
  readonly device: ApexDevice;
  readonly deltaP: number;
};

function buildChangesBox(previous: RunSummary, current: RunSummary, useColor: boolean): string {
  const prevAvg: AvgScores = computeAvgScores(previous.results);
  const currAvg: AvgScores = computeAvgScores(current.results);
  const avgDelta = {
    performance: currAvg.performance - prevAvg.performance,
    accessibility: currAvg.accessibility - prevAvg.accessibility,
    bestPractices: currAvg.bestPractices - prevAvg.bestPractices,
    seo: currAvg.seo - prevAvg.seo,
  };
  const prevMap: Map<string, PageDeviceSummary> = new Map(
    previous.results.map((r) => [`${r.label}:::${r.path}:::${r.device}`, r] as const),
  );
  const currMap: Map<string, PageDeviceSummary> = new Map(
    current.results.map((r) => [`${r.label}:::${r.path}:::${r.device}`, r] as const),
  );
  const allKeys: Set<string> = new Set([...prevMap.keys(), ...currMap.keys()]);
  const deltas: ChangeLine[] = [];
  let added = 0;
  let removed = 0;
  for (const key of allKeys) {
    const prev: PageDeviceSummary | undefined = prevMap.get(key);
    const curr: PageDeviceSummary | undefined = currMap.get(key);
    if (!prev && curr) {
      added += 1;
      continue;
    }
    if (prev && !curr) {
      removed += 1;
      continue;
    }
    if (!prev || !curr) {
      continue;
    }
    const deltaP: number = (curr.scores.performance ?? 0) - (prev.scores.performance ?? 0);
    deltas.push({
      key,
      label: curr.label,
      path: curr.path,
      device: curr.device,
      deltaP,
    });
  }
  deltas.sort((a, b) => a.deltaP - b.deltaP);
  const regressions: ChangeLine[] = deltas.slice(0, 5);
  const improvements: ChangeLine[] = [...deltas].reverse().slice(0, 5);
  const formatDelta = (value: number): string => {
    const sign: string = value > 0 ? "+" : "";
    if (!useColor) {
      return `${sign}${value}`;
    }
    if (value > 0) {
      return `${ANSI_GREEN}${sign}${value}${ANSI_RESET}`;
    }
    if (value < 0) {
      return `${ANSI_RED}${sign}${value}${ANSI_RESET}`;
    }
    return `${ANSI_CYAN}${sign}${value}${ANSI_RESET}`;
  };
  const lines: string[] = [];
  lines.push(`Avg deltas: P ${formatDelta(avgDelta.performance)} | A ${formatDelta(avgDelta.accessibility)} | BP ${formatDelta(avgDelta.bestPractices)} | SEO ${formatDelta(avgDelta.seo)}`);
  lines.push(`Combos: +${added} added, -${removed} removed`);
  lines.push("");
  lines.push("Top regressions (Performance):");
  for (const r of regressions) {
    lines.push(`- ${r.label} ${r.path} [${r.device}] ΔP:${formatDelta(r.deltaP)}`);
  }
  lines.push("");
  lines.push("Top improvements (Performance):");
  for (const r of improvements) {
    lines.push(`- ${r.label} ${r.path} [${r.device}] ΔP:${formatDelta(r.deltaP)}`);
  }
  return boxifyWithSeparators(lines);
}

/**
 * Runs the ApexAuditor audit CLI.
 *
 * @param argv - The process arguments array.
 */
export async function runAuditCli(argv: readonly string[], options?: { readonly signal?: AbortSignal }): Promise<void> {
  const args: CliArgs = parseArgs(argv);
  const startTimeMs: number = Date.now();
  const { configPath, config } = await loadConfig({ configPath: args.configPath });
  const previousSummary: RunSummary | undefined = await loadPreviousSummary();

  const presetThrottling: ApexThrottlingMethod | undefined = args.accurate ? "devtools" : undefined;
  const presetWarmUp: boolean | undefined = args.accurate ? true : args.overview ? false : undefined;
  const presetParallel: number | undefined = args.accurate ? 1 : undefined;

  const DEFAULT_PARALLEL: number = 4;
  const DEFAULT_WARM_UP: boolean = true;

  const effectiveLogLevel: CliLogLevel | undefined = args.logLevelOverride ?? config.logLevel;
  const effectiveThrottling: ApexThrottlingMethod | undefined = args.fast ? "simulate" : args.throttlingMethodOverride ?? presetThrottling ?? config.throttlingMethod;
  const effectiveCpuSlowdown: number | undefined = args.cpuSlowdownOverride ?? config.cpuSlowdownMultiplier;
  const effectiveParallel: number | undefined = args.stable ? 1 : args.parallelOverride ?? presetParallel ?? config.parallel ?? DEFAULT_PARALLEL;
  const effectiveAuditTimeoutMs: number | undefined = args.auditTimeoutMsOverride ?? config.auditTimeoutMs;
  const warmUpDefaulted: boolean = presetWarmUp ?? config.warmUp ?? DEFAULT_WARM_UP;
  const effectiveWarmUp: boolean = args.warmUp ? true : warmUpDefaulted;
  const effectiveIncremental: boolean = args.incremental;
  if (!effectiveIncremental && config.incremental === true) {
    // eslint-disable-next-line no-console
    console.log("Note: incremental caching is now opt-in. Pass --incremental to enable it for this run.");
  }
  const candidateBuildId: string | undefined = args.buildId ?? config.buildId;
  const autoBuildId: string | undefined = effectiveIncremental && candidateBuildId === undefined
    ? await resolveAutoBuildId(configPath)
    : undefined;
  const effectiveBuildId: string | undefined = candidateBuildId ?? autoBuildId;
  const finalIncremental: boolean = effectiveIncremental && effectiveBuildId !== undefined;
  if (effectiveIncremental && !finalIncremental) {
    // eslint-disable-next-line no-console
    console.log("Incremental mode requested, but no buildId could be resolved. Running a full audit. Tip: pass --build-id or set buildId in apex.config.json");
  }
  const effectiveRuns: number = 1;
  const onlyCategories: readonly ApexCategory[] | undefined = args.fast ? ["performance"] : undefined;
  let effectiveConfig: ApexConfig = {
    ...config,
    buildId: effectiveBuildId,
    logLevel: effectiveLogLevel,
    throttlingMethod: effectiveThrottling,
    cpuSlowdownMultiplier: effectiveCpuSlowdown,
    parallel: effectiveParallel,
    auditTimeoutMs: effectiveAuditTimeoutMs,
    warmUp: effectiveWarmUp,
    incremental: finalIncremental,
    runs: effectiveRuns,
  };
  if (args.changedOnly) {
    const changedFiles: readonly string[] = await getChangedFiles();
    const changedConfig: ApexConfig = filterConfigChanged(effectiveConfig, changedFiles);
    if (changedConfig.pages.length === 0) {
      // eslint-disable-next-line no-console
      console.error("Changed-only mode: no pages matched git diff. Nothing to run.");
      process.exitCode = 0;
      return;
    }
    effectiveConfig = changedConfig;
  }
  if (args.rerunFailing) {
    const rerunConfig: ApexConfig = filterConfigFailing(previousSummary, effectiveConfig);
    if (rerunConfig.pages.length === 0) {
      // eslint-disable-next-line no-console
      console.log("Rerun-failing mode: no failing combos found in previous summary. Nothing to run.");
      process.exitCode = 0;
      return;
    }
    effectiveConfig = rerunConfig;
  }
  const filteredConfig: ApexConfig = filterConfigDevices(effectiveConfig, args.deviceFilter);
  if (filteredConfig.pages.length === 0) {
    // eslint-disable-next-line no-console
    console.error("No pages remain after applying device filter. Check your config and device flags.");
    process.exitCode = 1;
    return;
  }
  const overviewMaxCombos: number = args.overviewCombos ?? DEFAULT_OVERVIEW_MAX_COMBOS;
  const overviewSample = args.overview && !args.yes ? sampleConfigForOverview(filteredConfig, overviewMaxCombos) : { config: filteredConfig, sampled: false, sampledCombos: 0 };
  const plannedCombos: number = overviewSample.config.pages.reduce((acc, p) => acc + p.devices.length, 0);
  const plannedRuns: number = overviewSample.config.runs ?? 1;
  const plannedSteps: number = plannedCombos * plannedRuns;
  const maxSteps: number = args.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxCombos: number = args.maxCombos ?? DEFAULT_MAX_COMBOS;
  const isTty: boolean = typeof process !== "undefined" && process.stdout?.isTTY === true;
  const exceeds: boolean = plannedSteps > maxSteps || plannedCombos > maxCombos;
  const useColor: boolean = shouldUseColor(args.ci, args.colorMode);
  if (args.plan) {
    printPlan({
      configPath,
      resolvedConfig: overviewSample.config,
      plannedCombos,
      plannedSteps,
      sampled: overviewSample.sampled,
      sampledCombos: overviewSample.sampledCombos,
      maxCombos,
      maxSteps,
      useColor,
    });
    return;
  }
  if (isTty && !args.ci && !args.jsonOutput) {
    const tipLines: string[] = [
      "Tip: use --plan to preview run size before starting.",
      "Note: runs-per-combo is always 1; rerun the same command to compare results.",
      "If parallel mode flakes (worker disconnects), retry with --stable (forces parallel=1).",
    ];
    // eslint-disable-next-line no-console
    console.log(boxifyWithSeparators(tipLines));
    printDivider();
  }
  if (overviewSample.sampled) {
    // eslint-disable-next-line no-console
    console.log(`Overview mode: sampling ${plannedCombos} combos (pass --yes for full suite or --overview-combos <n> to adjust).`);
  }
  if (exceeds && !args.yes) {
    const limitText: string = `limits combos<=${maxCombos}, steps<=${maxSteps}`;
    const planText: string = `Planned run: ${plannedCombos} combos x ${plannedRuns} runs = ${plannedSteps} Lighthouse runs.`;
    if (args.ci || !isTty) {
      // eslint-disable-next-line no-console
      console.error(`${planText} Refusing to start because it exceeds default ${limitText}. Use --yes to proceed or adjust with --max-steps/--max-combos.`);
      process.exitCode = 1;
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`${planText} This exceeds default ${limitText}.`);
    const ok: boolean = await confirmLargeRun("Continue? (y/N) ");
    if (!ok) {
      // eslint-disable-next-line no-console
      console.log("Cancelled.");
      return;
    }
  }
  let summary: RunSummary;
  const abortController: AbortController = new AbortController();
  if (options?.signal?.aborted === true) {
    abortController.abort();
  } else if (options?.signal) {
    const externalSignal: AbortSignal = options.signal;
    const onExternalAbort = (): void => abortController.abort();
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    abortController.signal.addEventListener("abort", () => {
      externalSignal.removeEventListener("abort", onExternalAbort);
    });
  }
  const onSigInt = (): void => {
    abortController.abort();
  };
  process.once("SIGINT", onSigInt);
  let spinnerStarted = false;
  let lastProgressLine: string | undefined;
  const formatEtaText = (etaMs?: number): string => {
    if (etaMs === undefined) {
      return "";
    }
    const seconds: number = Math.max(0, Math.round(etaMs / 1000));
    const minutes: number = Math.floor(seconds / 60);
    const remainingSeconds: number = seconds % 60;
    if (minutes === 0) {
      return `${remainingSeconds}s`;
    }
    return `${minutes}m ${remainingSeconds}s`;
  };
  const startAuditSpinner = (): void => {
    if (spinnerStarted) {
      return;
    }
    startSpinner("Running audit (Lighthouse)");
    spinnerStarted = true;
  };
  if (!filteredConfig.warmUp) {
    startAuditSpinner();
  }
  try {
    summary = await runAuditsForConfig({
      config: overviewSample.config,
      configPath,
      showParallel: args.showParallel,
      onlyCategories,
      signal: abortController.signal,
      onAfterWarmUp: startAuditSpinner,
      onProgress: ({ completed, total, path, device, etaMs }) => {
        if (!process.stdout.isTTY) {
          return;
        }
        const etaText: string = etaMs !== undefined ? ` | ETA ${formatEtaText(etaMs)}` : "";
        const message: string = `* Running audit (Lighthouse) page ${completed}/${total} — ${path} [${device}]${etaText}`;
        const padded: string = message.padEnd(lastProgressLine?.length ?? message.length, " ");
        process.stdout.write(`\r${padded}`);
        lastProgressLine = padded;
        updateSpinnerMessage(`Running audit (Lighthouse) page ${completed}/${total}`);
      },
    });
  } catch (error: unknown) {
    const message: string = error instanceof Error ? error.message : "Unknown error";
    if (abortController.signal.aborted || message.includes("Aborted")) {
      // eslint-disable-next-line no-console
      console.log("Audit cancelled.");
      process.exitCode = 130;
      return;
    }
    handleFriendlyError(error);
    process.exitCode = 1;
    return;
  } finally {
    process.removeListener("SIGINT", onSigInt);
    if (lastProgressLine !== undefined) {
      process.stdout.write("\n");
      lastProgressLine = undefined;
    }
    stopSpinner();
  }
  const outputDir: string = resolve(".apex-auditor");
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  const markdown: string = buildMarkdown(summary);
  await writeFile(resolve(outputDir, "summary.md"), markdown, "utf8");
  const html: string = buildHtmlReport(summary);
  const reportPath: string = resolve(outputDir, "report.html");
  await writeFile(reportPath, html, "utf8");
  const budgetViolations: readonly BudgetViolation[] =
    effectiveConfig.budgets === undefined ? [] : collectBudgetViolations(summary.results, effectiveConfig.budgets);
  const shareable: ShareableExport = buildShareableExport({
    configPath,
    previousSummary,
    current: summary,
    budgets: effectiveConfig.budgets,
  });
  const exportPath: string = resolve(outputDir, "export.json");
  await writeFile(exportPath, JSON.stringify(shareable, null, 2), "utf8");
  const accessibilityArtifacts: string = resolve(outputDir, "accessibility");
  const accessibilitySummary: AxeSummary = await runAccessibilityAudit({
    config: filteredConfig,
    configPath,
    artifactsDir: accessibilityArtifacts,
  });
  const accessibilitySummaryPath: string = resolve(outputDir, "accessibility-summary.json");
  await writeFile(accessibilitySummaryPath, JSON.stringify(accessibilitySummary, null, 2), "utf8");
  const accessibilityAggregated: AccessibilitySummary | undefined =
    accessibilitySummary === undefined ? undefined : summariseAccessibility(accessibilitySummary);
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
  printReportLink(reportPath);
  if (isTty && !args.ci) {
    // eslint-disable-next-line no-console
    console.log(buildEffectiveSettingsPanel({ configPath, config: effectiveConfig, useColor }));
    // eslint-disable-next-line no-console
    console.log(buildSectionIndex(useColor));
  }
  // Also echo a compact, colourised table to stdout for quick viewing.
  // Structured panels
  // eslint-disable-next-line no-console
  console.log(buildMetaPanel(summary.meta, useColor));
  // eslint-disable-next-line no-console
  console.log(buildStatsPanel(summary.results, useColor));
  if (previousSummary !== undefined) {
    printSectionHeader("Changes", useColor);
    printDivider();
    // eslint-disable-next-line no-console
    console.log(buildChangesBox(previousSummary, summary, useColor));
    printDivider();
  }
  printSectionHeader("Summary", useColor);
  // eslint-disable-next-line no-console
  console.log(
    buildSummaryPanel({
      results: summary.results,
      useColor,
      regressionsOnly: args.regressionsOnly,
      previousSummary,
    }),
  );
  printSectionHeader("Issues", useColor);
  // eslint-disable-next-line no-console
  console.log(buildIssuesPanel(summary.results, useColor));
  printSectionHeader("Top fixes", useColor);
  // eslint-disable-next-line no-console
  console.log(buildTopFixesPanel(summary.results, useColor));
  const budgetsPanel: string | undefined = buildBudgetsPanel({
    budgets: effectiveConfig.budgets,
    violations: budgetViolations,
    useColor,
  });
  if (budgetsPanel !== undefined) {
    printSectionHeader("Budgets", useColor);
    // eslint-disable-next-line no-console
    console.log(budgetsPanel);
  }
  printSectionHeader("Accessibility (fast pass)", useColor);
  // eslint-disable-next-line no-console
  console.log(buildAccessibilityPanel(summariseAccessibility(accessibilitySummary), useColor));
  // eslint-disable-next-line no-console
  console.log(buildAccessibilityIssuesPanel(accessibilitySummary.results, useColor));
  if (args.webhookUrl) {
    const regressions: readonly RegressionLine[] = collectRegressions(previousSummary, summary);
    if (args.webhookAlways || shouldSendWebhook(regressions, budgetViolations)) {
      const payload: WebhookPayload = buildWebhookPayload({
        current: summary,
        previous: previousSummary,
        budgetViolations,
        accessibility: accessibilityAggregated,
        reportPath,
        exportPath,
        accessibilityPath: accessibilitySummaryPath,
      });
      try {
        await postJsonWebhook({ url: args.webhookUrl, payload });
        // eslint-disable-next-line no-console
        console.log(`Sent webhook to ${args.webhookUrl}`);
      } catch (error: unknown) {
        const message: string = error instanceof Error ? error.message : String(error);
        // eslint-disable-next-line no-console
        console.error(`Failed to send webhook: ${message}`);
      }
    }
  }
  printCiSummary({ isCi: args.ci, failOnBudget: args.failOnBudget, violations: budgetViolations });
  printSectionHeader("Lowest performance", useColor);
  // eslint-disable-next-line no-console
  console.log(buildLowestPerformancePanel(summary.results, useColor));
  printSectionHeader("Export", useColor);
  // eslint-disable-next-line no-console
  console.log(buildExportPanel({ exportPath, useColor, share: shareable }));
  const elapsedMs: number = Date.now() - startTimeMs;
  const elapsedText: string = formatElapsedTime(elapsedMs);
  const elapsedDisplay: string = useColor ? `${ANSI_CYAN}${elapsedText}${ANSI_RESET}` : elapsedText;
  const runsPerTarget: number = effectiveConfig.runs ?? 1;
  const comboCount: number = summary.results.length;
  const totalRuns: number = comboCount * runsPerTarget;
  const cacheNote: string = summary.meta.incremental
    ? ` Cache: ${summary.meta.executedCombos} executed / ${summary.meta.cachedCombos} cached (steps: ${summary.meta.executedSteps} executed, ${summary.meta.cachedSteps} cached).`
    : "";
  // eslint-disable-next-line no-console
  console.log(
    `\nCompleted in ${elapsedDisplay} (${comboCount} page/device combinations x ${runsPerTarget} runs = ${totalRuns} Lighthouse runs).${cacheNote}`,
  );
}

async function getChangedFiles(): Promise<readonly string[]> {
  try {
    const diffOutput: string = await runCommand("git diff --name-only", process.cwd());
    const files: readonly string[] = diffOutput
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return files;
  } catch {
    return [];
  }
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

function filterConfigChanged(config: ApexConfig, changedFiles: readonly string[]): ApexConfig {
  if (changedFiles.length === 0) {
    return config;
  }
  const pageMatches = (pagePath: string): boolean => {
    const segment: string = pagePath.replace(/^\//, "");
    return changedFiles.some((file) => file.includes(segment));
  };
  const pages: ApexPageConfig[] = config.pages.filter((page) => pageMatches(page.path));
  return { ...config, pages };
}

function filterConfigFailing(previous: RunSummary | undefined, config: ApexConfig): ApexConfig {
  if (previous === undefined) {
    return config;
  }
  const failing = new Set<string>();
  for (const result of previous.results) {
    const runtimeFailed: boolean = Boolean(result.runtimeErrorMessage);
    const perfScore: number | undefined = result.scores.performance;
    const failedScore: boolean = typeof perfScore === "number" && perfScore < 90;
    if (runtimeFailed || failedScore) {
      failing.add(`${result.label}:::${result.path}:::${result.device}`);
    }
  }
  const pages: ApexPageConfig[] = config.pages.flatMap((page) => {
    const devices: readonly ApexDevice[] = page.devices.filter((device) =>
      failing.has(`${page.label}:::${page.path}:::${device}`),
    );
    if (devices.length === 0) {
      return [];
    }
    return [{ ...page, devices }];
  });
  return { ...config, pages };
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
    `| Build ID | ${meta.buildId ?? "-"} |`,
    `| Incremental | ${meta.incremental ? "yes" : "no"} |`,
    `| Resolved parallel | ${meta.resolvedParallel} |`,
    `| Warm-up | ${meta.warmUp ? "yes" : "no"} |`,
    `| Throttling | ${meta.throttlingMethod} |`,
    `| CPU slowdown | ${meta.cpuSlowdownMultiplier} |`,
    `| Combos | ${meta.comboCount} |`,
    `| Executed combos | ${meta.executedCombos} |`,
    `| Cached combos | ${meta.cachedCombos} |`,
    `| Runs per combo | ${meta.runsPerCombo} |`,
    `| Total steps | ${meta.totalSteps} |`,
    `| Executed steps | ${meta.executedSteps} |`,
    `| Cached steps | ${meta.cachedSteps} |`,
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
  const cacheSummary: string = meta.incremental
    ? `${meta.executedCombos} executed / ${meta.cachedCombos} cached`
    : "disabled";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ApexAuditor Report</title>
  <style>
    :root {
      --green: #0cce6b;
      --yellow: #ffa400;
      --red: #ff4e42;
      --bg: #0f172a;
      --panel: #0b1224;
      --card: #111a33;
      --border: #27324d;
      --text: #e8edf7;
      --muted: #93a4c3;
      --accent: #7c3aed;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "Inter", "IBM Plex Sans", "Segoe UI", system-ui, -apple-system, sans-serif;
      background: radial-gradient(circle at 20% 20%, #122042, #0a1020 45%), #0a0f1f;
      color: var(--text);
      padding: 2rem;
      line-height: 1.5;
    }
    h1 { margin-bottom: 0.5rem; letter-spacing: 0.02em; }
    .meta { color: var(--muted); margin-bottom: 2rem; font-size: 0.95rem; }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .meta-card {
      background: linear-gradient(135deg, var(--panel), #0f1a33);
      border-radius: 12px;
      padding: 1rem;
      border: 1px solid var(--border);
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35);
    }
    .meta-label { font-size: 0.78rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
    .meta-value { font-size: 1.05rem; font-weight: 650; color: var(--text); }
    .cards { display: grid; gap: 1.5rem; }
    .card {
      background: linear-gradient(180deg, var(--card), #0e1a31);
      border-radius: 14px;
      padding: 1.5rem;
      border: 1px solid var(--border);
      box-shadow: 0 14px 45px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 1rem;
    }
    .card-title { font-size: 1.1rem; font-weight: 650; }
    .card-title span { color: var(--muted); font-weight: 500; }
    .device-badge {
      font-size: 0.78rem;
      padding: 0.35rem 0.65rem;
      border-radius: 999px;
      background: #1f2937;
      border: 1px solid var(--border);
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .device-badge.mobile { background: linear-gradient(135deg, #0ea5e9, #0891b2); color: #e6f6ff; border-color: #0ea5e9; }
    .device-badge.desktop { background: linear-gradient(135deg, #8b5cf6, #7c3aed); color: #f5efff; border-color: #8b5cf6; }
    .scores { display: grid; grid-template-columns: repeat(auto-fit, minmax(90px, 1fr)); gap: 0.75rem; margin-bottom: 1rem; }
    .score-item { text-align: center; }
    .score-circle {
      width: 64px;
      height: 64px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.25rem;
      font-weight: 700;
      margin: 0 auto 0.35rem;
      border: 2px solid var(--border);
      background: #0c152a;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }
    .score-circle.green { border-color: var(--green); color: var(--green); box-shadow: 0 0 0 1px rgba(12, 206, 107, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.05); }
    .score-circle.yellow { border-color: var(--yellow); color: var(--yellow); box-shadow: 0 0 0 1px rgba(255, 164, 0, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.05); }
    .score-circle.red { border-color: var(--red); color: var(--red); box-shadow: 0 0 0 1px rgba(255, 78, 66, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.05); }
    .score-label { font-size: 0.78rem; color: var(--muted); }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 0.85rem; }
    .metric {
      background: #0c152a;
      padding: 0.85rem;
      border-radius: 10px;
      text-align: center;
      border: 1px solid var(--border);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
    }
    .metric-value { font-size: 1.05rem; font-weight: 650; }
    .metric-value.green { color: var(--green); }
    .metric-value.yellow { color: var(--yellow); }
    .metric-value.red { color: var(--red); }
    .metric-label { font-size: 0.72rem; color: var(--muted); margin-top: 0.25rem; letter-spacing: 0.04em; }
    .issues {
      margin-top: 1rem;
      padding: 1rem;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: #0c152a;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
    }
    .issues-title { font-size: 0.85rem; color: var(--muted); margin-bottom: 0.5rem; letter-spacing: 0.05em; text-transform: uppercase; }
    .issue {
      font-size: 0.88rem;
      color: var(--text);
      padding: 0.35rem 0.25rem;
      border-bottom: 1px dashed var(--border);
    }
    .issue:last-child { border-bottom: none; }
  </style>
</head>
<body>
  <h1>ApexAuditor Report</h1>
  <p class="meta">Generated: ${timestamp}</p>
  <div class="meta-grid">
    ${buildMetaCard("Build ID", meta.buildId ?? "-")}
    ${buildMetaCard("Incremental", meta.incremental ? "Yes" : "No")}
    ${buildMetaCard("Cache", cacheSummary)}
    ${buildMetaCard("Resolved parallel", meta.resolvedParallel.toString())}
    ${buildMetaCard("Elapsed", formatElapsedTime(meta.elapsedMs))}
    ${buildMetaCard("Avg / step", formatElapsedTime(meta.averageStepMs))}
    ${buildMetaCard("Combos", meta.comboCount.toString())}
    ${buildMetaCard("Runs per combo", meta.runsPerCombo.toString())}
    ${buildMetaCard("Throttling", meta.throttlingMethod)}
    ${buildMetaCard("CPU slowdown", meta.cpuSlowdownMultiplier.toString())}
    ${buildMetaCard("Warm-up", meta.warmUp ? "Yes" : "No")}
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
  const incrementalSummary: string = meta.incremental
    ? `${meta.executedCombos} executed / ${meta.cachedCombos} cached (${meta.executedSteps} executed steps, ${meta.cachedSteps} cached steps)`
    : "No";
  const rows: { readonly label: string; readonly value: string }[] = [
    { label: "Build ID", value: meta.buildId ?? "-" },
    { label: "Incremental", value: meta.incremental ? "Yes" : "No" },
    { label: "Resolved parallel", value: meta.resolvedParallel.toString() },
    { label: "Warm-up", value: meta.warmUp ? "Yes" : "No" },
    { label: "Throttling", value: meta.throttlingMethod },
    { label: "CPU slowdown", value: meta.cpuSlowdownMultiplier.toString() },
    { label: "Combos", value: meta.comboCount.toString() },
    { label: "Cache", value: incrementalSummary },
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

type FixAggregate = {
  readonly id: string;
  readonly title: string;
  readonly count: number;
  readonly totalMs: number;
  readonly totalBytes: number;
};

function printTopFixes(results: readonly PageDeviceSummary[]): void {
  const map: Map<string, { title: string; count: number; totalMs: number; totalBytes: number }> = new Map();
  for (const result of results) {
    for (const opp of result.opportunities) {
      if (!hasMeaningfulSavings(opp)) {
        continue;
      }
      const key: string = opp.id;
      const previous = map.get(key);
      map.set(key, {
        title: previous?.title ?? opp.title,
        count: (previous?.count ?? 0) + 1,
        totalMs: (previous?.totalMs ?? 0) + (opp.estimatedSavingsMs ?? 0),
        totalBytes: (previous?.totalBytes ?? 0) + (opp.estimatedSavingsBytes ?? 0),
      });
    }
  }
  const aggregates: FixAggregate[] = Array.from(map.entries()).map(([id, v]) => {
    return { id, title: v.title, count: v.count, totalMs: v.totalMs, totalBytes: v.totalBytes };
  });
  if (aggregates.length === 0) {
    // eslint-disable-next-line no-console
    console.log(boxifyWithSeparators(["No actionable opportunities found in this sample."]));
    return;
  }
  aggregates.sort((a, b) => {
    if (a.count !== b.count) {
      return b.count - a.count;
    }
    if (a.totalMs !== b.totalMs) {
      return b.totalMs - a.totalMs;
    }
    return b.totalBytes - a.totalBytes;
  });
  const top: FixAggregate[] = aggregates.slice(0, 8);
  const lines: string[] = ["Most common opportunities:"];
  for (const entry of top) {
    const ms: string = entry.totalMs > 0 ? `${Math.round(entry.totalMs)}ms` : "";
    const kb: string = entry.totalBytes > 0 ? `${Math.round(entry.totalBytes / 1024)}KB` : "";
    const parts: string[] = [ms, kb].filter((p) => p.length > 0);
    const suffix: string = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    lines.push(`- ${entry.id} – ${entry.title} (seen on ${entry.count} pages)${suffix}`);
  }
  // eslint-disable-next-line no-console
  console.log(boxifyWithSeparators(lines));
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
    // eslint-disable-next-line no-console
    console.log(boxify(["No red issues."]));
    return;
  }
  const lines: string[] = ["Red issues (scores below 50):"];
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
    lines.push(`- ${result.label} ${result.path} [${result.device}] – ${badParts.join(", ")} – ${issues}`);
  }
  // eslint-disable-next-line no-console
  console.log(boxifyWithSeparators(lines));
}

function shouldUseColor(ci: boolean, colorMode: CliColorMode): boolean {
  if (colorMode === "always") {
    return true;
  }
  if (colorMode === "never") {
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

function printCiSummary(params: {
  readonly isCi: boolean;
  readonly failOnBudget: boolean;
  readonly violations: readonly BudgetViolation[];
}): void {
  if (!params.isCi && !params.failOnBudget) {
    return;
  }
  if (params.violations.length === 0) {
    if (params.isCi) {
      // eslint-disable-next-line no-console
      console.log("\nCI budgets PASSED.");
    }
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`\nBudgets FAILED (${params.violations.length} violations):`);
  for (const violation of params.violations) {
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
  const lines: string[] = ["Lowest Performance pages:"];
  for (const entry of worst) {
    const perfText: string = colourScore(entry.performance, useColor);
    const label: string = entry.result.label;
    const path: string = entry.result.path;
    const device: ApexDevice = entry.result.device;
    lines.push(`- ${label} ${path} [${device}] P:${perfText}`);
  }
  // eslint-disable-next-line no-console
  console.log(boxifyWithSeparators(lines));
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

function printReportLink(reportPath: string): void {
  const fileUrl: string = `file://${reportPath.replace(/\\/g, "/")}`;
  // eslint-disable-next-line no-console
  console.log(`\nReport saved to: ${reportPath}`);
  // eslint-disable-next-line no-console
  console.log(`Open report: ${fileUrl}`);
}

function printSectionHeader(label: string, useColor: boolean): void {
  const decorated: string = useColor ? `${ANSI_BLUE}${label}${ANSI_RESET}` : label;
  // eslint-disable-next-line no-console
  console.log(`\n┌─ ${decorated} ${"─".repeat(Math.max(0, 30 - label.length))}`);
}

function printDivider(): void {
  // eslint-disable-next-line no-console
  console.log("├" + "─".repeat(40));
}

function boxify(lines: readonly string[]): string {
  if (lines.length === 0) {
    return "";
  }
  const maxWidth: number = Math.max(...lines.map((line) => line.length));
  const top: string = `┌${"─".repeat(maxWidth + 2)}┐`;
  const bottom: string = `└${"─".repeat(maxWidth + 2)}┘`;
  const body: string[] = lines.map((line) => `│ ${line.padEnd(maxWidth, " ")} │`);
  return [top, ...body, bottom].join("\n");
}

function boxifyWithSeparators(lines: readonly string[]): string {
  if (lines.length === 0) {
    return "";
  }
  const maxWidth: number = Math.max(...lines.map((line) => line.length));
  const top: string = `┌${"─".repeat(maxWidth + 2)}┐`;
  const bottom: string = `└${"─".repeat(maxWidth + 2)}┘`;
  const sep: string = `├${"─".repeat(maxWidth + 2)}┤`;
  const body: string[] = lines.flatMap((line, index) => {
    const row: string = `│ ${line.padEnd(maxWidth, " ")} │`;
    if (index === lines.length - 1) {
      return [row];
    }
    return [row, sep];
  });
  return [top, ...body, bottom].join("\n");
}

function handleFriendlyError(error: unknown): void {
  const message: string = error instanceof Error ? error.message : String(error);
  if (message.includes("Could not reach")) {
    // eslint-disable-next-line no-console
    console.error("Cannot reach the target URL. Is your dev server running and accessible from this machine?");
    return;
  }
  if (message.includes("LanternError")) {
    // eslint-disable-next-line no-console
    console.error("Lighthouse trace analysis failed (Lantern). Try: reduce parallelism, set --throttling devtools, or rerun with fewer pages.");
    return;
  }
  // eslint-disable-next-line no-console
  console.error(message);
}
