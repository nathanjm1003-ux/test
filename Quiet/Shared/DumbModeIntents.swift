import AppIntents

/// Toggling the mode from Shortcuts, Siri, or the Control Center control.
///
/// `SetValueIntent` is what a `ControlWidgetToggle` drives, and the same type
/// works as an ordinary Shortcuts action, so there is one implementation
/// rather than two that can drift.
struct SetDumbModeIntent: SetValueIntent {
    static var title: LocalizedStringResource = "Set Dumb Phone Mode"
    static var description = IntentDescription(
        "Shields every app except your Essential list.")

    @Parameter(title: "On")
    var value: Bool

    init() {}
    init(value: Bool) { self.value = value }

    func perform() async throws -> some IntentResult {
        let result = DumbModeController.set(value, source: .intent)
        guard result.canEnable else {
            throw DumbModeIntentError.refused(result.blocking.joined(separator: " "))
        }
        return .result()
    }
}

struct ToggleDumbModeIntent: AppIntent {
    static var title: LocalizedStringResource = "Toggle Dumb Phone Mode"
    static var description = IntentDescription("Turns dumb phone mode on if it is off, and off if it is on.")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let next = !DumbModeController.isOn()
        let result = DumbModeController.set(next, source: .intent)
        guard result.canEnable else {
            throw DumbModeIntentError.refused(result.blocking.joined(separator: " "))
        }
        return .result(dialog: next ? "Quiet is on." : "Quiet is off.")
    }
}

struct DumbModeStatusIntent: AppIntent {
    static var title: LocalizedStringResource = "Is Dumb Phone Mode On"
    static var description = IntentDescription("Reports whether Quiet is currently shielding apps.")

    func perform() async throws -> some IntentResult & ReturnsValue<Bool> & ProvidesDialog {
        let on = DumbModeController.isOn()
        return .result(value: on, dialog: on ? "Quiet is on." : "Quiet is off.")
    }
}

enum DumbModeIntentError: Error, CustomLocalizedStringResourceConvertible {
    case refused(String)

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .refused(let why): return "Couldn’t turn Quiet on. \(why)"
        }
    }
}
