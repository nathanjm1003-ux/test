import Foundation
import FamilyControls
import Observation

@Observable
@MainActor
final class AuthorizationModel {
    enum Status: Equatable {
        case unknown
        case notDetermined
        case approved
        case denied
        /// Simulator, or an account type Screen Time refuses.
        case unavailable(String)
    }

    private(set) var status: Status = .unknown
    private(set) var lastError: String?
    /// True once we have been approved and then lost it.
    private(set) var isRevoked = false

    private var everApproved = false

    func refresh() async {
        let current = AuthorizationCenter.shared.authorizationStatus
        switch current {
        case .approved:
            status = .approved
            everApproved = true
            isRevoked = false
        case .denied:
            status = .denied
            isRevoked = everApproved
        case .notDetermined:
            status = .notDetermined
            isRevoked = everApproved
        @unknown default:
            status = .unknown
        }
    }

    func request() async {
        lastError = nil
        do {
            try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
            await refresh()
        } catch {
            // FamilyControlsError covers the interesting cases: .unavailable on
            // the Simulator, .invalidAccountType for a managed/child account,
            // .authorizationCanceled when the sheet is dismissed.
            status = .unavailable(Self.describe(error))
            lastError = Self.describe(error)
        }
    }

    static func describe(_ error: Error) -> String {
        if let familyError = error as? FamilyControlsError {
            switch familyError {
            case .unavailable:
                return "Screen Time isn’t available here. This needs a real device, not the Simulator."
            case .invalidAccountType:
                return "This Apple Account can’t grant Screen Time access to an app. A child account needs a parent to approve it."
            case .authorizationCanceled:
                return "You dismissed the permission sheet."
            case .authorizationConflict:
                return "Another app already holds Screen Time authorization."
            case .restricted:
                return "Screen Time access is restricted on this device."
            @unknown default:
                return "Screen Time authorization failed (\(familyError))."
            }
        }
        return error.localizedDescription
    }
}
