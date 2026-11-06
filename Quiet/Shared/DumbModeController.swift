import Foundation

/// Everything that turns dumb-phone mode on or off, from any entry point:
/// the app's toggle, the App Intent, the Shortcut, or the Control Center
/// control. They all land here so the shields and the log stay consistent.
enum DumbModeController {

    enum Source: String { case app, intent, control, schedule }

    @discardableResult
    static func set(_ on: Bool, source: Source, store: SharedStore = SharedStore()) -> SafetyCheck.Result {
        if on {
            let check = SafetyCheck.forDumbMode(store: store)
            guard check.canEnable else { return check }
        }
        store.dumbModeManual = on
        ShieldPolicy.apply(store: store)
        EventLog.append(LoggedEvent(kind: on ? .modeOn : .modeOff,
                                    detail: source.rawValue),
                        store: store)
        return SafetyCheck.Result()
    }

    static func isOn(store: SharedStore = SharedStore()) -> Bool {
        store.dumbModeActive
    }
}
