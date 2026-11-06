import SwiftUI

struct RootView: View {
    @Environment(AuthorizationModel.self) private var authorization
    @Environment(\.scenePhase) private var scenePhase
    @State private var store = SharedStore()
    @State private var onboardingDone = SharedStore().bool(SharedKey.onboardingDone)

    var body: some View {
        Group {
            if !onboardingDone {
                OnboardingView(done: $onboardingDone)
            } else {
                TabView {
                    DumbModeView().tabItem { Label("Mode", systemImage: "moon") }
                    AppBucketsView().tabItem { Label("Apps", systemImage: "square.grid.2x2") }
                    LocksView().tabItem { Label("Lock", systemImage: "lock") }
                    StatsView().tabItem { Label("Stats", systemImage: "chart.bar") }
                    SettingsView().tabItem { Label("Settings", systemImage: "gearshape") }
                }
            }
        }
        .task { await authorization.refresh() }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await authorization.refresh() }
            // Expiring a lock on foreground is the belt to DeviceActivity's
            // braces: if the interval callback was missed, this catches it.
            if store.clearLockIfExpired() {
                EventLog.append(LoggedEvent(kind: .lockEnded, detail: "expired"))
            }
            ShieldPolicy.apply(store: store)
        }
        .onOpenURL { url in handle(url) }
        .overlay(alignment: .top) {
            if authorization.isRevoked {
                AuthorizationLostBanner()
            }
        }
    }

    /// `quiet://launch?slot=<uuid>` — the widget's indirect launch path.
    private func handle(_ url: URL) {
        guard url.scheme == "quiet", url.host == "launch",
              let id = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                  .queryItems?.first(where: { $0.name == "slot" })?.value,
              let slot = LaunchSlots.slot(withID: id),
              let target = slot.url
        else { return }
        UIApplication.shared.open(target)
    }
}

/// Authorization can be withdrawn in Settings at any time. When it is, every
/// shield drops and nothing we do will reinstate it — so say so plainly
/// instead of showing a UI that pretends to still be in control.
struct AuthorizationLostBanner: View {
    var body: some View {
        Text("Screen Time access was turned off. Nothing is being blocked.")
            .font(.system(.footnote, design: .monospaced))
            .padding(10)
            .frame(maxWidth: .infinity)
            .background(.red.opacity(0.85))
            .foregroundStyle(.white)
    }
}
