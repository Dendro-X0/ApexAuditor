# Auditorix

Auditorix (formerly ApexAuditor) helps web teams move from noisy Lighthouse runs to structured, actionable insight. Auditorix combines:

- **Measure** runs for fast LCP/CLS/INP + screenshot + console captures so you can spot regressions without waiting for full Lighthouse suites.
- **Audit** runs powered by Lighthouse with AI-ready artifacts (`issues.json`, `ai-ledger.json`, `pwa.json`, `diagnostics-lite/*`, `triage.md`) plus repeat-offender evidence to pinpoint what to fix next.
- **Review** output that highlights worst combos, aggregations, and scoped routes so you can prioritize public pages while still tracking auth-only flows.

The docs wallet (this README + `docs/`) now focuses on fast iteration, high-signal evidence, and making artifacts consumable for engineers, CI, and AI helpers. Auditorix is released via GitHub Releases and JSR (no npm).

## Installation

### Registry-free (recommended)

Use the GitHub Release portable zip and installer scripts. This avoids npm/JSR entirely.

You can run the installer scripts from the unpacked portable zip.

Windows (PowerShell):

```powershell
./release-assets/install.ps1 -AddToPath
```

macOS/Linux:

```bash
./release-assets/install.sh --add-to-path
```

After installation (restart your terminal), run from any directory:

```bash
signaler --help
signaler audit --help
```

Upgrade later (no registry):

```bash
signaler upgrade
```

Tip: the installers set `SIGNALER_REPO=Dendro-X0/signaler` for you.

```bash
signaler upgrade
```

### Portable zip

You can download the portable ZIP from GitHub Releases and run it without installing.

## Most common commands

Notes:

- `init` auto-detects your stack from `package.json` (Next.js, Nuxt, Remix/React Router, SvelteKit, SPA) and can scan `apps/*` or `packages/*` inside monorepos.
- The wizard can discover routes from the filesystem plus `robots.txt`/`sitemap.xml` and lets you filter includes/excludes (default filtering may be `Yes` for large route sets).
- Static projects are discovered via HTML files in `dist/`, `build/`, `out/`, `public/`, and `src/`.
- When using a localhost base URL (e.g. `http://localhost:3000`), keep the dev server port in sync to avoid auditing a different project.

Inside the interactive shell:

- **measure**
- **audit**
- **bundle** (scan build output sizes; writes `.apex-auditor/bundle-audit.json`)
- **health** (HTTP status/latency checks; writes `.apex-auditor/health.json`)
- **links** (broken links crawl; writes `.apex-auditor/links.json`)
- **headers** (security headers check; writes `.apex-auditor/headers.json`)
- **console** (console errors + runtime exceptions; writes `.apex-auditor/console.json`)
- **open** (open the latest HTML report)
- **open-triage** (open `.apex-auditor/triage.md`)
- **open-screenshots** (open `.apex-auditor/screenshots/`)
- **open-diagnostics** (open `.apex-auditor/lighthouse-artifacts/diagnostics/`)
- **open-lhr** (open `.apex-auditor/lighthouse-artifacts/lhr/`)
- **open-artifacts** (open `.apex-auditor/lighthouse-artifacts/`)
- **pages** / **routes** (print configured pages/routes from the current config)
- **add-page** (interactive: append a page to `apex.config.json`)
- **rm-page** (interactive: remove a page from `apex.config.json`)
- **clear-screenshots** (remove `.apex-auditor/screenshots/`)
- **init** (launch config wizard)
- **config <path>** (switch config file)

Cancel long-running commands:

- **Esc** (returns you to the shell prompt)

## Install & release

### GitHub Release asset (recommended)

Download the portable zip (no registries, no package managers):

1. Download `signaler-<version>-portable.zip` from the latest GitHub Release.
2. Unzip it.
3. Run:

Windows:

```bash
release-assets\\run.cmd audit
```

macOS/Linux:

```bash
./release-assets/run.sh audit
```

This runs `node dist/bin.js` from the unpacked folder. Ensure you have Node.js installed.

If you prefer installing into an existing project, you can also use the `.tgz` asset:

1. Download the `signaler-<version>.tgz` asset from the latest GitHub Release.
2. Install it:

```bash
pnpm add -D ./signaler-<version>.tgz
```

Run the CLI with the project-local binary:

```bash
pnpm exec signaler --help
```

Note: `pnpm exec signaler` runs the version installed in your current project, which may be older than the latest release; repeat the download/`pnpm add` step whenever you need a newer build.

### JSR install (optional)

```bash
npx jsr add @auditorix/signaler
```

or (pnpm 10.9+/yarn 4.9+/deno):

```bash
pnpm add jsr:@auditorix/signaler
```

JSR installs the published artifact and keeps you pinned to the release version.

If you want a fully registry-free workflow, prefer GitHub Releases + `install.ps1`/`install.sh` + `signaler upgrade`.

