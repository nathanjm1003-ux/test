import Foundation

/// The one piece of configuration every target must agree on.
///
/// If the App Group is not actually provisioned, `UserDefaults(suiteName:)`
/// returns nil. We do **not** silently fall back to `.standard`: that would let
/// the app and its extensions read two different stores and disagree without
/// any visible symptom. Instead `isConfigured` goes false and the UI says so.
enum AppGroup {
    static let identifier = "group.com.example.quiet"

    static let suite = UserDefaults(suiteName: identifier)

    static var isConfigured: Bool { suite != nil }

    /// Falls back to `.standard` so nothing crashes, but `isConfigured`
    /// is the flag callers should surface.
    static var defaults: UserDefaults { suite ?? .standard }

    static var containerURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier)
    }
}
