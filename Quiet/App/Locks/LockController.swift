import Foundation
import DeviceActivity

/// Starting a time-boxed lock. There is no `end()` — that is the feature.
enum LockController {

    struct Duration: Identifiable, Hashable {
        let label: String
        let seconds: TimeInterval
        var id: String { label }
    }

    static let durations: [Duration] = [
        .init(label: "1 hour",  seconds: 3600),
        .init(label: "4 hours", seconds: 4 * 3600),
        .init(label: "12 hours", seconds: 12 * 3600),
        .init(label: "24 hours", seconds: 24 * 3600),
        .init(label: "7 days",  seconds: 7 * 24 * 3600)
    ]

    enum StartError: LocalizedError {
        case alreadyLocked
        case nothingToLock
        case system(String)

        var errorDescription: String? {
            switch self {
            case .alreadyLocked: return "A lock is already running."
            case .nothingToLock: return "Your Distracting list is empty, so a lock would do nothing."
            case .system(let message): return "iOS refused to schedule the lock: \(message)"
            }
        }
    }

    static func start(_ duration: Duration,
                      strict: Bool,
                      store: SharedStore = SharedStore()) throws {
        guard !store.lock.isActive else { throw StartError.alreadyLocked }
        let distracting = store.selection(.distracting)
        guard !distracting.applicationTokens.isEmpty || !distracting.categoryTokens.isEmpty else {
            throw StartError.nothingToLock
        }

        let until = Date().addingTimeInterval(duration.seconds)
        store.beginLock(until: until, strict: strict)
        ShieldPolicy.apply(store: store)
        EventLog.append(LoggedEvent(kind: .lockStarted,
                                    detail: "\(duration.label)\(strict ? " strict" : "")"),
                        store: store)

        do {
            try armExpiry(until: until)
        } catch {
            // The shield is already on and will stay on; only the automatic
            // lift failed. Opening the app clears an expired lock anyway, so
            // this degrades to "you must open Quiet once after it ends"
            // rather than to a lock nobody can end.
            EventLog.append(LoggedEvent(kind: .lockStarted,
                                        detail: "expiry scheduling failed: \(error.localizedDescription)"),
                            store: store)
        }
    }

    /// Two mechanisms, because this is the one place where a missed callback
    /// means a lock that outstays its welcome:
    ///
    /// 1. A non-repeating window ending exactly at `until`.
    /// 2. A daily watchdog that clears the lock the first time it opens after
    ///    expiry — insurance against long intervals behaving oddly.
    ///
    /// Opening the app checks too (`RootView.onChange(of: scenePhase)`).
    private static func armExpiry(until: Date) throws {
        let center = DeviceActivityCenter()
        center.stopMonitoring([QuietActivity.lockWindow, QuietActivity.lockWatchdog])

        let calendar = Calendar.current
        let fields: Set<Calendar.Component> = [.year, .month, .day, .hour, .minute, .second]

        let window = DeviceActivitySchedule(
            intervalStart: calendar.dateComponents(fields, from: Date().addingTimeInterval(-60)),
            intervalEnd: calendar.dateComponents(fields, from: until),
            repeats: false
        )
        try center.startMonitoring(QuietActivity.lockWindow, during: window)

        let endOfDay = calendar.dateComponents([.hour, .minute], from: until)
        let watchdog = DeviceActivitySchedule(
            intervalStart: endOfDay,
            intervalEnd: DateComponents(hour: (endOfDay.hour ?? 0),
                                        minute: ((endOfDay.minute ?? 0) + 20) % 60),
            repeats: true
        )
        // A failure here is survivable; the precise window is the primary.
        try? center.startMonitoring(QuietActivity.lockWatchdog, during: watchdog)
    }
}
