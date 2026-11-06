import Foundation

enum SharedKey {
    static let selectionEssential   = "selection.essential"
    static let selectionDistracting = "selection.distracting"
    static let selectionBlocked     = "selection.blocked"

    static let dumbModeManual       = "mode.dumbModeManual"
    static let dumbModeBySchedule   = "mode.dumbModeBySchedule"

    static let schedules            = "schedules.list"

    static let lockUntil            = "lock.until"
    static let lockStrict           = "lock.strict"
    static let lockStartedAt        = "lock.startedAt"

    static let friction             = "friction.settings"
    static let overridesPending     = "overrides.pending"
    static let counters             = "counters.byDay"
    static let eventLog             = "log.pending"
    static let launchSlots          = "launcher.slots"

    static let onboardingDone       = "onboarding.complete"
}

/// Thin typed wrapper over the App Group defaults.
///
/// Deliberately a struct with no caching: a shield extension may be launched,
/// read one value and be torn down, so there is nothing worth keeping warm.
struct SharedStore {
    let defaults: UserDefaults

    init(defaults: UserDefaults = AppGroup.defaults) {
        self.defaults = defaults
    }

    // MARK: primitives

    func bool(_ key: String, default fallback: Bool = false) -> Bool {
        defaults.object(forKey: key) == nil ? fallback : defaults.bool(forKey: key)
    }

    func set(_ value: Bool, _ key: String) { defaults.set(value, forKey: key) }

    func date(_ key: String) -> Date? { defaults.object(forKey: key) as? Date }

    func set(_ value: Date?, _ key: String) {
        if let value { defaults.set(value, forKey: key) }
        else { defaults.removeObject(forKey: key) }
    }

    func decode<T: Decodable>(_ type: T.Type, _ key: String) -> T? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    func encode<T: Encodable>(_ value: T?, _ key: String) {
        guard let value else { defaults.removeObject(forKey: key); return }
        guard let data = try? JSONEncoder().encode(value) else { return }
        defaults.set(data, forKey: key)
    }

    func remove(_ key: String) { defaults.removeObject(forKey: key) }
}
