import SwiftUI

/// Text and bars. No charting framework — this renders inside an extension,
/// and the whole point of the app is to not be interesting to look at.
struct TotalsView: View {
    let summary: ActivitySummary

    private var peak: TimeInterval {
        max(summary.days.map(\.duration).max() ?? 1, 1)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline, spacing: 18) {
                figure(Self.hhmm(summary.totalDuration), "screen time")
                figure("\(summary.totalPickups)", "pickups")
            }

            if summary.days.isEmpty {
                Text("No data for this range yet.")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(summary.days) { day in
                        HStack(spacing: 8) {
                            Text(Self.dayLabel(day.date))
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .frame(width: 34, alignment: .leading)
                            GeometryReader { geo in
                                Rectangle()
                                    .fill(.white.opacity(0.85))
                                    .frame(width: max(1, geo.size.width * day.duration / peak),
                                           height: 9)
                                    .frame(maxHeight: .infinity, alignment: .center)
                            }
                            .frame(height: 12)
                            Text(Self.hhmm(day.duration))
                                .font(.system(size: 11, design: .monospaced))
                                .frame(width: 50, alignment: .trailing)
                        }
                    }
                }
            }
        }
        .padding(4)
    }

    private func figure(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value).font(.system(.title2, design: .monospaced, weight: .semibold))
            Text(label).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
        }
    }

    static func hhmm(_ interval: TimeInterval) -> String {
        let minutes = Int(interval) / 60
        return minutes >= 60 ? "\(minutes / 60)h \(minutes % 60)m" : "\(minutes)m"
    }

    static func dayLabel(_ date: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "EEE"
        return f.string(from: date)
    }
}
