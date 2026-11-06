import SwiftUI

struct LocksView: View {
    @State private var store = SharedStore()
    @State private var strict = false
    @State private var pending: LockController.Duration?
    @State private var error: String?
    @State private var now = Date()

    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        NavigationStack {
            List {
                if store.lock.isActive {
                    activeSection
                } else {
                    startSection
                }

                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .font(.system(.body, design: .monospaced))
            .navigationTitle("Lock")
            .onReceive(tick) { now = $0 }
            .confirmationDialog("Lock for \(pending?.label ?? "")?",
                                isPresented: .constant(pending != nil),
                                titleVisibility: .visible) {
                Button("Lock for \(pending?.label ?? "")", role: .destructive) {
                    if let pending { start(pending) }
                    pending = nil
                }
                Button("Cancel", role: .cancel) { pending = nil }
            } message: {
                Text(strict
                     ? "No early unlock. Strict mode also blocks deleting apps — any app, not just Quiet — until it ends."
                     : "No early unlock. Deleting Quiet would end it.")
            }
        }
    }

    private var activeSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(remainingText)
                    .font(.system(.title, design: .monospaced, weight: .semibold))
                    .monospacedDigit()
                Text("Distracting apps are locked. There is no way to end this early.")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                if store.lock.strict {
                    Text("Strict mode: app deletion is blocked device-wide.")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.orange)
                }
            }
            .padding(.vertical, 6)
        } header: {
            Text("Locked")
        }
    }

    private var startSection: some View {
        Group {
            Section {
                Toggle("Strict mode", isOn: $strict)
            } footer: {
                Text("Also sets denyAppRemoval, so no app can be deleted while the lock runs. That includes Quiet, which is the point — and also every other app, which iOS gives no way to narrow.")
            }

            Section("Lock Distracting apps for") {
                ForEach(LockController.durations) { duration in
                    Button(duration.label) { pending = duration }
                }
            }
        }
    }

    private var remainingText: String {
        let seconds = Int(max(0, store.lock.remaining))
        let days = seconds / 86400
        let hours = (seconds % 86400) / 3600
        let minutes = (seconds % 3600) / 60
        let secs = seconds % 60
        if days > 0 { return String(format: "%dd %02dh %02dm", days, hours, minutes) }
        return String(format: "%02d:%02d:%02d", hours, minutes, secs)
    }

    private func start(_ duration: LockController.Duration) {
        do {
            try LockController.start(duration, strict: strict, store: store)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
