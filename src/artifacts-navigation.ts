import { readdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type DirEntry = {
  readonly name: string;
  readonly kind: "file" | "dir";
};

type WriteArtifactsNavigationParams = {
  readonly outputDir: string;
};

async function listDirEntries(absoluteDir: string): Promise<readonly DirEntry[]> {
  try {
    const names: readonly string[] = await readdir(absoluteDir);
    const entries: DirEntry[] = [];
    for (const name of names) {
      const absolute: string = resolve(absoluteDir, name);
      const s = await stat(absolute);
      entries.push({ name, kind: s.isDirectory() ? "dir" : "file" });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function toRelativeLink(name: string, kind: DirEntry["kind"]): string {
  if (kind === "dir") {
    return `[${name}/](${name}/)`;
  }
  return `[${name}](${name})`;
}

function buildMarkdown(params: { readonly generatedAt: string; readonly entries: readonly DirEntry[] }): string {
  const lines: string[] = [];
  lines.push("# ApexAuditor artifacts navigation");
  lines.push("");
  lines.push(`Generated: ${params.generatedAt}`);
  lines.push("");
  lines.push("This folder contains outputs produced by ApexAuditor commands. Use this document to quickly locate the right artifact for a task.");
  lines.push("");
  lines.push("## Quick start");
  lines.push("");
  lines.push("- For a human summary: open `overview.md` then `triage.md`.");
  lines.push("- For a machine/AI plan: open `ai-ledger.json` and follow `fixPlan`.");
  lines.push("- For structured issues: open `issues.json`.");
  lines.push("- For PWA-specific signals: open `pwa.json`.");
  lines.push("- For a compact suite summary: open `summary-lite.json`.");
  lines.push("");
  lines.push("## Key artifacts (common)");
  lines.push("");
  lines.push("- `overview.md`: top issues + worst routes + recommended next runs.");
  lines.push("- `triage.md`: the fastest human triage view; links to the exact per-page artifacts.");
  lines.push("- `report.html`: full Lighthouse HTML report for the suite.");
  lines.push("- `summary.json`: full suite summary with all combos and metrics.");
  lines.push("- `summary-lite.json`: smaller summary for quick parsing.");
  lines.push("- `issues.json`: normalized issues across all combos (opportunities, hints, evidence).");
  lines.push("- `ai-ledger.json`: AI-first index: issueIndex + fixPlan + offenders + evidence pointers.");
  lines.push("- `pwa.json`: PWA-focused Lighthouse checks (installability, HTTPS, service worker, offline-ready signals).");
  lines.push("- `plan.json`: resolved run plan and safety estimates.");
  lines.push("- `export.json`: shareable payload for external tools.");
  lines.push("");
  lines.push("## Runner-specific artifacts");
  lines.push("");
  lines.push("- `measure.*`: fast CDP metrics (not Lighthouse).");
  lines.push("- `headers.*`: security headers audit.");
  lines.push("- `links.*`: broken links audit.");
  lines.push("- `bundle.*`: bundle size scan (Next.js `.next/` or other dist outputs).");
  lines.push("- `console.*`: browser console errors/exceptions capture.");
  lines.push("- `accessibility.*`: fast axe-core sweep (optional, non-Lighthouse).");
  lines.push("");
  lines.push("## Heavy diagnostics");
  lines.push("");
  lines.push("- `lighthouse-artifacts/diagnostics-lite/`: smaller per-combo Lighthouse payload (best for navigation).");
  lines.push("- `lighthouse-artifacts/diagnostics/`: larger payloads with more detail.");
  lines.push("- `screenshots/`: screenshots captured during Lighthouse runs.");
  lines.push("");
  lines.push("## Files in this directory");
  lines.push("");
  for (const entry of params.entries) {
    lines.push(`- ${toRelativeLink(entry.name, entry.kind)}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function writeArtifactsNavigation(params: WriteArtifactsNavigationParams): Promise<{ readonly absolutePath: string }> {
  const entries: readonly DirEntry[] = await listDirEntries(params.outputDir);
  const generatedAt: string = new Date().toISOString();
  const md: string = buildMarkdown({ generatedAt, entries });
  const absolutePath: string = resolve(params.outputDir, "NAVIGATION.md");
  await writeFile(absolutePath, md, "utf8");
  return { absolutePath };
}
