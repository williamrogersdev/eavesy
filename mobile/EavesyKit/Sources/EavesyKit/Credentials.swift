import Foundation
import Security

/// The device token, in the Keychain. Stored with the server it belongs to, so
/// a token is never sent to a different server than the one that issued it.
public struct Credentials: Sendable {
    private let service: String
    private let account: String

    /// `account` names the slot: the token in use, or one waiting to be revoked.
    public init(service: String = "com.eavesy.mobile.device-token", account: String = "device-token") {
        self.service = service
        self.account = account
    }

    public func token(for base: URL) -> String? {
        var query = self.query
        query[kSecReturnData as String] = true
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data, let stored = String(data: data, encoding: .utf8) else { return nil }
        let parts = stored.split(separator: "\n", maxSplits: 1).map(String.init)
        return parts.count == 2 && parts[0] == base.absoluteString ? parts[1] : nil
    }

    public func save(token: String, for base: URL) {
        clear()
        var item = query
        item[kSecValueData as String] = Data("\(base.absoluteString)\n\(token)".utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(item as CFDictionary, nil)
    }

    public func clear() {
        SecItemDelete(query as CFDictionary)
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
}
