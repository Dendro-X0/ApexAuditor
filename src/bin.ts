#!/usr/bin/env node

import { runAuditCli } from "./cli.js";
import { runWizardCli } from "./wizard-cli.js";

type ApexCommandId = "audit" | "wizard" | "help";

interface ParsedBinArgs {
  readonly command: ApexCommandId;
  readonly argv: readonly string[];
}

function parseBinArgs(argv: readonly string[]): ParsedBinArgs {
  const rawCommand: string | undefined = argv[2];
  if (rawCommand === undefined || rawCommand === "help" || rawCommand === "--help" || rawCommand === "-h") {
    return { command: "help", argv };
  }
  if (rawCommand === "audit" || rawCommand === "wizard") {
    const commandArgv: readonly string[] = ["node", "apex-auditor", ...argv.slice(3)];
    return { command: rawCommand, argv: commandArgv };
  }
  return { command: "help", argv };
}

function printHelp(): void {
  console.log(
    [
      "ApexAuditor CLI",
      "",
      "Usage:",
      "  apex-auditor wizard [--config <path>]",
      "  apex-auditor audit [--config <path>]",
      "",
      "Commands:",
      "  wizard   Run interactive config wizard",
      "  audit    Run Lighthouse audits using apex.config.json",
      "  help     Show this help message",
    ].join("\n"),
  );
}

export async function runBin(argv: readonly string[]): Promise<void> {
  const parsed: ParsedBinArgs = parseBinArgs(argv);
  if (parsed.command === "help") {
    printHelp();
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
