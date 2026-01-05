import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { loadConfig } from "./config.js";
import { buildDevServerGuidanceLines } from "./dev-server-guidance.js";
import type { AxeResult, AxeSummary, AxeViolation } from "./accessibility-types.js";
import { runAccessibilityAudit } from "./accessibility.js";
import { writeRunnerReports } from "./runner-reporting.js";
import { writeArtifactsNavigation } from "./artifacts-navigation.js";
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
  readonly diagnostics: boolean;
  readonly lhr: boolean;
  readonly plan: boolean;
  readonly flagsOnly: boolean;
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
  readonly devtoolsAccurate: boolean;
  readonly jsonOutput: boolean;
  readonly showParallel: boolean;
  readonly fast: boolean;
  readonly overview: boolean;
  readonly overviewCombos: number | undefined;
  readonly regressionsOnly: boolean;
  readonly changedOnly: boolean;
  readonly rerunFailing: boolean;
  readonly focusWorst: number | undefined;
  readonly aiMinCombos: number | undefined;
  readonly noAiFix: boolean;
  readonly noExport: boolean;
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

function isPublicCombo(r: PageDeviceSummary): boolean {
  return r.pageScope !== "requires-auth";
}

type IssueOffenderId = IssuesIndex["offenders"][number]["issueId"];

type OffenderComboRef = IssuesIndex["offenders"][number]["combos"][number];

function buildOffenderComboRef(params: {
  readonly combo: PageDeviceSummary;
  readonly artifacts?: IssuesIndex["failing"][number]["artifacts"];
  readonly issuesPointer: string;
  readonly diagnosticsLitePointer?: string;
}): OffenderComboRef {
  return {
    label: params.combo.label,
    path: params.combo.path,
    device: params.combo.device,
    pageScope: params.combo.pageScope,
    artifactBaseName: buildArtifactBaseName({ label: params.combo.label, path: params.combo.path, device: params.combo.device }),
    artifacts:
      params.artifacts === undefined
        ? undefined
        : {
            diagnosticsLiteRelPath: params.artifacts.diagnosticsLiteRelPath,
            diagnosticsLitePath: params.artifacts.diagnosticsLitePath,
            diagnosticsRelPath: params.artifacts.diagnosticsRelPath,
            diagnosticsPath: params.artifacts.diagnosticsPath,
            lhrRelPath: params.artifacts.lhrRelPath,
            lhrPath: params.artifacts.lhrPath,
          },
    pointers: {
      issuesPointer: params.issuesPointer,
      diagnosticsLitePointer: params.diagnosticsLitePointer,
    },
  };
}

function buildIssuesPointerForCombo(combo: { readonly label: string; readonly path: string; readonly device: ApexDevice }, suffix: string): string {
  const label: string = escapePointerValue(combo.label);
  const path: string = escapePointerValue(combo.path);
  const device: string = escapePointerValue(combo.device);
  return `results[?(@.label==\"${label}\" && @.path==\"${path}\" && @.device==\"${device}\")].${suffix}`;
}

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

type RunnerFindingLike = {
  readonly title: string;
  readonly severity: "info" | "warn" | "error";
  readonly details: readonly string[];
  readonly evidence: readonly { readonly kind: "file"; readonly path: string }[];
};

type LiteOpportunity = {
  readonly id: string;
  readonly title: string;
  readonly estimatedSavingsMs?: number;
  readonly estimatedSavingsBytes?: number;
};

type SummaryLiteLine = {
  readonly label: string;
  readonly path: string;
  readonly device: ApexDevice;
  readonly scores: {
    readonly performance?: number;
    readonly accessibility?: number;
    readonly bestPractices?: number;
    readonly seo?: number;
  };
  readonly metrics: {
    readonly lcpMs?: number;
    readonly fcpMs?: number;
    readonly tbtMs?: number;
    readonly cls?: number;
    readonly inpMs?: number;
  };
  readonly runtimeErrorMessage?: string;
  readonly topOpportunities: readonly LiteOpportunity[];
  readonly artifactBaseName: string;
};

type SummaryLite = {
  readonly generatedAt: string;
  readonly meta: RunSummary["meta"];
  readonly results: readonly SummaryLiteLine[];
};

type RuntimeMeta = {
  readonly chrome: {
    readonly mode: "managed-headless" | "external";
    readonly headless: boolean;
    readonly port?: number;
    readonly flags?: readonly string[];
  };
  readonly throttlingMethod: ApexThrottlingMethod;
  readonly throttlingOverridesApplied: boolean;
  readonly cpuSlowdownMultiplier?: number;
  readonly parallel: number;
  readonly runsPerCombo: number;
  readonly warmUp: boolean;
  readonly captureLevel: "diagnostics" | "lhr" | "none";
};

type AiFixPacket = {
  readonly generatedAt: string;
  readonly meta: RunSummary["meta"];
  readonly runtime: RuntimeMeta;
  readonly targetScore: number;
  readonly totals: IssuesIndex["totals"];
  readonly perCombo: readonly {
    readonly label: string;
    readonly path: string;
    readonly device: ApexDevice;
    readonly artifactBaseName: string;
    readonly scores: {
      readonly performance?: number;
      readonly accessibility?: number;
      readonly bestPractices?: number;
      readonly seo?: number;
    };
    readonly metrics: {
      readonly lcpMs?: number;
      readonly fcpMs?: number;
      readonly tbtMs?: number;
      readonly cls?: number;
      readonly inpMs?: number;
    };
    readonly runtimeErrorMessage?: string;
    readonly opportunities: readonly LiteOpportunity[];
    readonly hints?: IssuesIndex["failing"][number]["hints"];
    readonly artifacts?: IssuesIndex["failing"][number]["artifacts"];
    readonly runStats?: PageDeviceSummary["runStats"];
  }[];
  readonly aggregates: {
    readonly unusedJavascript: {
      readonly combos: number;
      readonly totalWastedBytes: number;
      readonly files: readonly {
        readonly url: string;
        readonly combos: number;
        readonly totalWastedBytes: number;
        readonly totalBytes?: number;
        readonly maxWastedPercent?: number;
      }[];
    };
    readonly redirects: {
      readonly combos: number;
      readonly totalSavingsMs: number;
      readonly chains: readonly {
        readonly key: string;
        readonly combos: number;
        readonly totalSavingsMs: number;
        readonly chain: readonly string[];
      }[];
    };
  };
};

type AiFixMinPacket = {
  readonly generatedAt: string;
  readonly runtime: RuntimeMeta;
  readonly targetScore: number;
  readonly totals: IssuesIndex["totals"];
  readonly limitedToWorstCombos?: number;
  readonly perCombo: readonly {
    readonly label: string;
    readonly path: string;
    readonly device: ApexDevice;
    readonly scores: { readonly performance?: number };
    readonly metrics: { readonly lcpMs?: number; readonly tbtMs?: number; readonly cls?: number };
    readonly opportunities: readonly { readonly id: string; readonly title: string }[];
    readonly hints?: {
      readonly lcpPhases?: NonNullable<IssuesIndex["failing"][number]["hints"]>["lcpPhases"];
      readonly lcpElement?: NonNullable<IssuesIndex["failing"][number]["hints"]>["lcpElement"];
      readonly unusedJavascript?: {
        readonly overallSavingsBytes?: number;
        readonly files: readonly { readonly url: string; readonly wastedBytes?: number }[];
      };
      readonly legacyJavascript?: NonNullable<IssuesIndex["failing"][number]["hints"]>["legacyJavascript"];
      readonly renderBlockingResources?: NonNullable<IssuesIndex["failing"][number]["hints"]>["renderBlockingResources"];
      readonly criticalRequestChains?: NonNullable<IssuesIndex["failing"][number]["hints"]>["criticalRequestChains"];
      readonly bfCache?: NonNullable<IssuesIndex["failing"][number]["hints"]>["bfCache"];
    };
  }[];
  readonly aggregates: AiFixPacket["aggregates"];
};

type AiLedgerSeverity = "red" | "yellow" | "info";

type AiLedgerIssueKind =
  | "runtime_error"
  | "redirect_chain"
  | "unused_javascript"
  | "legacy_javascript"
  | "render_blocking_resource"
  | "critical_request_chain"
  | "lcp_phases"
  | "lcp_element"
  | "bfcache_blocker";

type AiLedgerEvidence = {
  readonly artifactRelPath?: string;
  readonly sourceRelPath: string;
  readonly pointer: string;
  readonly excerpt?: string;
};

type AiLedgerComboRef = {
  readonly label: string;
  readonly path: string;
  readonly device: ApexDevice;
};

type AiLedgerComboKey = string;

type AiLedgerIssueKey = string;

type AiLedgerIssue = {
  readonly id: string;
  readonly kind: AiLedgerIssueKind;
  readonly severity: AiLedgerSeverity;
  readonly title: string;
  readonly summary?: string;
  readonly affected: readonly AiLedgerComboRef[];
  readonly evidence: readonly AiLedgerEvidence[];
};

type AiLedgerFixPlanStep = {
  readonly order: number;
  readonly title: string;
  readonly issueIds: readonly string[];
  readonly rationale: string;
  readonly verify: string;
};

type AiLedgerComboDelta = {
  readonly comboKey: AiLedgerComboKey;
  readonly label: string;
  readonly path: string;
  readonly device: ApexDevice;
  readonly deltas: {
    readonly performance?: number;
    readonly lcpMs?: number;
    readonly inpMs?: number;
    readonly cls?: number;
    readonly tbtMs?: number;
  };
};

type AiLedgerOffender = {
  readonly kind: AiLedgerIssueKind;
  readonly key: string;
  readonly severity: AiLedgerSeverity;
  readonly affectedCombos: number;
  readonly issueIds: readonly string[];
  readonly evidence: readonly AiLedgerEvidence[];
};

type AiLedger = {
  readonly generatedAt: string;
  readonly instructions: string;
  readonly meta: RunSummary["meta"];
  readonly runtime: RuntimeMeta;
  readonly targetScore: number;
  readonly totals: IssuesIndex["totals"];
  readonly regressions: readonly AiLedgerComboDelta[];
  readonly improvements: readonly AiLedgerComboDelta[];
  readonly combos: readonly {
    readonly label: string;
    readonly path: string;
    readonly device: ApexDevice;
    readonly scores: {
      readonly performance?: number;
      readonly accessibility?: number;
      readonly bestPractices?: number;
      readonly seo?: number;
    };
    readonly metrics: {
      readonly lcpMs?: number;
      readonly cls?: number;
      readonly inpMs?: number;
      readonly tbtMs?: number;
    };
    readonly runtimeErrorMessage?: string;
  }[];
  readonly comboIndex: Record<AiLedgerComboKey, AiLedger["combos"][number]>;
  readonly issueIndex: Record<AiLedgerIssueKey, AiLedgerIssue>;
  readonly issues: readonly AiLedgerIssue[];
  readonly fixPlan: readonly AiLedgerFixPlanStep[];
  readonly offenders: readonly AiLedgerOffender[];
};

type IssuesIndex = {
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
  readonly offenders: readonly {
    readonly issueId:
      | "unused-javascript"
      | "legacy-javascript"
      | "render-blocking-resources"
      | "lcp-phases"
      | "largest-contentful-paint-element"
      | "bf-cache";
    readonly title: string;
    readonly offenderKey: string;
    readonly affectedCombos: number;
    readonly combos: readonly {
      readonly label: string;
      readonly path: string;
      readonly device: ApexDevice;
      readonly pageScope?: "public" | "requires-auth";
      readonly artifactBaseName: string;
      readonly artifacts?: {
        readonly diagnosticsLiteRelPath?: string;
        readonly diagnosticsLitePath?: string;
        readonly diagnosticsRelPath?: string;
        readonly diagnosticsPath?: string;
        readonly lhrRelPath?: string;
        readonly lhrPath?: string;
      };
      readonly pointers: {
        readonly issuesPointer: string;
        readonly diagnosticsLitePointer?: string;
      };
    }[];
  }[];
  readonly failing: readonly {
    readonly label: string;
    readonly path: string;
    readonly device: ApexDevice;
    readonly pageScope?: "public" | "requires-auth";
    readonly performance?: number;
    readonly accessibility?: number;
    readonly bestPractices?: number;
    readonly seo?: number;
    readonly runtimeErrorMessage?: string;
    readonly artifactBaseName: string;
    readonly topOpportunities: readonly LiteOpportunity[];
    readonly artifacts?: {
      readonly screenshotsDir: string;
      readonly screenshotBaseName: string;
      readonly diagnosticsPath?: string;
      readonly diagnosticsRelPath?: string;
      readonly diagnosticsLitePath?: string;
      readonly diagnosticsLiteRelPath?: string;
      readonly lhrPath?: string;
      readonly lhrRelPath?: string;
    };
    readonly hints?: {
      readonly redirects?: {
        readonly overallSavingsMs?: number;
        readonly chain?: readonly string[];
      };
      readonly unusedJavascript?: {
        readonly overallSavingsMs?: number;
        readonly overallSavingsBytes?: number;
        readonly files: readonly {
          readonly url: string;
          readonly totalBytes?: number;
          readonly wastedBytes?: number;
          readonly wastedPercent?: number;
        }[];
      };
      readonly legacyJavascript?: {
        readonly overallSavingsBytes?: number;
        readonly totalWastedBytes?: number;
        readonly polyfills: readonly {
          readonly url: string;
          readonly wastedBytes?: number;
        }[];
      };
      readonly renderBlockingResources?: {
        readonly overallSavingsMs?: number;
        readonly resources: readonly {
          readonly url: string;
          readonly totalBytes?: number;
          readonly wastedMs?: number;
        }[];
      };
      readonly criticalRequestChains?: {
        readonly longestChainDurationMs?: number;
        readonly chain: readonly {
          readonly url: string;
          readonly transferSize?: number;
          readonly startTimeMs?: number;
          readonly endTimeMs?: number;
        }[];
      };
      readonly lcpPhases?: {
        readonly ttfbMs?: number;
        readonly loadDelayMs?: number;
        readonly loadTimeMs?: number;
        readonly renderDelayMs?: number;
      };
      readonly lcpElement?: {
        readonly snippet?: string;
        readonly selector?: string;
        readonly nodeLabel?: string;
      };
      readonly totalByteWeight?: {
        readonly totalBytes?: number;
        readonly topResources: readonly { readonly url: string; readonly totalBytes?: number }[];
      };
      readonly bfCache?: {
        readonly reasons: readonly string[];
      };
    };
  }[];
};

const GZIP_MIN_BYTES: number = 80_000;
const DEFAULT_TARGET_SCORE: number = 95;
const MAX_HINT_COMBOS: number = 50;
const MAX_HINT_ITEMS: number = 5;
const DEFAULT_AI_MIN_COMBOS: number = 25;

function buildAiFixPacket(params: { readonly summary: RunSummary; readonly issues: IssuesIndex; readonly targetScore: number; readonly runtime: RuntimeMeta }): AiFixPacket {
  const generatedAt: string = new Date().toISOString();
  const perCombo: AiFixPacket["perCombo"] = params.issues.failing.map((f) => {
    const match: PageDeviceSummary | undefined = params.summary.results.find(
      (r) => r.label === f.label && r.path === f.path && r.device === f.device,
    );
    return {
      label: f.label,
      path: f.path,
      device: f.device,
      artifactBaseName: f.artifactBaseName,
      scores: {
        performance: f.performance,
        accessibility: f.accessibility,
        bestPractices: f.bestPractices,
        seo: f.seo,
      },
      metrics: {
        lcpMs: match?.metrics.lcpMs,
        fcpMs: match?.metrics.fcpMs,
        tbtMs: match?.metrics.tbtMs,
        cls: match?.metrics.cls,
        inpMs: match?.metrics.inpMs,
      },
      runtimeErrorMessage: f.runtimeErrorMessage,
      opportunities: f.topOpportunities,
      hints: f.hints,
      artifacts: f.artifacts,
      runStats: match?.runStats,
    };
  });

  type UnusedAgg = {
    combos: Set<string>;
    totalWastedBytes: number;
    totalBytes?: number;
    maxWastedPercent?: number;
  };
  const unusedByUrl: Map<string, UnusedAgg> = new Map();
  let unusedCombos = 0;
  let unusedTotalWastedBytes = 0;

  type RedirectAgg = {
    combos: Set<string>;
    totalSavingsMs: number;
    chain: readonly string[];
  };
  const redirectByKey: Map<string, RedirectAgg> = new Map();
  let redirectCombos = 0;
  let redirectTotalSavingsMs = 0;

  for (const combo of params.issues.failing) {
    const comboKey: string = `${combo.label}|${combo.path}|${combo.device}`;
    const hints = combo.hints;
    const unused = hints?.unusedJavascript;
    if (unused && unused.files.length > 0) {
      unusedCombos += 1;
      unusedTotalWastedBytes += Math.max(0, Math.floor(unused.overallSavingsBytes ?? 0));
      for (const file of unused.files) {
        const url: string = file.url;
        const entry: UnusedAgg = unusedByUrl.get(url) ?? { combos: new Set<string>(), totalWastedBytes: 0 };
        entry.combos.add(comboKey);
        entry.totalWastedBytes += Math.max(0, Math.floor(file.wastedBytes ?? 0));
        if (typeof file.totalBytes === "number") {
          entry.totalBytes = Math.max(entry.totalBytes ?? 0, file.totalBytes);
        }
        if (typeof file.wastedPercent === "number") {
          entry.maxWastedPercent = Math.max(entry.maxWastedPercent ?? 0, file.wastedPercent);
        }
        unusedByUrl.set(url, entry);
      }
    }

    const redirects = hints?.redirects;
    if (redirects && ((redirects.chain && redirects.chain.length > 0) || typeof redirects.overallSavingsMs === "number")) {
      redirectCombos += 1;
      redirectTotalSavingsMs += Math.max(0, Math.floor(redirects.overallSavingsMs ?? 0));
      const chain: readonly string[] = redirects.chain ?? [];
      const chainKey: string = chain.length > 0 ? chain.join(" -> ") : "(unknown)";
      const entry: RedirectAgg = redirectByKey.get(chainKey) ?? { combos: new Set<string>(), totalSavingsMs: 0, chain };
      entry.combos.add(comboKey);
      entry.totalSavingsMs += Math.max(0, Math.floor(redirects.overallSavingsMs ?? 0));
      redirectByKey.set(chainKey, entry);
    }
  }

  const unusedFiles: AiFixPacket["aggregates"]["unusedJavascript"]["files"] = [...unusedByUrl.entries()]
    .map(([url, agg]) => ({
      url,
      combos: agg.combos.size,
      totalWastedBytes: agg.totalWastedBytes,
      totalBytes: agg.totalBytes,
      maxWastedPercent: agg.maxWastedPercent,
    }))
    .sort((a, b) => b.totalWastedBytes - a.totalWastedBytes)
    .slice(0, 50);

  const redirectChains: AiFixPacket["aggregates"]["redirects"]["chains"] = [...redirectByKey.entries()]
    .map(([key, agg]) => ({
      key,
      combos: agg.combos.size,
      totalSavingsMs: agg.totalSavingsMs,
      chain: agg.chain,
    }))
    .sort((a, b) => b.totalSavingsMs - a.totalSavingsMs)
    .slice(0, 50);

  return {
    generatedAt,
    meta: params.summary.meta,
    runtime: params.runtime,
    targetScore: params.targetScore,
    totals: params.issues.totals,
    perCombo,
    aggregates: {
      unusedJavascript: {
        combos: unusedCombos,
        totalWastedBytes: unusedTotalWastedBytes,
        files: unusedFiles,
      },
      redirects: {
        combos: redirectCombos,
        totalSavingsMs: redirectTotalSavingsMs,
        chains: redirectChains,
      },
    },
  };
}

