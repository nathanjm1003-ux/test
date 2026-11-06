import Foundation

/// Everything that governs how hard it is to get past a shield.
struct FrictionSettings: Codable, Equatable {
    /// Seconds to wait after tapping "Open anyway" before the app opens.
    var delaySeconds: Int = 15
    /// Minutes of use granted once the delay is served.
    var graceMinutes: Int = 5
    /// Opens allowed per Distracting app per day. 0 means unlimited.
    var dailyLimit: Int = 5
    /// Shown under the app name on the shield.
    var message: String = "This one is on your distracting list."

    static let `default` = FrictionSettings()

    /// `graceMinutes` doubles as a DeviceActivity usage threshold, which the
    /// system measures in whole minutes, so anything under 1 is meaningless.
    var clampedGraceMinutes: Int { max(1, min(graceMinutes, 60)) }
    var clampedDelaySeconds: Int { max(0, min(delaySeconds, 120)) }
}

extension SharedStore {
    var friction: FrictionSettings {
        get { decode(FrictionSettings.self, SharedKey.friction) ?? .default }
        nonmutating set { encode(newValue, SharedKey.friction) }
    }
}
