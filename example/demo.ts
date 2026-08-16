/**
 * The same five-minute lock, met four ways.
 *
 *   npm run demo
 */

import { SessionLock, type Snapshot } from "../src/index.ts";

const MINUTE = 60_000;
let at = new Date("2026-08-16T10:00:00Z").getTime();
const now = () => new Date(at);
const advance = (ms: number) => {
  at += ms;
};

const make = () => new SessionLock({ idleAfterMs: 5 * MINUTE, backgroundAfterMs: 2 * MINUTE, now });
const show = (label: string, snapshot: Snapshot) =>
  console.log(`  ${label.padEnd(42)} ${snapshot.state}${snapshot.reason ? ` (${snapshot.reason})` : ""}`);

console.log("app open, user reading");
const idling = make();
advance(4 * MINUTE);
show("4 minutes without a tap", idling.check());
advance(2 * MINUTE);
show("6 minutes without a tap", idling.check());

console.log("\nphone put down for an hour — no timer runs while backgrounded");
const away = make();
away.background();
advance(60 * MINUTE);
show("returning after an hour", away.foreground());

console.log("\nFace ID sheet, which backgrounds the app for a moment");
const biometric = make();
biometric.background();
advance(900);
show("returning after 0.9 s", biometric.foreground());

console.log("\napp force-quit, reopened an hour later");
const cold = make();
const stored: Snapshot = {
  state: "unlocked",
  lastActivityAt: new Date(at - 60 * MINUTE).toISOString(),
  reason: null,
};
show("restoring a session last used an hour ago", make().restore(stored));
show("restoring one used a minute ago", cold.restore({
  state: "unlocked",
  lastActivityAt: new Date(at - MINUTE).toISOString(),
  reason: null,
}));
