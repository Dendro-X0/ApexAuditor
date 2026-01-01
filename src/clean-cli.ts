import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import readline from "node:readline";

type CleanArgs = {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly removeReports: boolean;
  readonly removeConfig: boolean;
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly jsonOutput: boolean;
};

type CleanAction = {
  readonly kind: "rm";
  readonly path: string;
  readonly existsByAssumption: boolean;
};

type CleanReport = {
  readonly meta: {
    readonly projectRoot: string;
    readonly configPath: string;
    readonly dryRun: boolean;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly elapsedMs: number;
  };
  readonly planned: readonly CleanAction[];
  readonly executed: readonly CleanAction[];
};

function parseArgs(argv: readonly string[]): CleanArgs {
  let projectRoot: string = process.cwd();
  let configPath: string = "apex.config.json";
  let removeReports = true;
  let removeConfig = false;
  let dryRun = false;
  let yes = false;
  let jsonOutput = false;
  for (let i = 2; i < argv.length; i += 1) {
    const arg: string = argv[i] ?? "";
    if (arg === "--project-root" && i + 1 < argv.length) {
      projectRoot = argv[i + 1] ?? projectRoot;
      i += 1;
      continue;
    }
    if ((arg === "--config-path" || arg === "--config") && i + 1 < argv.length) {
      configPath = argv[i + 1] ?? configPath;
      i += 1;
      continue;
    }
    if (arg === "--reports") {
      removeReports = true;
      continue;
    }
    if (arg === "--no-reports") {
      removeReports = false;
      continue;
    }
    if (arg === "--remove-config") {
      removeConfig = true;
      continue;
    }
    if (arg === "--all") {
      removeReports = true;
      removeConfig = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      yes = true;
      continue;
    }
    if (arg === "--json") {
      jsonOutput = true;
      continue;
    }
  }
  return {
    projectRoot: resolve(projectRoot),
    configPath: resolve(projectRoot, configPath),
    removeReports,
    removeConfig,
    dryRun,
    yes,
    jsonOutput,
  };
}

async function confirmPrompt(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }
  process.stdin.resume();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer: string = await new Promise<string>((resolvePromise) => {
      rl.question(question, (value: string) => resolvePromise(value));
    });
    const text: string = answer.trim().toLowerCase();
    return text === "y" || text === "yes";
  } finally {
    rl.close();
  }
}

function buildPlan(args: CleanArgs): readonly CleanAction[] {
  const actions: CleanAction[] = [];
  if (args.removeReports) {
    actions.push({ kind: "rm", path: resolve(args.projectRoot, ".apex-auditor"), existsByAssumption: true });
  }
  if (args.removeConfig) {
    actions.push({ kind: "rm", path: args.configPath, existsByAssumption: true });
  }
  return actions;
}

async function executePlan(plan: readonly CleanAction[], dryRun: boolean): Promise<readonly CleanAction[]> {
  if (dryRun) {
    return [];
  }
  const executed: CleanAction[] = [];
  for (const action of plan) {
    if (action.kind === "rm") {
      await rm(action.path, { recursive: true, force: true });
      executed.push(action);
    }
  }
  return executed;
}

export async function runCleanCli(argv: readonly string[]): Promise<void> {
  const startedAtMs: number = Date.now();
  const args: CleanArgs = parseArgs(argv);
  const planned: readonly CleanAction[] = buildPlan(args);
  if (planned.length === 0) {
    const empty: CleanReport = {
      meta: {
        projectRoot: args.projectRoot,
        configPath: args.configPath,
        dryRun: args.dryRun,
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: new Date(startedAtMs).toISOString(),
        elapsedMs: 0,
      },
      planned: [],
      executed: [],
    };
    if (args.jsonOutput) {
      console.log(JSON.stringify(empty, null, 2));
      return;
    }
    console.log("Nothing to clean.");
    return;
  }
  if (!args.yes && process.stdin.isTTY) {
    const targets: string = planned.map((p) => p.path).join("\n");
    const ok: boolean = await confirmPrompt(`This will remove:\n${targets}\nContinue? (y/N) `);
    if (!ok) {
      console.log("Cancelled.");
      return;
    }
  }
  const executed: readonly CleanAction[] = await executePlan(planned, args.dryRun);
  const completedAtMs: number = Date.now();
  const report: CleanReport = {
    meta: {
      projectRoot: args.projectRoot,
      configPath: args.configPath,
      dryRun: args.dryRun,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      elapsedMs: completedAtMs - startedAtMs,
    },
    planned,
    executed,
  };
  if (args.jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (args.dryRun) {
    console.log(`Planned removals: ${planned.length} (dry-run).`);
    return;
  }
  console.log(`Removed: ${executed.length}/${planned.length}.`);
}