function hashId(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

function escapePointerValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
}

function buildComboPointer(combo: AiLedgerComboRef): string {
  const label: string = escapePointerValue(combo.label);
  const path: string = escapePointerValue(combo.path);
  const device: string = escapePointerValue(combo.device);
  return `failing[?(@.label==\"${label}\" && @.path==\"${path}\" && @.device==\"${device}\")]`;
}

function buildComboKey(combo: AiLedgerComboRef): AiLedgerComboKey {
  return `${combo.label}|${combo.path}|${combo.device}`;
}

function normalizeUrlKey(input: string): string {
  try {
    const u: URL = new URL(input);
    return `${u.origin}${u.pathname}`;
  } catch {
    const withoutHash: string = input.split("#")[0] ?? input;
    const withoutQuery: string = withoutHash.split("?")[0] ?? withoutHash;
    return withoutQuery;
  }
}

function buildOffenderKey(params: { readonly kind: AiLedgerIssueKind; readonly issueKey: string; readonly excerpt?: string }): string {
  const raw: string = params.excerpt ?? params.issueKey;
  if (params.kind === "unused_javascript" || params.kind === "legacy_javascript" || params.kind === "render_blocking_resource") {
    return `${params.kind}|${normalizeUrlKey(raw)}`;
  }
  if (params.kind === "redirect_chain") {
    return `${params.kind}|${raw.split("?").join("").split("#").join("")}`;
  }
  return `${params.kind}|${raw}`;
}

function escapeJsonPathString(input: string): string {
  return escapePointerValue(input);
}

function buildDiagnosticsLiteAuditPointer(params: { readonly auditId: string; readonly itemUrl?: string }): string {
  const auditId: string = escapeJsonPathString(params.auditId);
  if (params.itemUrl === undefined) {
    return `audits[?(@.id==\"${auditId}\")]`;
  }
  const url: string = escapeJsonPathString(params.itemUrl);
  return `audits[?(@.id==\"${auditId}\")].details.items[?(@.url==\"${url}\")]`;
}

function buildAiLedger(params: {
  readonly summary: RunSummary;
  readonly previousSummary?: RunSummary;
  readonly issues: IssuesIndex;
  readonly runtime: RuntimeMeta;
  readonly outputDir: string;
  readonly targetScore: number;
}): AiLedger {
  const generatedAt: string = new Date().toISOString();
  const sourceRelPath: string = "issues.json";
  const addCombo = (combo: AiLedgerComboRef, list: AiLedgerComboRef[]): AiLedgerComboRef[] => {
    const key: string = `${combo.label}|${combo.path}|${combo.device}`;
    if (list.some((c) => `${c.label}|${c.path}|${c.device}` === key)) {
      return list;
    }
    return [...list, combo];
  };
  const addEvidence = (evidence: AiLedgerEvidence, list: AiLedgerEvidence[]): AiLedgerEvidence[] => {
    const key: string = `${evidence.sourceRelPath}|${evidence.pointer}|${evidence.artifactRelPath ?? ""}`;
    if (list.some((e) => `${e.sourceRelPath}|${e.pointer}|${e.artifactRelPath ?? ""}` === key)) {
      return list;
    }
    return [...list, evidence];
  };
  type MutableIssue = {
    id: string;
    kind: AiLedgerIssueKind;
    severity: AiLedgerSeverity;
    title: string;
    summary?: string;
    affected: AiLedgerComboRef[];
    evidence: AiLedgerEvidence[];
  };
  const issueByKey: Map<string, MutableIssue> = new Map();
  type OffenderAgg = {
    kind: AiLedgerIssueKind;
    key: string;
    severity: AiLedgerSeverity;
    affectedKeys: Set<string>;
    issueIds: Set<string>;
    evidence: AiLedgerEvidence[];
  };
  const offendersByKey: Map<string, OffenderAgg> = new Map();
  const upsertWithDiagnosticsLite = (paramsUpsert: {
    readonly issueKey: string;
    readonly kind: AiLedgerIssueKind;
    readonly severity: AiLedgerSeverity;
    readonly title: string;
    readonly summary?: string;
    readonly combo: AiLedgerComboRef;
    readonly issuesPointer: string;
    readonly diagnosticsLiteRelPath?: string;
    readonly diagnosticsPointer?: string;
    readonly excerpt?: string;
  }): void => {
    upsert({
      issueKey: paramsUpsert.issueKey,
      kind: paramsUpsert.kind,
      severity: paramsUpsert.severity,
      title: paramsUpsert.title,
      summary: paramsUpsert.summary,
      combo: paramsUpsert.combo,
      evidence: {
        sourceRelPath,
        pointer: paramsUpsert.issuesPointer,
        artifactRelPath: paramsUpsert.diagnosticsLiteRelPath,
        excerpt: paramsUpsert.excerpt,
      },
    });
    if (paramsUpsert.diagnosticsLiteRelPath === undefined || paramsUpsert.diagnosticsPointer === undefined) {
      return;
    }
    upsert({
      issueKey: paramsUpsert.issueKey,
      kind: paramsUpsert.kind,
      severity: paramsUpsert.severity,
      title: paramsUpsert.title,
      summary: paramsUpsert.summary,
      combo: paramsUpsert.combo,
      evidence: {
        sourceRelPath: paramsUpsert.diagnosticsLiteRelPath,
        pointer: paramsUpsert.diagnosticsPointer,
        excerpt: paramsUpsert.excerpt,
      },
    });
  };
  const upsert = (paramsUpsert: {
    readonly issueKey: string;
    readonly kind: AiLedgerIssueKind;
    readonly severity: AiLedgerSeverity;
    readonly title: string;
    readonly summary?: string;
    readonly combo: AiLedgerComboRef;
    readonly evidence: AiLedgerEvidence;
  }): void => {
    const existing: MutableIssue | undefined = issueByKey.get(paramsUpsert.issueKey);
    if (existing) {
      existing.affected = addCombo(paramsUpsert.combo, existing.affected);
      existing.evidence = addEvidence(paramsUpsert.evidence, existing.evidence);
      if (existing.summary === undefined && paramsUpsert.summary !== undefined) {
        existing.summary = paramsUpsert.summary;
      }
      if (existing.severity !== "red" && paramsUpsert.severity === "red") {
        existing.severity = "red";
      }
      return;
    }
    const id: string = hashId(paramsUpsert.issueKey);
    issueByKey.set(paramsUpsert.issueKey, {
      id,
      kind: paramsUpsert.kind,
      severity: paramsUpsert.severity,
      title: paramsUpsert.title,
      summary: paramsUpsert.summary,
      affected: [paramsUpsert.combo],
      evidence: [paramsUpsert.evidence],
    });
  };
  const failingIndexByComboKey: Map<string, number> = new Map();
  params.issues.failing.forEach((f, index) => {
    failingIndexByComboKey.set(`${f.label}|${f.path}|${f.device}`, index);
  });
  for (const combo of params.issues.failing) {
    const comboKey: string = `${combo.label}|${combo.path}|${combo.device}`;
    const index: number | undefined = failingIndexByComboKey.get(comboKey);
    const comboRef: AiLedgerComboRef = { label: combo.label, path: combo.path, device: combo.device };
    const basePointer: string = index === undefined ? buildComboPointer(comboRef) : buildComboPointer(comboRef);
    const diagnosticsLiteRelPath: string | undefined = combo.artifacts?.diagnosticsLiteRelPath;
    if (typeof combo.runtimeErrorMessage === "string" && combo.runtimeErrorMessage.length > 0) {
      upsertWithDiagnosticsLite({
        issueKey: `runtime_error|${combo.path}|${combo.device}|${combo.runtimeErrorMessage}`,
        kind: "runtime_error",
        severity: "red",
        title: "Runtime error during audit",
        summary: combo.runtimeErrorMessage.slice(0, 200),
        combo: comboRef,
        issuesPointer: `${basePointer}.runtimeErrorMessage`,
        diagnosticsLiteRelPath,
        excerpt: combo.runtimeErrorMessage.slice(0, 200),
      });
    }
    const redirects = combo.hints?.redirects;
    if (redirects && (Array.isArray(redirects.chain) || typeof redirects.overallSavingsMs === "number")) {
      const chain: readonly string[] = redirects.chain ?? [];
      const chainKey: string = chain.length > 0 ? chain.join(" -> ") : "(unknown)";
      upsertWithDiagnosticsLite({
        issueKey: `redirect_chain|${chainKey}`,
        kind: "redirect_chain",
        severity: "red",
        title: "Redirect chain",
        summary: typeof redirects.overallSavingsMs === "number" ? `Estimated savings: ${Math.round(redirects.overallSavingsMs)}ms` : undefined,
        combo: comboRef,
        issuesPointer: `${basePointer}.hints.redirects`,
        diagnosticsLiteRelPath,
        diagnosticsPointer: buildDiagnosticsLiteAuditPointer({ auditId: "redirects" }),
        excerpt: chainKey.slice(0, 200),
      });
    }
    const unused = combo.hints?.unusedJavascript;
    if (unused && unused.files.length > 0) {
      for (const file of unused.files.slice(0, 5)) {
        const wastedBytes: number = Math.max(0, Math.floor(file.wastedBytes ?? 0));
        const summary = wastedBytes > 0 ? `Wasted bytes: ${wastedBytes}` : undefined;
        upsertWithDiagnosticsLite({
          issueKey: `unused_javascript|${file.url}`,
          kind: "unused_javascript",
          severity: "yellow",
          title: "Unused JavaScript",
          summary,
          combo: comboRef,
          issuesPointer: `${basePointer}.hints.unusedJavascript.files`,
          diagnosticsLiteRelPath,
          diagnosticsPointer: buildDiagnosticsLiteAuditPointer({ auditId: "unused-javascript", itemUrl: file.url }),
          excerpt: file.url.slice(0, 200),
        });
      }
    }
    const legacy = combo.hints?.legacyJavascript;
    if (legacy && legacy.polyfills.length > 0) {
      for (const poly of legacy.polyfills.slice(0, 5)) {
        const wastedBytes: number = Math.max(0, Math.floor(poly.wastedBytes ?? 0));
        const summary = wastedBytes > 0 ? `Wasted bytes: ${wastedBytes}` : undefined;
        upsertWithDiagnosticsLite({
          issueKey: `legacy_javascript|${poly.url}`,
          kind: "legacy_javascript",
          severity: "yellow",
          title: "Legacy JavaScript / polyfills",
          summary,
          combo: comboRef,
          issuesPointer: `${basePointer}.hints.legacyJavascript.polyfills`,
          diagnosticsLiteRelPath,
          diagnosticsPointer: buildDiagnosticsLiteAuditPointer({ auditId: "legacy-javascript", itemUrl: poly.url }),
          excerpt: poly.url.slice(0, 200),
        });
      }
    }
    const rbr = combo.hints?.renderBlockingResources;
    if (rbr && rbr.resources.length > 0) {
      for (const res of rbr.resources.slice(0, 5)) {
        const wastedMs: number = Math.max(0, Math.floor(res.wastedMs ?? 0));
        const summary = wastedMs > 0 ? `Estimated savings: ${wastedMs}ms` : undefined;
        upsertWithDiagnosticsLite({
          issueKey: `render_blocking_resource|${res.url}`,
          kind: "render_blocking_resource",
          severity: "yellow",
          title: "Render-blocking resource",
          summary,
          combo: comboRef,
          issuesPointer: `${basePointer}.hints.renderBlockingResources.resources`,
          diagnosticsLiteRelPath,
          diagnosticsPointer: buildDiagnosticsLiteAuditPointer({ auditId: "render-blocking-resources", itemUrl: res.url }),
          excerpt: res.url.slice(0, 200),
        });
      }
    }
    const crc = combo.hints?.criticalRequestChains;
    if (crc && crc.chain.length > 0) {
      const firstUrl: string = crc.chain[0]?.url ?? "(unknown)";
      upsertWithDiagnosticsLite({
        issueKey: `critical_request_chain|${combo.path}|${combo.device}|${firstUrl}`,
        kind: "critical_request_chain",
        severity: "yellow",
        title: "Critical request chain",
        summary: typeof crc.longestChainDurationMs === "number" ? `Chain duration: ${Math.round(crc.longestChainDurationMs)}ms` : undefined,
        combo: comboRef,
        issuesPointer: `${basePointer}.hints.criticalRequestChains`,
        diagnosticsLiteRelPath,
        diagnosticsPointer: buildDiagnosticsLiteAuditPointer({ auditId: "critical-request-chains" }),
        excerpt: firstUrl.slice(0, 200),
      });
    }
    const lcpPhases = combo.hints?.lcpPhases;
    if (lcpPhases && Object.values(lcpPhases).some((v) => typeof v === "number" && v > 0)) {
      upsertWithDiagnosticsLite({
        issueKey: `lcp_phases|${combo.path}|${combo.device}`,
        kind: "lcp_phases",
        severity: "yellow",
        title: "LCP phases breakdown",
        combo: comboRef,
        issuesPointer: `${basePointer}.hints.lcpPhases`,
        diagnosticsLiteRelPath,
        diagnosticsPointer: buildDiagnosticsLiteAuditPointer({ auditId: "lcp-phases" }),
      });
    }
    const lcpElement = combo.hints?.lcpElement;
    if (lcpElement && (typeof lcpElement.selector === "string" || typeof lcpElement.snippet === "string")) {
      const excerpt: string | undefined = typeof lcpElement.selector === "string" ? lcpElement.selector.slice(0, 200) : lcpElement.snippet?.slice(0, 200);
      upsertWithDiagnosticsLite({
        issueKey: `lcp_element|${combo.path}|${combo.device}|${lcpElement.selector ?? lcpElement.snippet ?? ""}`,
        kind: "lcp_element",
        severity: "info",
        title: "Largest Contentful Paint element",
        combo: comboRef,
        issuesPointer: `${basePointer}.hints.lcpElement`,
        diagnosticsLiteRelPath,
        diagnosticsPointer: buildDiagnosticsLiteAuditPointer({ auditId: "largest-contentful-paint-element" }),
        excerpt,
      });
    }
    const bfCache = combo.hints?.bfCache;
    if (bfCache && bfCache.reasons.length > 0) {
      upsertWithDiagnosticsLite({
        issueKey: `bfcache_blocker|${bfCache.reasons.join("|")}`,
        kind: "bfcache_blocker",
        severity: "info",
        title: "bfcache blocked",
        summary: bfCache.reasons.slice(0, 5).join("; ").slice(0, 200),
        combo: comboRef,
        issuesPointer: `${basePointer}.hints.bfCache`,
        diagnosticsLiteRelPath,
        diagnosticsPointer: buildDiagnosticsLiteAuditPointer({ auditId: "bf-cache" }),
      });
    }
  }
  const previousByComboKey: Map<string, PageDeviceSummary> = new Map(
    (params.previousSummary?.results ?? []).map((r) => [`${r.label}|${r.path}|${r.device}`, r]),
  );
  const deltasAll: readonly AiLedgerComboDelta[] = params.summary.results
    .map((current): AiLedgerComboDelta | undefined => {
      const key: string = `${current.label}|${current.path}|${current.device}`;
      const prev: PageDeviceSummary | undefined = previousByComboKey.get(key);
      if (prev === undefined) {
        return undefined;
      }
      type MutableDeltas = {
        performance?: number;
        lcpMs?: number;
        inpMs?: number;
        cls?: number;
        tbtMs?: number;
      };
      const deltas: MutableDeltas = {};
      if (typeof current.scores.performance === "number" && typeof prev.scores.performance === "number") {
        deltas.performance = current.scores.performance - prev.scores.performance;
      }
      if (typeof current.metrics.lcpMs === "number" && typeof prev.metrics.lcpMs === "number") {
        deltas.lcpMs = current.metrics.lcpMs - prev.metrics.lcpMs;
      }
      if (typeof current.metrics.inpMs === "number" && typeof prev.metrics.inpMs === "number") {
        deltas.inpMs = current.metrics.inpMs - prev.metrics.inpMs;
      }
      if (typeof current.metrics.cls === "number" && typeof prev.metrics.cls === "number") {
        deltas.cls = current.metrics.cls - prev.metrics.cls;
      }
      if (typeof current.metrics.tbtMs === "number" && typeof prev.metrics.tbtMs === "number") {
        deltas.tbtMs = current.metrics.tbtMs - prev.metrics.tbtMs;
      }
      const hasAnyDelta: boolean = Object.keys(deltas).length > 0;
      if (!hasAnyDelta) {
        return undefined;
      }
      return {
        comboKey: buildComboKey({ label: current.label, path: current.path, device: current.device }),
        label: current.label,
        path: current.path,
        device: current.device,
        deltas,
      };
    })
    .filter((x): x is AiLedgerComboDelta => x !== undefined);
  const scoreRegressionRank = (d: AiLedgerComboDelta): number => {
    const perf: number = d.deltas.performance ?? 0;
    const lcp: number = d.deltas.lcpMs ?? 0;
    const inp: number = d.deltas.inpMs ?? 0;
    const cls: number = d.deltas.cls ?? 0;
    const tbt: number = d.deltas.tbtMs ?? 0;
    const perfPenalty: number = perf < 0 ? Math.abs(perf) * 20 : 0;
    const lcpPenalty: number = lcp > 0 ? lcp / 100 : 0;
    const inpPenalty: number = inp > 0 ? inp / 100 : 0;
    const clsPenalty: number = cls > 0 ? cls * 1000 : 0;
    const tbtPenalty: number = tbt > 0 ? tbt / 100 : 0;
    return perfPenalty + lcpPenalty + inpPenalty + clsPenalty + tbtPenalty;
  };
  const scoreImprovementRank = (d: AiLedgerComboDelta): number => {
    const perf: number = d.deltas.performance ?? 0;
    const lcp: number = d.deltas.lcpMs ?? 0;
    const inp: number = d.deltas.inpMs ?? 0;
    const cls: number = d.deltas.cls ?? 0;
    const tbt: number = d.deltas.tbtMs ?? 0;
    const perfGain: number = perf > 0 ? perf * 20 : 0;
    const lcpGain: number = lcp < 0 ? Math.abs(lcp) / 100 : 0;
    const inpGain: number = inp < 0 ? Math.abs(inp) / 100 : 0;
    const clsGain: number = cls < 0 ? Math.abs(cls) * 1000 : 0;
    const tbtGain: number = tbt < 0 ? Math.abs(tbt) / 100 : 0;
    return perfGain + lcpGain + inpGain + clsGain + tbtGain;
  };
  const regressions: readonly AiLedgerComboDelta[] = [...deltasAll]
    .filter((d) => scoreRegressionRank(d) > 0)
    .sort((a, b) => scoreRegressionRank(b) - scoreRegressionRank(a))
    .slice(0, 10);
  const improvements: readonly AiLedgerComboDelta[] = [...deltasAll]
    .filter((d) => scoreImprovementRank(d) > 0)
    .sort((a, b) => scoreImprovementRank(b) - scoreImprovementRank(a))
    .slice(0, 10);
  const combos: AiLedger["combos"] = params.summary.results.map((r) => ({
    label: r.label,
    path: r.path,
    device: r.device,
    scores: {
      performance: r.scores.performance,
      accessibility: r.scores.accessibility,
      bestPractices: r.scores.bestPractices,
      seo: r.scores.seo,
    },
    metrics: {
      lcpMs: r.metrics.lcpMs,
      cls: r.metrics.cls,
      inpMs: r.metrics.inpMs,
      tbtMs: r.metrics.tbtMs,
    },
    runtimeErrorMessage: r.runtimeErrorMessage,
  }));
  const comboIndex: Record<AiLedgerComboKey, AiLedger["combos"][number]> = combos.reduce((acc, combo) => {
    const key: AiLedgerComboKey = buildComboKey({ label: combo.label, path: combo.path, device: combo.device });
    return { ...acc, [key]: combo };
  }, {} as Record<AiLedgerComboKey, AiLedger["combos"][number]>);
  const instructions: string =
    "Use fixPlan in order. Each step references issueIds which correspond to issues[].id. For each issue, use evidence[].sourceRelPath and evidence[].pointer to locate the exact source data (usually in issues.json). Heavy evidence is stored in diagnostics artifacts; prefer following artifactRelPath pointers instead of expanding large blobs. After applying fixes, re-run audit and compare summary.json to verify improvements.";
  const issues: readonly AiLedgerIssue[] = [...issueByKey.values()]
    .sort((a, b) => {
      const severityRank = (s: AiLedgerSeverity): number => (s === "red" ? 0 : s === "yellow" ? 1 : 2);
      const aR: number = severityRank(a.severity);
      const bR: number = severityRank(b.severity);
      if (aR !== bR) {
        return aR - bR;
      }
      if (a.affected.length !== b.affected.length) {
        return b.affected.length - a.affected.length;
      }
      return a.title.localeCompare(b.title);
    })
    .map((i) => ({
      id: i.id,
      kind: i.kind,
      severity: i.severity,
      title: i.title,
      summary: i.summary,
      affected: i.affected,
      evidence: i.evidence,
    }));
  const issueIndex: Record<AiLedgerIssueKey, AiLedgerIssue> = issues.reduce((acc, issue) => {
    return { ...acc, [issue.id]: issue };
  }, {} as Record<AiLedgerIssueKey, AiLedgerIssue>);
  for (const [issueKey, i] of issueByKey.entries()) {
    const isOffenderKind: boolean =
      i.kind === "unused_javascript" ||
      i.kind === "legacy_javascript" ||
      i.kind === "render_blocking_resource" ||
      i.kind === "redirect_chain";
    if (!isOffenderKind) {
      continue;
    }
    const excerpt: string | undefined = i.evidence[0]?.excerpt;
    const offenderKey: string = buildOffenderKey({ kind: i.kind, issueKey, excerpt });
    const existing: OffenderAgg | undefined = offendersByKey.get(offenderKey);
    const affectedKeys: Set<string> = new Set(i.affected.map((c) => buildComboKey(c)));
    const evidence: AiLedgerEvidence[] = i.evidence.slice(0, 2);
    if (!existing) {
      offendersByKey.set(offenderKey, {
        kind: i.kind,
        key: offenderKey,
        severity: i.severity,
        affectedKeys,
        issueIds: new Set([i.id]),
        evidence,
      });
      continue;
    }
    existing.issueIds.add(i.id);
    for (const k of affectedKeys) {
      existing.affectedKeys.add(k);
    }
    for (const e of evidence) {
      const eKey: string = `${e.sourceRelPath}|${e.pointer}|${e.artifactRelPath ?? ""}`;
      if (!existing.evidence.some((x) => `${x.sourceRelPath}|${x.pointer}|${x.artifactRelPath ?? ""}` === eKey)) {
        existing.evidence.push(e);
      }
    }
    if (existing.severity !== "red" && i.severity === "red") {
      existing.severity = "red";
    }
  }
  const offenders: readonly AiLedgerOffender[] = [...offendersByKey.values()]
    .map((o) => ({
      kind: o.kind,
      key: o.key,
      severity: o.severity,
      affectedCombos: o.affectedKeys.size,
      issueIds: [...o.issueIds.values()],
      evidence: o.evidence.slice(0, 2),
    }))
    .sort((a, b) => {
      const severityRank = (s: AiLedgerSeverity): number => (s === "red" ? 0 : s === "yellow" ? 1 : 2);
      const aS: number = severityRank(a.severity);
      const bS: number = severityRank(b.severity);
      if (aS !== bS) {
        return aS - bS;
      }
      if (a.affectedCombos !== b.affectedCombos) {
        return b.affectedCombos - a.affectedCombos;
      }
      return a.key.localeCompare(b.key);
    })
    .slice(0, 25);
  const kindRank = (kind: AiLedgerIssueKind): number => {
    switch (kind) {
      case "runtime_error":
        return 0;
      case "redirect_chain":
        return 1;
      case "render_blocking_resource":
        return 2;
      case "unused_javascript":
        return 3;
      case "legacy_javascript":
        return 4;
      case "critical_request_chain":
        return 5;
      case "lcp_phases":
        return 6;
      case "lcp_element":
        return 7;
      case "bfcache_blocker":
        return 8;
      default:
        return 99;
    }
  };
  const severityRank = (severity: AiLedgerSeverity): number => (severity === "red" ? 0 : severity === "yellow" ? 1 : 2);
  const fixPlanCandidates: readonly AiLedgerIssue[] = issues.filter((i) => i.severity !== "info").slice(0, 75);
  const buckets: Map<AiLedgerIssueKind, AiLedgerIssue[]> = new Map();
  for (const issue of fixPlanCandidates) {
    const list: AiLedgerIssue[] = buckets.get(issue.kind) ?? [];
    list.push(issue);
    buckets.set(issue.kind, list);
  }
  const pickTopIssueIds = (kind: AiLedgerIssueKind, max: number): readonly string[] => {
    const list: readonly AiLedgerIssue[] = buckets.get(kind) ?? [];
    return [...list]
      .sort((a, b) => b.affected.length - a.affected.length)
      .slice(0, max)
      .map((i) => i.id);
  };
  const planSteps: Omit<AiLedgerFixPlanStep, "order">[] = [];
  const runtimeIds: readonly string[] = pickTopIssueIds("runtime_error", 10);
  for (const id of runtimeIds) {
    const issue: AiLedgerIssue | undefined = issues.find((i) => i.id === id);
    if (!issue) {
      continue;
    }
    planSteps.push({
      title: issue.title,
      issueIds: [id],
      rationale: `${issue.severity.toUpperCase()} issue affecting ${issue.affected.length} combo(s).`,
      verify: "Re-run audit and ensure runtimeErrorMessage is cleared for affected combos.",
    });
  }
  const redirectIds: readonly string[] = pickTopIssueIds("redirect_chain", 10);
  if (redirectIds.length > 0) {
    planSteps.push({
      title: "Remove redirect chains",
      issueIds: redirectIds,
      rationale: `RED issue category affecting ${redirectIds.length} redirect offender(s).`,
      verify: "Re-run audit; redirect-chain issues should disappear and performance should increase.",
    });
  }
  const rbrIds: readonly string[] = pickTopIssueIds("render_blocking_resource", 10);
  if (rbrIds.length > 0) {
    planSteps.push({
      title: "Eliminate render-blocking resources",
      issueIds: rbrIds,
      rationale: `YELLOW issue category affecting ${rbrIds.length} resource offender(s).`,
      verify: "Re-run audit; render-blocking savings should drop and LCP/TBT should improve.",
    });
  }
  const unusedIds: readonly string[] = pickTopIssueIds("unused_javascript", 10);
  if (unusedIds.length > 0) {
    planSteps.push({
      title: "Reduce unused JavaScript",
      issueIds: unusedIds,
      rationale: `YELLOW issue category affecting ${unusedIds.length} script offender(s).`,
      verify: "Re-run audit; unused JS bytes should drop and performance should increase.",
    });
  }
  const legacyIds: readonly string[] = pickTopIssueIds("legacy_javascript", 10);
  if (legacyIds.length > 0) {
    planSteps.push({
      title: "Remove legacy JavaScript / polyfills",
      issueIds: legacyIds,
      rationale: `YELLOW issue category affecting ${legacyIds.length} polyfill offender(s).`,
      verify: "Re-run audit; legacy JS bytes should drop and performance should increase.",
    });
  }
  const remaining: readonly AiLedgerIssue[] = fixPlanCandidates
    .filter((i) =>
      i.kind !== "runtime_error" &&
      i.kind !== "redirect_chain" &&
      i.kind !== "render_blocking_resource" &&
      i.kind !== "unused_javascript" &&
      i.kind !== "legacy_javascript",
    )
    .sort((a, b) => {
      const aS: number = severityRank(a.severity);
      const bS: number = severityRank(b.severity);
      if (aS !== bS) {
        return aS - bS;
      }
      const aK: number = kindRank(a.kind);
      const bK: number = kindRank(b.kind);
      if (aK !== bK) {
        return aK - bK;
      }
      return b.affected.length - a.affected.length;
    })
    .slice(0, 20);
  for (const issue of remaining) {
    planSteps.push({
      title: issue.title,
      issueIds: [issue.id],
      rationale: `${issue.severity.toUpperCase()} issue affecting ${issue.affected.length} combo(s).`,
      verify: "Re-run audit; relevant diagnostics should improve.",
    });
  }
  const fixPlan: readonly AiLedgerFixPlanStep[] = planSteps
    .map((step, index) => ({ ...step, order: index + 1 }))
    .slice(0, 25);

  return {
    generatedAt,
    instructions,
    meta: params.summary.meta,
    runtime: params.runtime,
    targetScore: params.targetScore,
    totals: params.issues.totals,
    regressions,
    improvements,
    combos,
    comboIndex,
    issueIndex,
    issues,
    fixPlan,
    offenders,
  };
}

