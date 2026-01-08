import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { request } from "node:https";

type UpgradeArgs = {
  readonly repo: string;
  readonly version: string;
  readonly installDir: string;
  readonly binDir: string;
};

type GitHubAsset = {
  readonly name: string;
  readonly browser_download_url: string;
};

type GitHubRelease = {
  readonly tag_name: string;
  readonly assets: readonly GitHubAsset[];
};

type ParsedArgs = {
  readonly argv: readonly string[];
  readonly repo?: string;
  readonly version?: string;
  readonly installDir?: string;
  readonly binDir?: string;
};

function parseArgs(argv: readonly string[]): ParsedArgs {
  let repo: string | undefined;
  let version: string | undefined;
  let installDir: string | undefined;
  let binDir: string | undefined;
  for (let i: number = 2; i < argv.length; i += 1) {
    const arg: string = argv[i] ?? "";
    if (arg === "--repo" && i + 1 < argv.length) {
      repo = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--version" && i + 1 < argv.length) {
      version = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--install-dir" && i + 1 < argv.length) {
      installDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--bin-dir" && i + 1 < argv.length) {
      binDir = argv[i + 1];
      i += 1;
      continue;
    }
  }
  return { argv, repo, version, installDir, binDir };
}

function resolveDefaults(parsed: ParsedArgs): UpgradeArgs {
  const envRepo: string | undefined = process.env.SIGNALER_REPO;
  const repo: string | undefined = parsed.repo ?? envRepo;
  if (!repo || repo.trim().length === 0) {
    throw new Error("Missing repo. Pass --repo owner/name or set SIGNALER_REPO.");
  }
  const version: string = parsed.version ?? "latest";
  const baseDir: string = process.platform === "win32" ? resolve(process.env.LOCALAPPDATA ?? ".", "signaler") : resolve(process.env.XDG_DATA_HOME ?? resolve(process.env.HOME ?? ".", ".local/share"), "signaler");
  const installDir: string = parsed.installDir ?? resolve(baseDir, "current");
  const binDir: string = parsed.binDir ?? resolve(baseDir, "bin");
  return { repo, version, installDir, binDir };
}

function requestJson(url: string): Promise<GitHubRelease> {
  return new Promise<GitHubRelease>((resolveJson, rejectJson) => {
    const req = request(url, { headers: { "User-Agent": "signaler" } }, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        rejectJson(new Error(`GitHub API request failed: ${res.statusCode ?? "unknown"}`));
        res.resume();
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("end", () => {
        try {
          const raw: string = Buffer.concat(chunks).toString("utf8");
          const parsed: unknown = JSON.parse(raw) as unknown;
          if (!parsed || typeof parsed !== "object") {
            rejectJson(new Error("Invalid GitHub API response."));
            return;
          }
          resolveJson(parsed as GitHubRelease);
        } catch (err: unknown) {
          rejectJson(err);
        }
      });
    });
    req.on("error", rejectJson);
    req.end();
  });
}

function pickPortableAsset(release: GitHubRelease): GitHubAsset {
  const asset: GitHubAsset | undefined = release.assets.find((a) => a.name.endsWith("-portable.zip"));
  if (!asset) {
    throw new Error("No *-portable.zip asset found in the GitHub Release.");
  }
  return asset;
}

function downloadToFile(params: { readonly url: string; readonly destPath: string }): Promise<void> {
  return new Promise<void>((resolveDownload, rejectDownload) => {
    const file = createWriteStream(params.destPath);
    const req = request(params.url, { headers: { "User-Agent": "signaler" } }, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        rejectDownload(new Error(`Download failed: ${res.statusCode ?? "unknown"}`));
        res.resume();
        return;
      }
      res.pipe(file);
      file.on("finish", () => {
        file.close();
        resolveDownload();
      });
    });
    req.on("error", (err: unknown) => {
      file.close();
      rejectDownload(err);
    });
    file.on("error", (err: unknown) => {
      file.close();
      rejectDownload(err);
    });
    req.end();
  });
}

