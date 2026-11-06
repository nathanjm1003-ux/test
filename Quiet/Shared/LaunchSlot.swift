import Foundation

/// One row on the text-only home screen.
///
/// The label is typed by hand on purpose. An `ApplicationToken` carries no
/// name, and the only way to render one is a `Label(token)` view inside an app
/// that holds the Family Controls entitlement — which the widget target
/// deliberately does not. So the widget stores plain strings and knows nothing
/// about tokens.
struct LaunchSlot: Codable, Identifiable, Hashable {
    var id: UUID = UUID()
    var label: String
    /// Either a third-party scheme ("instagram://") or, more reliably,
    /// a Shortcuts URL ("shortcuts://run-shortcut?name=Open%20Maps").
    var urlString: String

    /// When true the widget links straight at `urlString`. When false it links
    /// at `quiet://launch?slot=<id>` and the app forwards — one extra frame of
    /// Quiet on screen, but it is the path that reliably works.
    var directLaunch: Bool = false

    var url: URL? { URL(string: urlString) }
}

enum LaunchSlots {
    static let maxSlots = 8

    static func load(store: SharedStore = SharedStore()) -> [LaunchSlot] {
        store.decode([LaunchSlot].self, SharedKey.launchSlots) ?? []
    }

    static func save(_ slots: [LaunchSlot], store: SharedStore = SharedStore()) {
        store.encode(Array(slots.prefix(maxSlots)), SharedKey.launchSlots)
    }

    static func slot(withID id: String, store: SharedStore = SharedStore()) -> LaunchSlot? {
        load(store: store).first { $0.id.uuidString == id }
    }
}
