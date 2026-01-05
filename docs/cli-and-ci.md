# CLI Reference and CI Integration

This document describes non-interactive CLI usage (for scripts/CI) and budget enforcement.

## 1. Commands

The CLI binary is `apex-auditor`.

Install from GitHub Releases:

1. Download the `apex-auditor-<version>.tgz` asset from the GitHub Release.
2. Install it in your project:

```bash
pnpm add -D ./apex-auditor-<version>.tgz
```

### `shell`

Interactive mode (recommended for local use):

```bash
apex-auditor shell
```

Inside the shell:

- `measure`
- `audit`
- `bundle`
- `health`
- `links`
- `headers`
- `console`
- `open`
- `open-triage`
- `open-screenshots`
- `open-diagnostics`
- `open-lhr`
- `open-artifacts`
- `pages` / `routes`
- `add-page`
- `rm-page`
- `clear-screenshots`
- `init`
- `config <path>`

Notes:

- `init` will attempt to detect your project type from `package.json`.
- In monorepos, `init` can scan `apps/*` and `packages/*` and prompt you to choose which app/package to configure.
- `init` can auto-discover routes from the filesystem and top-up from `robots.txt`/`sitemap.xml`.
- You can optionally filter detected routes with include/exclude patterns and still add manual routes. For larger route sets, the wizard may default filtering to **Yes** and prefill common excludes (framework-specific).
- Static HTML projects can be detected from HTML files under `dist/`, `build/`, `out/`, `public/`, and `src/`.
- If you use a localhost base URL (e.g. `http://localhost:3000`), ensure the dev server port matches the project you are configuring to avoid overwrites/conflicts when multiple projects are running.
- Confirmation prompts default to **Yes** on Enter (e.g. overwrite).

### `audit`

Run Lighthouse audits from a config file:

```bash
apex-auditor audit --config apex.config.json
```

Notes:

- **Runs-per-combo is always 1**.
- Accessibility is opt-in via `--accessibility-pass`.
- Progress output includes page count + ETA.

Key flags:

- `--ci`
- `--fail-on-budget`
- `--no-color` / `--color`
- `--log-level <silent|error|info|verbose>`
- `--stable` (forces parallel=1)
- `--mobile-only` / `--desktop-only`
- `--parallel <n>`
- `--audit-timeout-ms <ms>`
- `--diagnostics` / `--lhr`
- `--flags` (print audit flags/options and exit)
- `--plan` / `--max-steps <n>` / `--max-combos <n>` / `--yes`
- `--incremental --build-id <id>`
- `--focus-worst <n>` (re-run only the worst N combos from the previous `.apex-auditor/summary.json`)
- `--ai-min-combos <n>` (limit `ai-fix.min.json` to the worst N combos; default 25)
- `--no-ai-fix` (skip writing `ai-fix.json` and `ai-fix.min.json`)
- `--no-export` (skip writing `export.json`)
- `--open`
- `--json`

Outputs:

- `.apex-auditor/summary.json`
- `.apex-auditor/summary-lite.json`
- `.apex-auditor/issues.json`
- `.apex-auditor/pwa.json`
- `.apex-auditor/triage.md`
- `.apex-auditor/ai-ledger.json`
- `.apex-auditor/ai-fix.json` (unless `--no-ai-fix`)
- `.apex-auditor/ai-fix.min.json` (unless `--no-ai-fix`)
- `.apex-auditor/export.json` (unless `--no-export`)
- `.apex-auditor/lighthouse-artifacts/diagnostics/` (when `--diagnostics` or `--lhr`)
- `.apex-auditor/lighthouse-artifacts/diagnostics-lite/` (when `--diagnostics` or `--lhr`)
- `.apex-auditor/lighthouse-artifacts/lhr/` (when `--lhr`)

Note: large JSON artifacts may also be written as gzip copies (`*.json.gz`).

Exit codes:

- `0`: success
- `1`: failure (runtime error or budgets)
- `130`: cancelled (Ctrl+C). In shell mode, Esc-cancel returns you to the prompt.

