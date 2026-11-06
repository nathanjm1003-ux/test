import Foundation
import FamilyControls
import ManagedSettings

/// The three buckets the user sorts their apps into.
enum AppBucket: String, CaseIterable, Codable, Identifiable {
    case essential, distracting, blocked

    var id: String { rawValue }

    var title: String {
        switch self {
        case .essential:   return "Essential"
        case .distracting: return "Distracting"
        case .blocked:     return "Hidden"
        }
    }

    var explanation: String {
        switch self {
        case .essential:
            return "Always allowed, even in dumb-phone mode. Put Phone, Messages and Maps here."
        case .distracting:
            return "Allowed, but behind a delay and a daily open limit."
        case .blocked:
            return "Always shielded. No way through from the shield screen."
        }
    }

    var defaultsKey: String {
        switch self {
        case .essential:   return SharedKey.selectionEssential
        case .distracting: return SharedKey.selectionDistracting
        case .blocked:     return SharedKey.selectionBlocked
        }
    }
}

extension SharedStore {
    func selection(_ bucket: AppBucket) -> FamilyActivitySelection {
        decode(FamilyActivitySelection.self, bucket.defaultsKey) ?? FamilyActivitySelection()
    }

    func setSelection(_ selection: FamilyActivitySelection, for bucket: AppBucket) {
        encode(selection, bucket.defaultsKey)
    }
}

/// `ApplicationToken` is opaque: it is not a bundle id and carries no name.
/// It is Codable and Hashable, so the encoded bytes are the only stable
/// identity we can use as a dictionary key — and they are meaningful only on
/// this device, for this installation.
enum TokenKey {
    static func data(for token: ApplicationToken) -> Data? {
        try? JSONEncoder().encode(token)
    }

    static func key(for token: ApplicationToken) -> String? {
        data(for: token)?.base64EncodedString()
    }

    static func token(from data: Data) -> ApplicationToken? {
        try? JSONDecoder().decode(ApplicationToken.self, from: data)
    }

    static func token(fromKey key: String) -> ApplicationToken? {
        guard let data = Data(base64Encoded: key) else { return nil }
        return token(from: data)
    }
}
