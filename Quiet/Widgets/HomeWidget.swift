import WidgetKit
import SwiftUI

struct HomeEntry: TimelineEntry {
    let date: Date
    let slots: [LaunchSlot]
    let locked: Bool
}

struct HomeProvider: TimelineProvider {
    func placeholder(in context: Context) -> HomeEntry {
        HomeEntry(date: Date(),
                  slots: [LaunchSlot(label: "phone", urlString: "tel:"),
                          LaunchSlot(label: "messages", urlString: "sms:"),
                          LaunchSlot(label: "maps", urlString: "maps://")],
                  locked: false)
    }

    func getSnapshot(in context: Context, completion: @escaping (HomeEntry) -> Void) {
        completion(current())
    }

    /// One entry is enough: the clock is drawn with `Text(_:style:)`, which
    /// the system keeps ticking without a timeline reload. A refresh an hour
    /// out only exists to pick up edited rows if the app forgot to reload.
    func getTimeline(in context: Context, completion: @escaping (Timeline<HomeEntry>) -> Void) {
        let refresh = Calendar.current.date(byAdding: .hour, value: 1, to: Date()) ?? Date()
        completion(Timeline(entries: [current()], policy: .after(refresh)))
    }

    private func current() -> HomeEntry {
        HomeEntry(date: Date(),
                  slots: LaunchSlots.load(),
                  locked: SharedStore().lock.isActive)
    }
}

struct HomeWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "QuietHome", provider: HomeProvider()) { entry in
            HomeWidgetView(entry: entry)
                .containerBackground(.black, for: .widget)
        }
        .configurationDisplayName("Quiet home")
        .description("A plain list of the apps you actually meant to open.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct HomeWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: HomeEntry

    private var rowLimit: Int { family == .systemSmall ? 4 : LaunchSlots.maxSlots }
    private var rows: [LaunchSlot] { Array(entry.slots.prefix(rowLimit)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            header
            if rows.isEmpty {
                Text("set up rows in quiet")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
            } else {
                ForEach(rows) { slot in
                    row(for: slot)
                }
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // A small widget is a single tap target, so per-row links only work
        // from medium upwards. Tapping a small one opens Quiet.
        .widgetURL(family == .systemSmall ? URL(string: "quiet://open") : nil)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(entry.date, style: .time)
                .font(.system(size: family == .systemSmall ? 17 : 20,
                              weight: .medium, design: .monospaced))
            if family != .systemSmall {
                Text(entry.date, format: .dateTime.weekday(.abbreviated).day().month(.abbreviated))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if entry.locked {
                Text("locked")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.bottom, 2)
    }

    @ViewBuilder
    private func row(for slot: LaunchSlot) -> some View {
        let text = Text(slot.label.lowercased())
            .font(.system(size: family == .systemSmall ? 12 : 13, design: .monospaced))
            .lineLimit(1)

        if family == .systemSmall {
            text
        } else {
            Link(destination: destination(for: slot)) {
                text.frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// Direct launch puts the target's own scheme in the widget link. It is
    /// faster when it works, but WidgetKit documents `widgetURL`/`Link` as
    /// opening *the containing app*, and third-party schemes from a widget
    /// are not a supported path — so the default routes through Quiet, which
    /// costs one frame of Quiet on screen and always works.
    private func destination(for slot: LaunchSlot) -> URL {
        if slot.directLaunch, let direct = slot.url { return direct }
        return URL(string: "quiet://launch?slot=\(slot.id.uuidString)")!
    }
}
