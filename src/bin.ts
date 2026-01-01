#!/usr/bin/env node

import { runAuditCli } from "./cli.js";
import { runWizardCli } from "./wizard-cli.js";
import { runQuickstartCli } from "./quickstart-cli.js";
import { runShellCli } from "./shell-cli.js";
import { runMeasureCli } from "./measure-cli.js";
import { runBundleCli } from "./bundle-cli.js";
import { runHealthCli } from "./health-cli.js";
import { runLinksCli } from "./links-cli.js";
import { runHeadersCli } from "./headers-cli.js";
import { runConsoleCli } from "./console-cli.js";
import { runCleanCli } from "./clean-cli.js";

type ApexCommandId =
  | "audit"
  | "measure"
  | "bundle"
  | "health"
  | "links"
  | "headers"
  | "console"
  | "clean"
  | "wizard"
  | "quickstart"
  | "guide"
  | "shell"
  | "help"
  | "init";

interface ParsedBinArgs {
  readonly command: ApexCommandId;
  readonly argv: readonly string[];
}

function parseBinArgs(argv: readonly string[]): ParsedBinArgs {
  const rawCommand: string | undefined = argv[2];
  if (rawCommand === undefined) {
    return { command: "shell", argv };
  }
  if (rawCommand === "help" || rawCommand === "--help" || rawCommand === "-h") {
    return { command: "help", argv };
  }
  if (rawCommand === "shell") {
    const commandArgv: readonly string[] = ["node", "apex-auditor", ...argv.slice(3)];
    return { command: "shell", argv: commandArgv };
  }
  if (
    rawCommand === "audit" ||
    rawCommand === "measure" ||
    rawCommand === "bundle" ||
    rawCommand === "health" ||
    rawCommand === "links" ||
    rawCommand === "headers" ||
    rawCommand === "console" ||
    rawCommand === "clean" ||
    rawCommand === "wizard" ||
    rawCommand === "quickstart" ||
    rawCommand === "guide" ||
    rawCommand === "init"
  ) {
    const commandArgv: readonly string[] = ["node", "apex-auditor", ...argv.slice(3)];
    return { command: rawCommand as ApexCommandId, argv: commandArgv };
  }
  return { command: "help", argv };
}

