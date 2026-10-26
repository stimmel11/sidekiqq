import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/** A recorded request: URLProtocol moves `httpBody` into `httpBodyStream`, so the body is read back here. */
struct RecordedRequest {
    var method: String
    var url: URL
    var headers: [String: String]
    var body: Data

    func header(_ name: String) -> String? {
        headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value
    }
}

struct MockResponse {
    var status: Int = 200
    var body: Data = Data()
    var headers: [String: String] = ["Content-Type": "application/json"]

    static func json(_ s: String, status: Int = 200) -> MockResponse {
        MockResponse(status: status, body: Data(s.utf8))
    }
}

/** Intercepts every request of a session configured with `protocolClasses = [MockURLProtocol.self]`. */
final class MockURLProtocol: URLProtocol {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var _handler: ((RecordedRequest) -> MockResponse)?
    nonisolated(unsafe) private static var _requests: [RecordedRequest] = []

    static func set(_ handler: @escaping (RecordedRequest) -> MockResponse) {
        lock.lock(); defer { lock.unlock() }
        _handler = handler
        _requests = []
    }

    static var requests: [RecordedRequest] {
        lock.lock(); defer { lock.unlock() }
        return _requests
    }

    static func reset() {
        lock.lock(); defer { lock.unlock() }
        _handler = nil
        _requests = []
    }

    static func configuration() -> URLSessionConfiguration {
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [MockURLProtocol.self]
        return c
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let rec = RecordedRequest(
            method: request.httpMethod ?? "GET",
            url: request.url!,
            headers: request.allHTTPHeaderFields ?? [:],
            body: Self.readBody(request)
        )
        Self.lock.lock()
        Self._requests.append(rec)
        let handler = Self._handler
        Self.lock.unlock()

        let mock = handler?(rec) ?? MockResponse(status: 599, body: Data("no handler".utf8))
        let response = HTTPURLResponse(url: rec.url, statusCode: mock.status, httpVersion: "HTTP/1.1",
                                       headerFields: mock.headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: mock.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func readBody(_ request: URLRequest) -> Data {
        if let b = request.httpBody { return b }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }
}
