import Foundation

/// A time-boxed lock on the Distracting group.
///
/// There is deliberately no "unlock now". The only things that end a lock are
/// the clock and deleting the app — and strict mode blocks the latter.
///
/// Persistence note: the *shield* survives reboot for free, because
/// ManagedSettings is system state rather than anything we keep running.
/// What needs arranging is the **lifting**, which is why expiry is driven by a
/// DeviceActivity interval plus a check whenever the app is opened — never by
/// an in-process timer.
struct LockState: Equatable {
    var until: Date?
    var strict: Bool
    var startedAt: Date?

    var isActive: Bool {
        guard let until else { return false }
        return until > Date()
    }

    var remaining: TimeInterval {
        guard let until else { return 0 }
        return max(0, until.timeIntervalSinceNow)
    }

    static let inactive = LockState(until: nil, strict: false, startedAt: nil)
}

extension SharedStore {
    var lock: LockState {
        LockState(until: date(SharedKey.lockUntil),
                  strict: bool(SharedKey.lockStrict),
                  startedAt: date(SharedKey.lockStartedAt))
    }

    func beginLock(until: Date, strict: Bool) {
        set(until, SharedKey.lockUntil)
        set(strict, SharedKey.lockStrict)
        set(Date(), SharedKey.lockStartedAt)
    }

    func clearLock() {
        remove(SharedKey.lockUntil)
        remove(SharedKey.lockStrict)
        remove(SharedKey.lockStartedAt)
    }

    /// True if a lock existed and has now run out.
    @discardableResult
    func clearLockIfExpired() -> Bool {
        guard let until = date(SharedKey.lockUntil) else { return false }
        guard until <= Date() else { return false }
        clearLock()
        return true
    }
}
