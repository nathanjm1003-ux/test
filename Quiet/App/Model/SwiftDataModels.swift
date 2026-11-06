import Foundation
import SwiftData

@Model
final class OverrideEvent {
    var timestamp: Date = Date()
    var appKey: String = ""
    var detail: String?
    var granted: Bool = true

    init(timestamp: Date, appKey: String, detail: String?, granted: Bool) {
        self.timestamp = timestamp
        self.appKey = appKey
        self.detail = detail
        self.granted = granted
    }
}

@Model
final class LockEvent {
    var timestamp: Date = Date()
    var started: Bool = true
    var detail: String?

    init(timestamp: Date, started: Bool, detail: String?) {
        self.timestamp = timestamp
        self.started = started
        self.detail = detail
    }
}

@Model
final class ModeEvent {
    var timestamp: Date = Date()
    var on: Bool = false
    var source: String = ""

    init(timestamp: Date, on: Bool, source: String) {
        self.timestamp = timestamp
        self.on = on
        self.source = source
    }
}

/// Moves what the extensions logged into durable storage.
///
/// Extensions append to a small JSON buffer in the App Group; only the app
/// opens SwiftData. Draining is idempotent in the sense that the buffer is
/// cleared as it is read.
enum HistoryImporter {
    @MainActor
    static func drain(into container: ModelContainer) {
        let events = EventLog.drain()
        guard !events.isEmpty else { return }
        let context = container.mainContext
        for event in events {
            switch event.kind {
            case .overrideGranted:
                context.insert(OverrideEvent(timestamp: event.at, appKey: event.appKey ?? "",
                                             detail: event.detail, granted: true))
            case .overrideRefused, .overrideExpired:
                context.insert(OverrideEvent(timestamp: event.at, appKey: event.appKey ?? "",
                                             detail: event.detail ?? event.kind.rawValue,
                                             granted: false))
            case .lockStarted:
                context.insert(LockEvent(timestamp: event.at, started: true, detail: event.detail))
            case .lockEnded:
                context.insert(LockEvent(timestamp: event.at, started: false, detail: event.detail))
            case .modeOn, .modeOff:
                context.insert(ModeEvent(timestamp: event.at,
                                         on: event.kind == .modeOn,
                                         source: event.detail ?? "unknown"))
            }
        }
        try? context.save()
    }
}
