import Foundation
import DeviceActivity

/// Arms and disarms the recurring windows.
///
/// DeviceActivity wants one repeating activity per weekday, and caps how many
/// an app may monitor at once, so this refuses to arm past `maxActivities`
/// rather than letting `startMonitoring` throw halfway through and leave the
/// schedule half-applied.
enum ScheduleArmer {

    enum ArmError: LocalizedError {
        case tooMany(needed: Int, limit: Int)
        case system(Error)

        var errorDescription: String? {
            switch self {
            case .tooMany(let needed, let limit):
                return "These schedules need \(needed) monitoring slots; iOS allows about \(limit). Remove a day or a schedule."
            case .system(let error):
                return "iOS refused the schedule: \(error.localizedDescription)"
            }
        }
    }

    static func arm(_ specs: [ScheduleSpec]) throws {
        let center = DeviceActivityCenter()
        let existing = center.activities.filter { QuietActivity.kind(of: $0) == .schedule }
        center.stopMonitoring(existing)

        let active = specs.filter { $0.enabled && $0.isValid }
        let needed = ScheduleStore.activityCount(active)
        guard needed <= ScheduleStore.maxActivities else {
            throw ArmError.tooMany(needed: needed, limit: ScheduleStore.maxActivities)
        }

        for spec in active {
            for weekday in spec.weekdays {
                let schedule = DeviceActivitySchedule(
                    intervalStart: DateComponents(hour: spec.startHour,
                                                  minute: spec.startMinute,
                                                  weekday: weekday),
                    intervalEnd: DateComponents(hour: spec.endHour,
                                                minute: spec.endMinute,
                                                weekday: weekday),
                    repeats: true
                )
                do {
                    try center.startMonitoring(QuietActivity.schedule(spec.id.uuidString,
                                                                     weekday: weekday),
                                               during: schedule)
                } catch {
                    throw ArmError.system(error)
                }
            }
        }
    }

    static func disarmAll() {
        let center = DeviceActivityCenter()
        center.stopMonitoring(center.activities.filter { QuietActivity.kind(of: $0) == .schedule })
        SharedStore().dumbModeBySchedule = false
        ShieldPolicy.apply()
    }
}
