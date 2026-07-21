### Task 3: Final validation and commit

**Files:**

- Modify: files from Tasks 1 and 2 only.

- [ ] **Step 1: Run static and automated validation**

Run: `npm run check`

Expected: all unit tests, type checks, release checks, and bundle checks pass.

- [ ] **Step 2: Run browser/MV3 validation**

Run: `npm run test:browser`

Expected: all browser and MV3 tests pass.

- [ ] **Step 3: Commit only this feature's files**

```bash
git add manifest.json src/background.ts src/unavailable-notice.ts tests/unavailable-notice.test.ts scripts/check-release.ts tests/design.test.ts docs/superpowers/specs/2026-07-20-restricted-page-notification-design.md docs/superpowers/plans/2026-07-20-restricted-page-notification.md
git commit -m "feat: notify when Quick Note cannot open"
```

Do not stage unrelated worktree changes.
