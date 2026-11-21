'use strict';
// Cross-process lock for mutating runs (plan §9 `P8`, §5 limitation 32, finding F8).
//
// Before this file existed, two agent sessions — or a human plus an automation run — could interleave
// archive / remove / install against one state directory: `fsx.writeJSON` is tmp+rename, so the writes
// themselves stayed whole, but archive stamp ordering silently interleaved and the ledger became
// last-writer-wins. Nothing here makes a concurrent run *safe*; it makes it impossible to start.
//
// The limitation the plan accepts instead of solving (row 32): a lock is itself a failure mode on the
// destructive path, because a crashed or hung run keeps later runs out. Two things answer that, and both
// are behaviour you can observe rather than a promise in a comment:
//   * staleness is judged by **pid liveness**, never by age. A run killed with SIGKILL leaves a lock whose
//     pid is gone, and the next run takes it over — reporting the takeover instead of pretending it
//     acquired a clean lock.
//   * a refusal against a **live** holder prints the pid, what that run is doing, and the exact takeover
//     command. `--force-unlock` runs that command for you when you have decided the holder is hung.
//
// Ordering rail (§10.5): `O1` had to land first, because a prompt that can hang while holding a lock is
// strictly worse than no lock at all. It did (EOF resolves as a refusal), so this file is allowed to exist.
//
// Read-only verbs never take the lock: `doctor`, `status`, `detect` and every `--dry-run` are safe to run
// beside a live install, and blocking them would turn a safety net into an outage.

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK_NAME = 'install.lock';

function lockPathIn(dir) { return path.join(dir, LOCK_NAME); }

function readLock(lockPath) {
  try { return JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { return null; }
}

// Is that pid a process right now? `kill(pid, 0)` asks without signalling. EPERM means the pid exists but
// belongs to someone else — that is a live holder, and deleting its lock would let two runs write at once.
function holderAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// The line the refusal prints, and the only documented way past a live holder. Exact so it can be
// copy-pasted, and identical to what `--force-unlock` does.
function takeoverCommand(verb) { return `asbmods ${verb} --force-unlock`; }

function describe(holder) {
  if (!holder) return 'unreadable lock file';
  const bits = [];
  if (holder.pid) bits.push(`pid ${holder.pid}`);
  if (holder.verb) bits.push(`running "${holder.verb}"`);
  if (holder.startedAt) bits.push(`since ${holder.startedAt}`);
  if (holder.host) bits.push(`host ${holder.host}`);
  return bits.length ? bits.join(', ') : 'unreadable lock file';
}

/**
 * Take the lock for a mutating run.
 *
 * @param {object} opts
 * @param {string} opts.dir    state directory holding the lock file
 * @param {string} opts.verb   what this run is doing (recorded, and printed by a refusal)
 * @param {boolean} [opts.dryRun]   dry runs mutate nothing, so they neither take nor need the lock
 * @param {boolean} [opts.force]    take over from a live holder (the documented escape, always reported)
 * @param {string} [opts.host]      hostname for the record (defaults to os.hostname())
 * @returns {{acquired: boolean, lockPath?: string, dryRun?: boolean, tookStale?: object|null,
 *            held?: object, alive?: boolean, release?: () => boolean, error?: string}}
 */
function acquire(opts) {
  const { dir, verb, dryRun = false, force = false } = opts;
  const lockPath = lockPathIn(dir);
  if (dryRun) return { acquired: false, dryRun: true, lockPath };

  fs.mkdirSync(dir, { recursive: true });
  const mine = {
    pid: process.pid, verb, startedAt: new Date().toISOString(), host: opts.host || os.hostname(),
  };
  let tookStale = null;

  // Three attempts because a competitor can create, or clear, the file between our failed create and our
  // retry. Each pass either creates the lock or clears a holder we are allowed to clear.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Exclusive create: 'wx' fails with EEXIST rather than truncating someone else's record. This is the
      // primitive finding F8 says was missing.
      const fd = fs.openSync(lockPath, 'wx');
      try { fs.writeSync(fd, `${JSON.stringify(mine, null, 2)}\n`); } finally { fs.closeSync(fd); }
      return { acquired: true, lockPath, tookStale, release: () => release(lockPath, mine.pid) };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const held = readLock(lockPath);
      const alive = holderAlive(held ? held.pid : null);
      if (alive && !force) return { acquired: false, lockPath, held: held || { pid: null }, alive };
      // Either the holder's pid is gone (crash, SIGKILL) or --force-unlock decided for us. Both are
      // reported by the caller: an unannounced takeover would hide exactly the interleaving we prevent.
      tookStale = Object.assign({ alive, forced: alive && force }, held || {});
      fs.rmSync(lockPath, { force: true });
    }
  }
  return { acquired: false, lockPath, error: 'could not take the lock after 3 attempts — another run is creating it as fast as it is cleared' };
}

// Release only a lock that is still ours. If our own record is gone or names a different pid, something
// else holds it now and deleting that would reintroduce the interleaving this file exists to stop.
function release(lockPath, pid) {
  const held = readLock(lockPath);
  if (held && held.pid !== pid) return false;
  try { fs.rmSync(lockPath, { force: true }); return true; } catch { return false; }
}

module.exports = { acquire, release, holderAlive, readLock, describe, takeoverCommand, lockPathIn, LOCK_NAME };
