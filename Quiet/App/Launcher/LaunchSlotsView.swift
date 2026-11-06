import SwiftUI
import WidgetKit

struct LaunchSlotsView: View {
    @State private var slots = LaunchSlots.load()
    @State private var store = SharedStore()

    var body: some View {
        List {
            Section {
                Text("Up to \(LaunchSlots.maxSlots) rows. Type the name yourself — an app token carries no name that a widget is allowed to read.")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
            }

            ForEach($slots) { $slot in
                Section {
                    TextField("Label", text: $slot.label)
                    TextField("URL or shortcut", text: $slot.urlString)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Toggle("Direct launch", isOn: $slot.directLaunch)
                    if slot.directLaunch {
                        Text("Links straight at the app. Faster, but WidgetKit only documents links back to the containing app, so it may do nothing.")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.orange)
                    }
                    if slot.url == nil && !slot.urlString.isEmpty {
                        Text("That isn't a URL iOS can open.")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.red)
                    }
                }
            }
            .onDelete { slots.remove(atOffsets: $0) }
            .onMove { slots.move(fromOffsets: $0, toOffset: $1) }

            Section {
                Button("Add row") {
                    guard slots.count < LaunchSlots.maxSlots else { return }
                    slots.append(LaunchSlot(label: "", urlString: ""))
                }
                .disabled(slots.count >= LaunchSlots.maxSlots)
                Button("Add the usual suspects") { slots = Self.starter }
            }

            Section {
                Button("Save") { save() }
            } footer: {
                Text("Shortcuts URLs are the reliable option: build a shortcut whose only action is Open App, then use shortcuts://run-shortcut?name=Its%20Name")
            }
        }
        .font(.system(.body, design: .monospaced))
        .navigationTitle("Rows")
        .toolbar { EditButton() }
    }

    private func save() {
        LaunchSlots.save(slots, store: store)
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// Apple's own schemes, which are documented and stable — unlike most
    /// third-party ones.
    static let starter: [LaunchSlot] = [
        LaunchSlot(label: "phone", urlString: "tel:"),
        LaunchSlot(label: "messages", urlString: "sms:"),
        LaunchSlot(label: "maps", urlString: "maps://"),
        LaunchSlot(label: "camera", urlString: "camera://"),
        LaunchSlot(label: "music", urlString: "music://"),
        LaunchSlot(label: "notes", urlString: "mobilenotes://")
    ]
}
