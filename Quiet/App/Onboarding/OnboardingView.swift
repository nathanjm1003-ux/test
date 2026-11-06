import SwiftUI
import FamilyControls

struct OnboardingView: View {
    @Binding var done: Bool
    @Environment(AuthorizationModel.self) private var authorization
    @State private var step = 0
    @State private var store = SharedStore()

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                TabView(selection: $step) {
                    explainPage.tag(0)
                    authorizePage.tag(1)
                    sortPage.tag(2)
                }
                .tabViewStyle(.page)
                .indexViewStyle(.page(backgroundDisplayMode: .always))
            }
            .padding(24)
            .background(.black)
        }
    }

    // MARK: 1 — what this is

    private var explainPage: some View {
        page(title: "Quiet") {
            Text("""
                 Quiet makes your phone boring on purpose.

                 It uses Apple’s Screen Time system to put a plain grey screen \
                 in front of the apps you’d rather not open, and to hide them \
                 entirely while you’re working.

                 It has no account, makes no network requests, and keeps \
                 everything on this device.
                 """)
            Divider().overlay(.white.opacity(0.2))
            Text("What it can’t do")
                .font(.system(.footnote, design: .monospaced, weight: .semibold))
            Text("""
                 iOS won’t let any app remove icons from your home screen, \
                 replace the launcher, or filter notifications. Quiet shields \
                 apps when you open them — it can’t make them disappear. \
                 There’s a guide in the README for getting close with a blank \
                 home-screen page.
                 """)
            .foregroundStyle(.secondary)
        }
    }

    // MARK: 2 — authorization

    private var authorizePage: some View {
        page(title: "Permission") {
            Text("""
                 Quiet needs Screen Time access to shield apps. That permission \
                 lets it see which apps you pick and block them — it does not \
                 send anything anywhere.
                 """)

            switch authorization.status {
            case .approved:
                statusLine("Granted.", good: true)
            case .denied:
                statusLine("Denied. Settings → Screen Time → turn access back on.", good: false)
            case .unavailable(let why):
                statusLine(why, good: false)
            case .notDetermined, .unknown:
                Button("Grant Screen Time access") {
                    Task { await authorization.request() }
                }
                .buttonStyle(.borderedProminent)
            }

            if case .approved = authorization.status {
                Button("Next") { withAnimation { step = 2 } }
                    .buttonStyle(.bordered)
            }
        }
    }

    // MARK: 3 — sort the apps

    private var sortPage: some View {
        page(title: "Sort your apps") {
            Text("Pick apps for each group. You can change these any time.")
                .foregroundStyle(.secondary)

            ForEach(AppBucket.allCases) { bucket in
                NavigationLink {
                    BucketPickerView(bucket: bucket)
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(bucket.title)
                                .font(.system(.body, design: .monospaced, weight: .medium))
                            Text(bucket.explanation)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.leading)
                        }
                        Spacer()
                        Text(countLabel(bucket))
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)
                Divider().overlay(.white.opacity(0.15))
            }

            Button("Done") {
                store.set(true, SharedKey.onboardingDone)
                ShieldPolicy.apply(store: store)
                done = true
            }
            .buttonStyle(.borderedProminent)
            .disabled(store.selection(.essential).applicationTokens.isEmpty)

            if store.selection(.essential).applicationTokens.isEmpty {
                Text("Add at least one Essential app first — ideally Phone and Messages.")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.orange)
            }
        }
    }

    private func countLabel(_ bucket: AppBucket) -> String {
        let s = store.selection(bucket)
        return "\(s.applicationTokens.count) apps · \(s.categoryTokens.count) cats"
    }

    private func statusLine(_ text: String, good: Bool) -> some View {
        Text(text)
            .font(.system(.footnote, design: .monospaced))
            .foregroundStyle(good ? .green : .orange)
    }

    @ViewBuilder
    private func page<Content: View>(title: String,
                                     @ViewBuilder content: () -> Content) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(title)
                    .font(.system(.largeTitle, design: .monospaced, weight: .semibold))
                content()
            }
            .font(.system(.body, design: .monospaced))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 60)
        }
    }
}
