<!-- Title: Conventional Commits — e.g. feat(parser): build abstractNum → num → pStyle map -->

## Why
<!-- motivation: what problem, why now -->

## What
<!-- high-level summary + user-facing outcome; the code carries the detail -->

## Testing
- [ ] `pnpm test` passes (unit, no DB)
- [ ] `pnpm test:integration` passes (PostgreSQL; `pnpm migrate && pnpm seed` first)
- [ ] `pnpm lint` clean (eslint + `tsc --noEmit` + `prettier --check`)
- [ ] New behavior covered by a test at the module API boundary; bug-fixes pinned with a named regression test
- [ ] Manual verification: <steps>
- [ ] CI green

🤖 Co-authored by Claude. Closes #
