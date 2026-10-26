/**
 * Wiring the lock to an app's lifecycle.
 *
 * React Native's AppState is not imported: it arrives as anything with an
 * addEventListener that hands back a remove function, which is exactly its
 * shape. The same wiring then works with the browser's visibilitychange, or
 * with a fake in a test.
 */

import { SessionLock, type Snapshot } from "./lock.ts";

/** The part of React Native's AppState this needs. */
export type AppStateLike = {
  addEventListener(
    type: "change",
    listener: (state: string) => void,
  ): { remove(): void };
};

export type Timer = {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export const systemTimer: Timer = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type AttachOptions = {
  readonly appState: AppStateLike;
  readonly onChange: (snapshot: Snapshot) => void;
  readonly timer?: Timer;
};

/**
 * Listen for foreground and background transitions, and poll while the app is
 * open.
 *
 * The poll is an optimisation so the lock appears promptly for a user who is
 * looking at the screen. It is not the mechanism — a timer does not run in the
 * background, which is the hole this whole library exists to close.
 */
export function attach(lock: SessionLock, options: AttachOptions): () => void {
  const timer = options.timer ?? systemTimer;
  let handle: unknown = null;

  const schedule = () => {
    if (handle !== null) {
      timer.clear(handle);
      handle = null;
    }
    if (lock.locked) return;
    // Wake exactly when the idle deadline falls due, not on a fixed interval.
    handle = timer.set(() => {
      options.onChange(lock.check());
      schedule();
    }, Math.max(250, lock.msUntilIdleLock));
  };

  // Without this, a session unlocked between app state changes had no timer
  // until the next one, so a user who never left the app did not idle out.
  const unsubscribe = lock.subscribe(() => schedule());

  const subscription = options.appState.addEventListener("change", (state) => {
    const snapshot = state === "active" ? lock.foreground() : lock.background();
    options.onChange(snapshot);
    schedule();
  });

  schedule();

  return () => {
    unsubscribe();
    subscription.remove();
    if (handle !== null) {
      timer.clear(handle);
      handle = null;
    }
  };
}