function buildAiFixMinPacket(params: { readonly aiFix: AiFixPacket; readonly limit: number }): AiFixMinPacket {
  const worstFirst: readonly AiFixPacket["perCombo"][number][] = [...params.aiFix.perCombo].sort((a, b) => {
    const aP: number = a.scores.performance ?? 101;
    const bP: number = b.scores.performance ?? 101;
    if (aP !== bP) {
      return aP - bP;
    }
    const aLcp: number = a.metrics.lcpMs ?? Number.POSITIVE_INFINITY;
    const bLcp: number = b.metrics.lcpMs ?? Number.POSITIVE_INFINITY;
    return aLcp - bLcp;
  });
  const boundedLimit: number = Math.max(1, Math.floor(params.limit));
  const limited = worstFirst.slice(0, boundedLimit);
  const perCombo: AiFixMinPacket["perCombo"] = limited.map((c) => {
    const unused = c.hints?.unusedJavascript;
    const unusedFiles = unused?.files
      .map((f) => ({ url: f.url, wastedBytes: f.wastedBytes }))
      .slice(0, 5);
    return {
      label: c.label,
      path: c.path,
      device: c.device,
      scores: { performance: c.scores.performance },
      metrics: { lcpMs: c.metrics.lcpMs, tbtMs: c.metrics.tbtMs, cls: c.metrics.cls },
      opportunities: c.opportunities.map((o) => ({ id: o.id, title: o.title })).slice(0, 3),
      hints: c.hints === undefined
        ? undefined
        : {
          lcpPhases: c.hints.lcpPhases,
          lcpElement: c.hints.lcpElement,
          unusedJavascript: unusedFiles && unusedFiles.length > 0
            ? { overallSavingsBytes: unused?.overallSavingsBytes, files: unusedFiles }
            : undefined,
          legacyJavascript: c.hints.legacyJavascript,
          renderBlockingResources: c.hints.renderBlockingResources,
          criticalRequestChains: c.hints.criticalRequestChains,
          bfCache: c.hints.bfCache,
        },
    };
  });
  return {
    generatedAt: params.aiFix.generatedAt,
    runtime: params.aiFix.runtime,
    targetScore: params.aiFix.targetScore,
    totals: params.aiFix.totals,
    limitedToWorstCombos: worstFirst.length > limited.length ? boundedLimit : undefined,
    perCombo,
    aggregates: params.aiFix.aggregates,
  };
}

function filterConfigWorst(params: { readonly previous: RunSummary; readonly config: ApexConfig; readonly limit: number }): ApexConfig {
  const limit: number = Math.max(1, Math.floor(params.limit));
  const byWorst = [...params.previous.results].sort((a, b) => {
    const aP: number = a.scores.performance ?? 101;
    const bP: number = b.scores.performance ?? 101;
    if (aP !== bP) {
      return aP - bP;
    }
    const aLcp: number = a.metrics.lcpMs ?? Number.POSITIVE_INFINITY;
    const bLcp: number = b.metrics.lcpMs ?? Number.POSITIVE_INFINITY;
    return aLcp - bLcp;
  });
  const selected = byWorst.slice(0, limit);
  const pageByPath: Map<string, ApexPageConfig> = new Map(params.config.pages.map((p) => [p.path, p]));
  const devicesByPath: Map<string, Set<ApexDevice>> = new Map();
  for (const combo of selected) {
    const page: ApexPageConfig | undefined = pageByPath.get(combo.path);
    if (!page) {
      continue;
    }
    const bucket: Set<ApexDevice> = devicesByPath.get(page.path) ?? new Set<ApexDevice>();
    bucket.add(combo.device);
    devicesByPath.set(page.path, bucket);
  }
  const pages: ApexPageConfig[] = [];
  for (const [path, deviceSet] of devicesByPath.entries()) {
    const page: ApexPageConfig | undefined = pageByPath.get(path);
    if (!page) {
      continue;
    }
    const devices: readonly ApexDevice[] = page.devices.filter((d) => deviceSet.has(d));
    if (devices.length === 0) {
      continue;
    }
    pages.push({ label: page.label, path: page.path, devices });
  }
  if (pages.length === 0) {
    return { ...params.config, pages: [] };
  }
  return { ...params.config, pages };
}

function buildRuntimeMeta(params: {
  readonly config: ApexConfig;
  readonly captureLevel: "diagnostics" | "lhr" | undefined;
  readonly chromePort?: number;
}): RuntimeMeta {
  const captureLevel: RuntimeMeta["captureLevel"] = params.captureLevel ?? "none";
  const throttlingMethod: ApexThrottlingMethod = params.config.throttlingMethod ?? "simulate";
  const throttlingOverridesApplied: boolean = throttlingMethod === "simulate";
  const chromeMode: RuntimeMeta["chrome"]["mode"] = typeof params.chromePort === "number" ? "external" : "managed-headless";
  const chrome = {
    mode: chromeMode,
    headless: chromeMode === "managed-headless",
    port: params.chromePort,
    flags: chromeMode === "managed-headless"
      ? ([
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--disable-default-apps",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-client-side-phishing-detection",
        "--disable-sync",
        "--disable-translate",
        "--metrics-recording-only",
        "--safebrowsing-disable-auto-update",
        "--password-store=basic",
        "--use-mock-keychain",
        "--disable-hang-monitor",
        "--disable-ipc-flooding-protection",
        "--disable-domain-reliability",
        "--disable-component-update",
      ] as const)
      : undefined,
  };
  return {
    chrome,
    throttlingMethod,
    throttlingOverridesApplied,
    cpuSlowdownMultiplier: params.config.cpuSlowdownMultiplier,
    parallel: params.config.parallel ?? 1,
    runsPerCombo: params.config.runs ?? 1,
    warmUp: params.config.warmUp ?? false,
    captureLevel,
  };
}

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

function buildAccessibilityRunnerFindings(summary: AxeSummary): readonly RunnerFindingLike[] {
  const aggregated: AccessibilitySummary = summariseAccessibility(summary);
  const evidence = [{ kind: "file", path: ".apex-auditor/accessibility-summary.json" }] as const;
  const findings: RunnerFindingLike[] = [];
  const impactLines: readonly string[] = [
    `critical: ${aggregated.impactCounts.critical}`,
    `serious: ${aggregated.impactCounts.serious}`,
    `moderate: ${aggregated.impactCounts.moderate}`,
    `minor: ${aggregated.impactCounts.minor}`,
    `errored: ${aggregated.errored}/${aggregated.total}`,
  ];
  findings.push({
    title: "Impact counts",
    severity: aggregated.impactCounts.critical > 0 || aggregated.impactCounts.serious > 0 ? "error" : "info",
    details: impactLines,
    evidence,
  });
  const top: readonly AxeResult[] = [...summary.results]
    .filter((r) => !r.runtimeErrorMessage)
    .sort((a, b) => b.violations.length - a.violations.length)
    .slice(0, 5);
  if (top.length > 0) {
    const lines: string[] = [];
    for (const r of top) {
      const sample: readonly AxeViolation[] = selectTopViolations(r, 3);
      const sampleTitles: readonly string[] = sample.map((v) => v.help ?? v.id);
      lines.push(`${r.label} ${r.path} [${r.device}] – ${r.violations.length} violations: ${sampleTitles.join(" | ")}`);
    }
    findings.push({
      title: "Worst pages (top 5 by violation count)",
      severity: "warn",
      details: lines,
      evidence,
    });
  }
  const errored: readonly AxeResult[] = summary.results.filter((r) => typeof r.runtimeErrorMessage === "string" && r.runtimeErrorMessage.length > 0).slice(0, 10);
  if (errored.length > 0) {
    findings.push({
      title: "Errored pages",
      severity: "error",
      details: errored.map((r) => `${r.label} ${r.path} [${r.device}] – ${r.runtimeErrorMessage ?? ""}`),
      evidence,
    });
  }
  return findings;
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
  let diagnostics = false;
  let lhr = false;
  let plan = false;
  let flagsOnly = false;
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
  let devtoolsAccurate = false;
  let jsonOutput = false;
  let showParallel = false;
  let fast = false;
  let overview = false;
  let overviewCombos: number | undefined;
  let regressionsOnly = false;
  let changedOnly = false;
  let rerunFailing = false;
  let focusWorst: number | undefined;
  let aiMinCombos: number | undefined;
  let noAiFix = false;
  let noExport = false;
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
    } else if (arg === "--diagnostics") {
      diagnostics = true;
    } else if (arg === "--lhr") {
      lhr = true;
    } else if (arg === "--plan") {
      plan = true;
    } else if (arg === "--flags") {
      flagsOnly = true;
    } else if (arg === "--regressions-only") {
      regressionsOnly = true;
    } else if (arg === "--changed-only") {
      changedOnly = true;
    } else if (arg === "--rerun-failing") {
      rerunFailing = true;
    } else if (arg === "--focus-worst" && i + 1 < argv.length) {
      const value: number = parseInt(argv[i + 1], 10);
      if (Number.isNaN(value) || value <= 0 || value > 200) {
        throw new Error(`Invalid --focus-worst value: ${argv[i + 1]}. Expected integer between 1 and 200.`);
      }
      focusWorst = value;
      i += 1;
    } else if (arg === "--ai-min-combos" && i + 1 < argv.length) {
      const value: number = parseInt(argv[i + 1], 10);
      if (Number.isNaN(value) || value <= 0 || value > 200) {
        throw new Error(`Invalid --ai-min-combos value: ${argv[i + 1]}. Expected integer between 1 and 200.`);
      }
      aiMinCombos = value;
      i += 1;
    } else if (arg === "--no-ai-fix") {
      noAiFix = true;
    } else if (arg === "--no-export") {
      noExport = true;
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
    } else if (arg === "--devtools-accurate") {
      devtoolsAccurate = true;
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
  const presetCount: number = [fast, quick, accurate, devtoolsAccurate, overview].filter((flag) => flag).length;
  if (presetCount > 1) {
    throw new Error("Choose only one preset: --overview, --fast, --quick, --accurate, or --devtools-accurate");
  }
  if (lhr) {
    diagnostics = true;
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
    diagnostics,
    lhr,
    plan,
    flagsOnly,
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
    devtoolsAccurate,
    jsonOutput,
    showParallel,
    fast,
    overview,
    overviewCombos,
    regressionsOnly,
    changedOnly,
    rerunFailing,
    focusWorst,
    aiMinCombos,
    noAiFix,
    noExport,
    accessibilityPass,
    webhookUrl,
    webhookAlways,
  };
}

