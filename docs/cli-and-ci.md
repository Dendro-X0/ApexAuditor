# CLI Reference and CI Integration

This document describes non-interactive CLI usage (for scripts/CI) and budget enforcement.

## 1. Commands

The CLI binary is `apex-auditor`.

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
- `init`
- `config <path>`

Notes:

- `init` will attempt to detect your project type from `package.json`.
- In monorepos, `init` can scan `apps/*` and `packages/*` and prompt you to choose which app/package to configure.
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
- `--plan` / `--max-steps <n>` / `--max-combos <n>` / `--yes`
- `--incremental --build-id <id>`
- `--open`
- `--json`

Exit codes:

- `0`: success
- `1`: failure (runtime error or budgets)
- `130`: cancelled (Ctrl+C). In shell mode, Esc-cancel returns you to the prompt.

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
