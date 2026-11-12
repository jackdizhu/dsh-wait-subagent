/**
 * dsh-wait-subagent — plain-Node unit tests for lib/delegate/write-scope.js.
 *
 * These tests import no host package: they load the pure scope helpers straight
 * from the repository and assert the canonical-form contract plus the FIFO
 * arbitration queue. Run with `node scripts/test-write-scope.mjs`.
 *
 * Output contract: a final `PASS=<n> FAIL=<m>` line; exit 0 when everything
 * passed and exit 1 when anything failed. The queued-acquire test is wrapped
 * in a timeout so a broken queue fails the suite instead of hanging it.
 */

import assert from "node:assert/strict";
import { normalizeScope, scopesConflict, createScopeQueue } from "../lib/delegate/write-scope.js";

let passed = 0;
const failures = [];

/** Run one synchronous check, counting pass/fail and printing a line per check. */
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok ${name}`);
  } catch (err) {
    failures.push({ name, message: err?.message ?? String(err) });
    console.error(`not ok ${name}: ${err?.message ?? String(err)}`);
  }
}

/** Run one asynchronous check with the same counting contract. */
async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${name}`);
  } catch (err) {
    failures.push({ name, message: err?.message ?? String(err) });
    console.error(`not ok ${name}: ${err?.message ?? String(err)}`);
  }
}

/** Reject after `ms` so a stuck queue can never hang the suite. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 1. Normalization collapses case, separators, trailing slashes and duplicates.
check("normalizeScope deduplicates to 2 canonical prefixes", () => {
  const scope = normalizeScope(["C:\\Repo\\Src\\", "c:/repo/src", "D:\\Other"]);
  assert.equal(scope.length, 2);
  assert.deepEqual(scope, ["c:/repo/src", "d:/other"]);
});

// 2. An absent scope means "no scope".
check("normalizeScope(undefined) is the empty scope", () => {
  assert.deepEqual(normalizeScope(undefined), []);
});

// 3. A non-array scope is rejected.
check("normalizeScope rejects a string", () => {
  assert.throws(() => normalizeScope("x"), /write_scope must be an array of strings/);
});

// 4. A prefix ancestor conflicts with a nested path.
check("scopesConflict treats a parent prefix as conflicting", () => {
  assert.equal(scopesConflict(["c:/repo/src"], ["c:/repo/src/app.js"]), true);
});

// 5. Sibling prefixes with a shared string stem do not conflict.
check("scopesConflict keeps sibling stems apart", () => {
  assert.equal(scopesConflict(["c:/repo/src"], ["c:/repo/src2"]), false);
});

// 6. An empty scope conflicts with nothing.
check("scopesConflict never conflicts with an empty scope", () => {
  assert.equal(scopesConflict([], ["x"]), false);
});

// 7. The queue grants a free scope, refuses a conflicting one, and keeps
//    disjoint scopes parallel.
check("scope queue: grant, refuse conflicting, allow disjoint", () => {
  const queue = createScopeQueue();

  const releaseA = queue.tryAcquire(["a"]);
  assert.equal(typeof releaseA, "function", "first tryAcquire(['a']) must grant a release");

  const conflicting = queue.tryAcquire(["a"]);
  assert.equal(conflicting, null, "a held scope must not be granted twice");

  const releaseB = queue.tryAcquire(["b"]);
  assert.equal(typeof releaseB, "function", "a disjoint scope must be granted immediately");
  assert.equal(queue.size().active, 2);

  releaseA();
  releaseB();
  assert.equal(queue.size().active, 0);
});

// 8. A queued task wakes after the holder releases; timeout-protected.
await checkAsync("scope queue: release wakes the queued acquirer", async () => {
  const queue = createScopeQueue();

  const releaseFirst = queue.tryAcquire(["a"]);
  assert.equal(typeof releaseFirst, "function");

  let granted = false;
  let releaseQueued = null;
  const pending = queue.acquire(["a"]).then((release) => {
    granted = true;
    releaseQueued = release;
  });

  assert.equal(granted, false, "the queued acquire must not resolve before a release");

  releaseFirst();
  await withTimeout(pending, 2000, "queued acquire(['a'])");
  assert.equal(granted, true, "the queued acquire must resolve after the release");
  assert.equal(typeof releaseQueued, "function");
  assert.equal(queue.size().active, 1);

  releaseQueued();
  assert.equal(queue.size().active, 0);
});

console.log(`PASS=${passed} FAIL=${failures.length}`);
process.exitCode = failures.length === 0 ? 0 : 1;
