import Foundation
import FamilyControls
import ManagedSettings

extension ManagedSettingsStore.Name {
    static let dumbMode    = Self("quiet.dumbMode")
    static let distracting = Self("quiet.distracting")
    static let blocked     = Self("quiet.blocked")
    static let lock        = Self("quiet.lock")
}

/// Four named stores rather than one.
///
/// Restrictions from separate stores are unioned by the system, so each
/// feature can clear its own without having to know what the others wanted.
/// Collapsing these into one store is the classic way to end up with a lock
/// that a schedule quietly lifts.
enum ShieldStores {
    static let dumbMode    = ManagedSettingsStore(named: .dumbMode)
    static let distracting = ManagedSettingsStore(named: .distracting)
    static let blocked     = ManagedSettingsStore(named: .blocked)
    static let lock        = ManagedSettingsStore(named: .lock)

    static var all: [ManagedSettingsStore] { [dumbMode, distracting, blocked, lock] }

    static func clearAll() {
        all.forEach { $0.clearAllSettings() }
    }
}

/// Recomputes every shield from stored state.
///
/// Everything that changes policy — toggling the mode, a schedule starting,
/// an override being granted or running out, a lock beginning or expiring —
/// goes through `apply()`. There is no incremental path, because incremental
/// shield edits are how apps end up permanently shielding something nobody
/// asked for.
enum ShieldPolicy {

    static func apply(store: SharedStore = SharedStore()) {
        store.clearLockIfExpired()

        let essential   = store.selection(.essential)
        let distracting = store.selection(.distracting)
        let blocked     = store.selection(.blocked)
        let lock        = store.lock
        let ledger      = OverrideLedger(store: store)

        // A lock outranks any in-flight grace period.
        let allowances: Set<ApplicationToken> = lock.isActive ? [] : ledger.activeAllowances()

        applyBlocked(blocked)
        applyDumbMode(on: store.dumbModeActive, essential: essential, allowances: allowances)
        applyDistracting(distracting, allowances: allowances)
        applyLock(lock, distracting: distracting)
    }

    // MARK: pieces

    /// Always shielded, no way through. The shield action refuses to offer
    /// "Open anyway" for anything in here.
    private static func applyBlocked(_ selection: FamilyActivitySelection) {
        let store = ShieldStores.blocked
        store.shield.applications = selection.applicationTokens.isEmpty
            ? nil : selection.applicationTokens
        store.shield.webDomains = selection.webDomainTokens.isEmpty
            ? nil : selection.webDomainTokens
        store.shield.applicationCategories = selection.categoryTokens.isEmpty
            ? nil : .specific(selection.categoryTokens, except: [])
    }

    /// The allow-list. Everything is shielded except the Essential group and
    /// whatever currently holds a grace period.
    private static func applyDumbMode(on: Bool,
                                      essential: FamilyActivitySelection,
                                      allowances: Set<ApplicationToken>) {
        let store = ShieldStores.dumbMode
        guard on else {
            store.shield.applicationCategories = nil
            store.shield.webDomainCategories = nil
            return
        }
        let exceptApps = essential.applicationTokens.union(allowances)
        store.shield.applicationCategories = .all(except: exceptApps)
        store.shield.webDomainCategories = .all(except: essential.webDomainTokens)
    }

    /// Friction on the Distracting group, in force whether or not dumb-phone
    /// mode is on — that is the point of the group.
    private static func applyDistracting(_ selection: FamilyActivitySelection,
                                         allowances: Set<ApplicationToken>) {
        let store = ShieldStores.distracting
        let shielded = selection.applicationTokens.subtracting(allowances)
        store.shield.applications = shielded.isEmpty ? nil : shielded
        store.shield.webDomains = selection.webDomainTokens.isEmpty
            ? nil : selection.webDomainTokens
    }

    private static func applyLock(_ lock: LockState,
                                  distracting: FamilyActivitySelection) {
        let store = ShieldStores.lock
        guard lock.isActive else {
            store.shield.applications = nil
            store.shield.webDomains = nil
            store.application.denyAppRemoval = nil
            return
        }
        store.shield.applications = distracting.applicationTokens.isEmpty
            ? nil : distracting.applicationTokens
        store.shield.webDomains = distracting.webDomainTokens.isEmpty
            ? nil : distracting.webDomainTokens
        // Device-wide, not app-specific. See README: strict mode stops you
        // deleting *any* app while the lock runs, Quiet included.
        store.application.denyAppRemoval = lock.strict ? true : nil
    }
}

extension SharedStore {
    /// Dumb-phone mode is on if you switched it on, or if a schedule is
    /// currently inside its window.
    var dumbModeActive: Bool {
        bool(SharedKey.dumbModeManual) || bool(SharedKey.dumbModeBySchedule)
    }

    var dumbModeManual: Bool {
        get { bool(SharedKey.dumbModeManual) }
        nonmutating set { set(newValue, SharedKey.dumbModeManual) }
    }

    var dumbModeBySchedule: Bool {
        get { bool(SharedKey.dumbModeBySchedule) }
        nonmutating set { set(newValue, SharedKey.dumbModeBySchedule) }
    }
}

/// Things that must be true before dumb-phone mode is worth switching on.
///
/// We cannot put Phone or Messages on the allow-list ourselves: tokens only
/// come out of the picker, so only the user can add them. The honest move is
/// to refuse to arm an allow-list that would strand them.
enum SafetyCheck {
    struct Result {
        var blocking: [String] = []
        var warnings: [String] = []
        var canEnable: Bool { blocking.isEmpty }
    }

    static func forDumbMode(store: SharedStore = SharedStore()) -> Result {
        var result = Result()
        let essential = store.selection(.essential)

        if !AppGroup.isConfigured {
            result.blocking.append(
                "The App Group isn’t set up, so the app and its extensions can’t share settings.")
        }
        if essential.applicationTokens.isEmpty && essential.categoryTokens.isEmpty {
            result.blocking.append(
                "Your Essential list is empty. Turning this on would shield everything.")
        }
        if essential.applicationTokens.count < 2 {
            result.warnings.append(
                "Only one Essential app. Add Phone, Messages and Maps before you rely on this.")
        }
        return result
    }
}

extension SharedStore {
    private static let activeSchedulesKey = "mode.activeSchedules"

    /// Names of schedule activities currently inside their window.
    var activeScheduleNames: [String] {
        get { decode([String].self, Self.activeSchedulesKey) ?? [] }
        nonmutating set {
            encode(newValue, Self.activeSchedulesKey)
            dumbModeBySchedule = !newValue.isEmpty
        }
    }

    func noteScheduleStarted(_ name: String) {
        var names = activeScheduleNames
        guard !names.contains(name) else { return }
        names.append(name)
        activeScheduleNames = names
    }

    func noteScheduleEnded(_ name: String) {
        activeScheduleNames = activeScheduleNames.filter { $0 != name }
    }
}
