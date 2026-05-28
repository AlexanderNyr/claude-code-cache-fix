# Review: release v3.7.1

Date: 2026-05-28
Reviewed: `b01713e` on `main`
Label applied: `changes-requested`

## What Is Correct

- `git log --oneline v3.7.0..b01713e` contains the merged v3.7.1 work plus the separate README contributor-credit commit `2ff631d`. The `## [3.7.1]` changelog section fully covers the user-visible release work, and omitting the contributor-credit commit is appropriate.
- The release diff is cleanly scoped to the bootstrap-defense implementation, tests, release docs, `README.md`, `CHANGELOG.md`, and `package.json`. I did not find accidentally committed debug logging, `TODO`/`FIXME` markers, secrets, or local-only patches in `v3.7.0..b01713e`.
- The current worktree has only the expected untracked `.possibilities/` directory and local `package-lock.json`. Neither is tracked release content, and neither appears in the packaged tarball.
- The `proxy/extensions.json` normalization strategy is sound. After `git show HEAD:proxy/extensions.json > proxy/extensions.json`, the file is the compact 1044-byte committed form, and `npm pack --dry-run --json` includes `proxy/extensions.json` at 1044 bytes, not a deployment-local expanded variant.
- Tarball shape is sane. `npm pack --dry-run --json` reports `claude-code-cache-fix-3.7.1.tgz` with 60 entries, limited to runtime/package assets; local artifacts and review docs are not packaged.

## Blockers

- The version bump is patch when the documented policy calls for minor. `docs/release-workflow.md` classifies "new env var" and "new opt-in behavior" as minor-release triggers, and this release adds both: `CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS` is new, and `CACHE_FIX_BOOTSTRAP_MODE=allowlist` adds a new opt-in behavior. The release also expands the bootstrap audit schema from v1 to v2. The changelog, README, and directive all describe these as new release-scope capabilities, so `3.7.1` does not match the current written semver policy.

## What Needs Attention

- The handoff note expected a dirty local `proxy/extensions.json`, but this checkout was already clean on that path. The canonical reset still verified the right packaging path, so this is not a release issue.
- `docs/release-workflow.md` still says the version-bump step updates `package-lock.json`, but this repo does not track that file. That did not affect this release commit, but the workflow text remains inaccurate.

## Recommendations

- Either bump this release to `3.8.0` before tagging/publish, or amend `docs/release-workflow.md` to explicitly allow this category of backward-compatible bootstrap-defense expansion as patch-eligible before approving `3.7.1`.
- Keep `git show HEAD:proxy/extensions.json > proxy/extensions.json` in the packaging path. It correctly normalizes deployment-local state before `npm pack`.

## Bottom Line

Revise before tagging or publishing. The packaged artifact, changelog coverage, and release hygiene all check out, but the version number does not conform to the repo's current semver policy, so I cannot approve `v3.7.1` without either a minor-version bump or a documented policy exception.
