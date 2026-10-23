import { test } from "node:test";
import assert from "node:assert/strict";

import {
  attach,
  SessionLock,
  type AppStateLike,
  type LockReason,
  type LockState,
  type Snapshot,
  type Timer,
} from "../src/index.ts";

const MINUTE = 60_000;

/** A clock the test moves by hand. */
function clock(start = "2026-08-16T10:00:00Z") {
  let at = new Date(start).getTime();
  return {
    now: () => new Date(at),
    advance(ms: number) {
      at += ms;
    },
  };
}

function lockWith(time: ReturnType<typeof clock>, overrides = {}) {
  return new SessionLock({ idleAfterMs: 5 * MINUTE, now: time.now, ...overrides });
}

test("a fresh session is unlocked", () => {
  const lock = lockWith(clock());
  assert.equal(lock.locked, false);
  assert.equal(lock.snapshot.reason, null);
});

test("inactivity locks it, and activity postpones that", () => {
  const time = clock();
  const lock = lockWith(time);

  time.advance(4 * MINUTE);
  assert.equal(lock.check().state, "unlocked");

  lock.touch();
  time.advance(4 * MINUTE);
  assert.equal(lock.check().state, "unlocked", "the touch restarted the clock");

  time.advance(MINUTE);
  const snapshot = lock.check();
  assert.equal(snapshot.state, "locked");
  assert.equal(snapshot.reason, "idle");
});

// The hole this library exists to close: a setTimeout does not run while the
// app is backgrounded, so an app that locks "after five minutes" using a timer
// does not lock at all when the phone is put down for an hour.
test("an hour in the background locks it, though no timer ran", () => {
  const time = clock();
  const lock = lockWith(time);

  lock.background();
  time.advance(60 * MINUTE);
  const snapshot = lock.foreground();

  assert.equal(snapshot.state, "locked");
  assert.equal(snapshot.reason, "backgrounded");
});

// Face ID backgrounds the app. Counting that as leaving locks the user out of
// their own unlock, and they are stuck in a loop.
test("a trip through a system prompt does not count as leaving", () => {
  const time = clock();
  const lock = lockWith(time, { graceMs: 2000 });

  lock.background();
  time.advance(800);
  assert.equal(lock.foreground().state, "unlocked");

  // And the return counts as activity, so the idle clock restarts.
  time.advance(4 * MINUTE);
  assert.equal(lock.check().state, "unlocked");
});

test("the background timeout can be shorter than the idle one", () => {
  const time = clock();
  const lock = lockWith(time, { idleAfterMs: 30 * MINUTE, backgroundAfterMs: MINUTE });

  lock.background();
  time.advance(2 * MINUTE);
  const snapshot = lock.foreground();

  assert.equal(snapshot.state, "locked");
  assert.equal(snapshot.reason, "backgrounded", "the app switcher is more exposed than the owner's hand");
});

// The usual setup for locking as soon as the app is left: the grace period is
// still what tells a Face ID sheet apart from walking away.
test("a zero background timeout locks on leaving, but not on a Face ID trip", () => {
  const time = clock();
  const leaving = lockWith(time, { idleAfterMs: 30 * MINUTE, backgroundAfterMs: 0 });

  leaving.background();
  time.advance(2000);
  const snapshot = leaving.foreground();
  assert.equal(snapshot.state, "locked");
  assert.equal(snapshot.reason, "backgrounded");

  const prompt = lockWith(time, { idleAfterMs: 30 * MINUTE, backgroundAfterMs: 0 });
  prompt.background();
  time.advance(1000);
  assert.equal(prompt.foreground().state, "unlocked");
});

test("returning after a short absence still locks if the session went idle", () => {
  const time = clock();
  const lock = lockWith(time, { idleAfterMs: 5 * MINUTE, backgroundAfterMs: 30 * MINUTE });

  time.advance(4 * MINUTE); // idle in the foreground
  lock.background();
  time.advance(2 * MINUTE); // under the background limit
  const snapshot = lock.foreground();

  assert.equal(snapshot.state, "locked");
  assert.equal(snapshot.reason, "idle");
});

// Number("5m") is NaN, every comparison against NaN is false, and a lock
// configured that way was still unlocked after ten hours.
test("a timeout that is not a non-negative number is refused", () => {
  const time = clock();

  assert.throws(() => lockWith(time, { idleAfterMs: Number("5m") }), {
    name: "RangeError",
    message: /idleAfterMs/,
  });
  assert.throws(() => lockWith(time, { idleAfterMs: -1 }), {
    name: "RangeError",
    message: /idleAfterMs/,
  });
  assert.throws(() => lockWith(time, { backgroundAfterMs: Number.NaN }), {
    name: "RangeError",
    message: /backgroundAfterMs/,
  });
});

// An endless grace period treats every absence as a system prompt.
test("a grace period must be finite and non-negative", () => {
  const time = clock();

  assert.throws(() => lockWith(time, { graceMs: -1 }), {
    name: "RangeError",
    message: /graceMs/,
  });
  assert.throws(() => lockWith(time, { graceMs: Number.POSITIVE_INFINITY }), {
    name: "RangeError",
    message: /graceMs/,
  });
});

// A tap on the passcode screen is not a reason to consider the session live.
test("activity while locked is ignored", () => {
  const time = clock();
  const lock = lockWith(time);
  lock.lock();

  lock.touch();
  time.advance(MINUTE);
  assert.equal(lock.check().state, "locked");
  assert.equal(lock.snapshot.reason, "manual");
});