function execFileAsync(file: string, args: readonly string[]): Promise<void> {
  return new Promise<void>((resolveExec, rejectExec) => {
    execFile(file, [...args], (error) => {
      if (error) {
        rejectExec(error);
        return;
      }
      resolveExec();
    });
  });
}

async function extractZip(params: { readonly zipPath: string; readonly destDir: string }): Promise<void> {
  if (process.platform === "win32") {
    const ps: string = "powershell";
    const args: readonly string[] = ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath \\\"${params.zipPath}\\\" -DestinationPath \\\"${params.destDir}\\\" -Force`];
    await execFileAsync(ps, args);
  } else {
    await execFileAsync("unzip", ["-q", params.zipPath, "-d", params.destDir]);
  }
}

async function writeLauncher(params: { readonly binDir: string; readonly installDir: string }): Promise<void> {
  await mkdir(params.binDir, { recursive: true });
  if (process.platform === "win32") {
    const launcherPath: string = join(params.binDir, "signaler.cmd");
    const content: string = `@echo off\r\nsetlocal\r\nset \"ROOT=${params.installDir}\"\r\nnode \"%ROOT%\\dist\\bin.js\" %*\r\n`;
    await writeFile(launcherPath, content, "ascii");
  } else {
    const launcherPath: string = join(params.binDir, "signaler");
    const content: string = `#!/usr/bin/env bash\nset -euo pipefail\nROOT_DIR=\"$(cd \"$(dirname \"\${BASH_SOURCE[0]}\")/../current\" && pwd)\"\nnode \"$ROOT_DIR/dist/bin.js\" \"$@\"\n`;
    await writeFile(launcherPath, content, "utf8");
    await execFileAsync("chmod", ["+x", launcherPath]);
  }
}

function getApiUrl(repo: string, version: string): string {
  if (version === "latest") {
    return `https://api.github.com/repos/${repo}/releases/latest`;
  }
  return `https://api.github.com/repos/${repo}/releases/tags/${version}`;
}

/**
 * Upgrade or install the CLI by downloading the GitHub Release portable zip.
 *
 * @param argv - Process argv.
 */
export async function runUpgradeCli(argv: readonly string[]): Promise<void> {
  const parsed: ParsedArgs = parseArgs(argv);
  const args: UpgradeArgs = resolveDefaults(parsed);
  const apiUrl: string = getApiUrl(args.repo, args.version);
  const release: GitHubRelease = await requestJson(apiUrl);
  const asset: GitHubAsset = pickPortableAsset(release);
  const stagingDir: string = resolve(tmpdir(), `signaler-staging-${Date.now()}`);
  const zipPath: string = resolve(tmpdir(), `signaler-portable-${Date.now()}.zip`);
  await mkdir(stagingDir, { recursive: true });
  await downloadToFile({ url: asset.browser_download_url, destPath: zipPath });
  await extractZip({ zipPath, destDir: stagingDir });
  const entries: readonly string[] = await readdir(stagingDir);
  const rootName: string | undefined = entries.find((x: string) => x.trim().length > 0);
  if (!rootName) {
    throw new Error("Portable zip did not contain a root directory.");
  }
  const extractedRoot: string = join(stagingDir, rootName);
  await rm(args.installDir, { recursive: true, force: true });
  await mkdir(resolve(args.installDir, ".."), { recursive: true });
  await rename(extractedRoot, args.installDir);
  await writeLauncher({ binDir: args.binDir, installDir: args.installDir });
  await rm(stagingDir, { recursive: true, force: true });
  await rm(zipPath, { force: true });
  process.stdout.write(`Installed ${release.tag_name} to ${args.installDir}\n`);
  process.stdout.write("Run from anywhere: signaler --help\n");
  if (process.platform !== "win32") {
    process.stdout.write(`Ensure this is in your PATH: ${args.binDir}\n`);
  }
}
