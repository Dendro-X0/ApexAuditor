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
- `open`
- `init`
- `config <path>`

### `audit`

Run Lighthouse audits from a config file:

```bash
apex-auditor audit --config apex.config.json
```

Notes:

- **Runs-per-combo is always 1**.
- Accessibility is always included (axe-core pass + summary artifacts).
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
- `--json`

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