## 1.1 Recommended speed workflows

For large suites, prefer a two-phase workflow:

1. Broad sweep (fast feedback): set `throttlingMethod: simulate` in `apex.config.json` and run the full suite.
2. Focused rerun (high-signal): re-run only the worst combos from the previous run using `--focus-worst <n>`. For this focused rerun, you can switch to `throttlingMethod: devtools` for a more DevTools-like rerun.

When you care about token efficiency and disk output size:

- Use `--ai-min-combos <n>` to keep `ai-fix.min.json` small.
- Use `--no-ai-fix` when you only need `issues.json` / `triage.md` and the HTML report.
- Use `--no-export` when you do not need `export.json` links or share payloads.
- Use `ai-ledger.json` as the one-run AI entry point; it includes per-combo `regressions`/`improvements` when a previous `.apex-auditor/summary.json` exists, and evidence pointers into `issues.json` and `lighthouse-artifacts/diagnostics-lite/`.
- Use `issues.json.offenders` to find repeated offenders (e.g. unused JS files) with route + artifact evidence pointers.
- Use `pwa.json` to track PWA checks (HTTPS, service worker, offline signals) across routes.

## Known issues

- **Large-run Lighthouse stability**: very large audits (many page/device combinations) may show higher score variance than manual Lighthouse runs and can intermittently hit worker/Chrome disconnects. Workaround: reduce parallelism (`--stable`) and retry.

### `measure`

Run fast CDP-based metrics:

```bash
apex-auditor measure --config apex.config.json
```

Key flags:

- `--mobile-only` / `--desktop-only`
- `--parallel <n>`
- `--timeout-ms <ms>`
- `--screenshots`
- `--json`

### `bundle`

Scan build outputs to report total JS/CSS size and the largest files.

```bash
apex-auditor bundle --project-root .
```

Key flags:

- `--project-root <path>`
- `--top <n>`
- `--json`

Output:

- `.apex-auditor/bundle-audit.json`

### `health`

Fast HTTP checks for routes from `apex.config.json`.

```bash
apex-auditor health --config apex.config.json
```

Key flags:

- `--config <path>`
- `--parallel <n>`
- `--timeout-ms <ms>`
- `--json`

Output:

- `.apex-auditor/health.json`

### `links`

Sitemap + HTML link extraction to find broken internal links.

```bash
apex-auditor links --config apex.config.json
```

Key flags:

- `--config <path>`
- `--sitemap <url>`
- `--parallel <n>`
- `--timeout-ms <ms>`
- `--max-urls <n>`
- `--json`

Output:

- `.apex-auditor/links.json`

### `headers`

Security headers presence check per configured route.

```bash
apex-auditor headers --config apex.config.json
```

Key flags:

- `--config <path>`
- `--parallel <n>`
- `--timeout-ms <ms>`
- `--json`

Output:

- `.apex-auditor/headers.json`

### `console`

Headless Chrome pass that captures console errors and uncaught exceptions.

```bash
apex-auditor console --config apex.config.json
```

Key flags:

- `--config <path>`
- `--parallel <n>`
- `--timeout-ms <ms>`
- `--max-events <n>`
- `--json`

Output:

- `.apex-auditor/console.json`

## 2. CI mode and budgets

Budgets are configured in `apex.config.json` under `budgets`.

Run in CI:

```bash
apex-auditor audit --ci --no-color
```

Behavior:

- If budgets are configured, ApexAuditor evaluates thresholds and exits non-zero on violations.
- In CI mode, ANSI color is disabled by default unless you pass `--color`.

## 3. GitHub Actions example

Minimal example (start app, wait, run audit):

```yaml
name: ApexAuditor

on:
  pull_request:

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: corepack enable
      - run: pnpm install
      - run: pnpm build
      - run: pnpm start &
      - run: npx wait-on http://localhost:3000
      - run: pnpm dlx apex-auditor@latest audit --ci --no-color
```
