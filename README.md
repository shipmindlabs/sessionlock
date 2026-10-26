# sessionlock

Lock a mobile app after inactivity, counted with a clock that cannot be paused.

Banking and health apps all need this, and the naive version has a hole big
enough to walk through: **`setTimeout` does not run while the app is
backgrounded**, and on iOS it does not run while the device is asleep either. An
app that locks "after five minutes of inactivity" using a timer does not lock at
all when the phone is put down for an hour. The timer fires late, or never, and
the session stays open in the app switcher.

The fix is not a better timer. It is to stop counting elapsed time and start
comparing timestamps: record when activity last happened, and on every return to
the foreground ask how long ago that was.

```console
$ npm run demo
app open, user reading
  4 minutes without a tap                    unlocked
  6 minutes without a tap                    locked (idle)

phone put down for an hour — no timer runs while backgrounded
  returning after an hour                    locked (backgrounded)

Face ID sheet, which backgrounds the app for a moment
  returning after 0.9 s                      unlocked

app force-quit, reopened an hour later
  restoring a session last used an hour ago  locked (backgrounded)
  restoring one used a minute ago            unlocked
```

## The three cases people miss

**The background timeout is not the idle timeout.** An app sitting in the app
switcher is more exposed than one in its owner's hand, so `backgroundAfterMs` is
usually shorter, and it is a separate setting. `backgroundAfterMs: 0` locks as
soon as the app is left.

**Face ID backgrounds your app.** So does a permission dialog and a share sheet.
Counting that as leaving locks the user out of their own unlock and traps them
in a loop, so a short grace period covers the round trip.

**Force-quitting must not be a way around the lock.** `restore` judges a stored
session by the age of its last activity, not by the fact that the process is
new.

## Use

```ts
const lock = new SessionLock({ idleAfterMs: 5 * 60_000, backgroundAfterMs: 60_000 });

const detach = attach(lock, {
  appState: AppState,
  onChange: (snapshot) => setLocked(snapshot.state === "locked"),
});

// on any interaction
<Pressable onPress={() => lock.touch()} />

// after authenticating
lock.unlock();
```

The timeouts are checked when the lock is built: a duration that is not a
non-negative number — `Number("5m")` is `NaN` — throws a `RangeError` naming the
option, rather than producing a lock that never closes.

`attach` also polls while the app is open, so the lock appears promptly for
someone looking at the screen. That poll is an optimisation, not the mechanism —
which is the distinction the whole library rests on.

`lock.subscribe(listener)` reports every real change — a lock closing, or an
unlock of a session that was closed, but not an `unlock()` on one already open —
and returns a function that stops it. `attach` uses it so that unlocking
restarts the poll straight away, instead of leaving the session unpolled until
the app next changes state.

## No React Native import

`AppState` arrives as an argument typed by its shape, and so does the clock and
the timer. The package depends on nothing, every case above is tested in a plain
runner without a device, and the same lock works in a browser wired to
`visibilitychange`.

## What it is not

**Not authentication.** It decides *when* to ask. Asking — a passcode, Face ID,
a re-login — is yours, and so is what the locked screen shows.

**Not secure storage.** Locking the UI does not protect data at rest. Keep
secrets in the keychain and clear what you can when the lock closes; this cannot
do either for you.

**Not a screenshot or overlay guard.** Hiding sensitive content in the app
switcher is a separate, platform-specific job.

## Status

| | |
|---|---|
| Implemented | idle and background timeouts, grace period for system prompts, manual lock, restore across cold starts, countdown, change subscription, lifecycle wiring with cleanup |
| Not yet | a React hook wrapper, persistence helpers, a warning callback shortly before locking, per-screen sensitivity |

## Development

```bash
npm test        # node --test, no device and no waiting
npm run demo
npm run typecheck
```

## License

MIT © [Shipmind Labs](https://shipmindlabs.com)
