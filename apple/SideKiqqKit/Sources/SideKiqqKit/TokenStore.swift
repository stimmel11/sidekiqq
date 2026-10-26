import Foundation
#if canImport(Security)
import Security
#endif

/** What pairing produces: where the brain is and the device bearer token. */
public struct DeviceCredentials: Codable, Hashable, Sendable {
    public var baseURL: String
    public var token: String
    public var deviceId: String?
    public var device: DeviceKind?

    public init(baseURL: String, token: String, deviceId: String? = nil, device: DeviceKind? = nil) {
        self.baseURL = baseURL; self.token = token; self.deviceId = deviceId; self.device = device
    }
}

/**
 * Persists the brain URL and device token. Mirrors android/shared TokenStore.kt.
 * Reads must be cheap: `token()` is the client's `tokenProvider`.
 */
public protocol TokenStore: AnyObject, Sendable {
    func load() -> DeviceCredentials?
    func save(_ credentials: DeviceCredentials) throws
    func clear() throws
}

public extension TokenStore {
    func token() -> String? { load()?.token }
    var isPaired: Bool {
        guard let c = load() else { return false }
        return !c.baseURL.isEmpty && !c.token.isEmpty
    }
}

/** For tests and previews. Thread-safe. */
public final class InMemoryTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: DeviceCredentials?

    public init(_ initial: DeviceCredentials? = nil) { value = initial }

    public func load() -> DeviceCredentials? {
        lock.lock(); defer { lock.unlock() }
        return value
    }

    public func save(_ credentials: DeviceCredentials) throws {
        lock.lock(); defer { lock.unlock() }
        value = credentials
    }

    public func clear() throws {
        lock.lock(); defer { lock.unlock() }
        value = nil
    }
}

#if canImport(Security)
public enum KeychainError: Error, Equatable, Sendable {
    case status(OSStatus)
    case encoding
}

/**
 * Keychain-backed store: one generic-password item holding the JSON-encoded credentials.
 *
 * Accessibility is `AfterFirstUnlockThisDeviceOnly`:
 *  - "AfterFirstUnlock" so the app can still read the token when iOS relaunches it in the
 *    background for a medallion BLE event while the phone is locked.
 *  - "ThisDeviceOnly" so the token never migrates to another phone through a backup; a restored
 *    phone must re-pair (same policy as the Android Keystore key).
 *
 * The decoded value is cached in memory, so `token()` is cheap.
 */
public final class KeychainTokenStore: TokenStore, @unchecked Sendable {
    private let service: String
    private let account: String
    private let accessGroup: String?
    private let lock = NSLock()
    private var cached: DeviceCredentials??

    /**
     * - Parameter accessGroup: set to a shared keychain group later so a watch/widget/intent
     *   extension can read the same token.
     */
    public init(service: String = "com.sidekiqq.device", account: String = "credentials", accessGroup: String? = nil) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup
    }

    private func baseQuery() -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }

    public func load() -> DeviceCredentials? {
        lock.lock(); defer { lock.unlock() }
        if let cached { return cached }
        var q = baseQuery()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        let value: DeviceCredentials?
        if status == errSecSuccess, let data = out as? Data {
            value = try? JSONDecoder().decode(DeviceCredentials.self, from: data)
        } else {
            value = nil
        }
        // Don't cache "not found" while the device is still locked (errSecInteractionNotAllowed).
        if status == errSecSuccess || status == errSecItemNotFound { cached = .some(value) }
        return value
    }

    public func save(_ credentials: DeviceCredentials) throws {
        lock.lock(); defer { lock.unlock() }
        guard let data = try? JSONEncoder().encode(credentials) else { throw KeychainError.encoding }
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(baseQuery() as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            var add = baseQuery()
            add.merge(attrs) { _, new in new }
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError.status(status) }
        cached = .some(credentials)
    }

    public func clear() throws {
        lock.lock(); defer { lock.unlock() }
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError.status(status) }
        cached = .some(nil)
    }
}
#endif
