import SwiftUI

struct SettingsView: View {
    @Environment(AuthorizationModel.self) private var authorization
    @State private var store = SharedStore()
    @State private var friction = SharedStore().friction
    @State private var exporting = false
    @State private var importing = false
    @State private var message: String?
    @State private var document = ExportDocument(data: Data())

    var body: some View {
        NavigationStack {
            List {
                Section("Friction") {
                    Stepper("Delay: \(friction.delaySeconds)s",
                            value: $friction.delaySeconds, in: 0...120, step: 5)
                    Stepper("Grace: \(friction.graceMinutes) min",
                            value: $friction.graceMinutes, in: 1...60)
                    Stepper(friction.dailyLimit == 0
                            ? "Daily opens: unlimited"
                            : "Daily opens: \(friction.dailyLimit)",
                            value: $friction.dailyLimit, in: 0...20)
                    TextField("Shield message", text: $friction.message, axis: .vertical)
                }
                .onChange(of: friction) { _, new in store.friction = new }

                Section {
                    Text("The shield returns after \(friction.clampedGraceMinutes) min of use, or \(max(15, friction.clampedGraceMinutes + 1)) min of clock, whichever comes first.")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                } footer: {
                    Text("iOS won't watch a window shorter than 15 minutes, so the clock bound can't go below that. The usage threshold is the one that normally fires.")
                }

                Section("Home screen rows") {
                    NavigationLink("Edit rows") { LaunchSlotsView() }
                }

                Section("Screen Time access") {
                    LabeledContent("Status", value: statusText)
                    if authorization.status != .approved {
                        Button("Request access") { Task { await authorization.request() } }
                    }
                }

                Section {
                    Button("Export settings") { startExport() }
                    Button("Import settings") { importing = true }
                    if let message {
                        Text(message)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Backup")
                } footer: {
                    Text("App choices are not exported. Screen Time identifies apps with opaque tokens tied to this install, so they would not survive the trip. Everything else — friction, schedules, home rows — does.")
                }

                Section {
                    Button("Clear all shields", role: .destructive) {
                        ShieldStores.clearAll()
                        store.dumbModeManual = false
                        message = "All shields cleared."
                    }
                } footer: {
                    Text("A running lock is re-applied the next time policy is recomputed. This is for getting out of a broken state, not for ending a lock.")
                }
            }
            .font(.system(.body, design: .monospaced))
            .navigationTitle("Settings")
            .fileExporter(isPresented: $exporting, document: document,
                          contentType: .json, defaultFilename: "quiet-settings") { result in
                if case .failure(let error) = result { message = error.localizedDescription }
                else { message = "Exported." }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
                handleImport(result)
            }
        }
    }

    private var statusText: String {
        switch authorization.status {
        case .approved: return "granted"
        case .denied: return "denied"
        case .notDetermined: return "not asked"
        case .unknown: return "unknown"
        case .unavailable(let why): return why
        }
    }

    private func startExport() {
        do {
            document = ExportDocument(data: try QuietExport.current(store: store).encoded())
            exporting = true
        } catch {
            message = "Couldn't build the export: \(error.localizedDescription)"
        }
    }

    private func handleImport(_ result: Result<URL, Error>) {
        do {
            let url = try result.get()
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let imported = try QuietExport.decode(try Data(contentsOf: url))
            imported.apply(store: store)
            friction = imported.friction
            message = "Imported. Re-pick your apps — selections don't travel."
        } catch {
            message = "Import failed: \(error.localizedDescription)"
        }
    }
}