async function ensureApexAuditorGitIgnore(projectRoot: string): Promise<void> {
  const gitIgnorePath: string = resolve(projectRoot, ".gitignore");
  const desiredLine: string = ".apex-auditor/";
  try {
    let existing: string = "";
    try {
      existing = await readFile(gitIgnorePath, "utf8");
    } catch {
      existing = "";
    }
    const hasEntry: boolean = existing
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .some((line) => line === desiredLine || line === ".apex-auditor" || line === "/.apex-auditor" || line === "/.apex-auditor/");
    if (hasEntry) {
      return;
    }
    const next: string = existing.length === 0 ? `${desiredLine}\n` : existing.endsWith("\n") ? `${existing}${desiredLine}\n` : `${existing}\n${desiredLine}\n`;
    await writeFile(gitIgnorePath, next, "utf8");
  } catch {
    return;
  }
}

function printAuditFlags(): void {
  console.log(
    [
      "Options (audit):",
      "  --flags            Print this list and exit",
      "  --config <path>    Config path (default apex.config.json)",
      "  --ci               Enable CI mode with budgets and non-zero exit code on failure",
      "  --fail-on-budget   Exit non-zero if budgets fail even outside CI",
      "  --no-color         Disable ANSI colours in console output (default in CI mode)",
      "  --color            Force ANSI colours in console output",
      "  --log-level <lvl>  Override Lighthouse log level: silent|error|info|verbose",
      "  --stable           Flake-resistant mode: forces parallel=1",
      "  --mobile-only      Run audits only for 'mobile' devices defined in the config",
      "  --desktop-only     Run audits only for 'desktop' devices defined in the config",
      "  --parallel <n>     Override parallel workers (1-10)",
      "  --audit-timeout-ms <ms>  Per-audit timeout in milliseconds",
      "  --diagnostics      Capture DevTools-like Lighthouse tables + screenshots (writes .apex-auditor/...)",
      "  --lhr              Also capture full Lighthouse result JSON per combo (implies --diagnostics)",
      "  --plan             Print resolved settings + run size estimate and exit without auditing",
      "  --max-steps <n>    Safety limit: refuse/prompt if planned Lighthouse runs exceed this",
      "  --max-combos <n>   Safety limit: refuse/prompt if planned page/device combos exceed this",
      "  --yes, -y          Auto-confirm large runs (bypass safety prompt)",
      "  --changed-only     Run only pages whose paths match files in git diff --name-only",
      "  --rerun-failing    Re-run only combos that failed in the previous summary",
      "  --focus-worst <n>  Re-run only the worst N combos from the previous summary.json",
      "  --ai-min-combos <n>  Limit ai-fix.min.json to the worst N combos (default 25)",
      "  --no-ai-fix        Skip writing ai-fix.json and ai-fix.min.json",
      "  --no-export        Skip writing export.json",
      "  --accessibility-pass  Run a fast axe-core accessibility sweep after audits",
      "  --webhook-url <url> Send a JSON webhook",
      "  --webhook-always   Send webhook even if there are no regressions/violations",
      "  --show-parallel    Print the resolved parallel workers before running",
      "  --incremental      Reuse cached results for unchanged combos (requires --build-id)",
      "  --build-id <id>    Build identifier used as the cache key boundary for --incremental",
      "  --overview         Preset: quick overview",
      "  --overview-combos <n>  Overview sampling size",
      "  --quick            Preset: fast feedback",
      "  --accurate         Preset: devtools throttling + warm-up + stability-first",
      "  --devtools-accurate Preset: devtools throttling + warm-up + higher parallelism by default",
      "  --open             Open the HTML report after the run.",
    ].join("\n"),
  );
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
  if (args.flagsOnly) {
    printAuditFlags();
    return;
  }
  const startTimeMs: number = Date.now();
  const { configPath, config } = await loadConfig({ configPath: args.configPath });
  if (config.gitIgnoreApexAuditorDir === true) {
    await ensureApexAuditorGitIgnore(dirname(configPath));
  }
  const previousSummary: RunSummary | undefined = await loadPreviousSummary();

  const DEFAULT_PARALLEL: number = 4;
  const DEFAULT_WARM_UP: boolean = true;
  const DEFAULT_THROTTLING: ApexThrottlingMethod = "simulate";
  const DEVTOOLS_ACCURATE_DEFAULT_PARALLEL: number = 4;
  const isDevtoolsAccuratePreset: boolean = args.accurate || args.devtoolsAccurate;
  const presetThrottling: ApexThrottlingMethod | undefined = isDevtoolsAccuratePreset ? "devtools" : undefined;
  const presetWarmUp: boolean | undefined = isDevtoolsAccuratePreset ? true : args.overview ? false : undefined;
  const presetParallel: number | undefined = args.accurate ? 1 : args.devtoolsAccurate ? DEVTOOLS_ACCURATE_DEFAULT_PARALLEL : undefined;

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
  const configRuns: number | undefined = typeof config.runs === "number" && Number.isFinite(config.runs) ? Math.max(1, Math.floor(config.runs)) : undefined;
  const devtoolsRunsDefault: number | undefined = isDevtoolsAccuratePreset && configRuns === undefined ? 3 : undefined;
  const effectiveRuns: number = args.fast ? 1 : (configRuns ?? devtoolsRunsDefault ?? 1);
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
  if (args.focusWorst !== undefined) {
    if (previousSummary === undefined) {
      // eslint-disable-next-line no-console
      console.error("Focus-worst mode requires a previous run. Expected .apex-auditor/summary.json to exist.");
      process.exitCode = 1;
      return;
    }
    const focused: ApexConfig = filterConfigWorst({ previous: previousSummary, config: effectiveConfig, limit: args.focusWorst });
    if (focused.pages.length === 0) {
      // eslint-disable-next-line no-console
      console.error("Focus-worst mode: no matching combos found in current config.");
      process.exitCode = 1;
      return;
    }
    effectiveConfig = focused;
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
  const LARGE_RUN_COMBOS_THRESHOLD: number = 76;
  const LARGE_RUN_PARALLEL_CAP: number = 4;
  const usingDefaultParallel: boolean = args.parallelOverride === undefined && presetParallel === undefined && config.parallel === undefined;
  const isLargeRun: boolean = plannedCombos >= LARGE_RUN_COMBOS_THRESHOLD;
  const autoStableLargeRun: boolean = isLargeRun && !args.stable && usingDefaultParallel;
  const resolvedConfigForRun: ApexConfig = autoStableLargeRun
    ? { ...overviewSample.config, parallel: Math.min(overviewSample.config.parallel ?? DEFAULT_PARALLEL, LARGE_RUN_PARALLEL_CAP) }
    : overviewSample.config;
  const maxSteps: number = args.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxCombos: number = args.maxCombos ?? DEFAULT_MAX_COMBOS;
  const isTty: boolean = typeof process !== "undefined" && process.stdout?.isTTY === true;
  const LARGE_RUN_HINT_COMBOS_THRESHOLD: number = 40;
  const exceeds: boolean = plannedSteps > maxSteps || plannedCombos > maxCombos;
  const useColor: boolean = shouldUseColor(args.ci, args.colorMode);
  if (args.plan) {
    printPlan({
      configPath,
      resolvedConfig: resolvedConfigForRun,
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
  if (isTty && !args.ci && !args.jsonOutput && plannedCombos >= LARGE_RUN_HINT_COMBOS_THRESHOLD) {
    // eslint-disable-next-line no-console
    console.log(`Tip: large run (${plannedCombos} combos). Use --plan to preview, and retry with --stable if parallel mode flakes.`);
  }
  if (autoStableLargeRun && isTty && !args.ci && !args.jsonOutput) {
    // eslint-disable-next-line no-console
    console.log(
      `Large run detected (${plannedCombos} combos). Using stability mode: parallel capped to ${resolvedConfigForRun.parallel}. Override with --parallel <n> or --stable (parallel=1).`,
    );
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
  const captureLevel: "diagnostics" | "lhr" | undefined = args.lhr ? "lhr" : args.diagnostics ? "diagnostics" : undefined;
  if (!args.fast && isDevtoolsAccuratePreset && effectiveThrottling === "devtools" && effectiveCpuSlowdown !== undefined) {
    // eslint-disable-next-line no-console
    console.log("Note: devtools throttling ignores cpuSlowdownMultiplier. Remove --cpu-slowdown / cpuSlowdownMultiplier to avoid confusion.");
  }
  if (!args.fast && effectiveThrottling === "devtools" && effectiveParallel === 1 && plannedCombos >= 20 && !args.ci && process.stdout.isTTY) {
    // eslint-disable-next-line no-console
    console.log("Tip: devtools throttling with --stable can be very slow for large suites. Use simulate for full sweeps, then rerun focused routes with devtools.");
  }
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
      config: resolvedConfigForRun,
      configPath,
      showParallel: args.showParallel,
      onlyCategories,
      captureLevel,
      signal: abortController.signal,
      onAfterWarmUp: startAuditSpinner,
      onProgress: ({ completed, total, path, device, etaMs }) => {
        if (!process.stdout.isTTY) {
          return;
        }
        const etaText: string = etaMs !== undefined ? ` | ETA ${formatEtaText(etaMs)}` : "";
        startAuditSpinner();
        updateSpinnerMessage(`Running audit (Lighthouse) page ${completed}/${total} — ${path} [${device}]${etaText}`);
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
    await handleFriendlyError({
      error,
      configPath,
      baseUrl: filteredConfig.baseUrl,
    });
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
  if (captureLevel !== undefined && isTty && !args.ci && !args.jsonOutput) {
    // eslint-disable-next-line no-console
    console.log(`Capture enabled (${captureLevel}). Writing artifacts under ${outputDir}/screenshots and ${outputDir}/lighthouse-artifacts/.`);
  }
  await writeJsonWithOptionalGzip(resolve(outputDir, "summary.json"), summary);
  const summaryLite: SummaryLite = buildSummaryLite(summary);
  await writeJsonWithOptionalGzip(resolve(outputDir, "summary-lite.json"), summaryLite);
  const worstFirstForHints: readonly { readonly label: string; readonly path: string; readonly device: ApexDevice; readonly baseName: string }[] =
    [...summary.results]
      .sort((a, b) => (a.scores.performance ?? 101) - (b.scores.performance ?? 101))
      .map((r) => ({ label: r.label, path: r.path, device: r.device, baseName: buildArtifactBaseName({ label: r.label, path: r.path, device: r.device }) }));
  const failingForHints: readonly { readonly label: string; readonly path: string; readonly device: ApexDevice; readonly baseName: string }[] = worstFirstForHints.filter(
    (r) => {
      const match = summary.results.find((x) => x.label === r.label && x.path === r.path && x.device === r.device);
      if (!match) {
        return false;
      }
      const scores: readonly number[] = [match.scores.performance, match.scores.accessibility, match.scores.bestPractices, match.scores.seo].filter(
        (v): v is number => typeof v === "number",
      );
      return scores.some((v) => v < DEFAULT_TARGET_SCORE) || typeof match.runtimeErrorMessage === "string";
    },
  );
  const hintsByBaseName: Map<string, { readonly hints?: ComboHints }> = await loadComboHints({
    outputDir,
    captureLevel,
    failing: failingForHints,
  });
  const issues: IssuesIndex = buildIssuesIndex({
    summary,
    outputDir,
    captureLevel,
    targetScore: DEFAULT_TARGET_SCORE,
    hintsByBaseName,
  });
  await writeJsonWithOptionalGzip(resolve(outputDir, "issues.json"), issues);
  const runtime: RuntimeMeta = buildRuntimeMeta({ config: resolvedConfigForRun, captureLevel, chromePort: resolvedConfigForRun.chromePort });
  const aiLedger: AiLedger = buildAiLedger({
    summary,
    previousSummary,
    issues,
    runtime,
    outputDir,
    targetScore: DEFAULT_TARGET_SCORE,
  });
  await writeJsonWithOptionalGzip(resolve(outputDir, "ai-ledger.json"), aiLedger, { pretty: false });
  if (!args.noAiFix) {
    const aiFix: AiFixPacket = buildAiFixPacket({ summary, issues, targetScore: DEFAULT_TARGET_SCORE, runtime });
    await writeJsonWithOptionalGzip(resolve(outputDir, "ai-fix.json"), aiFix, { pretty: false });
    const limit: number = args.aiMinCombos ?? DEFAULT_AI_MIN_COMBOS;
    const aiFixMin: AiFixMinPacket = buildAiFixMinPacket({ aiFix, limit });
    await writeJsonWithOptionalGzip(resolve(outputDir, "ai-fix.min.json"), aiFixMin, { pretty: false });
  }
  const plan: AuditPlan = buildPlanJson({ summary, issues, targetScore: DEFAULT_TARGET_SCORE });
  await writeJsonWithOptionalGzip(resolve(outputDir, "plan.json"), plan);
  const pwa: PwaReport = await buildPwaReport({ summary, outputDir, captureLevel });
  await writeJsonWithOptionalGzip(resolve(outputDir, "pwa.json"), pwa);
  const markdown: string = buildMarkdown(summary);
  await writeFile(resolve(outputDir, "summary.md"), markdown, "utf8");
  const html: string = buildHtmlReport(summary);
  const reportPath: string = resolve(outputDir, "report.html");
  await writeFile(reportPath, html, "utf8");
  const budgetViolations: readonly BudgetViolation[] =
    effectiveConfig.budgets === undefined ? [] : collectBudgetViolations(summary.results, effectiveConfig.budgets);
  const exportPath: string = resolve(outputDir, "export.json");
  const shareable: ShareableExport = buildShareableExport({
    configPath,
    previousSummary,
    current: summary,
    budgets: effectiveConfig.budgets,
  });
  if (!args.noExport) {
    await writeJsonWithOptionalGzip(exportPath, shareable);
  }
  const triagePath: string = resolve(outputDir, "triage.md");
  const overviewPath: string = resolve(outputDir, "overview.md");
  const overview: string = buildOverviewMarkdown({
    summary,
    previousSummary,
    issues,
    outputDir,
    reportPath,
    exportPath,
    triagePath,
    planPath: resolve(outputDir, "plan.json"),
    captureLevel,
    targetScore: DEFAULT_TARGET_SCORE,
    includeAiFix: !args.noAiFix,
    includeExport: !args.noExport,
  });
  await writeFile(overviewPath, overview, "utf8");
  const triage: string = buildTriageMarkdown({
    summary,
    reportPath,
    exportPath,
    outputDir,
    captureLevel,
    targetScore: DEFAULT_TARGET_SCORE,
    issues,
    includeAiFix: !args.noAiFix,
    includeExport: !args.noExport,
  });
  await writeFile(triagePath, triage, "utf8");
  let accessibilitySummary: AxeSummary | undefined;
  let accessibilitySummaryPath: string | undefined;
  let accessibilityAggregated: AccessibilitySummary | undefined;
  if (args.accessibilityPass) {
    const accessibilityArtifacts: string = resolve(outputDir, "accessibility");
    accessibilitySummary = await runAccessibilityAudit({
      config: filteredConfig,
      configPath,
      artifactsDir: accessibilityArtifacts,
    });
    accessibilitySummaryPath = resolve(outputDir, "accessibility-summary.json");
    await writeFile(accessibilitySummaryPath, JSON.stringify(accessibilitySummary, null, 2), "utf8");
    await writeRunnerReports({
      outputDir,
      runner: "accessibility",
      generatedAt: new Date().toISOString(),
      humanTitle: "ApexAuditor Accessibility report",
      humanSummaryLines: [
        `Combos: ${accessibilitySummary.meta.comboCount}`,
        `Elapsed: ${Math.round(accessibilitySummary.meta.elapsedMs / 1000)}s`,
      ],
      artifacts: [
        { label: "Accessibility summary (JSON)", relativePath: "accessibility-summary.json" },
        { label: "Accessibility artifacts", relativePath: "accessibility/" },
      ],
      aiMeta: {
        configPath,
        comboCount: accessibilitySummary.meta.comboCount,
        elapsedMs: accessibilitySummary.meta.elapsedMs,
      },
      aiFindings: buildAccessibilityRunnerFindings(accessibilitySummary),
    });
    accessibilityAggregated = accessibilitySummary === undefined ? undefined : summariseAccessibility(accessibilitySummary);
  }
  await writeArtifactsNavigation({ outputDir });
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
    await printArtifactsSummary({ outputDir, reportPath, exportPath, captureLevel });
  }
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
  if (args.accessibilityPass && accessibilitySummary !== undefined) {
    printSectionHeader("Accessibility (fast pass)", useColor);
    // eslint-disable-next-line no-console
    console.log(buildAccessibilityPanel(summariseAccessibility(accessibilitySummary), useColor));
    // eslint-disable-next-line no-console
    console.log(buildAccessibilityIssuesPanel(accessibilitySummary.results, useColor));
  }
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
    "| --- | --- |",
    `| Config | \`${meta.configPath}\` |`,
    `| Build ID | \`${meta.buildId ?? "-"}\` |`,
    `| Incremental | \`${meta.incremental ? "yes" : "no"}\` |`,
    `| Resolved parallel | \`${meta.resolvedParallel}\` |`,
    `| Warm-up | \`${meta.warmUp ? "yes" : "no"}\` |`,
    `| Throttling | \`${meta.throttlingMethod}\` |`,
    `| CPU slowdown | \`${meta.cpuSlowdownMultiplier}\` |`,
    `| Combos | \`${meta.comboCount}\` |`,
    `| Executed combos | \`${meta.executedCombos}\` |`,
    `| Cached combos | \`${meta.cachedCombos}\` |`,
    `| Runs per combo | \`${meta.runsPerCombo}\` |`,
    `| Total steps | \`${meta.totalSteps}\` |`,
    `| Executed steps | \`${meta.executedSteps}\` |`,
    `| Cached steps | \`${meta.cachedSteps}\` |`,
    `| Started | \`${meta.startedAt}\` |`,
    `| Completed | \`${meta.completedAt}\` |`,
    `| Elapsed | \`${formatElapsedTime(meta.elapsedMs)}\` |`,
    `| Avg per step | \`${formatElapsedTime(meta.averageStepMs)}\` |`,
  ].join("\n");
  const header: string = [
    "| Label | Path | Device | P | A | BP | SEO | LCP (s) | FCP (s) | TBT (ms) | CLS | INP (ms) | Error | Top issues |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ].join("\n");
  const rows: string[] = summary.results.map((result) => buildRow(result));
  const lines: string[] = [];
  lines.push("# ApexAuditor summary");
  lines.push("");
  lines.push(`Generated: ${meta.completedAt}`);
  lines.push("");
  lines.push("This file is designed for quick scanning and copy/paste into issues/PRs.");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Run settings");
  lines.push("");
  lines.push(metaTable);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Results");
  lines.push("");
  lines.push(header);
  lines.push(rows.join("\n"));
  return `${lines.join("\n")}\n`;
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
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
  const issues: string = escapeMarkdownTableCell(formatTopIssues(result.opportunities));
  const error: string =
    escapeMarkdownTableCell(result.runtimeErrorCode ?? (result.runtimeErrorMessage !== undefined ? result.runtimeErrorMessage : ""));
  const label: string = escapeMarkdownTableCell(result.label);
  const path: string = escapeMarkdownTableCell(result.path);
  return `| ${label} | ${path} | ${result.device} | ${scores.performance ?? "-"} | ${scores.accessibility ?? "-"} | ${scores.bestPractices ?? "-"} | ${scores.seo ?? "-"} | ${lcpSeconds} | ${fcpSeconds} | ${tbtMs} | ${cls} | ${inpMs} | ${error} | ${issues} |`;
}

function toMarkdownLink(label: string, href: string): string {
  const safeHref: string = href.replace(/\\/g, "/");
  return `[${label}](${safeHref})`;
}

function toRelativeMarkdownLink(params: { readonly outputDir: string; readonly absolutePath: string; readonly label: string }): string {
  const rel: string = relative(params.outputDir, params.absolutePath);
  return toMarkdownLink(params.label, rel);
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

async function countFilesInDir(path: string): Promise<number> {
  try {
    const entries: readonly string[] = await readdir(path);
    return entries.length;
  } catch {
    return 0;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function toSafeSegment(input: string): string {
  const cleaned: string = input
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9\-_.]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "");
  return cleaned.length > 0 ? cleaned : "item";
}

function buildArtifactBaseName(params: { readonly label: string; readonly path: string; readonly device: ApexDevice }): string {
  const label: string = toSafeSegment(params.label);
  const path: string = toSafeSegment(params.path.replace(/^\//, ""));
  return `${label}__${path.length > 0 ? path : "root"}__${params.device}`;
}

type DiagnosticsLiteAudit = {
  readonly id: string;
  readonly title?: string;
  readonly score?: number;
  readonly scoreDisplayMode?: string;
  readonly numericValue?: number;
  readonly displayValue?: string;
  readonly details?: {
    readonly type?: string;
    readonly overallSavingsMs?: number;
    readonly overallSavingsBytes?: number;
    readonly headings?: readonly string[];
    readonly items?: readonly Record<string, unknown>[];
    readonly truncated?: boolean;
  };
};

type DiagnosticsLiteFile = {
  readonly meta?: {
    readonly label?: string;
    readonly path?: string;
    readonly device?: string;
  };
  readonly audits?: readonly DiagnosticsLiteAudit[];
};

type LhrAuditDetails = {
  readonly type?: unknown;
  readonly items?: unknown;
  readonly overallSavingsMs?: unknown;
  readonly overallSavingsBytes?: unknown;
  readonly chains?: unknown;
  readonly longestChain?: unknown;
};

type LhrAudit = {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly score?: unknown;
  readonly scoreDisplayMode?: unknown;
  readonly numericValue?: unknown;
  readonly displayValue?: unknown;
  readonly details?: unknown;
};

type LhrLike = {
  readonly audits?: unknown;
};

type PwaAuditStatus = "pass" | "fail" | "not-applicable" | "informative" | "unknown";

type PwaAuditFinding = {
  readonly auditId: string;
  readonly title?: string;
  readonly status: PwaAuditStatus;
  readonly score?: number;
  readonly scoreDisplayMode?: string;
  readonly description?: string;
};

type PwaComboFinding = {
  readonly label: string;
  readonly path: string;
  readonly device: ApexDevice;
  readonly pageScope?: "public" | "requires-auth";
  readonly artifactBaseName: string;
  readonly artifacts?: {
    readonly diagnosticsLiteRelPath: string;
    readonly diagnosticsLitePointerByAuditId: Record<string, string>;
  };
  readonly audits: readonly PwaAuditFinding[];
};

type PwaReport = {
  readonly generatedAt: string;
  readonly meta: {
    readonly comboCount: number;
    readonly auditedComboCount: number;
    readonly captureLevel: "diagnostics" | "lhr" | undefined;
  };
  readonly combos: readonly PwaComboFinding[];
};

type ComboHints = NonNullable<IssuesIndex["failing"][number]["hints"]>;

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getAudit(lite: DiagnosticsLiteFile, id: string): DiagnosticsLiteAudit | undefined {
  const audits: readonly DiagnosticsLiteAudit[] = Array.isArray(lite.audits) ? lite.audits : [];
  return audits.find((a) => a.id === id);
}

function toPwaStatusFromScoreDisplayMode(mode: string | undefined, score: number | undefined): PwaAuditStatus {
  if (mode === "notApplicable") {
    return "not-applicable";
  }
  if (mode === "informative") {
    return "informative";
  }
  if (mode === "manual") {
    return "informative";
  }
  if (mode === "error") {
    return "unknown";
  }
  if (mode === "binary") {
    if (score === 1) {
      return "pass";
    }
    if (score === 0) {
      return "fail";
    }
    return "unknown";
  }
  if (typeof score === "number") {
    return score >= 0.9 ? "pass" : "fail";
  }
  return "unknown";
}

function buildPwaAuditFinding(audit: DiagnosticsLiteAudit | undefined): PwaAuditFinding | undefined {
  if (!audit) {
    return undefined;
  }
  const score: number | undefined = typeof audit.score === "number" ? audit.score : undefined;
  const scoreDisplayMode: string | undefined = typeof audit.scoreDisplayMode === "string" ? audit.scoreDisplayMode : undefined;
  return {
    auditId: audit.id,
    title: typeof audit.title === "string" ? audit.title : undefined,
    status: toPwaStatusFromScoreDisplayMode(scoreDisplayMode, score),
    score,
    scoreDisplayMode,
    description: typeof (audit as unknown as { readonly description?: unknown }).description === "string"
      ? String((audit as unknown as { readonly description?: unknown }).description)
      : undefined,
  };
}

async function buildPwaReport(params: {
  readonly summary: RunSummary;
  readonly outputDir: string;
  readonly captureLevel: "diagnostics" | "lhr" | undefined;
}): Promise<PwaReport> {
  const generatedAt: string = new Date().toISOString();
  if (params.captureLevel === undefined) {
    return {
      generatedAt,
      meta: { comboCount: params.summary.results.length, auditedComboCount: 0, captureLevel: params.captureLevel },
      combos: [],
    };
  }
  const diagnosticsLiteDir: string = resolve(params.outputDir, "lighthouse-artifacts", "diagnostics-lite");
  const PWA_AUDIT_IDS: readonly string[] = [
    "is-on-https",
    "service-worker",
    "works-offline",
    "installable-manifest",
    "splash-screen",
    "themed-omnibox",
    "viewport",
    "content-width",
    "offline-start-url",
    "redirects-http",
  ];
  const combos: PwaComboFinding[] = [];
  let auditedComboCount: number = 0;
  for (const r of params.summary.results) {
    const baseName: string = buildArtifactBaseName({ label: r.label, path: r.path, device: r.device });
    const diagnosticsLitePath: string = resolve(diagnosticsLiteDir, `${baseName}.json`);
    let lite: DiagnosticsLiteFile | undefined;
    try {
      const raw: string = await readFile(diagnosticsLitePath, "utf8");
      const parsed: unknown = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") {
        lite = parsed as DiagnosticsLiteFile;
      }
    } catch {
      lite = undefined;
    }
    if (!lite) {
      continue;
    }
    const findings: PwaAuditFinding[] = [];
    const pointerByAuditId: Record<string, string> = {};
    for (const id of PWA_AUDIT_IDS) {
      const finding: PwaAuditFinding | undefined = buildPwaAuditFinding(getAudit(lite, id));
      if (!finding) {
        continue;
      }
      findings.push(finding);
      pointerByAuditId[id] = buildDiagnosticsLiteAuditPointer({ auditId: id });
    }
    if (findings.length === 0) {
      continue;
    }
    auditedComboCount += 1;
    combos.push({
      label: r.label,
      path: r.path,
      device: r.device,
      pageScope: r.pageScope,
      artifactBaseName: baseName,
      artifacts: {
        diagnosticsLiteRelPath: join("lighthouse-artifacts", "diagnostics-lite", `${baseName}.json`),
        diagnosticsLitePointerByAuditId: pointerByAuditId,
      },
      audits: findings,
    });
  }
  return {
    generatedAt,
    meta: { comboCount: params.summary.results.length, auditedComboCount, captureLevel: params.captureLevel },
    combos,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function getLhrAudit(lhr: LhrLike, id: string): LhrAudit | undefined {
  if (!isObject(lhr.audits)) {
    return undefined;
  }
  const audits: Record<string, unknown> = lhr.audits;
  const auditUnknown: unknown = audits[id];
  if (!isObject(auditUnknown)) {
    return undefined;
  }
  return auditUnknown as LhrAudit;
}

function toDetails(value: unknown): LhrAuditDetails | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  return value as LhrAuditDetails;
}

function extractRedirectChain(audit: DiagnosticsLiteAudit | undefined): ComboHints["redirects"] | undefined {
  if (!audit?.details) {
    return undefined;
  }
  const overallSavingsMs: number | undefined = toNumber(audit.details.overallSavingsMs);
  const items: readonly Record<string, unknown>[] = Array.isArray(audit.details.items) ? audit.details.items : [];
  const urls: string[] = [];
  for (const item of items.slice(0, MAX_HINT_ITEMS)) {
    const url: string | undefined = toString(item["url"]);
    if (url) {
      urls.push(url);
    }
  }
  return overallSavingsMs === undefined && urls.length === 0 ? undefined : { overallSavingsMs, chain: urls.length > 0 ? urls : undefined };
}

function extractUnusedJs(audit: DiagnosticsLiteAudit | undefined): ComboHints["unusedJavascript"] | undefined {
  if (!audit?.details) {
    return undefined;
  }
  const overallSavingsMs: number | undefined = toNumber(audit.details.overallSavingsMs);
  const overallSavingsBytes: number | undefined = toNumber(audit.details.overallSavingsBytes);
  const items: readonly Record<string, unknown>[] = Array.isArray(audit.details.items) ? audit.details.items : [];
  const files = items
    .map((item) => {
      const url: string | undefined = toString(item["url"]);
      if (!url) {
        return undefined;
      }
      return {
        url,
        totalBytes: toNumber(item["totalBytes"]),
        wastedBytes: toNumber(item["wastedBytes"]),
        wastedPercent: toNumber(item["wastedPercent"]),
      };
    })
    .filter((v): v is NonNullable<typeof v> => v !== undefined)
    .sort((a, b) => (b.wastedBytes ?? 0) - (a.wastedBytes ?? 0))
    .slice(0, MAX_HINT_ITEMS);
  if (overallSavingsMs === undefined && overallSavingsBytes === undefined && files.length === 0) {
    return undefined;
  }
  return {
    overallSavingsMs,
    overallSavingsBytes,
    files,
  };
}

function extractLegacyJsFromLite(audit: DiagnosticsLiteAudit | undefined): ComboHints["legacyJavascript"] | undefined {
  if (!audit?.details) {
    return undefined;
  }
  const overallSavingsBytes: number | undefined = toNumber(audit.details.overallSavingsBytes);
  const items: readonly Record<string, unknown>[] = Array.isArray(audit.details.items) ? audit.details.items : [];
  const polyfills = items
    .map((item) => {
      const url: string | undefined = toString(item["url"]);
      if (!url) {
        return undefined;
      }
      return { url, wastedBytes: toNumber(item["wastedBytes"]) };
    })
    .filter((v): v is NonNullable<typeof v> => v !== undefined)
    .sort((a, b) => (b.wastedBytes ?? 0) - (a.wastedBytes ?? 0))
    .slice(0, MAX_HINT_ITEMS);
  const totalWastedBytes: number = polyfills.reduce((acc, x) => acc + Math.max(0, Math.floor(x.wastedBytes ?? 0)), 0);
  if (overallSavingsBytes === undefined && polyfills.length === 0) {
    return undefined;
  }
  return { overallSavingsBytes, totalWastedBytes: totalWastedBytes > 0 ? totalWastedBytes : undefined, polyfills };
}

function extractRenderBlockingFromLite(audit: DiagnosticsLiteAudit | undefined): ComboHints["renderBlockingResources"] | undefined {
  if (!audit?.details) {
    return undefined;
  }
  const overallSavingsMs: number | undefined = toNumber(audit.details.overallSavingsMs);
  const items: readonly Record<string, unknown>[] = Array.isArray(audit.details.items) ? audit.details.items : [];
  const resources = items
    .map((item) => {
      const url: string | undefined = toString(item["url"]);
      if (!url) {
        return undefined;
      }
      return {
        url,
        totalBytes: toNumber(item["totalBytes"]),
        wastedMs: toNumber(item["wastedMs"]),
      };
    })
    .filter((v): v is NonNullable<typeof v> => v !== undefined)
    .slice(0, MAX_HINT_ITEMS);
  if (overallSavingsMs === undefined && resources.length === 0) {
    return undefined;
  }
  return { overallSavingsMs, resources };
}

function extractLcpPhasesFromLite(audit: DiagnosticsLiteAudit | undefined): ComboHints["lcpPhases"] | undefined {
  if (!audit?.details) {
    return undefined;
  }
  const items: readonly Record<string, unknown>[] = Array.isArray(audit.details.items) ? audit.details.items : [];
  const first: Record<string, unknown> | undefined = items.length > 0 ? items[0] : undefined;
  if (!first) {
    return undefined;
  }
  const ttfbMs: number | undefined = toNumber(first["ttfb"]);
  const loadDelayMs: number | undefined = toNumber(first["loadDelay"]);
  const loadTimeMs: number | undefined = toNumber(first["loadTime"]);
  const renderDelayMs: number | undefined = toNumber(first["renderDelay"]);
  if (ttfbMs === undefined && loadDelayMs === undefined && loadTimeMs === undefined && renderDelayMs === undefined) {
    return undefined;
  }
  return { ttfbMs, loadDelayMs, loadTimeMs, renderDelayMs };
}

function extractLcpElementFromLite(audit: DiagnosticsLiteAudit | undefined): ComboHints["lcpElement"] | undefined {
  if (!audit?.details) {
    return undefined;
  }
  const items: readonly Record<string, unknown>[] = Array.isArray(audit.details.items) ? audit.details.items : [];
  const first: Record<string, unknown> | undefined = items.length > 0 ? items[0] : undefined;
  if (!first) {
    return undefined;
  }
  const snippet: string | undefined = toString(first["snippet"]);
  const selector: string | undefined = toString(first["selector"]);
  const nodeLabel: string | undefined = toString(first["nodeLabel"]);
  if (snippet === undefined && selector === undefined && nodeLabel === undefined) {
    return undefined;
  }
  return { snippet, selector, nodeLabel };
}

function extractLcpElementFromLhr(lhr: LhrLike): ComboHints["lcpElement"] | undefined {
  const audit: LhrAudit | undefined = getLhrAudit(lhr, "largest-contentful-paint-element");
  const details: LhrAuditDetails | undefined = toDetails(audit?.details);
  const itemsUnknown: unknown = details?.items;
  if (!Array.isArray(itemsUnknown) || itemsUnknown.length === 0) {
    return undefined;
  }
  const firstUnknown: unknown = itemsUnknown[0];
  if (!isObject(firstUnknown)) {
    return undefined;
  }
  const snippet: string | undefined = typeof firstUnknown["snippet"] === "string" ? (firstUnknown["snippet"] as string) : undefined;
  const selector: string | undefined = typeof firstUnknown["selector"] === "string" ? (firstUnknown["selector"] as string) : undefined;
  const nodeUnknown: unknown = firstUnknown["node"];
  const nodeLabel: string | undefined = isObject(nodeUnknown) && typeof nodeUnknown["nodeLabel"] === "string" ? (nodeUnknown["nodeLabel"] as string) : undefined;
  if (snippet === undefined && selector === undefined && nodeLabel === undefined) {
    return undefined;
  }
  return { snippet, selector, nodeLabel };
}

function extractLcpPhasesFromLhr(lhr: LhrLike): ComboHints["lcpPhases"] | undefined {
  const audit: LhrAudit | undefined = getLhrAudit(lhr, "lcp-phases");
  const details: LhrAuditDetails | undefined = toDetails(audit?.details);
  const itemsUnknown: unknown = details?.items;
  if (!Array.isArray(itemsUnknown) || itemsUnknown.length === 0) {
    return undefined;
  }
  const firstUnknown: unknown = itemsUnknown[0];
  if (!isObject(firstUnknown)) {
    return undefined;
  }
  const ttfbMs: number | undefined = toNumber(firstUnknown["ttfb"]);
  const loadDelayMs: number | undefined = toNumber(firstUnknown["loadDelay"]);
  const loadTimeMs: number | undefined = toNumber(firstUnknown["loadTime"]);
  const renderDelayMs: number | undefined = toNumber(firstUnknown["renderDelay"]);
  if (ttfbMs === undefined && loadDelayMs === undefined && loadTimeMs === undefined && renderDelayMs === undefined) {
    return undefined;
  }
  return { ttfbMs, loadDelayMs, loadTimeMs, renderDelayMs };
}

function extractLegacyJsFromLhr(lhr: LhrLike): ComboHints["legacyJavascript"] | undefined {
  const audit: LhrAudit | undefined = getLhrAudit(lhr, "legacy-javascript");
  const details: LhrAuditDetails | undefined = toDetails(audit?.details);
  const itemsUnknown: unknown = details?.items;
  const overallSavingsBytes: number | undefined = toNumber(details?.overallSavingsBytes) ?? toNumber(audit?.numericValue);
  if (!Array.isArray(itemsUnknown)) {
    return overallSavingsBytes === undefined ? undefined : { overallSavingsBytes, polyfills: [] };
  }
  const polyfills = itemsUnknown
    .map((item) => {
      if (!isObject(item)) {
        return undefined;
      }
      const url: string | undefined = typeof item["url"] === "string" ? (item["url"] as string) : undefined;
      if (!url) {
        return undefined;
      }
      return { url, wastedBytes: toNumber(item["wastedBytes"]) };
    })
    .filter((v): v is NonNullable<typeof v> => v !== undefined)
    .sort((a, b) => (b.wastedBytes ?? 0) - (a.wastedBytes ?? 0))
    .slice(0, MAX_HINT_ITEMS);
  const totalWastedBytes: number = polyfills.reduce((acc, x) => acc + Math.max(0, Math.floor(x.wastedBytes ?? 0)), 0);
  if (overallSavingsBytes === undefined && polyfills.length === 0) {
    return undefined;
  }
  return { overallSavingsBytes, totalWastedBytes: totalWastedBytes > 0 ? totalWastedBytes : undefined, polyfills };
}

function extractRenderBlockingFromLhr(lhr: LhrLike): ComboHints["renderBlockingResources"] | undefined {
  const audit: LhrAudit | undefined = getLhrAudit(lhr, "render-blocking-resources");
  const details: LhrAuditDetails | undefined = toDetails(audit?.details);
  const overallSavingsMs: number | undefined = toNumber(details?.overallSavingsMs);
  const itemsUnknown: unknown = details?.items;
  if (!Array.isArray(itemsUnknown)) {
    return overallSavingsMs === undefined ? undefined : { overallSavingsMs, resources: [] };
  }
  const resources = itemsUnknown
    .map((item) => {
      if (!isObject(item)) {
        return undefined;
      }
      const url: string | undefined = typeof item["url"] === "string" ? (item["url"] as string) : undefined;
      if (!url) {
        return undefined;
      }
      return { url, totalBytes: toNumber(item["totalBytes"]), wastedMs: toNumber(item["wastedMs"]) };
    })
    .filter((v): v is NonNullable<typeof v> => v !== undefined)
    .slice(0, MAX_HINT_ITEMS);
  if (overallSavingsMs === undefined && resources.length === 0) {
    return undefined;
  }
  return { overallSavingsMs, resources };
}

type CriticalRequestNode = {
  readonly request?: { readonly url?: unknown; readonly startTime?: unknown; readonly endTime?: unknown; readonly transferSize?: unknown };
  readonly children?: unknown;
};

function flattenCriticalChain(node: CriticalRequestNode | undefined, out: { url: string; transferSize?: number; startTimeMs?: number; endTimeMs?: number }[]): void {
  if (!node || !isObject(node.request)) {
    return;
  }
  const url: string | undefined = typeof node.request.url === "string" ? (node.request.url as string) : undefined;
  if (url) {
    out.push({
      url,
      transferSize: toNumber(node.request.transferSize),
      startTimeMs: toNumber(node.request.startTime),
      endTimeMs: toNumber(node.request.endTime),
    });
  }
  if (!Array.isArray(node.children)) {
    return;
  }
  for (const child of node.children) {
    if (!isObject(child)) {
      continue;
    }
    flattenCriticalChain(child as CriticalRequestNode, out);
  }
}

function extractCriticalChainsFromLhr(lhr: LhrLike): ComboHints["criticalRequestChains"] | undefined {
  const audit: LhrAudit | undefined = getLhrAudit(lhr, "critical-request-chains");
  const details: LhrAuditDetails | undefined = toDetails(audit?.details);
  const longestChainUnknown: unknown = details?.longestChain;
  if (!isObject(longestChainUnknown)) {
    return undefined;
  }
  const chain: { url: string; transferSize?: number; startTimeMs?: number; endTimeMs?: number }[] = [];
  flattenCriticalChain(longestChainUnknown as CriticalRequestNode, chain);
  const bounded = chain.slice(0, MAX_HINT_ITEMS);
  const first = bounded[0];
  const last = bounded.length > 0 ? bounded[bounded.length - 1] : undefined;
  const duration = first?.startTimeMs !== undefined && last?.endTimeMs !== undefined ? Math.max(0, last.endTimeMs - first.startTimeMs) : undefined;
  if (bounded.length === 0 && duration === undefined) {
    return undefined;
  }
  return { longestChainDurationMs: duration, chain: bounded };
}

function extractTotalByteWeight(audit: DiagnosticsLiteAudit | undefined): ComboHints["totalByteWeight"] | undefined {
  if (!audit?.details) {
    return undefined;
  }
  const totalBytes: number | undefined = toNumber(audit.numericValue);
  const items: readonly Record<string, unknown>[] = Array.isArray(audit.details.items) ? audit.details.items : [];
  const topResources = items
    .map((item) => {
      const url: string | undefined = toString(item["url"]);
      if (!url) {
        return undefined;
      }
      return { url, totalBytes: toNumber(item["totalBytes"]) };
    })
    .filter((v): v is NonNullable<typeof v> => v !== undefined)
    .sort((a, b) => (b.totalBytes ?? 0) - (a.totalBytes ?? 0))
    .slice(0, MAX_HINT_ITEMS);
  return totalBytes === undefined && topResources.length === 0 ? undefined : { totalBytes, topResources };
}

function extractBfCache(audit: DiagnosticsLiteAudit | undefined): ComboHints["bfCache"] | undefined {
  if (!audit?.details) {
    return undefined;
  }
  const items: readonly Record<string, unknown>[] = Array.isArray(audit.details.items) ? audit.details.items : [];
  const reasons: string[] = [];
  for (const item of items.slice(0, MAX_HINT_ITEMS)) {
    const reason: string | undefined = toString(item["reason"]);
    if (reason) {
      reasons.push(reason);
    }
  }
  return reasons.length === 0 ? undefined : { reasons };
}

function buildHintsFromDiagnosticsLite(lite: DiagnosticsLiteFile): ComboHints | undefined {
  const redirects: ComboHints["redirects"] | undefined = extractRedirectChain(getAudit(lite, "redirects"));
  const unusedJavascript: ComboHints["unusedJavascript"] | undefined = extractUnusedJs(getAudit(lite, "unused-javascript"));
  const legacyJavascript: ComboHints["legacyJavascript"] | undefined = extractLegacyJsFromLite(getAudit(lite, "legacy-javascript"));
  const renderBlockingResources: ComboHints["renderBlockingResources"] | undefined = extractRenderBlockingFromLite(getAudit(lite, "render-blocking-resources"));
  const lcpPhases: ComboHints["lcpPhases"] | undefined = extractLcpPhasesFromLite(getAudit(lite, "lcp-phases"));
  const lcpElement: ComboHints["lcpElement"] | undefined = extractLcpElementFromLite(getAudit(lite, "largest-contentful-paint-element"));
  const totalByteWeight: ComboHints["totalByteWeight"] | undefined = extractTotalByteWeight(getAudit(lite, "total-byte-weight"));
  const bfCache: ComboHints["bfCache"] | undefined = extractBfCache(getAudit(lite, "bf-cache"));
  if (!redirects && !unusedJavascript && !legacyJavascript && !renderBlockingResources && !lcpPhases && !lcpElement && !totalByteWeight && !bfCache) {
    return undefined;
  }
  return {
    redirects,
    unusedJavascript,
    legacyJavascript,
    renderBlockingResources,
    lcpPhases,
    lcpElement,
    totalByteWeight,
    bfCache,
  };
}

function mergeHints(params: { readonly fromLite?: ComboHints; readonly fromLhr?: ComboHints }): ComboHints | undefined {
  const lite = params.fromLite;
  const lhr = params.fromLhr;
  const merged: ComboHints = {
    redirects: lhr?.redirects ?? lite?.redirects,
    unusedJavascript: lhr?.unusedJavascript ?? lite?.unusedJavascript,
    legacyJavascript: lhr?.legacyJavascript ?? lite?.legacyJavascript,
    renderBlockingResources: lhr?.renderBlockingResources ?? lite?.renderBlockingResources,
    criticalRequestChains: lhr?.criticalRequestChains ?? lite?.criticalRequestChains,
    lcpPhases: lhr?.lcpPhases ?? lite?.lcpPhases,
    lcpElement: lhr?.lcpElement ?? lite?.lcpElement,
    totalByteWeight: lhr?.totalByteWeight ?? lite?.totalByteWeight,
    bfCache: lhr?.bfCache ?? lite?.bfCache,
  };
  const hasAny: boolean = Boolean(
    merged.redirects ||
      merged.unusedJavascript ||
      merged.legacyJavascript ||
      merged.renderBlockingResources ||
      merged.criticalRequestChains ||
      merged.lcpPhases ||
      merged.lcpElement ||
      merged.totalByteWeight ||
      merged.bfCache,
  );
  return hasAny ? merged : undefined;
}

function buildHintsFromLhrJson(lhrUnknown: unknown): ComboHints | undefined {
  if (!isObject(lhrUnknown)) {
    return undefined;
  }
  const lhr: LhrLike = lhrUnknown as LhrLike;
  const legacyJavascript: ComboHints["legacyJavascript"] | undefined = extractLegacyJsFromLhr(lhr);
  const renderBlockingResources: ComboHints["renderBlockingResources"] | undefined = extractRenderBlockingFromLhr(lhr);
  const criticalRequestChains: ComboHints["criticalRequestChains"] | undefined = extractCriticalChainsFromLhr(lhr);
  const lcpPhases: ComboHints["lcpPhases"] | undefined = extractLcpPhasesFromLhr(lhr);
  const lcpElement: ComboHints["lcpElement"] | undefined = extractLcpElementFromLhr(lhr);
  if (!legacyJavascript && !renderBlockingResources && !criticalRequestChains && !lcpPhases && !lcpElement) {
    return undefined;
  }
  return { legacyJavascript, renderBlockingResources, criticalRequestChains, lcpPhases, lcpElement };
}

async function loadComboHints(params: {
  readonly outputDir: string;
  readonly captureLevel: "diagnostics" | "lhr" | undefined;
  readonly failing: readonly { readonly label: string; readonly path: string; readonly device: ApexDevice; readonly baseName: string }[];
}): Promise<Map<string, { readonly hints?: ComboHints }>> {
  const map: Map<string, { readonly hints?: ComboHints }> = new Map();
  if (params.captureLevel === undefined) {
    return map;
  }
  const diagnosticsLiteDir: string = resolve(params.outputDir, "lighthouse-artifacts", "diagnostics-lite");
  const lhrDir: string = resolve(params.outputDir, "lighthouse-artifacts", "lhr");
  const toRead: readonly { readonly baseName: string }[] = params.failing.slice(0, MAX_HINT_COMBOS).map((f) => ({ baseName: f.baseName }));
  for (const item of toRead) {
    const path: string = resolve(diagnosticsLiteDir, `${item.baseName}.json`);
    try {
      const raw: string = await readFile(path, "utf8");
      const parsed: unknown = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object") {
        continue;
      }
      const lite: DiagnosticsLiteFile = parsed as DiagnosticsLiteFile;
      const fromLite: ComboHints | undefined = buildHintsFromDiagnosticsLite(lite);
      let fromLhr: ComboHints | undefined;
      if (params.captureLevel === "lhr") {
        try {
          const lhrRaw: string = await readFile(resolve(lhrDir, `${item.baseName}.json`), "utf8");
          const lhrParsed: unknown = JSON.parse(lhrRaw) as unknown;
          fromLhr = buildHintsFromLhrJson(lhrParsed);
        } catch {
          fromLhr = undefined;
        }
      }
      const hints: ComboHints | undefined = mergeHints({ fromLite, fromLhr });
      if (hints) {
        map.set(item.baseName, { hints });
      }
    } catch {
      continue;
    }
  }
  return map;
}

async function writeJsonWithOptionalGzip(absolutePath: string, value: unknown, options?: { readonly pretty?: boolean }): Promise<void> {
  const pretty: boolean = options?.pretty !== false;
  const jsonText: string = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  await writeFile(absolutePath, `${jsonText}\n`, "utf8");
  if (Buffer.byteLength(jsonText, "utf8") < GZIP_MIN_BYTES) {
    return;
  }
  const gzPath: string = `${absolutePath}.gz`;
  const gz: Buffer = gzipSync(Buffer.from(jsonText, "utf8"));
  await writeFile(gzPath, gz);
}

function toLiteOpportunity(o: OpportunitySummary): LiteOpportunity {
  return {
    id: o.id,
    title: o.title,
    estimatedSavingsMs: o.estimatedSavingsMs,
    estimatedSavingsBytes: o.estimatedSavingsBytes,
  };
}

function buildSummaryLite(summary: RunSummary): SummaryLite {
  const generatedAt: string = new Date().toISOString();
  const results: SummaryLiteLine[] = summary.results.map((r) => {
    const artifactBaseName: string = buildArtifactBaseName({ label: r.label, path: r.path, device: r.device });
    const topOpportunities: readonly LiteOpportunity[] = r.opportunities.slice(0, 5).map(toLiteOpportunity);
    return {
      label: r.label,
      path: r.path,
      device: r.device,
      scores: {
        performance: r.scores.performance,
        accessibility: r.scores.accessibility,
        bestPractices: r.scores.bestPractices,
        seo: r.scores.seo,
      },
      metrics: {
        lcpMs: r.metrics.lcpMs,
        fcpMs: r.metrics.fcpMs,
        tbtMs: r.metrics.tbtMs,
        cls: r.metrics.cls,
        inpMs: r.metrics.inpMs,
      },
      runtimeErrorMessage: r.runtimeErrorMessage,
      topOpportunities,
      artifactBaseName,
    };
  });
  return { generatedAt, meta: summary.meta, results };
}

function buildIssuesIndex(params: {
  readonly summary: RunSummary;
  readonly outputDir: string;
  readonly captureLevel: "diagnostics" | "lhr" | undefined;
  readonly targetScore: number;
  readonly hintsByBaseName?: ReadonlyMap<string, { readonly hints?: ComboHints }>;
}): IssuesIndex {
  const generatedAt: string = new Date().toISOString();
  const counts = { red: 0, yellow: 0, green: 0, runtimeErrors: 0 };
  const issueAgg: Map<string, { title: string; count: number; totalMs: number }> = new Map();
  type OffenderAgg = {
    readonly issueId: IssueOffenderId;
    readonly title: string;
    offenderKey: string;
    combos: OffenderComboRef[];
  };
  const offenders: Map<string, OffenderAgg> = new Map();
  const failing: {
    readonly label: string;
    readonly path: string;
    readonly device: ApexDevice;
    readonly pageScope?: "public" | "requires-auth";
    readonly performance?: number;
    readonly accessibility?: number;
    readonly bestPractices?: number;
    readonly seo?: number;
    readonly runtimeErrorMessage?: string;
    readonly artifactBaseName: string;
    readonly topOpportunities: readonly LiteOpportunity[];
    readonly artifacts?: IssuesIndex["failing"][number]["artifacts"];
    readonly hints?: IssuesIndex["failing"][number]["hints"];
  }[] = [];
  const scored: readonly PageDeviceSummary[] = params.summary.results.filter(isPublicCombo);
  for (const r of scored) {
    const p: number | undefined = r.scores.performance;
    if (typeof p === "number") {
      if (p >= 90) counts.green += 1;
      else if (p >= 50) counts.yellow += 1;
      else counts.red += 1;
    }
    if (typeof r.runtimeErrorMessage === "string") {
      counts.runtimeErrors += 1;
    }
    for (const o of r.opportunities) {
      const prev = issueAgg.get(o.id);
      const ms: number = typeof o.estimatedSavingsMs === "number" ? o.estimatedSavingsMs : 0;
      if (!prev) {
        issueAgg.set(o.id, { title: o.title, count: 1, totalMs: ms });
      } else {
        issueAgg.set(o.id, { title: prev.title, count: prev.count + 1, totalMs: prev.totalMs + ms });
      }
    }
    const scores: readonly number[] = [r.scores.performance, r.scores.accessibility, r.scores.bestPractices, r.scores.seo].filter(
      (v): v is number => typeof v === "number",
    );
    const isFailing: boolean = scores.some((v) => v < params.targetScore) || typeof r.runtimeErrorMessage === "string";
    if (isFailing) {
      const baseName: string = buildArtifactBaseName({ label: r.label, path: r.path, device: r.device });
      const screenshotsDir: string = resolve(params.outputDir, "screenshots");
      const diagnosticsDir: string = resolve(params.outputDir, "lighthouse-artifacts", "diagnostics");
      const diagnosticsLiteDir: string = resolve(params.outputDir, "lighthouse-artifacts", "diagnostics-lite");
      const lhrDir: string = resolve(params.outputDir, "lighthouse-artifacts", "lhr");
      const diagnosticsRel: string = join("lighthouse-artifacts", "diagnostics", `${baseName}.json`);
      const diagnosticsLiteRel: string = join("lighthouse-artifacts", "diagnostics-lite", `${baseName}.json`);
      const lhrRel: string = join("lighthouse-artifacts", "lhr", `${baseName}.json`);
      const artifacts =
        params.captureLevel === undefined
          ? undefined
          : {
              screenshotsDir,
              screenshotBaseName: baseName,
              diagnosticsPath: resolve(diagnosticsDir, `${baseName}.json`),
              diagnosticsRelPath: diagnosticsRel,
              diagnosticsLitePath: resolve(diagnosticsLiteDir, `${baseName}.json`),
              diagnosticsLiteRelPath: diagnosticsLiteRel,
              lhrPath: params.captureLevel === "lhr" ? resolve(lhrDir, `${baseName}.json`) : undefined,
              lhrRelPath: params.captureLevel === "lhr" ? lhrRel : undefined,
            };
      const hints: ComboHints | undefined = params.hintsByBaseName?.get(baseName)?.hints;
      if (hints !== undefined) {
        const unused = hints.unusedJavascript;
        if (unused && unused.files.length > 0) {
          for (const file of unused.files) {
            const key: string = `unused-javascript|${normalizeUrlKey(file.url)}`;
            const existing: OffenderAgg | undefined = offenders.get(key);
            const comboRef: OffenderComboRef = buildOffenderComboRef({
              combo: r,
              artifacts,
              issuesPointer: buildIssuesPointerForCombo({ label: r.label, path: r.path, device: r.device }, "hints.unusedJavascript"),
              diagnosticsLitePointer: artifacts?.diagnosticsLiteRelPath ? buildDiagnosticsLiteAuditPointer({ auditId: "unused-javascript", itemUrl: file.url }) : undefined,
            });
            if (!existing) {
              offenders.set(key, { issueId: "unused-javascript", title: "Reduce unused JavaScript", offenderKey: file.url, combos: [comboRef] });
            } else {
              existing.combos.push(comboRef);
            }
          }
        }
        const legacy = hints.legacyJavascript;
        if (legacy && legacy.polyfills.length > 0) {
          for (const polyfill of legacy.polyfills) {
            const key: string = `legacy-javascript|${normalizeUrlKey(polyfill.url)}`;
            const existing: OffenderAgg | undefined = offenders.get(key);
            const comboRef: OffenderComboRef = buildOffenderComboRef({
              combo: r,
              artifacts,
              issuesPointer: buildIssuesPointerForCombo({ label: r.label, path: r.path, device: r.device }, "hints.legacyJavascript"),
              diagnosticsLitePointer: artifacts?.diagnosticsLiteRelPath ? buildDiagnosticsLiteAuditPointer({ auditId: "legacy-javascript", itemUrl: polyfill.url }) : undefined,
            });
            if (!existing) {
              offenders.set(key, { issueId: "legacy-javascript", title: "Avoid serving legacy JavaScript to modern browsers", offenderKey: polyfill.url, combos: [comboRef] });
            } else {
              existing.combos.push(comboRef);
            }
          }
        }
        const rbr = hints.renderBlockingResources;
        if (rbr && rbr.resources.length > 0) {
          for (const resource of rbr.resources) {
            const key: string = `render-blocking-resources|${normalizeUrlKey(resource.url)}`;
            const existing: OffenderAgg | undefined = offenders.get(key);
            const comboRef: OffenderComboRef = buildOffenderComboRef({
              combo: r,
              artifacts,
              issuesPointer: buildIssuesPointerForCombo({ label: r.label, path: r.path, device: r.device }, "hints.renderBlockingResources"),
              diagnosticsLitePointer: artifacts?.diagnosticsLiteRelPath ? buildDiagnosticsLiteAuditPointer({ auditId: "render-blocking-resources", itemUrl: resource.url }) : undefined,
            });
            if (!existing) {
              offenders.set(key, { issueId: "render-blocking-resources", title: "Eliminate render-blocking resources", offenderKey: resource.url, combos: [comboRef] });
            } else {
              existing.combos.push(comboRef);
            }
          }
        }
        const lcpPhases = hints.lcpPhases;
        if (lcpPhases && Object.values(lcpPhases).some((v) => typeof v === "number" && v > 0)) {
          const key: string = `lcp-phases|${r.path}|${r.device}`;
          const existing: OffenderAgg | undefined = offenders.get(key);
          const comboRef: OffenderComboRef = buildOffenderComboRef({
            combo: r,
            artifacts,
            issuesPointer: buildIssuesPointerForCombo({ label: r.label, path: r.path, device: r.device }, "hints.lcpPhases"),
            diagnosticsLitePointer: artifacts?.diagnosticsLiteRelPath ? buildDiagnosticsLiteAuditPointer({ auditId: "lcp-phases" }) : undefined,
          });
          if (!existing) {
            offenders.set(key, { issueId: "lcp-phases", title: "LCP breakdown", offenderKey: `${r.path} [${r.device}]`, combos: [comboRef] });
          } else {
            existing.combos.push(comboRef);
          }
        }
        const lcpElement = hints.lcpElement;
        if (lcpElement && (typeof lcpElement.selector === "string" || typeof lcpElement.snippet === "string")) {
          const excerpt: string = lcpElement.selector ?? lcpElement.snippet ?? "(unknown)";
          const key: string = `largest-contentful-paint-element|${r.path}|${r.device}|${excerpt.slice(0, 200)}`;
          const existing: OffenderAgg | undefined = offenders.get(key);
          const comboRef: OffenderComboRef = buildOffenderComboRef({
            combo: r,
            artifacts,
            issuesPointer: buildIssuesPointerForCombo({ label: r.label, path: r.path, device: r.device }, "hints.lcpElement"),
            diagnosticsLitePointer: artifacts?.diagnosticsLiteRelPath ? buildDiagnosticsLiteAuditPointer({ auditId: "largest-contentful-paint-element" }) : undefined,
          });
          if (!existing) {
            offenders.set(key, { issueId: "largest-contentful-paint-element", title: "Largest Contentful Paint element", offenderKey: excerpt, combos: [comboRef] });
          } else {
            existing.combos.push(comboRef);
          }
        }
        const bfCache = hints.bfCache;
        if (bfCache && bfCache.reasons.length > 0) {
          const reasonKey: string = bfCache.reasons.join(" | ");
          const key: string = `bf-cache|${r.path}|${r.device}|${reasonKey.slice(0, 200)}`;
          const existing: OffenderAgg | undefined = offenders.get(key);
          const comboRef: OffenderComboRef = buildOffenderComboRef({
            combo: r,
            artifacts,
            issuesPointer: buildIssuesPointerForCombo({ label: r.label, path: r.path, device: r.device }, "hints.bfCache"),
            diagnosticsLitePointer: artifacts?.diagnosticsLiteRelPath ? buildDiagnosticsLiteAuditPointer({ auditId: "bf-cache" }) : undefined,
          });
          if (!existing) {
            offenders.set(key, { issueId: "bf-cache", title: "Page prevented back/forward cache restoration", offenderKey: reasonKey, combos: [comboRef] });
          } else {
            existing.combos.push(comboRef);
          }
        }
      }
      failing.push({
        label: r.label,
        path: r.path,
        device: r.device,
        pageScope: r.pageScope,
        performance: r.scores.performance,
        accessibility: r.scores.accessibility,
        bestPractices: r.scores.bestPractices,
        seo: r.scores.seo,
        runtimeErrorMessage: r.runtimeErrorMessage,
        artifactBaseName: baseName,
        topOpportunities: r.opportunities.slice(0, 5).map(toLiteOpportunity),
        artifacts,
        hints,
      });
    }
  }
  failing.sort((a: (typeof failing)[number], b: (typeof failing)[number]) => (a.performance ?? 101) - (b.performance ?? 101));
  const topIssues: IssuesIndex["topIssues"] = [...issueAgg.entries()]
    .map(([id, v]) => ({ id, title: v.title, count: v.count, totalMs: Math.round(v.totalMs) }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, 20);
  const offendersList: IssuesIndex["offenders"] = [...offenders.values()]
    .map((o) => {
      const uniqueCombos: OffenderComboRef[] = o.combos.reduce((acc, c) => {
        const key: string = `${c.label}|${c.path}|${c.device}`;
        if (acc.some((x) => `${x.label}|${x.path}|${x.device}` === key)) {
          return acc;
        }
        return [...acc, c];
      }, [] as OffenderComboRef[]);
      return {
        issueId: o.issueId,
        title: o.title,
        offenderKey: o.offenderKey,
        affectedCombos: uniqueCombos.length,
        combos: uniqueCombos,
      };
    })
    .sort((a, b) => b.affectedCombos - a.affectedCombos)
    .slice(0, 100);
  return {
    generatedAt,
    targetScore: params.targetScore,
    totals: {
      combos: scored.length,
      redCombos: counts.red,
      yellowCombos: counts.yellow,
      greenCombos: counts.green,
      runtimeErrors: counts.runtimeErrors,
    },
    topIssues,
    offenders: offendersList,
    failing,
  };
}

type AuditPlanCategory = "performance" | "accessibility" | "best-practices" | "seo";

interface AuditPlanWorkstream {
  readonly id: string;
  readonly category: AuditPlanCategory;
  readonly title: string;
  readonly rationale: string;
  readonly affectedCombos: readonly {
    readonly label: string;
    readonly path: string;
    readonly device: ApexDevice;
    readonly artifactBaseName: string;
    readonly scores: {
      readonly performance?: number;
      readonly accessibility?: number;
      readonly bestPractices?: number;
      readonly seo?: number;
    };
    readonly metrics: {
      readonly lcpMs?: number;
      readonly tbtMs?: number;
      readonly cls?: number;
      readonly inpMs?: number;
    };
    readonly runtimeErrorMessage?: string;
  }[];
  readonly expectedImpact: {
    readonly scoreUplift: "high" | "medium" | "low";
    readonly primarySignals: readonly string[];
  };
  readonly nextCommands: readonly string[];
  readonly acceptanceCriteria: readonly string[];
}

interface AuditPlan {
  readonly generatedAt: string;
  readonly meta: RunSummary["meta"];
  readonly targetScore: number;
  readonly totals: IssuesIndex["totals"];
  readonly topIssues: IssuesIndex["topIssues"];
  readonly workstreams: readonly AuditPlanWorkstream[];
}

function buildPlanJson(params: { readonly summary: RunSummary; readonly issues: IssuesIndex; readonly targetScore: number }): AuditPlan {
  const generatedAt: string = new Date().toISOString();
  const combosBelowTarget = (category: AuditPlanCategory): readonly PageDeviceSummary[] => {
    if (category === "performance") {
      return params.summary.results.filter((r) => (r.scores.performance ?? 101) < params.targetScore || typeof r.runtimeErrorMessage === "string");
    }
    if (category === "accessibility") {
      return params.summary.results.filter((r) => (r.scores.accessibility ?? 101) < params.targetScore || typeof r.runtimeErrorMessage === "string");
    }
    if (category === "best-practices") {
      return params.summary.results.filter((r) => (r.scores.bestPractices ?? 101) < params.targetScore || typeof r.runtimeErrorMessage === "string");
    }
    return params.summary.results.filter((r) => (r.scores.seo ?? 101) < params.targetScore || typeof r.runtimeErrorMessage === "string");
  };
  const toAffectedCombo = (r: PageDeviceSummary): AuditPlanWorkstream["affectedCombos"][number] => {
    const artifactBaseName: string = buildArtifactBaseName({ label: r.label, path: r.path, device: r.device });
    return {
      label: r.label,
      path: r.path,
      device: r.device,
      artifactBaseName,
      scores: {
        performance: r.scores.performance,
        accessibility: r.scores.accessibility,
        bestPractices: r.scores.bestPractices,
        seo: r.scores.seo,
      },
      metrics: {
        lcpMs: r.metrics.lcpMs,
        tbtMs: r.metrics.tbtMs,
        cls: r.metrics.cls,
        inpMs: r.metrics.inpMs,
      },
      runtimeErrorMessage: r.runtimeErrorMessage,
    };
  };
  const perfCombos: readonly PageDeviceSummary[] = combosBelowTarget("performance");
  const a11yCombos: readonly PageDeviceSummary[] = combosBelowTarget("accessibility");
  const bpCombos: readonly PageDeviceSummary[] = combosBelowTarget("best-practices");
  const seoCombos: readonly PageDeviceSummary[] = combosBelowTarget("seo");
  const workstreams: AuditPlanWorkstream[] = [];
  if (perfCombos.length > 0) {
    workstreams.push({
      id: "performance-top-opportunities",
      category: "performance",
      title: "Performance: attack the top Lighthouse opportunities",
      rationale: "Most performance wins come from fixing the highest-frequency / highest-savings Lighthouse opportunities across failing pages.",
      affectedCombos: [...perfCombos]
        .sort((a: PageDeviceSummary, b: PageDeviceSummary) => (a.scores.performance ?? 101) - (b.scores.performance ?? 101))
        .slice(0, 20)
        .map(toAffectedCombo),
      expectedImpact: { scoreUplift: "high", primarySignals: ["performance score", "LCP", "TBT", "INP", "CLS"] },
      nextCommands: [
        "apex-auditor audit --diagnostics --stable",
        "apex-auditor audit --diagnostics --throttling devtools --stable",
      ],
      acceptanceCriteria: [
        `The worst combos reach ${params.targetScore}+ performance score (or show a clear upward trend).`,
        "Top offending opportunities shrink in frequency and estimated savings.",
      ],
    });
  }
  if (a11yCombos.length > 0) {
    workstreams.push({
      id: "accessibility-fix-below-target",
      category: "accessibility",
      title: "Accessibility: raise below-target pages",
      rationale: "Accessibility issues tend to be systematic and repeat across pages; fixing a few components can lift many routes.",
      affectedCombos: [...a11yCombos]
        .sort((a: PageDeviceSummary, b: PageDeviceSummary) => (a.scores.accessibility ?? 101) - (b.scores.accessibility ?? 101))
        .slice(0, 20)
        .map(toAffectedCombo),
      expectedImpact: { scoreUplift: "medium", primarySignals: ["accessibility score"] },
      nextCommands: ["apex-auditor audit --stable"],
      acceptanceCriteria: [`All combos reach ${params.targetScore}+ accessibility score.`],
    });
  }
  if (bpCombos.length > 0) {
    workstreams.push({
      id: "best-practices-fix-below-target",
      category: "best-practices",
      title: "Best Practices: raise below-target pages",
      rationale: "Best Practices failures usually point to a small set of security / correctness issues that are easy to fix once.",
      affectedCombos: [...bpCombos]
        .sort((a: PageDeviceSummary, b: PageDeviceSummary) => (a.scores.bestPractices ?? 101) - (b.scores.bestPractices ?? 101))
        .slice(0, 20)
        .map(toAffectedCombo),
      expectedImpact: { scoreUplift: "low", primarySignals: ["best-practices score"] },
      nextCommands: ["apex-auditor audit --stable"],
      acceptanceCriteria: [`All combos reach ${params.targetScore}+ best practices score.`],
    });
  }
  if (seoCombos.length > 0) {
    workstreams.push({
      id: "seo-fix-below-target",
      category: "seo",
      title: "SEO: raise below-target pages",
      rationale: "SEO score gaps are commonly caused by missing meta tags or indexing/canonical issues; fixing templates often resolves many pages.",
      affectedCombos: [...seoCombos]
        .sort((a: PageDeviceSummary, b: PageDeviceSummary) => (a.scores.seo ?? 101) - (b.scores.seo ?? 101))
        .slice(0, 20)
        .map(toAffectedCombo),
      expectedImpact: { scoreUplift: "low", primarySignals: ["seo score"] },
      nextCommands: ["apex-auditor audit --stable"],
      acceptanceCriteria: [`All combos reach ${params.targetScore}+ SEO score.`],
    });
  }
  return {
    generatedAt,
    meta: params.summary.meta,
    targetScore: params.targetScore,
    totals: params.issues.totals,
    topIssues: params.issues.topIssues,
    workstreams,
  };
}

function buildOverviewMarkdown(params: {
  readonly summary: RunSummary;
  readonly previousSummary: RunSummary | undefined;
  readonly issues: IssuesIndex;
  readonly outputDir: string;
  readonly reportPath: string;
  readonly exportPath: string;
  readonly triagePath: string;
  readonly planPath: string;
  readonly captureLevel: "diagnostics" | "lhr" | undefined;
  readonly targetScore: number;
  readonly includeAiFix: boolean;
  readonly includeExport: boolean;
}): string {
  const lines: string[] = [];
  const meta: RunSummary["meta"] = params.summary.meta;
  const runtime: RuntimeMeta = buildRuntimeMeta({
    config: {
      baseUrl: "",
      pages: [],
      throttlingMethod: meta.throttlingMethod,
      cpuSlowdownMultiplier: meta.cpuSlowdownMultiplier,
      parallel: meta.resolvedParallel,
      runs: meta.runsPerCombo,
      warmUp: meta.warmUp,
      chromePort: undefined,
    },
    captureLevel: params.captureLevel,
    chromePort: undefined,
  });
  const results: readonly PageDeviceSummary[] = params.summary.results.filter(isPublicCombo);
  const worstPerf: readonly PageDeviceSummary[] = [...results].sort((a, b) => (a.scores.performance ?? 101) - (b.scores.performance ?? 101)).slice(0, 10);
  const worstA11y: readonly PageDeviceSummary[] = [...results].sort((a, b) => (a.scores.accessibility ?? 101) - (b.scores.accessibility ?? 101)).slice(0, 10);
  const worstBp: readonly PageDeviceSummary[] = [...results].sort((a, b) => (a.scores.bestPractices ?? 101) - (b.scores.bestPractices ?? 101)).slice(0, 10);
  const worstSeo: readonly PageDeviceSummary[] = [...results].sort((a, b) => (a.scores.seo ?? 101) - (b.scores.seo ?? 101)).slice(0, 10);
  const belowTarget = (value: number | undefined): boolean => typeof value === "number" && value < params.targetScore;
  const countBelow = (selector: (r: PageDeviceSummary) => number | undefined): number => results.filter((r) => belowTarget(selector(r)) || typeof r.runtimeErrorMessage === "string").length;
  const pBelow: number = countBelow((r) => r.scores.performance);
  const aBelow: number = countBelow((r) => r.scores.accessibility);
  const bpBelow: number = countBelow((r) => r.scores.bestPractices);
  const seoBelow: number = countBelow((r) => r.scores.seo);
  lines.push("# ApexAuditor overview");
  lines.push("");
  lines.push(`Generated: ${meta.completedAt}`);
  lines.push("");
  lines.push("## Key files");
  lines.push("");
  lines.push(`- Overview: ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: resolve(params.outputDir, "overview.md"), label: "overview.md" })}`);
  lines.push(`- Triage: ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: params.triagePath, label: "triage.md" })}`);
  lines.push(`- Plan (JSON): ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: params.planPath, label: "plan.json" })}`);
  lines.push(`- Report: ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: params.reportPath, label: "report.html" })}`);
  lines.push(`- Issues (JSON): ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: resolve(params.outputDir, "issues.json"), label: "issues.json" })}`);
  lines.push(`- AI ledger (JSON): ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: resolve(params.outputDir, "ai-ledger.json"), label: "ai-ledger.json" })}`);
  if (params.includeAiFix) {
    lines.push(`- AI fix packet (JSON): ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: resolve(params.outputDir, "ai-fix.json"), label: "ai-fix.json" })}`);
    lines.push(`- AI fix packet (min): ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: resolve(params.outputDir, "ai-fix.min.json"), label: "ai-fix.min.json" })}`);
  }
  lines.push(`- Summary (lite): ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: resolve(params.outputDir, "summary-lite.json"), label: "summary-lite.json" })}`);
  if (params.includeExport) {
    lines.push(`- Export: ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: params.exportPath, label: "export.json" })}`);
  }
  considerCaptureNotes({ captureLevel: params.captureLevel, outputDir: params.outputDir, lines });
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Run settings");
  lines.push("");
  lines.push("```text");
  lines.push(`Build ID: ${meta.buildId ?? "-"}`);
  lines.push(`Incremental: ${meta.incremental ? "yes" : "no"}`);
  lines.push(`Resolved parallel: ${meta.resolvedParallel}`);
  lines.push(`Warm-up: ${meta.warmUp ? "yes" : "no"}`);
  lines.push(`Throttling: ${meta.throttlingMethod}`);
  lines.push(`CPU slowdown: ${meta.cpuSlowdownMultiplier}`);
  lines.push(`Throttling overrides applied: ${runtime.throttlingOverridesApplied ? "yes" : "no"}`);
  lines.push(`Chrome: ${runtime.chrome.mode}${runtime.chrome.headless ? " (headless)" : ""}`);
  lines.push(`Combos: ${meta.comboCount}`);
  lines.push(`Runs per combo: ${meta.runsPerCombo}`);
  lines.push(`Elapsed: ${formatElapsedTime(meta.elapsedMs)}`);
  lines.push("```");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Status");
  lines.push("");
  lines.push("```text");
  lines.push(`Target score: ${params.targetScore}+`);
  lines.push(`Below target — P: ${pBelow} | A: ${aBelow} | BP: ${bpBelow} | SEO: ${seoBelow}`);
  lines.push(`Suite totals — red: ${params.issues.totals.redCombos} | yellow: ${params.issues.totals.yellowCombos} | green: ${params.issues.totals.greenCombos} | runtime errors: ${params.issues.totals.runtimeErrors}`);
  lines.push("```");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Top issues (by total estimated savings)");
  lines.push("");
  if (params.issues.topIssues.length === 0) {
    lines.push("No opportunity issues were aggregated.");
  } else {
    lines.push("| Issue | Count | Total savings (ms) |");
    lines.push("| --- | --- | --- |");
    for (const issue of params.issues.topIssues.slice(0, 10)) {
      lines.push(`| ${escapeMarkdownTableCell(issue.title)} | ${issue.count} | ${issue.totalMs} |`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Worst combos (quick jump)");
  lines.push("");
  lines.push("### Performance");
  lines.push("");
  lines.push(buildWorstTable({ outputDir: params.outputDir, rows: worstPerf }));
  lines.push("");
  lines.push("### Accessibility");
  lines.push("");
  lines.push(buildWorstTable({ outputDir: params.outputDir, rows: worstA11y }));
  lines.push("");
  lines.push("### Best Practices");
  lines.push("");
  lines.push(buildWorstTable({ outputDir: params.outputDir, rows: worstBp }));
  lines.push("");
  lines.push("### SEO");
  lines.push("");
  lines.push(buildWorstTable({ outputDir: params.outputDir, rows: worstSeo }));
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Next runs (fast iteration)");
  lines.push("");
  lines.push("Use this to iterate quickly and keep a high-signal feedback loop. Treat `--stable` as a fallback when parallel mode flakes.");
  lines.push("");
  lines.push("```bash");
  lines.push("# Full sweep (fast feedback)");
  lines.push("apex-auditor audit --diagnostics");
  lines.push("# Focused rerun (high signal)");
  lines.push("# - re-runs only the worst N combos from the previous summary.json");
  lines.push("apex-auditor audit --focus-worst 10 --diagnostics");
  lines.push("# Fallback stability mode (only if parallel flakes)");
  lines.push("apex-auditor audit --stable --diagnostics");
  lines.push("```");
  const prev: RunSummary | undefined = params.previousSummary;
  const prevThrottling: ApexThrottlingMethod | undefined = prev?.meta.throttlingMethod;
  const currThrottling: ApexThrottlingMethod | undefined = meta.throttlingMethod;
  const isComparePair: boolean =
    prev !== undefined &&
    prevThrottling !== undefined &&
    currThrottling !== undefined &&
    prevThrottling !== currThrottling &&
    ((prevThrottling === "simulate" && currThrottling === "devtools") || (prevThrottling === "devtools" && currThrottling === "simulate"));
  if (prev !== undefined && isComparePair) {
    const previous: RunSummary = prev;
    const computeAvg = (items: readonly PageDeviceSummary[]): { readonly performance: number; readonly accessibility: number; readonly bestPractices: number; readonly seo: number } => {
      const sums = items.reduce(
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
    };
    const prevAvg = computeAvg(previous.results);
    const currAvg = computeAvg(results);
    const delta = {
      performance: currAvg.performance - prevAvg.performance,
      accessibility: currAvg.accessibility - prevAvg.accessibility,
      bestPractices: currAvg.bestPractices - prevAvg.bestPractices,
      seo: currAvg.seo - prevAvg.seo,
    };
    const formatDelta = (value: number): string => {
      const sign: string = value > 0 ? "+" : "";
      return `${sign}${value}`;
    };
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("## Compare runs (simulate vs devtools)");
    lines.push("");
    lines.push("```text");
    lines.push(`Previous throttling: ${prevThrottling} | Current throttling: ${currThrottling}`);
    lines.push(`Avg score deltas (current - previous): P ${formatDelta(delta.performance)} | A ${formatDelta(delta.accessibility)} | BP ${formatDelta(delta.bestPractices)} | SEO ${formatDelta(delta.seo)}`);
    lines.push("```");
  }
  return `${lines.join("\n")}\n`;
}

function considerCaptureNotes(params: { readonly captureLevel: "diagnostics" | "lhr" | undefined; readonly outputDir: string; readonly lines: string[] }): void {
  if (params.captureLevel === undefined) {
    return;
  }
  const screenshotsDir: string = resolve(params.outputDir, "screenshots");
  const diagnosticsLiteDir: string = resolve(params.outputDir, "lighthouse-artifacts", "diagnostics-lite");
  params.lines.push(`- Screenshots: ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: screenshotsDir, label: "screenshots/" })}`);
  params.lines.push(`- Diagnostics (lite): ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: diagnosticsLiteDir, label: "lighthouse-artifacts/diagnostics-lite/" })}`);
}

function buildWorstTable(params: { readonly outputDir: string; readonly rows: readonly PageDeviceSummary[] }): string {
  const lines: string[] = [];
  lines.push("| Label | Path | Device | P | A | BP | SEO | Artifacts |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of params.rows) {
    const baseName: string = buildArtifactBaseName({ label: r.label, path: r.path, device: r.device });
    const diagnosticsLitePath: string = resolve(params.outputDir, "lighthouse-artifacts", "diagnostics-lite", `${baseName}.json`);
    const artifactCell: string = toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: diagnosticsLitePath, label: "diagnostics-lite" });
    lines.push(`| ${escapeMarkdownTableCell(r.label)} | \`${escapeMarkdownTableCell(r.path)}\` | ${r.device} | ${formatScore(r.scores.performance)} | ${formatScore(r.scores.accessibility)} | ${formatScore(r.scores.bestPractices)} | ${formatScore(r.scores.seo)} | ${artifactCell} |`);
  }
  return lines.join("\n");
}

function formatScore(value: number | undefined): string {
  return value === undefined ? "-" : String(value);
}

function buildTriageMarkdown(params: {
  readonly summary: RunSummary;
  readonly reportPath: string;
  readonly exportPath: string;
  readonly outputDir: string;
  readonly captureLevel: "diagnostics" | "lhr" | undefined;
  readonly targetScore: number;
  readonly issues?: IssuesIndex;
  readonly includeAiFix: boolean;
  readonly includeExport: boolean;
}): string {
  const lines: string[] = [];
  const scopedResults: readonly PageDeviceSummary[] = params.summary.results.filter(isPublicCombo);
  const worstFirst: readonly PageDeviceSummary[] = [...scopedResults].sort((a, b) => {
    const aP: number = a.scores.performance ?? 101;
    const bP: number = b.scores.performance ?? 101;
    if (aP !== bP) {
      return aP - bP;
    }
    const aMin: number = Math.min(a.scores.accessibility ?? 101, a.scores.bestPractices ?? 101, a.scores.seo ?? 101);
    const bMin: number = Math.min(b.scores.accessibility ?? 101, b.scores.bestPractices ?? 101, b.scores.seo ?? 101);
    return aMin - bMin;
  });
  const failing: readonly PageDeviceSummary[] = worstFirst.filter((r) => {
    const scores: readonly number[] = [r.scores.performance, r.scores.accessibility, r.scores.bestPractices, r.scores.seo].filter(
      (v): v is number => typeof v === "number",
    );
    return scores.some((v) => v < params.targetScore) || typeof r.runtimeErrorMessage === "string";
  });
  const severe: readonly PageDeviceSummary[] = failing.filter((r) => {
    const scores: readonly number[] = [r.scores.performance, r.scores.accessibility, r.scores.bestPractices, r.scores.seo].filter(
      (v): v is number => typeof v === "number",
    );
    return scores.some((v) => v < 50) || typeof r.runtimeErrorMessage === "string";
  });
  const screenshotsDir: string = resolve(params.outputDir, "screenshots");
  const diagnosticsDir: string = resolve(params.outputDir, "lighthouse-artifacts", "diagnostics");
  const diagnosticsLiteDir: string = resolve(params.outputDir, "lighthouse-artifacts", "diagnostics-lite");
  const lhrDir: string = resolve(params.outputDir, "lighthouse-artifacts", "lhr");
  lines.push("# ApexAuditor triage");
  lines.push("");
  lines.push(`Generated: ${params.summary.meta.completedAt}`);
  lines.push("");
  lines.push("This file is optimized for human triage. Start with **Fix first (severe)**, then use **All combos below target** to navigate directly to per-combo artifacts.");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Key files");
  lines.push("");
  lines.push(`- Overview: ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: resolve(params.outputDir, "overview.md"), label: "overview.md" })}`);
  lines.push(`- Plan (JSON): ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: resolve(params.outputDir, "plan.json"), label: "plan.json" })}`);
  lines.push(`- Report: ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: params.reportPath, label: "report.html" })} (\`${params.reportPath}\`)`);
  if (params.includeExport) {
    lines.push(`- Export: ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: params.exportPath, label: "export.json" })} (\`${params.exportPath}\`)`);
  }
  lines.push(`- Summary: ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: resolve(params.outputDir, "summary.json"), label: "summary.json" })}`);
  lines.push(`- Summary (lite): ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: resolve(params.outputDir, "summary-lite.json"), label: "summary-lite.json" })}`);
  lines.push(`- Issues: ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: resolve(params.outputDir, "issues.json"), label: "issues.json" })}`);
  lines.push(`- AI ledger: ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: resolve(params.outputDir, "ai-ledger.json"), label: "ai-ledger.json" })}`);
  if (params.includeAiFix) {
    lines.push(`- AI fix packet: ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: resolve(params.outputDir, "ai-fix.min.json"), label: "ai-fix.min.json" })}`);
  }
  lines.push("");
  if (params.captureLevel !== undefined) {
    lines.push("## Artifacts folders");
    lines.push("");
    lines.push(`- Screenshots: ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: screenshotsDir, label: "screenshots/" })}`);
    lines.push(`- Diagnostics: ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: diagnosticsDir, label: "lighthouse-artifacts/diagnostics/" })}`);
    lines.push(`- Diagnostics (lite): ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: diagnosticsLiteDir, label: "lighthouse-artifacts/diagnostics-lite/" })}`);
    if (params.captureLevel === "lhr") {
      lines.push(`- LHR: ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: lhrDir, label: "lighthouse-artifacts/lhr/" })}`);
    }
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push("## Fix first (severe)");
  lines.push("");
  if (severe.length === 0) {
    lines.push("No severe issues found.");
    lines.push("");
  } else {
    lines.push(`Target: ${params.targetScore}+`);
    lines.push("");
    for (const r of severe.slice(0, 25)) {
      const baseName: string = buildArtifactBaseName({ label: r.label, path: r.path, device: r.device });
      const diagnosticsPath: string = resolve(diagnosticsDir, `${baseName}.json`);
      const diagnosticsLitePath: string = resolve(diagnosticsLiteDir, `${baseName}.json`);
      const lhrPath: string = resolve(lhrDir, `${baseName}.json`);
      const hints: IssuesIndex["failing"][number]["hints"] | undefined = params.issues?.failing.find(
        (x) => x.artifactBaseName === baseName,
      )?.hints;
      lines.push(`### ${escapeMarkdownTableCell(r.label)} \`${escapeMarkdownTableCell(r.path)}\` (${r.device})`);
      lines.push("");
      lines.push(`- Scores: P ${formatScore(r.scores.performance)} | A ${formatScore(r.scores.accessibility)} | BP ${formatScore(r.scores.bestPractices)} | SEO ${formatScore(r.scores.seo)}`);
      if (r.runtimeErrorMessage) {
        lines.push(`- Runtime error: ${escapeMarkdownTableCell(r.runtimeErrorMessage)}`);
      }
      if (params.captureLevel !== undefined) {
        lines.push(`- Diagnostics: ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: diagnosticsPath, label: "diagnostics" })}`);
        lines.push(`- Diagnostics (lite): ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: diagnosticsLitePath, label: "diagnostics-lite" })}`);
      }
      if (params.captureLevel === "lhr") {
        lines.push(`- LHR: ${toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: lhrPath, label: "lhr" })}`);
      }
      lines.push(`- Screenshot: ${params.captureLevel === undefined ? "(not captured)" : `base: \`${baseName}\``}`);
      if (hints?.redirects?.overallSavingsMs !== undefined || (hints?.redirects?.chain && hints.redirects.chain.length > 0)) {
        const savings: string = typeof hints.redirects?.overallSavingsMs === "number" ? ` ~${Math.round(hints.redirects.overallSavingsMs)}ms` : "";
        lines.push(`- Redirects:${savings}`);
        if (hints.redirects?.chain && hints.redirects.chain.length > 0) {
          for (const url of hints.redirects.chain.slice(0, 5)) {
            lines.push(`  - ${url}`);
          }
        }
        lines.push("  - Tip: eliminate redirect chains (canonical/trailing slash/auth middleware) to reduce TTFB + improve LCP.");
      }
      if (hints?.unusedJavascript?.files && hints.unusedJavascript.files.length > 0) {
        lines.push("- Unused JS (top):");
        for (const file of hints.unusedJavascript.files.slice(0, 3)) {
          const wastedKb: string = typeof file.wastedBytes === "number" ? ` wasted~${Math.round(file.wastedBytes / 1024)}KiB` : "";
          const totalKb: string = typeof file.totalBytes === "number" ? ` total~${Math.round(file.totalBytes / 1024)}KiB` : "";
          const pct: string = typeof file.wastedPercent === "number" ? ` (${Math.round(file.wastedPercent)}%)` : "";
          lines.push(`  - ${file.url}${wastedKb}${totalKb}${pct}`);
        }
        lines.push("  - Tip: use route-level code-splitting + dynamic import for admin/auth-only modules.");
      }
      if (hints?.totalByteWeight?.topResources && hints.totalByteWeight.topResources.length > 0) {
        lines.push("- Payload (top):");
        for (const res of hints.totalByteWeight.topResources.slice(0, 3)) {
          const kb: string = typeof res.totalBytes === "number" ? ` ${Math.round(res.totalBytes / 1024)}KiB` : "";
          lines.push(`  - ${res.url}${kb}`);
        }
      }
      if (hints?.bfCache?.reasons && hints.bfCache.reasons.length > 0) {
        lines.push("- BFCache blockers:");
        for (const reason of hints.bfCache.reasons.slice(0, 2)) {
          lines.push(`  - ${reason}`);
        }
      }
      const topOpps: readonly OpportunitySummary[] = r.opportunities.slice(0, 5);
      if (topOpps.length > 0) {
        lines.push("- Top opportunities:");
        for (const o of topOpps) {
          const savingsMs: string = typeof o.estimatedSavingsMs === "number" ? ` ~${Math.round(o.estimatedSavingsMs)}ms` : "";
          const savingsBytes: string = typeof o.estimatedSavingsBytes === "number" ? ` ~${Math.round(o.estimatedSavingsBytes / 1024)}KiB` : "";
          lines.push(`  - ${o.title}${savingsMs}${savingsBytes}`);
        }
      }
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }
  lines.push("## All combos below target");
  lines.push("");
  if (failing.length === 0) {
    lines.push(`All combos meet target ${params.targetScore}+.`);
    lines.push("");
  } else {
    lines.push(`Target: ${params.targetScore}+`);
    lines.push("");
    lines.push("| Label | Path | Device | P | A | BP | SEO | Runtime error | Artifacts |" );
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |" );
    for (const r of failing.slice(0, 200)) {
      const baseName: string = buildArtifactBaseName({ label: r.label, path: r.path, device: r.device });
      const diagnosticsPath: string = resolve(diagnosticsDir, `${baseName}.json`);
      const diagnosticsLitePath: string = resolve(diagnosticsLiteDir, `${baseName}.json`);
      const lhrPath: string = resolve(lhrDir, `${baseName}.json`);
      const screenshotPath: string = params.captureLevel === undefined ? "(not captured)" : `base: \`${baseName}\``;
      const err: string = r.runtimeErrorMessage ? r.runtimeErrorMessage.replace(/\|/g, "\\|") : "";
      const artifactLinks: string[] = [];
      if (params.captureLevel !== undefined) {
        artifactLinks.push(toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: diagnosticsLitePath, label: "diagnostics-lite" }));
        artifactLinks.push(toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: diagnosticsPath, label: "diagnostics" }));
      }
      if (params.captureLevel === "lhr") {
        artifactLinks.push(toRelativeMarkdownLink({ outputDir: params.outputDir, absolutePath: lhrPath, label: "lhr" }));
      }
      if (params.captureLevel !== undefined) {
        artifactLinks.push(screenshotPath);
      }
      lines.push(
        `| ${escapeMarkdownTableCell(r.label)} | \`${escapeMarkdownTableCell(r.path)}\` | ${r.device} | ${formatScore(r.scores.performance)} | ${formatScore(r.scores.accessibility)} | ${formatScore(r.scores.bestPractices)} | ${formatScore(r.scores.seo)} | ${err} | ${artifactLinks.join(" ")} |`,
      );
    }
    lines.push("");
    if (params.captureLevel !== undefined) {
      lines.push("Artifacts links are relative to the `.apex-auditor/` folder, so they are clickable in most Markdown viewers.");
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

async function printArtifactsSummary(params: {
  readonly outputDir: string;
  readonly reportPath: string;
  readonly exportPath: string;
  readonly captureLevel: "diagnostics" | "lhr" | undefined;
}): Promise<void> {
  const screenshotsDir: string = resolve(params.outputDir, "screenshots");
  const diagnosticsDir: string = resolve(params.outputDir, "lighthouse-artifacts", "diagnostics");
  const diagnosticsLiteDir: string = resolve(params.outputDir, "lighthouse-artifacts", "diagnostics-lite");
  const lhrDir: string = resolve(params.outputDir, "lighthouse-artifacts", "lhr");
  const triagePath: string = resolve(params.outputDir, "triage.md");
  const screenshotCount: number = await countFilesInDir(screenshotsDir);
  const diagnosticsCount: number = await countFilesInDir(diagnosticsDir);
  const diagnosticsLiteCount: number = await countFilesInDir(diagnosticsLiteDir);
  const lhrCount: number = params.captureLevel === "lhr" ? await countFilesInDir(lhrDir) : 0;
  const lines: string[] = [];
  const summaryPath: string = resolve(params.outputDir, "summary.json");
  const summaryLitePath: string = resolve(params.outputDir, "summary-lite.json");
  const issuesPath: string = resolve(params.outputDir, "issues.json");
  const overviewPath: string = resolve(params.outputDir, "overview.md");
  const planPath: string = resolve(params.outputDir, "plan.json");
  const measureSummaryLitePath: string = resolve(params.outputDir, "measure-summary-lite.json");
  const gzipSummaryLitePath: string = `${summaryLitePath}.gz`;
  const gzipIssuesPath: string = `${issuesPath}.gz`;
  const gzipPlanPath: string = `${planPath}.gz`;
  const gzipMeasureSummaryLitePath: string = `${measureSummaryLitePath}.gz`;
  const hasSummaryLiteGz: boolean = await fileExists(gzipSummaryLitePath);
  const hasIssuesGz: boolean = await fileExists(gzipIssuesPath);
  const hasPlanGz: boolean = await fileExists(gzipPlanPath);
  const hasMeasureSummaryLiteGz: boolean = await fileExists(gzipMeasureSummaryLitePath);

  lines.push(`Report: ${params.reportPath}`);
  lines.push(`Export: ${params.exportPath}`);
  lines.push(`Triage: ${triagePath}`);
  lines.push(`Summary: ${summaryPath}`);
  lines.push(`Summary lite: ${summaryLitePath}${hasSummaryLiteGz ? ` (+ ${gzipSummaryLitePath})` : ""}`);
  lines.push(`Issues: ${issuesPath}${hasIssuesGz ? ` (+ ${gzipIssuesPath})` : ""}`);
  lines.push(`Overview: ${overviewPath}`);
  lines.push(`Plan: ${planPath}${hasPlanGz ? ` (+ ${gzipPlanPath})` : ""}`);
  if (await fileExists(measureSummaryLitePath)) {
    lines.push(`Measure summary lite: ${measureSummaryLitePath}${hasMeasureSummaryLiteGz ? ` (+ ${gzipMeasureSummaryLitePath})` : ""}`);
  }
  if (params.captureLevel !== undefined) {
    lines.push(`Screenshots: ${screenshotsDir} (${screenshotCount})`);
    lines.push(`Diagnostics: ${diagnosticsDir} (${diagnosticsCount})`);
    lines.push(`Diagnostics lite: ${diagnosticsLiteDir} (${diagnosticsLiteCount})`);
  }
  if (params.captureLevel === "lhr") {
    lines.push(`LHR: ${lhrDir} (${lhrCount})`);
  }
  // eslint-disable-next-line no-console
  console.log(renderPanel({ title: new UiTheme({ noColor: true }).bold("Artifacts"), lines }));
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

function isConnectionError(error: unknown): boolean {
  const anyError = error as { readonly code?: unknown; readonly message?: unknown } | undefined;
  const code: string = typeof anyError?.code === "string" ? anyError.code : "";
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return true;
  }
  const message: string = typeof anyError?.message === "string" ? anyError.message : String(error);
  return message.includes("ECONNREFUSED") || message.includes("ENOTFOUND") || message.includes("EAI_AGAIN") || message.includes("Could not reach");
}

async function handleFriendlyError(params: {
  readonly error: unknown;
  readonly configPath?: string;
  readonly baseUrl?: string;
}): Promise<void> {
  const error: unknown = params.error;
  const message: string = error instanceof Error ? error.message : String(error);
  if (isConnectionError(error) && params.baseUrl !== undefined) {
    const noColor: boolean = Boolean(process.env.NO_COLOR) || process.env.CI === "true";
    const theme: UiTheme = new UiTheme({ noColor });
    const projectRoot: string = params.configPath ? dirname(params.configPath) : process.cwd();
    const lines: readonly string[] = await buildDevServerGuidanceLines({ projectRoot, baseUrl: params.baseUrl });
    // eslint-disable-next-line no-console
    console.error(renderPanel({ title: theme.bold("Dev server"), lines }));
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
