import SwiftUI

struct DumbModeView: View {
    @Environment(AuthorizationModel.self) private var authorization
    @State private var store = SharedStore()
    @State private var isOn = SharedStore().dumbModeManual
    @State private var blockingReasons: [String] = []
    @State private var warnings: [String] = []

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Toggle(isOn: $isOn) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Dumb phone mode")
                            Text(isOn ? "Only Essential apps open." : "Everything opens normally.")
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .onChange(of: isOn) { _, newValue in apply(newValue) }
                    .disabled(!isAuthorized)

                    if store.dumbModeBySchedule {
                        Label("A schedule is holding this on right now.",
                              systemImage: "clock")
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                } footer: {
                    Text("Shields everything except your Essential list, including Safari domains.")
                }

                if !isAuthorized {
                    Section {
                        Text("Screen Time access is off, so nothing can be blocked.")
                            .foregroundStyle(.orange)
                        Button("Request access") { Task { await authorization.request() } }
                    }
                }

                ForEach(blockingReasons, id: \.self) { reason in
                    Section { Text(reason).foregroundStyle(.red) }
                }
                ForEach(warnings, id: \.self) { warning in
                    Section { Text(warning).foregroundStyle(.orange) }
                }

                Section("Schedules") {
                    NavigationLink("Recurring windows") { SchedulesView() }
                }
            }
            .font(.system(.body, design: .monospaced))
            .navigationTitle("Quiet")
            .onAppear { refresh() }
        }
    }

    private var isAuthorized: Bool { authorization.status == .approved }

    private func refresh() {
        isOn = store.dumbModeManual
        let check = SafetyCheck.forDumbMode(store: store)
        blockingReasons = check.blocking
        warnings = check.warnings
    }

    private func apply(_ on: Bool) {
        let result = DumbModeController.set(on, source: .app, store: store)
        if !result.canEnable {
            blockingReasons = result.blocking
            isOn = false
        } else {
            blockingReasons = []
        }
        warnings = SafetyCheck.forDumbMode(store: store).warnings
    }
}
