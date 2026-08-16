/**
 * sessionlock — locking a mobile app after inactivity, counted with timestamps
 * rather than a timer that does not run in the background.
 */

export {
  DEFAULT_GRACE_MS,
  SessionLock,
  type LockReason,
  type LockState,
  type Options,
  type Snapshot,
} from "./lock.ts";

export {
  attach,
  systemTimer,
  type AppStateLike,
  type AttachOptions,
  type Timer,
} from "./attach.ts";
