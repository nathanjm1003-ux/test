import DeviceActivity
import SwiftUI

/// Screen-time figures live entirely inside this extension.
///
/// `DeviceActivityReport` hands its data to the extension and nowhere else:
/// the numbers cannot be read by the containing app, written to the App
/// Group, or persisted. That is a privacy guarantee of the framework, not an
/// oversight — so there is no "export my screen time" feature, and there
/// cannot be one.
@main
struct QuietReportExtension: DeviceActivityReportExtension {
    var body: some DeviceActivityReportScene {
        TotalsReport { summary in
            TotalsView(summary: summary)
        }
    }
}

struct DaySummary: Identifiable, Hashable {
    var id: Date { date }
    let date: Date
    let duration: TimeInterval
    let pickups: Int
}

struct ActivitySummary {
    var totalDuration: TimeInterval = 0
    var totalPickups: Int = 0
    var days: [DaySummary] = []
}

struct TotalsReport: DeviceActivityReportScene {
    let context: DeviceActivityReport.Context = .quietTotals
    let content: (ActivitySummary) -> TotalsView

    func makeConfiguration(
        representing data: DeviceActivityResults<DeviceActivityData>
    ) async -> ActivitySummary {
        var summary = ActivitySummary()

        for await result in data {
            for await segment in result.activitySegments {
                let duration = segment.totalActivityDuration
                var pickups = 0
                for await category in segment.categories {
                    for await app in category.applications {
                        pickups += app.numberOfPickups
                    }
                }
                summary.totalDuration += duration
                summary.totalPickups += pickups
                summary.days.append(DaySummary(date: segment.dateInterval.start,
                                               duration: duration,
                                               pickups: pickups))
            }
        }
        summary.days.sort { $0.date < $1.date }
        return summary
    }
}
