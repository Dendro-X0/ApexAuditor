# ApexAuditor

ApexAuditor is a **measure-first** performance + metrics assistant.

Use it to:

- **Measure fast** (CDP-based): LCP/CLS/INP + screenshot + console errors.
- **Audit deep** (Lighthouse): Performance + Accessibility + Best Practices + SEO.
- **Review results** in a clean, structured console output and an HTML report.

## Most common commands

From your web project root:

```bash
pnpm dlx apex-auditor@latest
```

Notes:

- `init` can auto-detect your stack from `package.json` (Next.js, Nuxt, Remix/React Router, SvelteKit, SPA).
- In monorepos, `init` can prompt you to pick an app/package under `apps/` or `packages/`.

Inside the interactive shell:

- **measure**
- **audit**
- **bundle** (scan build output sizes; writes `.apex-auditor/bundle-audit.json`)
- **health** (HTTP status/latency checks; writes `.apex-auditor/health.json`)
- **links** (broken links crawl; writes `.apex-auditor/links.json`)
- **headers** (security headers check; writes `.apex-auditor/headers.json`)
- **console** (console errors + runtime exceptions; writes `.apex-auditor/console.json`)
- **open** (open the latest HTML report)
- **init** (launch config wizard)
- **config <path>** (switch config file)

Cancel long-running commands:

- **Esc** (returns you to the shell prompt)

## Install

Install as a dev dependency (recommended):

```bash
pnpm add -D apex-auditor
```

Or run without installing:

```bash
pnpm dlx apex-auditor@latest
```

## Outputs

All outputs are written under `.apex-auditor/` in your project.

### `audit` outputs

- `summary.json`
- `summary.md`
- `report.html`
- `accessibility-summary.json`
- `accessibility/` (axe-core artifacts per page/device)

Notes:

- **Runs-per-combo is always 1**. Re-run the same command to compare results.
- During an audit you will see a runtime progress line like `page X/Y — /path [device] | ETA ...`.
- After `audit` completes, type `open` to open the latest HTML report.

### `measure` outputs

- `measure-summary.json`
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

Example:

```json
{
  "baseUrl": "http://localhost:3000",
  "throttlingMethod": "simulate",
  "cpuSlowdownMultiplier": 4,
  "parallel": 4,
  "warmUp": true,
  "pages": [
    { "path": "/", "label": "home", "devices": ["mobile", "desktop"] },
    { "path": "/docs", "label": "docs", "devices": ["desktop"] }
  ],
  "budgets": {
    "categories": { "performance": 80, "accessibility": 90, "bestPractices": 90, "seo": 90 },
    "metrics": { "lcpMs": 2500, "inpMs": 200, "cls": 0.1 }
  }
}
```

## Documentation

The docs in `docs/` reflect the current shell-based workflow:

- `docs/getting-started.md`
- `docs/configuration-and-routes.md`
- `docs/cli-and-ci.md`

## License

MIT
