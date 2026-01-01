import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { renderPanel } from "./ui/render-panel.js";
import { renderTable } from "./ui/render-table.js";
import { UiTheme } from "./ui/ui-theme.js";
import { stopSpinner } from "./spinner.js";

type BundleArgs = {
  readonly projectRoot: string;
  readonly jsonOutput: boolean;
  readonly top: number;
};

type BundleFileKind = "js" | "css";

type BundleFileEntry = {
  readonly kind: BundleFileKind;
  readonly relativePath: string;
  readonly bytes: number;
};

type BundleAuditSummary = {
  readonly meta: {
    readonly projectRoot: string;
    readonly scannedAt: string;
    readonly detected: {
      readonly nextDir: boolean;
      readonly distDir: boolean;
    };
  };
  readonly totals: {
    readonly jsBytes: number;
    readonly cssBytes: number;
    readonly fileCount: number;
  };
  readonly topFiles: readonly BundleFileEntry[];
  readonly files: readonly BundleFileEntry[];
};

const NO_COLOR: boolean = Boolean(process.env.NO_COLOR) || process.env.CI === "true";
const theme: UiTheme = new UiTheme({ noColor: NO_COLOR });

function formatBytes(bytes: number): string {
  const kb: number = bytes / 1024;
  if (kb < 1024) {
    return `${Math.round(kb)}KB`;
  }
  const mb: number = kb / 1024;
  return `${mb.toFixed(1)}MB`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(params: {
  readonly root: string;
  readonly base: string;
  readonly extensions: readonly string[];
  readonly signal?: AbortSignal;
}): Promise<readonly BundleFileEntry[]> {
  const entries: BundleFileEntry[] = [];
  const visitDir = async (dir: string): Promise<void> => {
    if (params.signal?.aborted) {
      throw new Error("Aborted");
    }
    const children: readonly string[] = await readdir(dir);
    for (const name of children) {
      if (params.signal?.aborted) {
        throw new Error("Aborted");
      }
      const absolute: string = join(dir, name);
      const s = await stat(absolute);
      if (s.isDirectory()) {
        await visitDir(absolute);
        continue;
      }
      const matchedExt: string | undefined = params.extensions.find((ext) => name.endsWith(ext));
      if (!matchedExt) {
        continue;
      }
      const kind: BundleFileKind = matchedExt === ".css" ? "css" : "js";
      const rel: string = relative(params.base, absolute).replace(/\\/g, "/");
      entries.push({ kind, relativePath: rel, bytes: s.size });
    }
  };

  await visitDir(params.root);
  return entries;
}

function parseArgs(argv: readonly string[]): BundleArgs {
  let projectRoot: string = process.cwd();
  let jsonOutput = false;
  let top = 15;
  for (let i = 2; i < argv.length; i += 1) {
    const arg: string = argv[i];
    if ((arg === "--project-root" || arg === "--root") && i + 1 < argv.length) {
      projectRoot = argv[i + 1] ?? projectRoot;
      i += 1;
    } else if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--top" && i + 1 < argv.length) {
      const value: number = parseInt(argv[i + 1] ?? "", 10);
      if (!Number.isFinite(value) || value <= 0 || value > 100) {
        throw new Error(`Invalid --top value: ${argv[i + 1]}. Expected 1-100.`);
      }
      top = value;
      i += 1;
    }
  }
  return { projectRoot, jsonOutput, top };
}

function buildTopFilesTable(entries: readonly BundleFileEntry[], top: number): string {
  const rows = [...entries]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, top)
    .map((f) => [f.kind, formatBytes(f.bytes), f.relativePath] as const);

  if (rows.length === 0) {
    return "";
  }

  return renderTable({ headers: ["Type", "Size", "File"], rows });
}

export async function runBundleCli(argv: readonly string[], options?: { readonly signal?: AbortSignal }): Promise<void> {
  stopSpinner();
  const args: BundleArgs = parseArgs(argv);
  const projectRoot: string = resolve(args.projectRoot);

  const nextDir: string = resolve(projectRoot, ".next");
  const distDir: string = resolve(projectRoot, "dist");

  const hasNext: boolean = await pathExists(nextDir);
  const hasDist: boolean = await pathExists(distDir);

  const scanTargets: readonly string[] = [
    hasNext ? resolve(nextDir, "static") : "",
    hasDist ? distDir : "",
  ].filter((p) => p.length > 0);

  const allEntries: BundleFileEntry[] = [];
  for (const target of scanTargets) {
    if (options?.signal?.aborted) {
      throw new Error("Aborted");
    }
    const entries: readonly BundleFileEntry[] = await walkFiles({
      root: target,
      base: projectRoot,
      extensions: [".js", ".css"],
      signal: options?.signal,
    });
    allEntries.push(...entries);
  }

  const jsBytes: number = allEntries.filter((e) => e.kind === "js").reduce((sum, e) => sum + e.bytes, 0);
  const cssBytes: number = allEntries.filter((e) => e.kind === "css").reduce((sum, e) => sum + e.bytes, 0);

  const topFiles: readonly BundleFileEntry[] = [...allEntries].sort((a, b) => b.bytes - a.bytes).slice(0, args.top);

  const report: BundleAuditSummary = {
    meta: {
      projectRoot,
      scannedAt: new Date().toISOString(),
      detected: { nextDir: hasNext, distDir: hasDist },
    },
    totals: {
      jsBytes,
      cssBytes,
      fileCount: allEntries.length,
    },
    topFiles,
    files: allEntries,
  };

  const outputDir: string = resolve(projectRoot, ".apex-auditor");
  const outputPath: string = resolve(outputDir, "bundle-audit.json");
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");

  if (args.jsonOutput) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const detectedText: string = [hasNext ? ".next" : "", hasDist ? "dist" : ""].filter((v) => v.length > 0).join(", ") || "(none)";
  const lines: readonly string[] = [
    `Project: ${projectRoot}`,
    `Detected: ${detectedText}`,
    `Files: ${report.totals.fileCount}`,
    `JS: ${formatBytes(report.totals.jsBytes)}`,
    `CSS: ${formatBytes(report.totals.cssBytes)}`,
    `Output: ${relative(projectRoot, outputPath).replace(/\\/g, "/")}`,
  ];

  // eslint-disable-next-line no-console
  console.log(renderPanel({ title: theme.bold("Bundle"), lines }));

  const table: string = buildTopFilesTable(allEntries, args.top);
  if (table.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`\n${theme.bold(`Largest files (top ${args.top})`)}`);
    // eslint-disable-next-line no-console
    console.log(table);
  }
}
