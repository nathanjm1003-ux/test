import Foundation
import UniformTypeIdentifiers
import SwiftUI

/// Everything portable about a Quiet setup.
///
/// App selections are deliberately absent. A `FamilyActivitySelection`
/// contains opaque tokens that are only meaningful to the installation that
/// minted them — carrying them to another device or a reinstall would produce
/// references to nothing. Rather than export bytes that silently decode to an
/// empty set, the export says so in a field you can read.
struct QuietExport: Codable {
    var formatVersion = 1
    var exportedAt = Date()
    var friction: FrictionSettings
    var schedules: [ScheduleSpec]
    var launchSlots: [LaunchSlot]
    var strictLockPreferred: Bool
    var note = """
        App selections are not included. Screen Time identifies apps with \
        opaque tokens that are only valid on the device and installation that \
        created them, so there is nothing portable to write down. After \
        importing, re-pick your Essential, Distracting and Hidden apps.
        """

    static func current(store: SharedStore = SharedStore()) -> QuietExport {
        QuietExport(friction: store.friction,
                    schedules: ScheduleStore.load(store: store),
                    launchSlots: LaunchSlots.load(store: store),
                    strictLockPreferred: store.lock.strict)
    }

    func apply(store: SharedStore = SharedStore()) {
        store.friction = friction
        ScheduleStore.save(schedules, store: store)
        LaunchSlots.save(launchSlots, store: store)
    }

    func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return try encoder.encode(self)
    }

    static func decode(_ data: Data) throws -> QuietExport {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(QuietExport.self, from: data)
    }
}

/// Wraps the JSON for `fileExporter`.
struct ExportDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var data: Data

    init(data: Data) { self.data = data }

    init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}