test("unlocking restarts the idle clock", () => {
  const time = clock();
  const lock = lockWith(time);
  time.advance(10 * MINUTE);
  lock.check();
  assert.equal(lock.locked, true);

  lock.unlock();
  assert.equal(lock.locked, false);
  time.advance(4 * MINUTE);
  assert.equal(lock.check().state, "unlocked");
});

// Force-quitting the app must not be a way around the lock.
test("a cold start judges the stored session by its age", () => {
  const time = clock();
  const stale: Snapshot = {
    state: "unlocked",
    lastActivityAt: new Date(time.now().getTime() - 60 * MINUTE).toISOString(),
    reason: null,
  };
  assert.equal(lockWith(time).restore(stale).state, "locked");

  const recent: Snapshot = {
    state: "unlocked",
    lastActivityAt: new Date(time.now().getTime() - MINUTE).toISOString(),
    reason: null,
  };
  assert.equal(lockWith(time).restore(recent).state, "unlocked");
});

test("a stored locked session stays locked", () => {
  const time = clock();
  const snapshot: Snapshot = {
    state: "locked",
    lastActivityAt: time.now().toISOString(),
    reason: "backgrounded",
  };
  const restored = lockWith(time).restore(snapshot);
  assert.equal(restored.state, "locked");
  assert.equal(restored.reason, "backgrounded");
});

// A snapshot whose date cannot be read once restored unlocked and stayed that
// way: every comparison against NaN is false, so no amount of waiting locked
// it and the countdown reported NaN.
test("a stored session with an unreadable date restores locked", () => {
  const time = clock();
  const lock = lockWith(time);
  const restored = lock.restore({ state: "unlocked", lastActivityAt: "garbage", reason: null });

  assert.equal(restored.state, "locked");
  assert.equal(restored.reason, "manual");

  time.advance(60 * MINUTE);
  assert.equal(lock.check().state, "locked");
  assert.equal(lock.msUntilIdleLock, 0);
});

test("a stored session with an unknown state restores locked", () => {
  const time = clock();
  const restored = lockWith(time).restore({
    state: "weird" as LockState,
    lastActivityAt: time.now().toISOString(),
    reason: null,
  });

  assert.equal(restored.state, "locked");
  assert.equal(restored.reason, "manual");
});

test("an unknown reason is not passed through to the passcode screen", () => {
  const time = clock();
  const restored = lockWith(time).restore({
    state: "locked",
    lastActivityAt: time.now().toISOString(),
    reason: "bogus" as LockReason,
  });

  assert.equal(restored.state, "locked");
  assert.equal(restored.reason, "manual");
});

test("the countdown reports how long is left", () => {
  const time = clock();
  const lock = lockWith(time);
  assert.equal(lock.msUntilIdleLock, 5 * MINUTE);

  time.advance(3 * MINUTE);
  assert.equal(lock.msUntilIdleLock, 2 * MINUTE);

  time.advance(3 * MINUTE);
  assert.equal(lock.msUntilIdleLock, 0);
});

// The wiring, against a fake AppState and a fake timer, so the test does not
// wait for anything.
test("attach follows the app's lifecycle", () => {
  const time = clock();
  const lock = lockWith(time);
  const seen: Snapshot[] = [];

  let listener: ((state: string) => void) | null = null;
  let removed = false;
  const appState: AppStateLike = {
    addEventListener(_type, callback) {
      listener = callback;
      return {
        remove() {
          removed = true;
        },
      };
    },
  };

  let scheduled: (() => void) | null = null;
  const timer: Timer = {
    set(callback) {
      scheduled = callback;
      return 1;
    },
    clear() {
      scheduled = null;
    },
  };

  const detach = attach(lock, { appState, onChange: (s) => seen.push(s), timer });

  listener!("background");
  time.advance(60 * MINUTE);
  listener!("active");

  assert.equal(seen.at(-1)?.state, "locked");
  assert.equal(seen.at(-1)?.reason, "backgrounded");

  detach();
  assert.equal(removed, true, "the listener must be removed on unmount");
  assert.equal(scheduled, null, "and the timer cancelled");
});

test("the poll locks a session that idles with the app open", () => {
  const time = clock();
  const lock = lockWith(time);
  const seen: Snapshot[] = [];

  let scheduled: (() => void) | null = null;
  const timer: Timer = {
    set(callback) {
      scheduled = callback;
      return 1;
    },
    clear() {},
  };
  const appState: AppStateLike = { addEventListener: () => ({ remove() {} }) };

  attach(lock, { appState, onChange: (s) => seen.push(s), timer });
  time.advance(6 * MINUTE);
  scheduled!();

  assert.equal(seen.at(-1)?.state, "locked");
  assert.equal(seen.at(-1)?.reason, "idle");
});

// The grace period is for a trip through a biometric sheet, not for a cold
// start. Routing a restore through foreground() once made force-quitting the
// app a way around the lock.
test("a cold start does not get the biometric grace period", () => {
  const time = clock();
  const lock = lockWith(time, { graceMs: 10 * MINUTE });
  const stale: Snapshot = {
    state: "unlocked",
    lastActivityAt: new Date(time.now().getTime() - 60 * MINUTE).toISOString(),
    reason: null,
  };
  assert.equal(lock.restore(stale).state, "locked");
});
