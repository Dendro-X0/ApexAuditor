# Configuration

This document describes the `apex.config.json` format.

## 1. ApexConfig shape

Key points:

- `pages` defines which routes to check and which devices to run against.
- **Runs-per-combo is always 1**. Re-run the same command to compare results.
- Budgets are optional and are used for CI gating.

Minimal example:

```json
{
  "baseUrl": "http://localhost:3000",
  "pages": [
    { "path": "/", "label": "home", "devices": ["mobile", "desktop"] }
  ]
}
```

Common fields:

- `baseUrl`
- `query` (optional query string appended to every URL)
- `throttlingMethod` (`simulate` or `devtools`)
- `cpuSlowdownMultiplier` (default 4)
- `parallel` (optional; the CLI will auto-tune a sensible default)
- `warmUp` (optional)
- `auditTimeoutMs` (optional per-audit timeout)
- `incremental` + `buildId` (optional cache reuse)
- `gitIgnoreApexAuditorDir` (optional; when true, Signaler appends `.apex-auditor/` to `.gitignore` if a `.gitignore` exists)
- `budgets` (optional)

## Route auto-detection notes

When the init wizard auto-detects routes, Signaler filters out unresolved dynamic route patterns to avoid inaccurate audits.

Examples that are excluded:

- Next.js/Remix-style: `[slug]`, `[...catchall]`
- Express-style: `:id`
- Wildcards: `*`

## 2. Pages

Each page entry:

```json
{ "path": "/pricing", "label": "pricing", "devices": ["mobile", "desktop"] }
```

Optional fields:

- `scope`: `public` (default) or `requires-auth`

Notes:

- Pages marked `requires-auth` are still audited and appear in per-combo outputs, but they are excluded from global suite scoring and aggregated issue counts.

Rules:

- `path` must start with `/`.
- `label` is used in reports.
- `devices` is a list of `mobile` and/or `desktop`.

## 3. Budgets

Budgets gate CI.

Example:

```json
{
  "baseUrl": "http://localhost:3000",
  "pages": [{ "path": "/", "label": "home", "devices": ["mobile"] }],
  "budgets": {
    "categories": { "performance": 90, "accessibility": 95, "bestPractices": 90, "seo": 90 },
    "metrics": { "lcpMs": 2500, "inpMs": 200, "cls": 0.1 }
  }
}
```

Rules:

- Category budgets are minimum scores (0-100).
- Metric budgets are maximum values.

## 4. Warm-up

Set `warmUp: true` to run a lightweight warm-up request pass before Lighthouse audits.

## 5. Incremental caching

Incremental mode reuses cached results for unchanged combos between runs.

- Set `incremental: true`.
- Provide a `buildId` (string).

See `cli-and-ci.md` for recommended CI usage.
