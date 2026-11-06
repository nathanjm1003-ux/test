import Foundation
import ManagedSettings

/// Decides whether "Open anyway" is offered at all.
///
/// Shared by the configuration extension (which draws the button) and the
/// action extension (which must not trust that drawing). Both re-derive it
/// independently from stored state.
enum Gatekeeper {
    enum Verdict {
        case allowed(remaining: Int)
        case locked(until: Date)
        case hidden
        case limitReached(limit: Int)
        case noAuthorizationData

        var allowsOverride: Bool {
            if case .allowed = self { return true }
            return false
        }

        func message(friction: FrictionSettings) -> String {
            switch self {
            case .allowed(let remaining):
                let wait = "Opening takes \(friction.clampedDelaySeconds)s."
                return remaining > 0
                    ? "\(friction.message) \(wait) \(remaining) left today."
                    : "\(friction.message) \(wait)"
            case .locked(let until):
                let f = DateFormatter()
                f.dateFormat = "EEE HH:mm"
                return "Locked until \(f.string(from: until)). There’s no way to end it early."
            case .hidden:
                return "You put this on the hidden list."
            case .limitReached(let limit):
                return "That’s your \(limit) for today. Back at midnight."
            case .noAuthorizationData:
                return "Blocked by Quiet."
            }
        }
    }

    static func verdict(for token: ApplicationToken?, store: SharedStore) -> Verdict {
        let lock = store.lock
        if lock.isActive, let until = lock.until { return .locked(until: until) }

        guard let token, let key = TokenKey.key(for: token) else { return .noAuthorizationData }

        if store.selection(.blocked).applicationTokens.contains(token) { return .hidden }

        let friction = store.friction
        let ledger = OverrideLedger(store: store)
        let used = ledger.openCount(forKey: key)
        let limit = friction.dailyLimit

        if limit > 0 && used >= limit { return .limitReached(limit: limit) }
        return .allowed(remaining: limit > 0 ? limit - used : 0)
    }
}