## Outputs

All outputs are written under `.apex-auditor/` in your project.

Start here for a human-first prioritized list:

- `red-issues.md`

### `audit` outputs

- `summary.json`
- `summary-lite.json`
- `summary.md`
- `triage.md`
- `issues.json`
- `ai-ledger.json`
- `ai-fix.json` (unless `audit --no-ai-fix`)
- `ai-fix.min.json` (unless `audit --no-ai-fix`)
- `pwa.json`
- `export.json` (unless `audit --no-export`)
- `report.html`
- `screenshots/` (when `audit --diagnostics` or `audit --lhr` is used)
- `lighthouse-artifacts/diagnostics/` (when `audit --diagnostics` or `audit --lhr` is used)
- `lighthouse-artifacts/diagnostics-lite/` (when `audit --diagnostics` or `audit --lhr` is used)
- `lighthouse-artifacts/lhr/` (when `audit --lhr` is used)
- `accessibility-summary.json`
- `accessibility/` (axe-core artifacts per page/device)

Notes:

- **Runs-per-combo is always 1**. Re-run the same command to compare results.
- During an audit you will see a runtime progress line like `page X/Y — /path [device] | ETA ...`.
- After `audit` completes, type `open` to open the latest HTML report.
- Large JSON files may also be written as gzip copies (`*.json.gz`) to reduce disk size.
- `ai-ledger.json` is the AI-first, one-run-sufficient index. It includes `regressions`/`improvements` (when a previous `.apex-auditor/summary.json` exists) and evidence pointers into `issues.json` and `lighthouse-artifacts/diagnostics-lite/`.
- `issues.json` includes an `offenders` section that aggregates repeated offenders (for example unused JS files) and links each offender back to the exact combo(s) and artifact pointers that contain the evidence.

Speed and output controls:

- `audit --ai-min-combos <n>` limits `ai-fix.min.json` to the worst N combos (default 25).
- `audit --no-ai-fix` skips writing `ai-fix.json` and `ai-fix.min.json` entirely.
- `audit --no-export` skips writing `export.json`.
- `audit --focus-worst <n>` re-runs only the worst N combos from the previous `.apex-auditor/summary.json`.

### `measure` outputs

- `measure-summary.json`
- `measure-summary-lite.json`
- `measure/` (screenshots and artifacts)

### `bundle` outputs

- `bundle-audit.json`

### `health` outputs

- `health.json`

### `links` outputs

- `links.json`

### `headers` outputs

- `headers.json`

### `console` outputs

- `console.json`

## Configuration

ApexAuditor reads `apex.config.json` by default.

Common fields:

- `baseUrl`
- `pages` (routes + devices)
- `pages[].scope` (optional: `public` | `requires-auth`)
- `throttlingMethod` (`simulate` or `devtools`)
- `cpuSlowdownMultiplier`
- `parallel`
- `warmUp`
- `auditTimeoutMs`
- `incremental` + `buildId`
- `gitIgnoreApexAuditorDir` (auto-add `.apex-auditor/` to `.gitignore`)
- `budgets`

Example:

```json
{
  "baseUrl": "http://localhost:3000",
  "throttlingMethod": "simulate",
  "cpuSlowdownMultiplier": 4,
  "parallel": 4,
  "warmUp": true,
  "pages": [
    { "path": "/", "label": "home", "devices": ["mobile", "desktop"], "scope": "public" },
    { "path": "/account", "label": "account", "devices": ["mobile"], "scope": "requires-auth" },
    { "path": "/docs", "label": "docs", "devices": ["desktop"], "scope": "public" }
  ],
  "budgets": {
    "categories": { "performance": 80, "accessibility": 90, "bestPractices": 90, "seo": 90 },
    "metrics": { "lcpMs": 2500, "inpMs": 200, "cls": 0.1 }
  }
}
```

## CLI tips

- Use `audit --flags` to print all audit flags/options.
- Use `audit --diagnostics` or `audit --lhr` when you want per-combo JSON artifacts and screenshots.
- Start with `triage.md` and `issues.json` when the suite is large.

Recommended workflow for large suites:

- Run a broad sweep with `throttlingMethod: simulate` (fast feedback).
- Then re-run only the worst routes with `audit --focus-worst <n>` and `throttlingMethod: devtools` for a more DevTools-like focused rerun.
- If parallel mode flakes (Chrome disconnects / Lighthouse target errors), retry with `audit --stable` (forces parallel=1).

## Documentation

The docs in `docs/` reflect the current shell-based workflow:

- `docs/getting-started.md`
- `docs/configuration-and-routes.md`
- `docs/cli-and-ci.md`

## Known issues

- **Large-run Lighthouse stability**: very large audits (many page/device combinations) may show higher score variance than manual Lighthouse runs and can intermittently hit worker/Chrome disconnects. Workaround: reduce parallelism (e.g. `--stable`) and retry.

## License

MIT
