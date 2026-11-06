import Foundation
import ManagedSettings

/// One granted "Open anyway": which app, until when, and which
/// DeviceActivity activity is watching to re-shield it.
struct OverrideRecord: Codable, Equatable {
    var tokenData: Data
    var activityName: String
    var grantedAt: Date
    var expiresAt: Date

    var key: String { tokenData.base64EncodedString() }
    var token: ApplicationToken? { TokenKey.token(from: tokenData) }
    var isActive: Bool { expiresAt > Date() }
}

/// Daily open counts and in-flight grace periods.
///
/// Counters are keyed by calendar day, so "reset at midnight" needs no
/// scheduled job at all — yesterday's key simply stops being read. That is one
/// less DeviceActivity activity against the system's cap.
struct OverrideLedger {
    let store: SharedStore

    init(store: SharedStore = SharedStore()) { self.store = store }

    // MARK: day keys

    static func dayKey(_ date: Date = Date()) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    private func allCounters() -> [String: [String: Int]] {
        store.decode([String: [String: Int]].self, SharedKey.counters) ?? [:]
    }

    func openCount(forKey key: String, on date: Date = Date()) -> Int {
        allCounters()[Self.dayKey(date)]?[key] ?? 0
    }

    func todaysCounts() -> [String: Int] {
        allCounters()[Self.dayKey()] ?? [:]
    }

    /// Increments today's count and drops every other day's, which keeps the
    /// stored dictionary from growing without bound.
    func recordOpen(forKey key: String) {
        let today = Self.dayKey()
        var counters = allCounters()
        var todays = counters[today] ?? [:]
        todays[key, default: 0] += 1
        counters = [today: todays]
        store.encode(counters, SharedKey.counters)
    }

    /// 0 means unlimited.
    func hasOpensLeft(forKey key: String, limit: Int) -> Bool {
        limit <= 0 || openCount(forKey: key) < limit
    }

    // MARK: in-flight grace periods

    func pending() -> [String: OverrideRecord] {
        store.decode([String: OverrideRecord].self, SharedKey.overridesPending) ?? [:]
    }

    private func setPending(_ records: [String: OverrideRecord]) {
        store.encode(records, SharedKey.overridesPending)
    }

    func add(_ record: OverrideRecord) {
        var records = pending()
        records[record.activityName] = record
        setPending(records)
    }

    func remove(activityName: String) {
        var records = pending()
        records.removeValue(forKey: activityName)
        setPending(records)
    }

    func record(forKey key: String) -> OverrideRecord? {
        pending().values.first { $0.key == key && $0.isActive }
    }

    /// Tokens that should be let through right now, with anything stale
    /// pruned on the way past.
    func activeAllowances() -> Set<ApplicationToken> {
        let records = pending()
        let live = records.filter { $0.value.isActive }
        if live.count != records.count {
            setPending(live)
        }
        return Set(live.values.compactMap(\.token))
    }

    /// Activity names whose grace period has already run out.
    func expiredActivityNames() -> [String] {
        pending().filter { !$0.value.isActive }.map(\.key)
    }
}
