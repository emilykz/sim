import Foundation

final class SignalingClient {
    private let url: URL
    private var task: URLSessionWebSocketTask?
    private let session = URLSession(configuration: .default)

    private var keepAliveTimer: Timer?
    private var reconnectAttempt: Int = 0
    private var reconnectTimer: Timer?
    private var isStopped: Bool = false

    var onMessage: (([String: Any]) -> Void)?
    var onConnected: (() -> Void)?
    var onDisconnected: (() -> Void)?

    init(hostPort: String, path: String) {
        let u = URL(string: "ws://\(hostPort)\(path)")!
        self.url = u
        print("Signaling Client url:", u)
    }

    // Public: start (will auto-reconnect on drops)
    func connect() {
        isStopped = false
        reconnectAttempt = 0
        connectOnce()
    }

    // Public: stop (no reconnect)
    func disconnect() {
        isStopped = true
        reconnectTimer?.invalidate()
        reconnectTimer = nil
        cleanDisconnectAndNotify()
    }

    private func connectOnce() {
        cleanDisconnectSilently()

        self.task = session.webSocketTask(with: url)
        self.task?.resume()

        task?.sendPing { [weak self] err in
            guard let self else { return }
            if err == nil {
                self.reconnectAttempt = 0
                self.onConnected?()
                self.startKeepAlive()
                self.receiveLoop()
            } else {
                print("WS ping failed:", err?.localizedDescription ?? "unknown")
                self.cleanDisconnectAndNotify()
                self.scheduleReconnect()
            }
        }
    }

    private func scheduleReconnect() {
        guard !isStopped else { return }
        reconnectTimer?.invalidate()

        let base = min(15.0, 0.3 * pow(2.0, Double(reconnectAttempt))) // 0.3,0.6,1.2,... cap 15s
        let jitter = Double.random(in: 0...0.25)
        let wait = base + jitter
        reconnectAttempt += 1

        print(String(format: "WS reconnect in %.2fs (attempt=%d)", wait, reconnectAttempt))
        reconnectTimer = Timer.scheduledTimer(withTimeInterval: wait, repeats: false) { [weak self] _ in
            self?.connectOnce()
        }
    }

    private func startKeepAlive() {
        keepAliveTimer?.invalidate()
        keepAliveTimer = Timer.scheduledTimer(withTimeInterval: 15.0, repeats: true) { [weak self] _ in
            guard let self, let task = self.task else { return }
            task.sendPing { err in
                if let err {
                    print("WS keepalive ping failed:", err.localizedDescription)
                    self.cleanDisconnectAndNotify()
                    self.scheduleReconnect()
                }
            }
        }
    }

    func send(_ obj: [String: Any]) {
        guard let task else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let text = String(data: data, encoding: .utf8) else { return }

        task.send(.string(text)) { _ in }
    }

    private func receiveLoop() {
        guard let task else { return }
        task.receive { [weak self] result in
            guard let self else { return }

            switch result {
            case .success(let msg):
                switch msg {
                case .string(let s):
                    if let data = s.data(using: .utf8),
                       let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                        self.onMessage?(obj)
                    }
                case .data(let d):
                    if let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] {
                        self.onMessage?(obj)
                    }
                @unknown default:
                    break
                }
                self.receiveLoop()

            case .failure(let err):
                print("WS receive error:", err.localizedDescription)
                self.cleanDisconnectAndNotify()
                self.scheduleReconnect()
            }
        }
    }

    private func cleanDisconnectSilently() {
        keepAliveTimer?.invalidate()
        keepAliveTimer = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    private func cleanDisconnectAndNotify() {
        cleanDisconnectSilently()
        onDisconnected?()
    }
}

