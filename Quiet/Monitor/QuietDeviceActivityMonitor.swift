import Foundation
import DeviceActivity
import ManagedSettings

/// Runs in a memory-constrained extension (roughly 6 MB), so it does as
/// little as possible: read a flag, recompute the shields, exit. No SwiftData,
/// no networking, no formatting.
///
/// Every branch funnels into `ShieldPolicy.apply`, which recomputes shields
/// from stored state rather than trying to patch them incrementally.
final class QuietDeviceActivityMonitor: DeviceActivityMonitor {

    override func intervalDidStart(for activity: DeviceActivityName) {
        super.intervalDidStart(for: activity)
        let store = SharedStore()

        switch QuietActivity.kind(of: activity) {
        case .schedule:
            store.noteScheduleStarted(activity.rawValue)
            ShieldPolicy.apply(store: store)

        case .lock:
            // The watchdog window. Clears the lock the first time it opens
            // after the lock was due to end.
            if store.clearLockIfExpired() {
                EventLog.append(LoggedEvent(kind: .lockEnded, detail: "watchdog"), store: store)
                DeviceActivityCenter().stopMonitoring([activity])
            }
            ShieldPolicy.apply(store: store)

        case .override, .unknown:
            break
        }
    }

    override func intervalDidEnd(for activity: DeviceActivityName) {
        super.intervalDidEnd(for: activity)
        let store = SharedStore()

        switch QuietActivity.kind(of: activity) {
        case .schedule:
            store.noteScheduleEnded(activity.rawValue)
            ShieldPolicy.apply(store: store)

        case .override:
            // Backstop: the grace period is normally ended by the usage
            // threshold below, but if the app was left open and never used
            // again the interval still closes it out.
            finishOverride(activity, store: store, reason: "interval")

        case .lock:
            store.clearLockIfExpired()
            ShieldPolicy.apply(store: store)

        case .unknown:
            break
        }
    }

    /// The grace period is measured in *use*, not wall clock: five minutes of
    /// Instagram, not five minutes during which you might have put the phone
    /// down. That is why it is a usage threshold rather than a short interval
    /// — and conveniently it sidesteps DeviceActivity's 15-minute floor on
    /// interval length.
    override func eventDidReachThreshold(_ event: DeviceActivityEvent.Name,
                                         activity: DeviceActivityName) {
        super.eventDidReachThreshold(event, activity: activity)
        guard event == .graceUsedUp else { return }
        finishOverride(activity, store: SharedStore(), reason: "used up")
    }

    private func finishOverride(_ activity: DeviceActivityName,
                                store: SharedStore,
                                reason: String) {
        let ledger = OverrideLedger(store: store)
        let name = activity.rawValue
        if let record = ledger.pending()[name] {
            EventLog.append(LoggedEvent(kind: .overrideExpired,
                                        appKey: record.key,
                                        detail: reason),
                            store: store)
        }
        ledger.remove(activityName: name)
        DeviceActivityCenter().stopMonitoring([activity])
        ShieldPolicy.apply(store: store)
    }
}
