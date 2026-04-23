# Review: corporate proxy and CA support

Date: 2026-04-23
Reviewed: PR #54 implementation on commit 08b428d
Label applied: changes-requested

## What Is Correct
- The upstream forwarder now has a concrete path for honoring corporate HTTP proxy settings and custom CA bundles.
- The new focused upstream tests are a good addition and validate the basic HTTPS proxy and `NO_PROXY` behavior for the default Anthropic upstream path.
- Documentation for corporate environments is useful and clearly explains the intended operator setup.

## Blockers
- `proxy/config.mjs:27-28` collapses `HTTPS_PROXY` and `HTTP_PROXY` into a single `httpProxy` value chosen at module load, with `HTTPS_PROXY` taking precedence unconditionally. That means a plain-HTTP upstream (`CACHE_FIX_PROXY_UPSTREAM=http://...`) will still prefer `HTTPS_PROXY` when both vars are set, which is not standard proxy-env behavior and does not match the PR's "Honor HTTPS_PROXY / NO_PROXY ..." framing. The current tests only exercise the default HTTPS upstream path, so this regression is not covered.

## What Needs Attention
- `npm pack --dry-run` now includes `proxy/upstream.test.mjs` in the published tarball because `package.json` ships the whole `proxy/` directory. That is avoidable package bloat and publishes test-only code unnecessarily.

## Recommendations
- Select proxy environment variables by upstream protocol: use `HTTPS_PROXY` for `https:` upstreams and `HTTP_PROXY` for `http:` upstreams, with the usual lowercase fallbacks and `NO_PROXY` applied after that selection.
- Move the new upstream test under the normal test tree or otherwise exclude it from the published package.

## Bottom Line
The feature is useful and mostly well-scoped, but I would not approve it yet. Proxy-variable selection still appears wrong for plain-HTTP upstreams, and the new test file is being shipped in the npm artifact.
