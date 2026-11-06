import SwiftUI
import DeviceActivity
import SwiftData

struct StatsView: View {
    @Environment(AuthorizationModel.self) private var authorization
    @Query(sort: \OverrideEvent.timestamp, order: .reverse) private var overrides: [OverrideEvent]
    @State private var range: Range = .week

    enum Range: String, CaseIterable, Identifiable {
        case day = "Today", week = "7 days"
        var id: String { rawValue }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Picker("Range", selection: $range) {
                        ForEach(Range.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)

                    if authorization.status == .approved {
                        // The report renders inside its own extension; this
                        // view is only a window onto it.
                        DeviceActivityReport(.quietTotals, filter: filter)
                            .frame(minHeight: 260)
                    } else {
                        Text("Screen Time access is off, so there are no figures to show.")
                            .font(.system(.footnote, design: .monospaced))
                            .foregroundStyle(.orange)
                    }

                    Divider().overlay(.white.opacity(0.15))

                    Text("Overrides")
                        .font(.system(.headline, design: .monospaced))
                    if overrides.isEmpty {
                        Text("None yet.")
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(overrides.prefix(25)) { event in
                            HStack {
                                Text(event.timestamp, format: .dateTime.day().month().hour().minute())
                                Spacer()
                                Text(event.granted ? "opened" : "refused")
                                    .foregroundStyle(event.granted ? .orange : .secondary)
                            }
                            .font(.system(size: 11, design: .monospaced))
                        }
                        Text("Apps are shown as counts only: an app token carries no name outside the picker, so there is nothing to label these with.")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(20)
            }
            .navigationTitle("Stats")
        }
    }

    private var filter: DeviceActivityFilter {
        let calendar = Calendar.current
        let end = Date()
        let start: Date
        switch range {
        case .day:  start = calendar.startOfDay(for: end)
        case .week: start = calendar.date(byAdding: .day, value: -6, to: calendar.startOfDay(for: end)) ?? end
        }
        return DeviceActivityFilter(
            segment: .daily(during: DateInterval(start: start, end: end)),
            users: .all,
            devices: .init([.iPhone])
        )
    }
}
