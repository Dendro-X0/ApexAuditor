#!/usr/bin/env node

import { runAuditCli } from "./cli.js";
import { runWizardCli } from "./wizard-cli.js";
import { runQuickstartCli } from "./quickstart-cli.js";

type ApexCommandId = "audit" | "wizard" | "quickstart" | "help";

interface ParsedBinArgs {
  readonly command: ApexCommandId;
  readonly argv: readonly string[];
}

function parseBinArgs(argv: readonly string[]): ParsedBinArgs {
  const rawCommand: string | undefined = argv[2];
  if (rawCommand === undefined || rawCommand === "help" || rawCommand === "--help" || rawCommand === "-h") {
    return { command: "help", argv };
  }
  if (rawCommand === "audit" || rawCommand === "wizard" || rawCommand === "quickstart") {
    const commandArgv: readonly string[] = ["node", "apex-auditor", ...argv.slice(3)];
    return { command: rawCommand as ApexCommandId, argv: commandArgv };
  }
  return { command: "help", argv };
}

function printHelp(): void {
  console.log(
    [
      "ApexAuditor CLI",
      "",
      "Usage:",
      "  apex-auditor quickstart --base-url <url> [--project-root <path>]",
      "  apex-auditor wizard [--config <path>]",
      "  apex-auditor audit [--config <path>] [--ci] [--no-color|--color] [--log-level <level>]",
      "",
      "Commands:",
      "  quickstart  Detect routes and run a one-off audit with sensible defaults",
      "  wizard   Run interactive config wizard",
      "  audit    Run Lighthouse audits using apex.config.json",
      "  help     Show this help message",
      "",
      "Options (audit):",
      "  --ci               Enable CI mode with budgets and non-zero exit code on failure",
      "  --no-color         Disable ANSI colours in console output (default in CI mode)",
      "  --color            Force ANSI colours in console output",
      "  --log-level <lvl>  Override Lighthouse log level: silent|error|info|verbose",
      "  --mobile-only      Run audits only for 'mobile' devices defined in the config",
      "  --desktop-only     Run audits only for 'desktop' devices defined in the config",
      "  --parallel <n>     Override parallel workers (1-10). Default auto-tunes from CPU/memory.",
      "  --show-parallel    Print the resolved parallel workers before running.",
    ].join("\n"),
  );
}

export async function runBin(argv: readonly string[]): Promise<void> {
  const parsed: ParsedBinArgs = parseBinArgs(argv);
  if (parsed.command === "help") {
    printHelp();
    return;
  }
  if (parsed.command === "quickstart") {
    await runQuickstartCli(parsed.argv);
    return;
  }
  if (parsed.command === "audit") {
    await runAuditCli(parsed.argv);
    return;
  }
  if (parsed.command === "wizard") {
    await runWizardCli(parsed.argv);
  }
}

void runBin(process.argv).catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error("ApexAuditor CLI failed:", error);
  process.exitCode = 1;
});
