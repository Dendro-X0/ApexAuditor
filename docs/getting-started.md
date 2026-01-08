# Getting Started

Signaler (formerly ApexAuditor) is a **measure-first** performance + metrics assistant.

Typical workflow:

1. Run the interactive shell.
2. Use `measure` for fast feedback.
3. Use `audit` for deep Lighthouse analysis.
4. Use `bundle` to quickly sanity-check build output sizes.
5. Use `health` to validate routes are up and reasonably fast.
6. Type `open` to review the latest HTML report.

Helpful navigation shortcuts:

- `open-triage` opens `.apex-auditor/triage.md`
- `open-screenshots` opens `.apex-auditor/screenshots/`
- `open-diagnostics` opens `.apex-auditor/lighthouse-artifacts/diagnostics/`
- `open-lhr` opens `.apex-auditor/lighthouse-artifacts/lhr/`

Optional audits:

- `links` (broken links crawl)
- `headers` (security headers)
- `console` (console errors + runtime exceptions)

## 1. Install / run

Registry-free installation (recommended):

1. Download `signaler-<version>-portable.zip` from GitHub Releases.
2. Unzip it.
3. Run the installer script from the unpacked folder:

Windows (PowerShell):

```powershell
./release-assets/install.ps1 -AddToPath
```

macOS/Linux:

```bash
./release-assets/install.sh --add-to-path
```

Upgrade later (no registry):

```bash
signaler upgrade
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

Optional capture flags:

- `audit --diagnostics`: capture DevTools-like Lighthouse tables and save screenshots.
- `audit --lhr`: also save the full Lighthouse result JSON per page/device (implies `--diagnostics`).

During an audit:

- A warm-up step may run first (if enabled).
- You will see a runtime progress line like `page X/Y — /path [device] | ETA ...`.
- Press **Esc** to cancel and return to the shell prompt.

Outputs:

- `.apex-auditor/summary.json`
- `.apex-auditor/summary-lite.json`
- `.apex-auditor/summary.md`
- `.apex-auditor/triage.md`
- `.apex-auditor/issues.json`
- `.apex-auditor/red-issues.md`
- `.apex-auditor/pwa.json`
- `.apex-auditor/ai-fix.json` (unless `audit --no-ai-fix`)
- `.apex-auditor/ai-fix.min.json` (unless `audit --no-ai-fix`)
- `.apex-auditor/export.json` (unless `audit --no-export`)
- `.apex-auditor/report.html`
- `.apex-auditor/screenshots/` (when `--diagnostics` or `--lhr` is enabled)
- `.apex-auditor/lighthouse-artifacts/diagnostics/` (when `--diagnostics` or `--lhr` is enabled)
- `.apex-auditor/lighthouse-artifacts/diagnostics-lite/` (when `--diagnostics` or `--lhr` is enabled)
- `.apex-auditor/lighthouse-artifacts/lhr/` (when `--lhr` is enabled)
- `.apex-auditor/accessibility-summary.json`
- `.apex-auditor/accessibility/` (axe-core artifacts per page/device)

Notes:

- Start with `triage.md` and `issues.json` when the suite is large.
- For PWA-specific checks (HTTPS, service worker, offline signals), use `pwa.json`.
- Large JSON files may also be written as gzip copies (`*.json.gz`) to reduce disk size.

Speed and output controls:

- `audit --focus-worst <n>` re-runs only the worst N combos from the previous run.
- `audit --ai-min-combos <n>` limits `ai-fix.min.json` to the worst N combos (default 25).
- `audit --no-ai-fix` and `audit --no-export` can skip writing large artifacts.
- If parallel mode flakes (Chrome disconnects / Lighthouse target errors), retry with `audit --stable` (forces parallel=1).

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
