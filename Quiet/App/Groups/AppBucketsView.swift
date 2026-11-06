import SwiftUI
import FamilyControls

struct AppBucketsView: View {
    @State private var store = SharedStore()
    @State private var refreshToken = UUID()

    var body: some View {
        NavigationStack {
            List {
                ForEach(AppBucket.allCases) { bucket in
                    Section {
                        NavigationLink {
                            BucketPickerView(bucket: bucket)
                        } label: {
                            HStack {
                                Text("Choose apps")
                                Spacer()
                                Text(count(bucket))
                                    .foregroundStyle(.secondary)
                            }
                        }
                        SelectionSummary(selection: store.selection(bucket))
                    } header: {
                        Text(bucket.title)
                    } footer: {
                        Text(bucket.explanation)
                    }
                }
            }
            .id(refreshToken)
            .font(.system(.body, design: .monospaced))
            .navigationTitle("Apps")
            .onAppear { refreshToken = UUID() }
        }
    }

    private func count(_ bucket: AppBucket) -> String {
        let s = store.selection(bucket)
        return "\(s.applicationTokens.count)"
    }
}

/// The only place app names may be rendered.
///
/// `Label(token)` is the single supported way to show what an opaque token
/// refers to. There is no API that hands the name back as a `String`, so it
/// cannot be logged, exported or put in a widget.
struct SelectionSummary: View {
    let selection: FamilyActivitySelection

    var body: some View {
        if selection.applicationTokens.isEmpty && selection.categoryTokens.isEmpty {
            Text("Nothing selected")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
        } else {
            ForEach(Array(selection.applicationTokens), id: \.self) { token in
                Label(token)
                    .labelStyle(.titleAndIcon)
                    .font(.system(.caption, design: .monospaced))
            }
            ForEach(Array(selection.categoryTokens), id: \.self) { token in
                Label(token)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
        }
    }
}

struct BucketPickerView: View {
    let bucket: AppBucket
    @State private var selection = FamilyActivitySelection()
    @State private var store = SharedStore()
    @State private var loaded = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        FamilyActivityPicker(selection: $selection)
            .navigationTitle(bucket.title)
            .navigationBarTitleDisplayMode(.inline)
            .onAppear {
                guard !loaded else { return }
                selection = store.selection(bucket)
                loaded = true
            }
            .onDisappear {
                guard loaded else { return }
                store.setSelection(selection, for: bucket)
                ShieldPolicy.apply(store: store)
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
    }
}
