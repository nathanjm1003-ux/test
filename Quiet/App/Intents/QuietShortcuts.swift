import AppIntents

/// Surfaces the intents in the Shortcuts app and to Siri without the user
/// having to build anything first.
struct QuietShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: ToggleDumbModeIntent(),
            phrases: ["Toggle \(.applicationName)", "Flip \(.applicationName) mode"],
            shortTitle: "Toggle Quiet",
            systemImageName: "moon"
        )
        AppShortcut(
            intent: DumbModeStatusIntent(),
            phrases: ["Is \(.applicationName) on"],
            shortTitle: "Quiet status",
            systemImageName: "questionmark.circle"
        )
    }
}
