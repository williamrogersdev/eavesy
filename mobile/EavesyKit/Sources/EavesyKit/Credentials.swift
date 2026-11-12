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
        tokens(for: base).first
    }

    /// Every token in the slot: one for the token in use, any number waiting to be revoked.
    public func tokens(for base: URL) -> [String] {
        var query = self.query
        query[kSecReturnData as String] = true
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data, let stored = String(data: data, encoding: .utf8) else { return [] }
        return Self.decode(stored, for: base)
    }

    @discardableResult
    public func save(token: String, for base: URL) -> Bool {
        save(tokens: [token], for: base)
    }

    /// Replaces the slot in place, so a failed write leaves what was there.
    /// Returns whether the Keychain took it. An empty list clears the slot.
    @discardableResult
    public func save(tokens: [String], for base: URL) -> Bool {
        guard !tokens.isEmpty else {
            clear()
            return true
        }
        let data = Data(Self.encode(tokens, for: base).utf8)
        let updated = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        guard updated == errSecItemNotFound else { return updated == errSecSuccess }
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    /// The stored form: the server's address, then one token per line.
    static func encode(_ tokens: [String], for base: URL) -> String {
        ([base.absoluteString] + tokens).joined(separator: "\n")
    }

    /// Tokens are only ever read back for the server they were stored with.
    static func decode(_ stored: String, for base: URL) -> [String] {
        let lines = stored.split(separator: "\n").map(String.init)
        guard lines.first == base.absoluteString else { return [] }
        return Array(lines.dropFirst())
    }

    public func clear() {
        SecItemDelete(query as CFDictionary)
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
}
