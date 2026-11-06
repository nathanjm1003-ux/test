# Quiet — build plan

## 0. What I could and could not do

This repository was written on a Linux machine with **no Swift toolchain and no
Xcode**. Every line of Swift here is unbuilt and unrun. `xcodebuild` cannot
exist on Linux, and `FamilyControls` / `ManagedSettings` / `DeviceActivity` /
`SwiftUI` / `WidgetKit` are iOS-only, so even a Linux Swift compiler could not
typecheck them.

What that means concretely:

- Expect compile errors on first open. They should be shallow (a renamed
  initialiser, a missing `import`), not architectural.
- Everything marked "needs a device" below is genuinely unverifiable without an
  iPhone — not even the Simulator will do.
- I have flagged, inline and in the README, every place where I am working from
  memory of an API rather than from a compiler.

See `README.md` § "Verification status" for the per-file breakdown.

## 1. Targets

| Target | Type | Why |
|---|---|---|
| `Quiet` | iOS app, SwiftUI, iOS 17 | UI, pickers, schedules, locks, stats host, settings |
| `QuietMonitor` | `DeviceActivityMonitor` extension | Interval/event callbacks: apply + lift shields on schedule, re-shield after an override, expire locks |
| `QuietShieldConfiguration` | `ShieldConfigurationDataSource` extension | The dark text-only blocking screen |
| `QuietShieldAction` | `ShieldActionDelegate` extension | "Never mind" / "Open anyway" button handling, the delay, override accounting |
| `QuietWidgets` | WidgetKit extension | Text-only home-screen widgets + (iOS 18) the Control Center control |
| `QuietReport` | `DeviceActivityReportExtension` | Screen-time / pickups figures — **a sixth target you did not list, but feature 6 cannot work without it** |

All six share one App Group: `group.com.example.quiet`.

## 2. Entitlements and capabilities

| Capability | Targets | Notes |
|---|---|---|
| `com.apple.developer.family-controls` (Bool `true`) | app, monitor, shield config, shield action, report | **Restricted.** Works on a device with a paid account for development. App Store distribution needs a separate approval request to Apple. |
| App Groups `group.com.example.quiet` | all six | Shared settings, selections, counters, override ledger |

The widget target needs family-controls too. I initially scoped it out — the
text widgets themselves never touch a token — but the Control Center toggle
applies the shield policy in place, and writing `ManagedSettingsStore` requires
the entitlement. Display-only widgets would not need it.

No network entitlements. No background modes. No push. No analytics SDK.

## 3. Data model

Two tiers, split by memory budget.

**Tier 1 — App Group `UserDefaults` (`group.com.example.quiet`).** Small, cheap,
readable from a 6 MB extension without pulling in a database:

- `selection.essential` / `selection.distracting` / `selection.blocked`
  — `FamilyActivitySelection` encoded with `JSONEncoder`
- `mode.dumbModeOn: Bool`, `mode.manualOverrideUntil: Date?`
- `schedules: [ScheduleSpec]` (JSON)
- `lock.until: Date?`, `lock.strict: Bool`
- `friction.delaySeconds: Int`, `friction.graceMinutes: Int`, `friction.dailyLimit: Int`
- `counters.<yyyy-MM-dd>.<tokenKey>: Int` — daily opens per app
- `overrides.pending: [activityName: OverrideRecord]` (JSON)
- `log.pending: [EventRecord]` (JSON, a bounded ring buffer)

**Tier 2 — SwiftData, main app only.** The durable history. The app drains
`log.pending` into SwiftData on launch and clears it. Extensions never link
SwiftData — a `ModelContainer` in a 6 MB shield extension is a bad trade.

- `OverrideEvent(timestamp, appKey, displayName?, delayServed, granted)`
- `LockEvent(start, end, duration, strict, completed)`
- `ModeEvent(timestamp, on, source)`

**Tokens are opaque.** `ApplicationToken` is not a bundle ID and carries no
name. It is `Codable` + `Hashable`, so the only stable key is the base64 of its
encoded form — that is `tokenKey` above. Those keys are meaningless on another
device, which is why settings export excludes them (feature 7).

## 4. Simulator vs. device

| Thing | Simulator | Device |
|---|---|---|
| App builds, SwiftUI layout, navigation | yes | yes |
| `AuthorizationCenter.requestAuthorization` | **no** — fails/returns unavailable | yes |
| `FamilyActivityPicker` | renders, no real apps | yes |
| Shields actually appearing over apps | **no** | yes |
| Shield configuration / action extensions firing | **no** | yes |
| `DeviceActivity` schedules and events | **no** | yes |
| `DeviceActivityReport` figures | **no** | yes |
| Widgets rendering | yes (static text) | yes |
| Control Center control | iOS 18 sim renders | yes |

So: the Simulator is good for layout and nothing else. **An iPhone 13 on iOS 17+
signed with a real team is required for every behaviour that matters.**

## 5. Order of work

Features 1–7 as specified. After each, a structural check (YAML/plist parse,
brace balance, every source file claimed by a target) — the honest substitute
for a build on this machine.
