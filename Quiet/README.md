# Quiet

Turns an iPhone into something closer to a dumb phone, using the Screen Time
APIs Apple actually exposes to third parties: `FamilyControls`,
`ManagedSettings`, `DeviceActivity`, App Intents and WidgetKit.

No account, no network code, no analytics, no ads. Everything lives in an App
Group container and a SwiftData store on the device.

---

## Status: written, never compiled

This was written on a Linux machine with no Swift toolchain and no Xcode. **No
part of it has been built or run.** `xcodebuild` cannot exist on Linux, and
these frameworks are iOS-only, so there was nothing to typecheck against.

Expect compile errors on first open. They should be shallow — a renamed
initialiser, a missing import — rather than structural. What *was* checked, by
script, before publishing:

- `project.yml` parses, and every source path, Info.plist and entitlements
  file it names exists
- all 39 Swift files are claimed by at least one target
- braces, parens and brackets balance in every file
- no target references a type declared in a file it does not compile

That last check earned its keep: it caught `ShieldAction` calling `Gatekeeper`,
which lived in the `ShieldConfiguration` target. Separate extensions are
separate modules, so that would not have compiled. `Gatekeeper` now lives in
`Shared/`.

See [Verification status](#verification-status) for the APIs I am least sure
of.

---

## What iOS will not let this app do

Read this before anything else. Every one of these is a hard platform limit,
not a gap in the implementation.

**No custom launcher.** There is no API to replace the home screen. Quiet
cannot be the thing you see when you unlock the phone.

**No removing or hiding app icons.** Shielded apps still sit on your home
screen looking completely normal. The shield only appears *after* you tap one.
The widget page in [Text-only home screen](#text-only-home-screen) is a
workaround, not a fix.

**No notification filtering.** Notification content and delivery are off
limits to third-party apps. A shielded app can still buzz your phone. Use a
Focus mode for that — Quiet can trigger one, but it cannot do the filtering
itself.

**Nothing is unbreakable.** Settings → Screen Time → Apps with Screen Time
Access lets you revoke Quiet's authorization, and every shield drops
immediately. Strict mode blocks *deleting* the app but cannot stop you turning
the permission off. If you want a lock that a determined version of you cannot
escape, this is not that, and no App Store app is.

**Phone and Settings are not shieldable** by Screen Time at all, which is
good. **Messages and Maps are.** Quiet cannot put them on your allow-list for
you, because app identities only come out of the system picker — so you must
add them to Essential yourself. The app refuses to arm dumb-phone mode with an
empty Essential list for exactly this reason.

**App names are not readable.** A `FamilyActivitySelection` holds opaque
tokens, not bundle IDs. The only way to display one is a `Label(token)` view,
and the only place a name arrives as a string is inside the shield extension,
for the app being shielded right then. So: stats show counts rather than
names, widget rows are typed by hand, and exports cannot include your app
choices.

**Screen-time figures cannot leave the report extension.** `DeviceActivityReport`
hands data to its extension and nowhere else. The containing app never sees
the numbers, so they cannot be stored, exported or graphed outside that view.

**Control Center controls need iOS 18.** The app targets iOS 17. On 17 the
equivalents are the Shortcuts action and the Lock Screen.

**Shield delays are best-effort.** Holding the "Open anyway" countdown means
sleeping inside an extension with a short runtime budget. If the system
reclaims it mid-wait, nothing completes and the shield stays up — the safe
direction, but you may occasionally tap twice.

---

## Setting up the project

### 1. Generate the Xcode project

```bash
brew install xcodegen
cd Quiet
./configure.sh com.yourname.quiet TEAMID1234   # bundle prefix, Apple team ID
xcodegen generate
open Quiet.xcodeproj
```

`configure.sh` rewrites the bundle identifier prefix and App Group across
`project.yml`, the entitlements files and `Shared/AppGroup.swift`. Run it
before generating, or edit those by hand.

### 2. What you must click yourself

In the **Apple Developer portal** (developer.apple.com):

1. Certificates, Identifiers & Profiles → Identifiers → register six App IDs:
   `com.yourname.quiet` plus `.monitor`, `.shieldconfig`, `.shieldaction`,
   `.widgets`, `.report`.
2. On each, enable **App Groups** and **Family Controls**, except the widget
   App ID which needs both too (the Control Center toggle writes
   ManagedSettings — see below).
3. Identifiers → App Groups → register `group.com.yourname.quiet`, and
   associate it with all six App IDs.

Family Controls is a **restricted entitlement**. On a paid account it works
for development builds straight away. Shipping to the App Store needs a
separate request to Apple describing why the app needs it — there is a form
linked from the capability in the portal. TestFlight also needs the
distribution version approved.

In **Xcode**, per target → Signing & Capabilities:

4. Set your team on all six targets.
5. Confirm **App Groups** is ticked and points at your group.
6. Confirm **Family Controls** appears on the app, monitor, both shields, the
   report *and* the widget extension.

### 3. Run it

On a **real device**, iOS 17 or later. The Simulator will build and show the
UI, but `AuthorizationCenter.requestAuthorization` fails there, no shield will
ever appear, and no DeviceActivity callback will ever fire.

---

## How it fits together

```
                 ┌──────────────────────────────┐
   you tap ─────▶│ ShieldConfiguration ext      │  draws the dark screen,
   a shielded    │   Gatekeeper.verdict()       │  decides if "Open anyway"
   app           └──────────────────────────────┘  is even offered
                                │
                 ┌──────────────▼───────────────┐
   you tap ─────▶│ ShieldAction ext             │  re-checks the verdict,
   "Open anyway" │   waits, then opens a window │  waits the delay,
                 └──────────────┬───────────────┘  arms the re-shield
                                │
                 ┌──────────────▼───────────────┐
                 │ DeviceActivityMonitor ext    │  grace used up / schedule
                 │   → ShieldPolicy.apply()     │  boundary / lock expiry
                 └──────────────┬───────────────┘
                                │
         ┌──────────────────────▼──────────────────────┐
         │ App Group: selections, friction, counters,  │
         │ pending overrides, lock state, event log    │
         └─────────────────────────────────────────────┘
```

**One function recomputes everything.** `ShieldPolicy.apply()` reads stored
state and rewrites all four `ManagedSettingsStore`s from scratch. Nothing
patches a shield incrementally — that is how apps end up permanently blocking
something nobody asked for.

**Four named stores, not one.** `dumbMode`, `distracting`, `blocked` and
`lock`. The system unions restrictions across stores, so each feature clears
its own without having to know what the others wanted. One shared store is how
you get a schedule quietly lifting a 7-day lock.

**The grace period is measured in use, not clock.** "Five more minutes of
Instagram" is a `DeviceActivityEvent` threshold, not a timer — so putting the
phone down does not burn it. It also sidesteps DeviceActivity's refusal to
watch any interval shorter than 15 minutes. A wall-clock window of
`max(15, grace+1)` minutes backstops it, so the shield returns after five
minutes of use *or* fifteen minutes of clock, whichever lands first.

**Daily limits need no midnight job.** Counters are keyed by calendar day, so
yesterday's key simply stops being read. That saves a DeviceActivity activity,
and the system caps how many an app may hold (around 20 — `ScheduleStore`
refuses to arm more than 16 so overrides and locks keep headroom).

**Locks survive reboot** because `ManagedSettings` is system state, not
something Quiet keeps running. What needs arranging is the *lifting*: a
precise non-repeating window ending at the expiry, a daily watchdog as
insurance, and a check every time you foreground the app. No in-process
timers.

**Extensions stay small.** Shield and monitor extensions get roughly 6 MB.
They compile only the shared files they need — see the per-file `sources`
lists in `project.yml` — and never link SwiftData. They append to a small JSON
buffer in the App Group; the main app drains it into SwiftData on launch.

---

## Text-only home screen

Widgets cannot replace the launcher, but a dedicated page gets close.

**1. Add the rows.** Quiet → Settings → Home screen rows. Type a label and a
URL for each, up to 8. "Add the usual suspects" fills in Apple's own schemes
(`tel:`, `sms:`, `maps://`), which are documented and stable.

For third-party apps, the reliable route is Shortcuts, not a guessed scheme:

- Shortcuts → new shortcut → single action **Open App** → pick the app →
  name it e.g. `Open Spotify`
- In Quiet, set the row URL to `shortcuts://run-shortcut?name=Open%20Spotify`

Leave **Direct launch** off unless you want to experiment: WidgetKit documents
widget links as opening *the containing app*, so a raw `instagram://` in a
widget may do nothing. With it off, the row opens Quiet, which forwards —
one frame of Quiet on screen, but it works.

**2. Make a blank page.** Long-press the home screen to enter jiggle mode.
Drag every icon off one page (they stay in App Library). Add the Quiet widget:
tap **+** → Quiet → choose small or medium.

**3. Hide the other pages.** Still in jiggle mode, tap the row of page dots at
the bottom. Untick every page except the widget one. Tap Done.

**4. Clear the Dock.** Drag the four dock apps up into the page area, then off
it. An empty dock is less of a pull than four bright icons.

**5. Dark wallpaper.** Settings → Wallpaper → Add New Wallpaper → **Colour** →
pick black → Set. For a text-based one, make a black PNG with a line of text
in any editor, save to Photos, then Add New Wallpaper → Photos.

**6. Link it to a Focus.** Settings → Focus → **+** → Custom → name it Quiet.
Under **Customise Pages** (in the Home Screen section) select only your widget
page. Now turning the Focus on hides everything else.

**7. Turn the mode on with the Focus.** Shortcuts → Automation → **+** → When
→ Focus → Quiet → Is Turned On → Run Immediately → add action **Set Dumb Phone
Mode** → On. Add the mirror automation for Is Turned Off.

Reality check: the apps are still installed, still in App Library, still
reachable from Search. The page is a speed bump, and the shield is the part
with teeth.

---

## Verification status

| Area | Confidence | Why |
|---|---|---|
| App Group plumbing, `SharedStore`, ledger, lock state | high | Plain Foundation |
| `ShieldPolicy` composition over four stores | high | Documented behaviour |
| `FamilyActivityPicker` / `Label(token)` usage | high | Well-trodden |
| `ManagedSettingsStore.Name` init, `.all(except:)` shape | medium | Written from memory of the API; check the exact initialiser |
| `DeviceActivitySchedule` spanning more than 24h | **low** | Long non-repeating intervals are the part I trust least — hence the watchdog |
| `ShieldConfiguration` initialiser argument list | medium | Order and optionality may differ |
| Sleeping in `ShieldActionDelegate` for 15s | **low** | No documented runtime budget; fails closed |
| `DeviceActivityResults` iteration in the report extension | **low** | `activitySegments` / `categories` / `applications` / `numberOfPickups` written from memory |
| `ControlWidgetToggle` + `ControlValueProvider` (iOS 18) | medium | Newer API, gated behind `@available` |

### Needs a real iPhone 13 to verify

Everything behavioural:

1. Authorization actually granted, and the revoke path showing the banner
2. A shield appearing over a real app, with the right name in the title
3. "Never mind" closing, "Open anyway" waiting the full delay
4. The shield returning after the grace period — both by usage threshold and
   by window expiry
5. The daily limit removing the secondary button, and resetting at midnight
6. Schedules firing `intervalDidStart` / `intervalDidEnd` on the right days
7. A lock surviving a reboot, and lifting on time — especially the 7-day one
8. Strict mode actually blocking app deletion
9. Widgets rendering, and rows launching (both direct and via Quiet)
10. The report extension producing non-zero figures

---

## Settings export

`Settings → Export settings` writes JSON containing friction settings,
schedules and home-screen rows.

It deliberately **excludes your app selections**. Screen Time identifies apps
with opaque tokens that are only valid for the installation that minted them;
exporting them would produce a file that silently decodes to nothing on the
other end. The export carries a `note` field saying so. After importing,
re-pick Essential / Distracting / Hidden.

## Known rough edges

- `FamilyActivityPicker` has been known to hang or crash when many categories
  are expanded. Pick apps rather than whole categories where you can.
- Re-arming schedules repeatedly, or stacking several multi-day schedules,
  can bump against the limit on concurrently monitored activities. `Disarm
  all` in Schedules clears them and starts over.
- There is no migration for the SwiftData store. If the models change, delete
  and reinstall.

## Running the structural checks

`check_structure.py` is the script described at the top — the stand-in for a
build on a machine that has no Swift. It is worth re-running after editing
`project.yml` or moving files between targets, since the cross-target symbol
check catches the one mistake that per-file target membership invites.

```bash
python3 Quiet/check_structure.py
```

It is not a compiler and will not find type errors. Once you have Xcode,
`xcodebuild -scheme Quiet -destination 'generic/platform=iOS' build` is the
real check.
