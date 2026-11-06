import AppIntents
import SwiftUI
import WidgetKit

/// Control Center toggle.
///
/// Control Center controls are iOS 18. The app targets iOS 17, so this is
/// gated and simply does not appear on 17 — where the Shortcuts action and
/// the Lock Screen widget are the equivalents.
@available(iOS 18.0, *)
struct QuietControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.example.quiet.control",
                                   provider: DumbModeValueProvider()) { isOn in
            ControlWidgetToggle("Quiet", isOn: isOn, action: SetDumbModeIntent()) { on in
                Label(on ? "Quiet on" : "Quiet off", systemImage: on ? "moon.fill" : "moon")
            }
        }
        .displayName("Dumb phone mode")
        .description("Shield everything except your Essential apps.")
    }
}

@available(iOS 18.0, *)
struct DumbModeValueProvider: ControlValueProvider {
    var previewValue: Bool { false }

    func currentValue() async throws -> Bool {
        DumbModeController.isOn()
    }
}
