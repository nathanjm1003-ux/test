import SwiftUI

struct SchedulesView: View {
    @State private var specs = ScheduleStore.load()
    @State private var error: String?

    var body: some View {
        List {
            if let error {
                Section { Text(error).foregroundStyle(.red) }
            }

            Section {
                Text("Slots used: \(ScheduleStore.activityCount(specs)) of \(ScheduleStore.maxActivities)")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
            } footer: {
                Text("iOS limits how many windows one app can watch. Each weekday of each schedule costs one slot.")
            }

            ForEach($specs) { $spec in
                Section {
                    Toggle("Enabled", isOn: $spec.enabled)
                    TextField("Name", text: $spec.name)
                    TimeRow(label: "Start", hour: $spec.startHour, minute: $spec.startMinute)
                    TimeRow(label: "End", hour: $spec.endHour, minute: $spec.endMinute)
                    WeekdayRow(weekdays: $spec.weekdays)
                    if !spec.isValid {
                        Text(spec.weekdays.isEmpty
                             ? "Pick at least one day."
                             : "Windows must be at least 15 minutes — iOS rejects shorter ones.")
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.orange)
                    }
                } header: {
                    Text(spec.summary)
                }
            }
            .onDelete { specs.remove(atOffsets: $0) }

            Section {
                Button("Add schedule") { specs.append(ScheduleSpec()) }
                Button("Add wind-down (21:00–23:30)") { specs.append(.windDown) }
            }

            Section {
                Button("Save and arm") { save() }
                    .disabled(specs.contains { $0.enabled && !$0.isValid })
                Button("Disarm all", role: .destructive) {
                    ScheduleArmer.disarmAll()
                    error = nil
                }
            }
        }
        .font(.system(.body, design: .monospaced))
        .navigationTitle("Schedules")
    }

    private func save() {
        ScheduleStore.save(specs)
        do {
            try ScheduleArmer.arm(specs)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct TimeRow: View {
    let label: String
    @Binding var hour: Int
    @Binding var minute: Int

    var body: some View {
        HStack {
            Text(label)
            Spacer()
            Picker("", selection: $hour) {
                ForEach(0..<24, id: \.self) { Text(String(format: "%02d", $0)).tag($0) }
            }
            .labelsHidden()
            Text(":")
            Picker("", selection: $minute) {
                ForEach([0, 15, 30, 45], id: \.self) { Text(String(format: "%02d", $0)).tag($0) }
            }
            .labelsHidden()
        }
    }
}

struct WeekdayRow: View {
    @Binding var weekdays: Set<Int>
    private let names = [(1, "S"), (2, "M"), (3, "T"), (4, "W"), (5, "T"), (6, "F"), (7, "S")]

    var body: some View {
        HStack(spacing: 6) {
            ForEach(names, id: \.0) { day, letter in
                Button {
                    if weekdays.contains(day) { weekdays.remove(day) } else { weekdays.insert(day) }
                } label: {
                    Text(letter)
                        .font(.system(.caption, design: .monospaced))
                        .frame(width: 30, height: 30)
                        .background(weekdays.contains(day) ? Color.white : Color.clear)
                        .foregroundStyle(weekdays.contains(day) ? Color.black : Color.white)
                        .overlay(Circle().stroke(.white.opacity(0.3)))
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
            }
        }
    }
}
