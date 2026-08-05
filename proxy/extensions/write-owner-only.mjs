import { appendFile as _appendFile, chmod as _chmod, writeFile as _writeFile } from "node:fs/promises";
import { appendFileSync, chmodSync, writeFileSync } from "node:fs";

// Owner-only (0600) writes for conversation-derived state.
//
// WHAT THIS GUARANTEES. Every file the proxy writes under the user's
// Claude config root whose content is derived from live traffic —
// message bytes, request/response bodies, system-prompt text, and the
// stable session identifiers that link a record back to a conversation —
// is readable and writable by its owner alone.
//
// WHY. Without an explicit mode these files land at the ambient umask:
// 0664 or 0644, i.e. group- or world-readable. The threat is not a
// remote attacker; it is that ~/.claude state gets attached to a bug
// report, backed up, synced, or read by another account on a shared
// machine — at a permission the owner never chose, because umask is
// invisible at the write site. Reported as a series-wide finding across
// three PRs writing the same shape (#272 canon content, #275 request
// bodies, #280 system-prompt text), so it is fixed once, here.
//
// TWO MECHANISMS, because neither covers the other's case:
//
//   1. `mode` at CREATE. Node applies the `mode` option only when the
//      write actually creates the file. Passing it means a new file is
//      never, not even briefly, group-readable — there is no window
//      between creation and a repair.
//   2. A lazy chmod, once per path per process. This is what fixes files
//      created before this module existed, and the rare umask that masks
//      bits out of the create mode (chmod ignores umask; the `mode`
//      option does not). It is deliberately NOT a startup sweep: a sweep
//      would have to guess the file set and would touch state nobody
//      writes again. Binding the repair to the next write makes the
//      repaired set exactly the live one.
//
// ATOMIC WRITERS (tmp + rename) need only mechanism 1, which is why the
// write helpers below take no repair path. The tmp file is always freshly
// created, so it is born 0600, and the rename carries that mode onto the
// final path — replacing a loose mode on an existing final file for free.
// Log rotation (`rename(path, path + ".1")`) preserves mode the same way.

export const OWNER_ONLY = 0o600;

// Paths already repaired in this process. Bounded by the number of
// distinct state files a single proxy process touches, which is a handful
// per session — not the unbounded per-request growth a cache would be.
const repaired = new Set();

// Repair an existing file's mode once per path per process. Best-effort by
// design: a chmod failure must never fail the write that triggered it —
// the file is written either way, and losing telemetry to a permissions
// error would be a worse outcome than a stale mode. ENOENT is the normal
// case on first write (the file does not exist yet) and is not a problem:
// the create mode already covered it.
export async function ensureOwnerOnly(path, fs) {
  if (repaired.has(path)) return;
  repaired.add(path);
  try {
    await (fs?.chmod ?? _chmod)(path, OWNER_ONLY);
  } catch {
    // Intentionally silent — see above.
  }
}

function repairOnceSync(path) {
  if (repaired.has(path)) return;
  repaired.add(path);
  try {
    chmodSync(path, OWNER_ONLY);
  } catch {
    // Intentionally silent — see above.
  }
}

/**
 * Write a file owner-only. Intended for the tmp half of a tmp+rename
 * atomic write, where the target is newly created every time.
 *
 * `fs` is the injected filesystem seam the call sites already carry
 * (DEFAULT_FS objects with a `writeFile`); it defaults to node's promises
 * API for the sites that import the functions directly.
 */
export async function writeFileOwnerOnly(path, data, fs) {
  const writeFn = fs?.writeFile ?? _writeFile;
  await writeFn(path, data, { mode: OWNER_ONLY });
}

/**
 * Append to a file owner-only, repairing a stale mode on this process's
 * first append to the path.
 */
export async function appendFileOwnerOnly(path, data, fs) {
  const appendFn = fs?.appendFile ?? _appendFile;
  await ensureOwnerOnly(path, fs);
  await appendFn(path, data, { mode: OWNER_ONLY });
}

/** Synchronous counterpart of `writeFileOwnerOnly`. */
export function writeFileSyncOwnerOnly(path, data) {
  writeFileSync(path, data, { mode: OWNER_ONLY });
}

/** Synchronous counterpart of `appendFileOwnerOnly`. */
export function appendFileSyncOwnerOnly(path, data) {
  repairOnceSync(path);
  appendFileSync(path, data, { mode: OWNER_ONLY });
}

/** Test seam: forget the per-process repair memo. */
export function _resetRepairMemo() {
  repaired.clear();
}