function printHelp(topic?: string): void {
  if (topic === "topics") {
    console.log(
      [
        "Help topics:",
        "  budgets   Budget schema and CI behaviour",
        "  configs   apex.config.json fields and defaults",
        "  ci        CI mode, exit codes, budgets",
        "  topics    This list",
        "Examples:",
        "  apex-auditor help budgets",
        "  apex-auditor help configs",
        "  apex-auditor help ci",
      ].join("\n"),
    );
    return;
  }
  if (topic === "budgets") {
    console.log(
      [
        "Budgets:",
        "  - categories: performance, accessibility, bestPractices, seo (0-100 scores)",
        "  - metrics: lcpMs, fcpMs, tbtMs, cls, inpMs (numeric thresholds)",
        "Example apex.config.json budget:",
        '  "budgets": {',
        '    "categories": { "performance": 80, "accessibility": 90 },',
        '    "metrics": { "lcpMs": 2500, "inpMs": 200 }',
        "  }",
        "",
        "CI behaviour:",
        "  - --ci exits non-zero if any budget is under/over its limit",
        "  - Summary prints violations; JSON includes full results",
      ].join("\n"),
    );
    return;
  }
  if (topic === "configs") {
    console.log(
      [
        "Config (apex.config.json):",
        "  baseUrl (required)     Base URL of your running site",
        "  query                  Query string appended to every path (e.g., ?lhci=1)",
        "  buildId                Build identifier used for incremental cache keys",
        "  runs                   Runs per page/device (must be 1; rerun command to compare)",
        "  auditTimeoutMs         Per-audit timeout in milliseconds (prevents hung runs from stalling)",
        "  throttlingMethod       simulate | devtools (default simulate)",
        "  cpuSlowdownMultiplier  CPU slowdown (default 4)",
        "  parallel               Workers (default auto up to 4, respects CPU/memory)",
        "  warmUp                 true/false to warm cache before auditing (bounded concurrency)",
        "  incremental            (deprecated default) Set in config but only active when --incremental is passed",
        "  pages                  Array of { path, label, devices: [mobile|desktop] }",
        "  budgets                Optional { categories, metrics } thresholds",
        "",
        "Tip:",
        "  For best accuracy and stable throughput, run audits against a production server (e.g., Next.js: next build && next start)",
      ].join("\n"),
    );
    return;
  }
  if (topic === "ci") {
    console.log(
      [
        "CI mode:",
        "  - Use --ci to enable budgets and non-zero exit codes on failures",
        "  - Exit code 1 if any budget fails or a runtime error occurs",
        "  - Use --json to pipe results to other tools",
        "  - Combine with --parallel and --throttling for speed/accuracy trade-offs",
      ].join("\n"),
    );
    return;
  }
  console.log(
    [
      "ApexAuditor CLI",
      "",
      "Usage:",
      "  apex-auditor                 # interactive shell (default)",
      "  apex-auditor quickstart --base-url <url> [--project-root <path>]",
      "  apex-auditor wizard [--config <path>]",
      "  apex-auditor audit [--config <path>] [--ci] [--no-color|--color] [--log-level <level>]",
      "  apex-auditor guide  (alias of wizard) interactive flow with tips for non-technical users",
      "  apex-auditor shell           # same as default entrypoint",
      "",
      "Commands:",
      "  shell      Start interactive shell (audit/open/diff/preset/help/exit)",
      "  quickstart  Detect routes and run a one-off audit with sensible defaults",
      "  wizard     Run interactive config wizard",
      "  guide      Same as wizard, with inline tips for non-technical users",
      "  audit      Run Lighthouse audits using apex.config.json",
      "  measure    Fast batch metrics (CDP-based, non-Lighthouse)",
      "  bundle     Bundle size audit (Next.js .next/ or dist/ build output)",
      "  health     HTTP status + latency checks for configured routes",
      "  links      Broken links audit (sitemap + HTML link extraction)",
      "  headers    Security headers audit",
      "  console    Console errors + runtime exceptions audit (headless Chrome)",
      "  clean      Remove ApexAuditor artifacts (reports/cache and optionally config)",
      "  help       Show this help message",
      "",
      "Options (audit):",
      "  --ci               Enable CI mode with budgets and non-zero exit code on failure",
      "  --fail-on-budget   Exit non-zero if budgets fail even outside CI",
      "  --no-color         Disable ANSI colours in console output (default in CI mode)",
      "  --color            Force ANSI colours in console output",
      "  --log-level <lvl>  Override Lighthouse log level: silent|error|info|verbose",
      "  --stable           Flake-resistant mode: forces parallel=1, good for big suites or flaky runners",
      "  --mobile-only      Run audits only for 'mobile' devices defined in the config",
      "  --desktop-only     Run audits only for 'desktop' devices defined in the config",
      "  --parallel <n>     Override parallel workers (1-10). Default auto-tunes from CPU/memory.",
      "  --audit-timeout-ms <ms>  Per-audit timeout in milliseconds (prevents hung runs from stalling)",
      "  --plan             Print resolved settings + run size estimate and exit without auditing",
      "  --max-steps <n>    Safety limit: refuse/prompt if planned Lighthouse runs exceed this (default 120)",
      "  --max-combos <n>   Safety limit: refuse/prompt if planned page/device combos exceed this (default 60)",
      "  --yes, -y          Auto-confirm large runs (bypass safety prompt)",
      "  --changed-only     Run only pages whose paths match files in git diff --name-only (working tree diff)",
      "  --rerun-failing    Re-run only combos that failed in the previous summary (runtime errors or perf<90)",
      "  --accessibility-pass  Opt-in: run a fast axe-core accessibility sweep after audits (lightweight, CDP-based)",
      "  --webhook-url <url> Send a JSON webhook with regressions/budgets/accessibility (regressions-only summary)",
      "  --show-parallel    Print the resolved parallel workers before running.",
      "  --incremental      Reuse cached results for unchanged combos (requires --build-id). Opt-in; off by default.",
      "  --build-id <id>    Build identifier used as the cache key boundary for --incremental",
      "  --overview         Preset: quick overview (runs=1) and samples a small set of combos unless --yes.",
      "  --overview-combos <n>  Overview sampling size (default 10).",
      "  --quick            Preset: fast feedback (runs=1) without changing throttling defaults",
      "  --accurate         Preset: devtools throttling + warm-up + stability-first (parallel=1 unless overridden)",
      "  --open             Open the HTML report after the run.",
      "",
      "Options (measure):",
      "  --mobile-only      Run measure only for 'mobile' devices defined in the config",
      "  --desktop-only     Run measure only for 'desktop' devices defined in the config",
      "  --parallel <n>     Override parallel workers (1-10).",
      "  --timeout-ms <ms>  Per-navigation timeout in milliseconds (default 60000)",
      "  --screenshots      Opt-in: save a screenshot per combo (slower; writes .apex-auditor/measure/*.png)",
      "  --json             Print JSON summary to stdout",
      "",
      "Options (bundle):",
      "  --project-root <path>  Project root to scan (default cwd)",
      "  --top <n>              Show top N largest files (default 15)",
      "  --json                 Print JSON report to stdout",
      "",
      "Options (health):",
      "  --config <path>        Config path (default apex.config.json)",
      "  --parallel <n>         Parallel requests (default auto)",
      "  --timeout-ms <ms>      Per-request timeout (default 20000)",
      "  --json                 Print JSON report to stdout",
      "",
      "Options (links):",
      "  --config <path>        Config path (default apex.config.json)",
      "  --sitemap <url>        Override sitemap URL (default <baseUrl>/sitemap.xml)",
      "  --parallel <n>         Parallel requests (default auto)",
      "  --timeout-ms <ms>      Per-request timeout (default 20000)",
      "  --max-urls <n>         Limit total URLs checked (default 200)",
      "  --json                 Print JSON report to stdout",
      "",
      "Options (headers):",
      "  --config <path>        Config path (default apex.config.json)",
      "  --parallel <n>         Parallel requests (default auto)",
      "  --timeout-ms <ms>      Per-request timeout (default 20000)",
      "  --json                 Print JSON report to stdout",
      "",
      "Options (console):",
      "  --config <path>        Config path (default apex.config.json)",
      "  --parallel <n>         Parallel workers (default auto)",
      "  --timeout-ms <ms>      Per-navigation timeout (default 60000)",
      "  --max-events <n>       Cap captured events per combo (default 50)",
      "  --json                 Print JSON report to stdout",
      "",
      "Options (clean):",
      "  --project-root <path>  Project root (default cwd)",
      "  --config-path <path>   Config file path relative to project root (default apex.config.json)",
      "  --reports              Remove .apex-auditor/ (default)",
      "  --no-reports           Keep .apex-auditor/",
      "  --remove-config        Remove config file",
      "  --all                  Remove reports and config",
      "  --dry-run              Print planned removals without deleting",
      "  --yes, -y              Skip confirmation prompt",
      "  --json                 Print JSON report to stdout",
      "",
      "Outputs:",
      "  - Writes .apex-auditor/summary.json, summary.md, report.html",
      "  - Prints a file:// link to the HTML report after completion",
      "",
      "Quick start:",
      "  pnpm dlx apex-auditor@latest wizard      # guided setup",
      "  pnpm dlx apex-auditor@latest audit       # run with apex.config.json",
      "",
      "Defaults:",
      "  - Parallel auto-tunes from CPU/memory (up to 4 by default)",
      "  - Throttling: simulate, CPU slowdown: 4, Runs: 1",
      "  - Stable: use --stable to force serial runs when parallel flakes (e.g., TargetClose/Lantern errors)",
      "  - Accuracy tip: run against a production server (e.g., Next.js: next build && next start)",
      "  - Incremental: use --incremental --build-id <id> to skip unchanged audits between runs",
      "  - Presets: choose only one of --fast, --quick, --accurate",
      "",
      "More help:",
      "  apex-auditor help topics",
      "  apex-auditor help budgets",
    ].join("\n"),
  );
}

function isInteractiveTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function runBin(argv: readonly string[]): Promise<void> {
  const parsed: ParsedBinArgs = parseBinArgs(argv);
  if (parsed.command === "help") {
    const topic: string | undefined = argv[3];
    printHelp(topic);
    return;
  }

  if (parsed.command === "shell") {
    await runShellCli(parsed.argv);
    return;
  }

  if (parsed.command === "quickstart") {
    await runQuickstartCli(parsed.argv);
    if (isInteractiveTty()) {
      await runShellCli(["node", "apex-auditor"]);
    }
    return;
  }

  const runOnce = async (): Promise<void> => {
    if (parsed.command === "audit") {
      await runAuditCli(parsed.argv);
      return;
    }
    if (parsed.command === "measure") {
      await runMeasureCli(parsed.argv);
      return;
    }
    if (parsed.command === "bundle") {
      await runBundleCli(parsed.argv);
      return;
    }
    if (parsed.command === "health") {
      await runHealthCli(parsed.argv);
      return;
    }
    if (parsed.command === "links") {
      await runLinksCli(parsed.argv);
      return;
    }
    if (parsed.command === "headers") {
      await runHeadersCli(parsed.argv);
      return;
    }
    if (parsed.command === "console") {
      await runConsoleCli(parsed.argv);
      return;
    }
    if (parsed.command === "clean") {
      await runCleanCli(parsed.argv);
      return;
    }
    if (parsed.command === "init" || parsed.command === "wizard" || parsed.command === "guide") {
      await runWizardCli(parsed.argv);
      return;
    }
  };

  try {
    await runOnce();
  } catch (error: unknown) {
    const message: string = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      // eslint-disable-next-line no-console
      console.error("Config file not found. Run `apex-auditor init` to create a config or set one with `config <path>`.");
      return;
    }
    throw error;
  }

  if (isInteractiveTty()) {
    await runShellCli(["node", "apex-auditor"]);
  }
}

void runBin(process.argv).catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error("ApexAuditor CLI failed:", error);
  process.exitCode = 1;
});
