// source-fingerprint — the content answer to "is the running proxy stale?"
//
// The check this replaces compared the newest MTIME under proxy/ against the
// service start time, and its comment declared that a defensible exception:
// "what the process holds in memory is not hashable, so here the label is the
// whole truth". On 2026-07-28 it reported "still running old code" because a
// bite test restored a file from a backup — same bytes, new mtime. The label
// was not the whole truth, and the false alarm is the expensive half: it
// trains its reader to discount the warning that will one day be real.
//
// So the properties below are the whole point, not incidental:
//   - identical bytes at a different mtime  -> SAME fingerprint
//   - one changed byte anywhere             -> DIFFERENT fingerprint
// The rest pins the details a second reader might otherwise assume.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sourceFingerprint } from "../proxy/source-fingerprint.mjs";

async function tree(spec) {
  const root = await mkdtemp(join(tmpdir(), "cache-fix-fp-"));
  for (const [rel, content] of Object.entries(spec)) {
    const full = join(root, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

test("fingerprint: identical content is identical regardless of MTIME", async () => {
  // The exact false positive that motivated the replacement.
  const root = await tree({ "a.mjs": "export const x = 1;\n", "sub/b.mjs": "// b\n" });
  try {
    const before = await sourceFingerprint(root);

    // Rewrite both files with the SAME bytes and push their mtimes far into
    // the future — what `cp`, `git checkout` and a backup restore all do.
    await writeFile(join(root, "a.mjs"), "export const x = 1;\n");
    await writeFile(join(root, "sub/b.mjs"), "// b\n");
    const future = new Date(Date.now() + 86_400_000);
    await utimes(join(root, "a.mjs"), future, future);
    await utimes(join(root, "sub/b.mjs"), future, future);

    assert.equal(await sourceFingerprint(root), before, "touching bytes-identical files must be silent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fingerprint: BITE — a single changed byte is caught", async () => {
  const root = await tree({ "a.mjs": "export const x = 1;\n", "sub/b.mjs": "// b\n" });
  try {
    const before = await sourceFingerprint(root);
    await writeFile(join(root, "sub/b.mjs"), "// c\n");
    assert.notEqual(await sourceFingerprint(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fingerprint: BITE — an added or removed file is caught", async () => {
  const root = await tree({ "a.mjs": "x\n" });
  try {
    const before = await sourceFingerprint(root);
    await writeFile(join(root, "new.mjs"), "y\n");
    const added = await sourceFingerprint(root);
    assert.notEqual(added, before, "a new extension file must change the fingerprint");
    await rm(join(root, "new.mjs"));
    assert.equal(await sourceFingerprint(root), before, "removing it must restore the old value");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Content is hashed per PATH, so moving a file is a change even though the
// bytes in the tree are unchanged — an extension that moves between
// directories is loaded differently, or not at all.
test("fingerprint: renaming a file changes the fingerprint even though bytes are unchanged", async () => {
  const root = await tree({ "a.mjs": "same\n" });
  try {
    const before = await sourceFingerprint(root);
    await rm(join(root, "a.mjs"));
    await writeFile(join(root, "b.mjs"), "same\n");
    assert.notEqual(await sourceFingerprint(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fingerprint: node_modules and dot-directories are excluded", async () => {
  const root = await tree({ "a.mjs": "x\n" });
  try {
    const before = await sourceFingerprint(root);
    await mkdir(join(root, "node_modules/pkg"), { recursive: true });
    await writeFile(join(root, "node_modules/pkg/index.js"), "vendored\n");
    await mkdir(join(root, ".cache"), { recursive: true });
    await writeFile(join(root, ".cache/junk"), "junk\n");
    assert.equal(
      await sourceFingerprint(root),
      before,
      "dependency and cache churn must not read as a proxy source change",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fingerprint: stable across calls, and a hex digest", async () => {
  const root = await tree({ "a.mjs": "x\n", "z/y.mjs": "z\n" });
  try {
    const fp = await sourceFingerprint(root);
    assert.equal(fp, await sourceFingerprint(root));
    assert.match(fp, /^[0-9a-f]{12}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
