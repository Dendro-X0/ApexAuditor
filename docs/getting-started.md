# Getting Started

ApexAuditor is a **measure-first** performance + metrics assistant.

Typical workflow:

1. Run the interactive shell.
2. Use `measure` for fast feedback.
3. Use `audit` for deep Lighthouse analysis.
4. Use `bundle` to quickly sanity-check build output sizes.
5. Use `health` to validate routes are up and reasonably fast.
6. Type `open` to review the latest HTML report.

Optional audits:

- `links` (broken links crawl)
- `headers` (security headers)
- `console` (console errors + runtime exceptions)

## 1. Install / run

From your web project root:

```bash
pnpm dlx apex-auditor@latest
```

Or install as a dev dependency:

```bash
pnpm add -D apex-auditor
pnpm apex-auditor
```

Prerequisites:

- Your app must be reachable at a stable URL (for example `http://localhost:3000`).

## 2. Create a config

Inside the shell:

```text
> init
```

The wizard creates or updates `apex.config.json`.

You can also point the shell at a different config file:

```text
> config path/to/apex.config.json
```

## 3. Measure (fast)

```text
> measure
```

This is a CDP-based pass (non-Lighthouse) designed for quick iteration.

Outputs:

- `.apex-auditor/measure-summary.json`
- `.apex-auditor/measure/` (screenshots and artifacts)

## 4. Audit (Lighthouse)

```text
> audit
```

During an audit:

- A warm-up step may run first (if enabled).
- You will see a runtime progress line like `page X/Y — /path [device] | ETA ...`.
- Press **Esc** to cancel and return to the shell prompt.

Outputs:

- `.apex-auditor/summary.json`
- `.apex-auditor/summary.md`
- `.apex-auditor/report.html`
- `.apex-auditor/accessibility-summary.json`
- `.apex-auditor/accessibility/` (axe-core artifacts per page/device)

## 5. Bundle (build output sizes)

```text
> bundle
```

Output:

- `.apex-auditor/bundle-audit.json`

## 6. Health (HTTP checks)

```text
> health
```

Output:

- `.apex-auditor/health.json`

## 7. Links (broken links crawl)

```text
> links
```

Output:

- `.apex-auditor/links.json`

## 8. Headers (security headers)

```text
> headers
```

Output:

- `.apex-auditor/headers.json`

## 9. Console (runtime errors)

```text
> console
```

Output:

- `.apex-auditor/console.json`

Notes:

- **Runs-per-combo is always 1**. Re-run the same command to compare results.
- The report includes Performance, Accessibility, Best Practices, and SEO.

## 10. Open the report

```text
> open
```

## 11. Next steps

- `configuration-and-routes.md` for config details.
- `cli-and-ci.md` for non-interactive CLI usage and CI/budgets.
