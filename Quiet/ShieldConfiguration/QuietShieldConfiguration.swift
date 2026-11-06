import Foundation
import ManagedSettings
import ManagedSettingsUI
import UIKit

/// The blocking screen. Dark, text only, no imagery.
///
/// This is the one context in which an app may learn what a token refers to:
/// `Application.localizedDisplayName` is handed to us for the app being
/// shielded. It still cannot be read anywhere else, so it is used here and
/// not stored.
final class QuietShieldConfiguration: ShieldConfigurationDataSource {

    override func configuration(shielding application: Application) -> ShieldConfiguration {
        build(name: application.localizedDisplayName, token: application.token)
    }

    override func configuration(shielding application: Application,
                                in category: ActivityCategory) -> ShieldConfiguration {
        build(name: application.localizedDisplayName, token: application.token)
    }

    override func configuration(shielding webDomain: WebDomain) -> ShieldConfiguration {
        build(name: webDomain.domain, token: nil)
    }

    override func configuration(shielding webDomain: WebDomain,
                                in category: ActivityCategory) -> ShieldConfiguration {
        build(name: webDomain.domain, token: nil)
    }

    // MARK: -

    private func build(name: String?, token: ApplicationToken?) -> ShieldConfiguration {
        let store = SharedStore()
        let friction = store.friction
        let verdict = Gatekeeper.verdict(for: token, store: store)

        let label = name.map { "Open \($0)?" } ?? "Blocked"

        return ShieldConfiguration(
            backgroundBlurStyle: nil,
            backgroundColor: .black,
            icon: nil,
            title: ShieldConfiguration.Label(text: label, color: .white),
            subtitle: ShieldConfiguration.Label(text: verdict.message(friction: friction),
                                                color: UIColor(white: 0.62, alpha: 1)),
            primaryButtonLabel: ShieldConfiguration.Label(text: "Never mind", color: .black),
            primaryButtonBackgroundColor: .white,
            secondaryButtonLabel: verdict.allowsOverride
                ? ShieldConfiguration.Label(text: "Open anyway",
                                            color: UIColor(white: 0.62, alpha: 1))
                : nil
        )
    }
}
