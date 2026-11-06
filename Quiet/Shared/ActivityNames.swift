import Foundation
import DeviceActivity

/// Naming scheme for DeviceActivity activities.
///
/// The monitor extension gets only a `DeviceActivityName`, so the prefix is
/// how it works out what a callback is about before touching shared storage.
enum QuietActivity {
    static let schedulePrefix = "quiet.schedule."
    static let overridePrefix = "quiet.override."
    static let lockPrefix     = "quiet.lock."

    static func schedule(_ id: String, weekday: Int) -> DeviceActivityName {
        DeviceActivityName("\(schedulePrefix)\(id).\(weekday)")
    }

    static func override(_ id: UUID = UUID()) -> DeviceActivityName {
        DeviceActivityName("\(overridePrefix)\(id.uuidString)")
    }

    /// Ends precisely when the lock is due to end.
    static let lockWindow = DeviceActivityName("\(lockPrefix)window")
    /// Fires daily as a backstop, in case the precise window is missed —
    /// long intervals are the part of DeviceActivity I trust least.
    static let lockWatchdog = DeviceActivityName("\(lockPrefix)watchdog")

    static func kind(of name: DeviceActivityName) -> Kind {
        let raw = name.rawValue
        if raw.hasPrefix(schedulePrefix) { return .schedule }
        if raw.hasPrefix(overridePrefix) { return .override }
        if raw.hasPrefix(lockPrefix)     { return .lock }
        return .unknown
    }

    enum Kind { case schedule, override, lock, unknown }
}

extension DeviceActivityEvent.Name {
    /// Fires once the grace period has been *used up*, which is what we
    /// actually want: five minutes of Instagram, not five minutes of clock.
    static let graceUsedUp = Self("quiet.graceUsedUp")
}
