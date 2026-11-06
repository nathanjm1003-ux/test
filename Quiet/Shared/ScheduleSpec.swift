import Foundation

/// A recurring window during which dumb-phone mode applies.
///
/// DeviceActivity wants one repeating activity per weekday, so a Mon–Fri
/// schedule costs five activities. The system caps how many a single app may
/// monitor at once (around 20 in practice), which is why `ScheduleStore`
/// refuses to arm more than `maxActivities` worth.
struct ScheduleSpec: Codable, Identifiable, Hashable {
    var id: UUID = UUID()
    var name: String = "Work hours"
    var startHour: Int = 9
    var startMinute: Int = 0
    var endHour: Int = 17
    var endMinute: Int = 0
    /// 1 = Sunday ... 7 = Saturday, matching `Calendar`'s weekday numbering.
    var weekdays: Set<Int> = [2, 3, 4, 5, 6]
    var enabled: Bool = true

    /// DeviceActivity rejects intervals shorter than 15 minutes.
    var durationMinutes: Int {
        let start = startHour * 60 + startMinute
        let end = endHour * 60 + endMinute
        return end > start ? end - start : (24 * 60 - start) + end
    }

    var isValid: Bool { durationMinutes >= 15 && !weekdays.isEmpty }

    var summary: String {
        let f = { (h: Int, m: Int) in String(format: "%02d:%02d", h, m) }
        return "\(f(startHour, startMinute))–\(f(endHour, endMinute))  \(weekdaySummary)"
    }

    var weekdaySummary: String {
        let names = ["", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
        return weekdays.sorted().compactMap { names.indices.contains($0) ? names[$0] : nil }
            .joined(separator: " ")
    }

    static let windDown = ScheduleSpec(
        name: "Wind-down",
        startHour: 21, startMinute: 0,
        endHour: 23, endMinute: 30,
        weekdays: [1, 2, 3, 4, 5, 6, 7]
    )
}

enum ScheduleStore {
    /// Headroom left for override and lock activities.
    static let maxActivities = 16

    static func load(store: SharedStore = SharedStore()) -> [ScheduleSpec] {
        store.decode([ScheduleSpec].self, SharedKey.schedules) ?? []
    }

    static func save(_ specs: [ScheduleSpec], store: SharedStore = SharedStore()) {
        store.encode(specs, SharedKey.schedules)
    }

    /// How many DeviceActivity activities the enabled schedules would need.
    static func activityCount(_ specs: [ScheduleSpec]) -> Int {
        specs.filter { $0.enabled && $0.isValid }.reduce(0) { $0 + $1.weekdays.count }
    }
}
