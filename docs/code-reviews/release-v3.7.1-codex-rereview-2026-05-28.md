# Review: release v3.7.1 re-review

Date: 2026-05-28
Reviewed: `v3.7.1` release artifacts at `b01713e`, re-reviewed under `docs/release-workflow.md` amendment `aefd1c3`
Label applied: `approved-by-codex-agent`

## What Is Correct

- The amended workflow doc at `aefd1c3` now makes the release-stage policy explicit: a patch release may carry new env vars and an opt-in mode only when the four security-extension carve-out conditions all hold, and it cites v3.7.1 as the precedent.
- **Same feature:** the release extends the existing `bootstrap-defense` extension in place. The directive scope says "Extend `bootstrap-defense` in-place," the implementation change is in `proxy/extensions/bootstrap-defense.mjs`, and `proxy/extensions.json` is unchanged. No new extension file or new pipeline binding was introduced.
- **Same threat class:** the directive, issue #153, and implementation all stay on the same `/api/claude_cli/bootstrap` response-body channel. The extension still binds `routes: ["bootstrap"]`, still uses the same audit/log/optional block defensive family, and still writes to `~/.claude/cache-fix-bootstrap-log.jsonl`.
- **Defaults unchanged on upgrade:** v3.7.0 and v3.7.1 both resolve the default mode to `audit`. `block` still short-circuits with an empty 200 from `onRequest`. The new `allowlist` behavior only activates when `CACHE_FIX_BOOTSTRAP_MODE=allowlist`, and `CACHE_FIX_BOOTSTRAP_ALLOWED_KEYS` is only consulted on that opt-in path.
- **Directive explicitly endorsed patch scope:** issue #153 bodies the release as "`v3.7.1 patch` — security extension of an existing v3.7.0 feature ... same threat class." The AI Team Lead's directive-stage answer explicitly reaffirmed that patch releases should not change defaults and approved `allowlist` only as an opt-in mode. That rationale was on record before implementation began.
- The prior release-stage objection at `ef6e11d` was grounded in the then-current written workflow. Under the amended workflow language now on `main`, that objection is resolved rather than contradicted.

## Blockers

None.

## What Needs Attention

- Keep the carve-out narrow. If a future release adds a new top-level extension, changes the default posture, or expands beyond the existing bootstrap-defense threat channel, it should go back to minor-release treatment.

## Recommendations

- Approve `v3.7.1` under the amended workflow and rescind the prior release-stage `changes-requested` status.

## Bottom Line

Approve. The workflow amendment at `aefd1c3` closes the policy gap that triggered my earlier release-stage pushback, and the shipped v3.7.1 artifacts satisfy all four carve-out conditions on the merits: same extension surface, same bootstrap threat class, unchanged defaults with opt-in additions only, and explicit patch-scope endorsement in the directive record before implementation.
