# Changelog

## 0.3.0 - 2025-12-29

### Added
- Auto-tuned parallel default that respects CPU/memory and falls back to 1 when attaching to an external Chrome instance.
- ETA-aware progress output in the CLI for audit runs.
- `--show-parallel` flag to print the resolved parallel worker count before execution.
- Structured meta in outputs: Markdown now includes a meta table; HTML report now shows a meta grid (parallel, throttling, timings, etc.).
- Console output now prints run meta (parallel, warm-up, throttling, CPU slowdown, combos, timings).

### Documentation
- README documents `--show-parallel` and the enriched Markdown/HTML outputs.
- Wizard copy notes auto-parallel defaults and how to override/inspect them.

### Tests
- `pnpm test` (vitest) passing.
