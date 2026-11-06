import SwiftUI
import SwiftData

@main
struct QuietApp: App {
    @State private var authorization = AuthorizationModel()
    @State private var store = SharedStore()

    /// SwiftData lives in the App Group container so the history survives
    /// reinstall-adjacent events and stays beside the shared defaults.
    /// Only the main app opens it — extensions must stay small.
    private let container: ModelContainer? = {
        guard let dir = AppGroup.containerURL else { return nil }
        let config = ModelConfiguration(url: dir.appendingPathComponent("Quiet.store"))
        return try? ModelContainer(for: OverrideEvent.self, LockEvent.self, ModeEvent.self,
                                   configurations: config)
    }()

    var body: some Scene {
        WindowGroup {
            Group {
                if let container {
                    RootView()
                        .modelContainer(container)
                        .task { HistoryImporter.drain(into: container) }
                } else {
                    StorageUnavailableView()
                }
            }
            .environment(authorization)
            .preferredColorScheme(.dark)
            .tint(.white)
        }
    }
}

/// Shown only when the App Group is missing, which means the app and its
/// extensions cannot share anything. Better a blunt screen than a silent
/// split brain.
struct StorageUnavailableView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Shared storage unavailable")
                .font(.system(.title2, design: .monospaced, weight: .semibold))
            Text("""
                 Quiet needs the App Group “\(AppGroup.identifier)” on the app \
                 and on every extension. Without it the blocking screen can’t \
                 read your settings.

                 In Xcode: select each target → Signing & Capabilities → \
                 App Groups → add the group.
                 """)
            .font(.system(.footnote, design: .monospaced))
            .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.black)
    }
}
