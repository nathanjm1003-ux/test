import Foundation
import ManagedSettings
import DeviceActivity

/// Handles the two shield buttons.
///
/// Fails closed by design: if anything here is slow, throws, or the extension
/// is terminated before it finishes, the completion handler is never called
/// and the shield simply stays up. The failure mode of this app should always
/// be "more blocked", never "less".
final class QuietShieldAction: ShieldActionDelegate {

    override func handle(action: ShieldAction,
                         for application: ApplicationToken,
                         completionHandler: @escaping (ShieldActionResponse) -> Void) {
        switch action {
        case .primaryButtonPressed:
            completionHandler(.close)
        case .secondaryButtonPressed:
            grantOverride(for: application, completionHandler: completionHandler)
        @unknown default:
            completionHandler(.close)
        }
    }

    override func handle(action: ShieldAction,
                         for webDomain: WebDomainToken,
                         completionHandler: @escaping (ShieldActionResponse) -> Void) {
        // Web domains get no override path: there is no per-domain ledger and
        // a half-built one would be worse than none.
        completionHandler(.close)
    }

    override func handle(action: ShieldAction,
                         for category: ActivityCategoryToken,
                         completionHandler: @escaping (ShieldActionResponse) -> Void) {
        completionHandler(.close)
    }

    // MARK: -

    private func grantOverride(for token: ApplicationToken,
                               completionHandler: @escaping (ShieldActionResponse) -> Void) {
        let store = SharedStore()

        // Re-check rather than trusting that the button was drawn: the
        // configuration extension ran at some earlier moment, and a lock may
        // have started since.
        let verdict = Gatekeeper.verdict(for: token, store: store)
        guard verdict.allowsOverride,
              let tokenData = TokenKey.data(for: token) else {
            if let key = TokenKey.key(for: token) {
                EventLog.append(LoggedEvent(kind: .overrideRefused, appKey: key), store: store)
            }
            completionHandler(.defer)   // keep the shield on screen
            return
        }

        let friction = store.friction
        let delay = friction.clampedDelaySeconds

        // The wait. There is no way to draw a countdown — ShieldConfiguration
        // is rendered once, and nothing in ManagedSettingsUI animates — so the
        // screen simply sits there until the delay is served.
        //
        // This is the piece most at risk from the extension's runtime budget.
        // If the system reclaims us mid-wait, no completion handler is called
        // and the shield stays: the safe direction.
        DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(delay)) {
            let granted = Self.openWindow(for: token, tokenData: tokenData,
                                          friction: friction, store: store)
            completionHandler(granted ? .none : .defer)
        }
    }

    /// Lifts the shield for this app and arms its return.
    ///
    /// Returns false if DeviceActivity refused to watch the window — in which
    /// case nothing is unshielded, because an override we cannot end is worse
    /// than an override refused.
    private static func openWindow(for token: ApplicationToken,
                                   tokenData: Data,
                                   friction: FrictionSettings,
                                   store: SharedStore) -> Bool {
        let now = Date()
        let graceMinutes = friction.clampedGraceMinutes
        // DeviceActivity rejects intervals under 15 minutes, so the interval
        // is the outer bound and the usage threshold is the real limit:
        // the shield returns after `graceMinutes` of use, or when the window
        // closes, whichever happens first.
        let windowMinutes = max(15, graceMinutes + 1)
        let expiresAt = now.addingTimeInterval(TimeInterval(windowMinutes * 60))

        let activity = QuietActivity.override()
        let calendar = Calendar.current
        let fields: Set<Calendar.Component> = [.year, .month, .day, .hour, .minute, .second]

        let schedule = DeviceActivitySchedule(
            intervalStart: calendar.dateComponents(fields, from: now.addingTimeInterval(-60)),
            intervalEnd: calendar.dateComponents(fields, from: expiresAt),
            repeats: false
        )
        let event = DeviceActivityEvent(
            applications: [token],
            threshold: DateComponents(minute: graceMinutes)
        )

        do {
            try DeviceActivityCenter().startMonitoring(
                activity,
                during: schedule,
                events: [.graceUsedUp: event]
            )
        } catch {
            EventLog.append(LoggedEvent(kind: .overrideRefused,
                                        appKey: tokenData.base64EncodedString(),
                                        detail: "monitor refused: \(error.localizedDescription)"),
                            store: store)
            return false
        }

        let ledger = OverrideLedger(store: store)
        ledger.add(OverrideRecord(tokenData: tokenData,
                                  activityName: activity.rawValue,
                                  grantedAt: now,
                                  expiresAt: expiresAt))
        ledger.recordOpen(forKey: tokenData.base64EncodedString())
        EventLog.append(LoggedEvent(kind: .overrideGranted,
                                    appKey: tokenData.base64EncodedString(),
                                    detail: "delay \(friction.clampedDelaySeconds)s"),
                        store: store)

        ShieldPolicy.apply(store: store)
        return true
    }
}
