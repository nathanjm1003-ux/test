import Foundation

/// A bounded append-only buffer in the App Group.
///
/// Extensions write here; the main app drains it into SwiftData on launch.
/// Extensions never link SwiftData — standing a ModelContainer up inside a
/// ~6 MB shield extension is not a trade worth making for a log line.
struct LoggedEvent: Codable, Identifiable, Equatable {
    enum Kind: String, Codable {
        case overrideGranted, overrideRefused, overrideExpired
        case lockStarted, lockEnded
        case modeOn, modeOff
    }

    var id: UUID = UUID()
    var kind: Kind
    var at: Date = Date()
    /// Opaque token key, when the event concerns one app.
    var appKey: String?
    var detail: String?
}

enum EventLog {
    /// Keeps the buffer small enough that a torn-down extension never spends
    /// real time on it.
    static let capacity = 300

    static func append(_ event: LoggedEvent, store: SharedStore = SharedStore()) {
        var events = store.decode([LoggedEvent].self, SharedKey.eventLog) ?? []
        events.append(event)
        if events.count > capacity {
            events.removeFirst(events.count - capacity)
        }
        store.encode(events, SharedKey.eventLog)
    }

    static func peek(store: SharedStore = SharedStore()) -> [LoggedEvent] {
        store.decode([LoggedEvent].self, SharedKey.eventLog) ?? []
    }

    static func drain(store: SharedStore = SharedStore()) -> [LoggedEvent] {
        let events = peek(store: store)
        store.remove(SharedKey.eventLog)
        return events
    }
}
