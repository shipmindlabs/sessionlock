/**
 * Locking a mobile app after inactivity, counted with a clock that cannot be
 * paused.
 *
 * Banking and health apps all need this, and the naive version has a hole big
 * enough to walk through: a timer set with setTimeout does not run while the
 * app is in the background, and on iOS it does not run while the device is
 * asleep either. An app that locks after five minutes of inactivity, using a
 * timer, does not lock at all if the phone is put down for an hour — the timer
 * simply fires late, or never, and the session stays open.
 *
 * The fix is not a better timer. It is to stop counting elapsed time and start
 * comparing timestamps: record when activity last happened, and on every
 * return to the foreground ask how long ago that was. A timer then becomes an
 * optimisation for the case where the app stays open, not the mechanism.
 *
 * This module holds the rule. It imports nothing from React Native: AppState
 * and the clock arrive as arguments.
 */

export type LockState = "unlocked" | "locked";

export type Snapshot = {
  readonly state: LockState;
  /** When activity was last seen. Null once locked. */
  readonly lastActivityAt: string | null;
  /** Why the lock closed, for the screen that asks for a passcode. */
  readonly reason: LockReason | null;
};

export type LockReason =
  /** Enough time passed without the user doing anything. */
  | "idle"
  /** The app was in the background longer than allowed. */
  | "backgrounded"
  /** The caller locked it deliberately, e.g. a "lock now" button. */
  | "manual";

export type Options = {
  /** How long without activity before locking, in milliseconds. */
  readonly idleAfterMs: number;
  /**
   * How long in the background before locking. Usually shorter than the idle
   * timeout: a banking app in the app switcher is more exposed than one in
   * front of its owner. Defaults to the idle timeout.
   */
  readonly backgroundAfterMs?: number;
  /**
   * A short grace period so that returning from a system prompt — a biometric
   * sheet, a permission dialog, a share sheet — does not count as leaving the
   * app. Without it, Face ID itself backgrounds the app and locks it, and the
   * user is stuck in a loop.
   */
  readonly graceMs?: number;
  readonly now?: () => Date;
};

export const DEFAULT_GRACE_MS = 1500;

/** The lock's rule, as a value that can be stored and restored. */
export class SessionLock {
  #state: LockState = "unlocked";
  #lastActivityAt: number;
  #leftForegroundAt: number | null = null;
  #reason: LockReason | null = null;
  #options: Required<Options>;

  constructor(options: Options) {
    this.#options = {
      backgroundAfterMs: options.backgroundAfterMs ?? options.idleAfterMs,
      graceMs: options.graceMs ?? DEFAULT_GRACE_MS,
      now: options.now ?? (() => new Date()),
      idleAfterMs: options.idleAfterMs,
    };
    this.#lastActivityAt = this.#options.now().getTime();
  }

  get snapshot(): Snapshot {
    return {
      state: this.#state,
      lastActivityAt: this.#lastActivityAt ? new Date(this.#lastActivityAt).toISOString() : null,
      reason: this.#reason,
    };
  }

  get locked(): boolean {
    return this.#state === "locked";
  }

  /** Milliseconds until an idle lock, or 0 when it is already due. */
  get msUntilIdleLock(): number {
    if (this.#state === "locked") return 0;
    const elapsed = this.#options.now().getTime() - this.#lastActivityAt;
    return Math.max(0, this.#options.idleAfterMs - elapsed);
  }

  /**
   * The user did something. Ignored while locked: a tap on the passcode screen
   * is not a reason to consider the session live.
   */
  touch(): this {
    if (this.#state === "locked") return this;
    this.#lastActivityAt = this.#options.now().getTime();
    return this;
  }

  /**
   * Check whether enough idle time has passed. Called by a timer while the app
   * is open — an optimisation, not the mechanism.
   */
  check(): Snapshot {
    if (this.#state === "locked") return this.snapshot;
    if (this.#options.now().getTime() - this.#lastActivityAt >= this.#options.idleAfterMs) {
      this.#lock("idle");
    }
    return this.snapshot;
  }

  /** The app went to the background. Only the time is recorded. */
  background(): Snapshot {
    if (this.#state === "locked") return this.snapshot;
    this.#leftForegroundAt = this.#options.now().getTime();
    return this.snapshot;
  }

  /**
   * The app came back. This is where the decision is actually made, by
   * comparing timestamps rather than trusting a timer that was not running.
   */
  foreground(): Snapshot {
    if (this.#state === "locked") return this.snapshot;

    const now = this.#options.now().getTime();
    const away = this.#leftForegroundAt === null ? 0 : now - this.#leftForegroundAt;
    this.#leftForegroundAt = null;

    // A trip through a biometric or permission sheet backgrounds the app for a
    // moment. Counting that as leaving locks the user out of their own unlock.
    if (away <= this.#options.graceMs) {
      this.#lastActivityAt = now;
      return this.snapshot;
    }
    if (away >= this.#options.backgroundAfterMs) return this.#lock("backgrounded");
    if (now - this.#lastActivityAt >= this.#options.idleAfterMs) return this.#lock("idle");
    return this.snapshot;
  }

  /** Lock deliberately. */
  lock(): Snapshot {
    return this.#lock("manual");
  }

  /** The user authenticated. The idle clock starts again from now. */
  unlock(): Snapshot {
    this.#state = "unlocked";
    this.#reason = null;
    this.#leftForegroundAt = null;
    this.#lastActivityAt = this.#options.now().getTime();
    return this.snapshot;
  }

  /**
   * Restore after a cold start.
   *
   * A session that was open when the process died is only still open if its
   * last activity is recent enough. Treating a cold start as a fresh session
   * would mean force-quitting the app is a way around the lock.
   */
  restore(snapshot: Snapshot): Snapshot {
    if (snapshot.state === "locked" || !snapshot.lastActivityAt) {
      this.#state = "locked";
      this.#reason = snapshot.reason ?? "manual";
      return this.snapshot;
    }
    this.#lastActivityAt = new Date(snapshot.lastActivityAt).getTime();
    this.#state = "unlocked";
    this.#reason = null;
    this.#leftForegroundAt = null;

    // Judged directly rather than through foreground(). That path grants a
    // grace period for a trip through a biometric sheet, and a cold start is
    // not that — routing through it made force-quitting the app a way around
    // the lock, which is the hole this method exists to close.
    const away = this.#options.now().getTime() - this.#lastActivityAt;
    if (away >= this.#options.backgroundAfterMs) return this.#lock("backgrounded");
    if (away >= this.#options.idleAfterMs) return this.#lock("idle");
    return this.snapshot;
  }

  #lock(reason: LockReason): Snapshot {
    this.#state = "locked";
    this.#reason = reason;
    this.#leftForegroundAt = null;
    return this.snapshot;
  }
}
