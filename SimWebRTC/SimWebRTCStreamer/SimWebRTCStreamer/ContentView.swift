import SwiftUI
import Foundation
import QuartzCore

final class AgentApp: ObservableObject {
    @Published var status: String = "idle"
    @Published var frameWidth: Int = 0
    @Published var frameHeight: Int = 0
    @Published var fps: Double = 0
    @Published var viewerCount: Int = 0
   
    private var signaling: SignalingClient?
    private let webrtc = WebRTCManager()
    private let capture = ScreenCaptureSource()

    private let deviceId: String
    private let hostPort: String  // e.g. "192.168.86.21:8080"

    // Which viewer currently has control for this device (as decided by server.js)
    private var currentControllerId: String? = nil
    
    // Appium (manual-control lease) for iOS simulators
    private let appium = AppiumDriver()
    private var appiumSessionId: String? = nil
    private var appiumWindowRect: (width: Double, height: Double)? = nil
    private var appiumKeepAliveTimer: Timer? = nil
    private var appiumUdid: String? = nil
    private var lastPlatformStr: String = "ios"

    // Pointer aggregation (down/move/up -> tap/swipe)
    private var pointerDown: (x: Double, y: Double, t: CFTimeInterval)? = nil
    private var pointerLast: (x: Double, y: Double)? = nil

    
    private var isCapturing = false
    private var activeWindowMatch: String? = nil
    private var captureStopTask: Task<Void, Never>?
    private let stopGraceSeconds: Double = 15
    
    private var fpsFrameCount: Int = 0
    private var fpsWindowStartTime: CFTimeInterval = CACurrentMediaTime()

    init(config: DeviceConfig, hostPort: String) {
        self.deviceId = config.id
        self.hostPort = hostPort
        self.appiumUdid = config.udid
        self.lastPlatformStr = config.platform
        self.appium.setBaseUrl(config.appiumUrl)

        signaling = SignalingClient(hostPort: hostPort, path: "/agent")
        signaling?.onMessage = { [weak self] msg in
            self?.handle(msg: msg)
        }

        capture.onFrame = { [weak self] frame in
            guard let self = self else { return }

            // --- Resolution metrics ---
            let w = Int(frame.width)
            let h = Int(frame.height)
            if w != self.frameWidth || h != self.frameHeight {
                DispatchQueue.main.async {
                    self.frameWidth = w
                    self.frameHeight = h
                }
            }

            // --- FPS metrics (approx over a ~1s window) ---
            self.fpsFrameCount += 1
            let now = CACurrentMediaTime()
            let elapsed = now - self.fpsWindowStartTime
            if elapsed >= 1.0 {
                let fps = Double(self.fpsFrameCount) / elapsed
                self.fpsFrameCount = 0
                self.fpsWindowStartTime = now
                DispatchQueue.main.async {
                    self.fps = fps
                }
            }

            // Forward the frame into WebRTC
            self.webrtc.pushFrame(frame)
        }
        let did = deviceId
        webrtc.onAnswer = { [weak self] viewerId, sdp in
            self?.signaling?.send([
                "type": "answer",
                "deviceId": did,
                "viewerId": viewerId,
                "sdp": sdp.sdp
            ])
        }

        webrtc.onLocalIce = { [weak self] viewerId, cand in
            self?.signaling?.send([
                "type": "ice",
                "deviceId": did,
                "viewerId": viewerId,
                "candidate": [
                    "candidate": cand.sdp,
                    "sdpMid": cand.sdpMid ?? "",
                    "sdpMLineIndex": cand.sdpMLineIndex
                ]
            ])
        }
        
        // Data-channel control path: viewer input (pointer / key / text) arrives here.
        webrtc.onControlMessage = { [weak self] viewerId, text in
            guard let self else { return }

            // Data channel carries the same JSON objects we send over WebSocket from the browser.
            guard let data = text.data(using: .utf8),
                  let anyObj = try? JSONSerialization.jsonObject(with: data, options: []),
                  let obj = anyObj as? [String: Any] else {
                print("[control] ⚠️ could not decode control JSON from viewerId=\(viewerId)")
                return
            }

            self.handleControlPayload(viewerId: viewerId, payload: obj)
        }
        

        signaling?.connect()
        signaling?.send([
            "type": "iam-agent",
            "deviceId": deviceId
        ])
    }
    
    private func refreshViewerCount() {
        let n = webrtc.viewerCount()
        if n != viewerCount {
            DispatchQueue.main.async { [weak self] in
                self?.viewerCount = n
            }
        }
    }

    private func handle(msg: [String: Any]) {
        guard let type = msg["type"] as? String else { return }

        switch type {
        case "offer":
            guard let viewerId = msg["viewerId"] as? String,
                  let sdp = msg["sdp"] as? String else { return }

            // ✅ read from top-level OR nested deviceInfo
            let info = msg["deviceInfo"] as? [String: Any]

            let platformStr =
                (msg["platform"] as? String)
                ?? (info?["platform"] as? String)
                ?? "ios"

            let windowMatch =
                (msg["windowMatch"] as? String)
                ?? (info?["windowMatch"] as? String)

            lastPlatformStr = platformStr
            print("[agent] offer viewerId=\(viewerId) platform=\(platformStr) windowMatch=\(windowMatch ?? "nil")")

            // ✅ If windowMatch changed, restart capture on new window
            if windowMatch != activeWindowMatch {
                activeWindowMatch = windowMatch
                restartCapture(platformStr: platformStr, windowMatch: windowMatch)
            } else {
                // Ensure capture is running at least once
                if !isCapturing {
                    restartCapture(platformStr: platformStr, windowMatch: windowMatch)
                }
            }

            webrtc.handleOffer(viewerId: viewerId, sdp: sdp)
            refreshViewerCount()

        case "ice":
            guard let viewerId = msg["viewerId"] as? String,
                  let cand = msg["candidate"] as? [String: Any] else { return }
            webrtc.addIce(viewerId: viewerId, cand: cand)
        case "control-state":
            // Server telling us who currently owns control for this device.
            let controllerId = msg["controllerId"] as? String
            let prev = currentControllerId
            currentControllerId = controllerId
            print("[agent] control-state deviceId=\(deviceId) controllerId=\(controllerId ?? "nil")")

            // If control was released or transferred, end the current Appium session.
            if controllerId == nil || (prev != nil && prev != controllerId) {
                pointerDown = nil
                pointerLast = nil
                Task { [weak self] in
                    await self?.stopAppiumSession(reason: "control-state-changed")
                }
            }



            // Pre-warm Appium session when someone takes control (so first tap is instant)
            if controllerId != nil {
                Task { [weak self] in
                    _ = await self?.ensureAppiumSession()
                }
            }


        case "pointer", "key", "text", "home":
            // Control messages routed over the /agent WebSocket path (fallback when data channel is not used).
            let viewerId = msg["viewerId"] as? String ?? "<ws-no-viewer-id>"
            handleControlPayload(viewerId: viewerId, payload: msg)
            
        case "viewer-left":
            // server.js sends "viewer-left"
            guard let viewerId = msg["viewerId"] as? String else { return }
            print("👋 viewer left viewerId=\(viewerId)")
            webrtc.removeViewer(viewerId)
            refreshViewerCount()

            if webrtc.viewerCount() == 0 {
                captureStopTask?.cancel()
                captureStopTask = Task { [weak self] in
                    guard let self else { return }
                    try? await Task.sleep(nanoseconds: UInt64(self.stopGraceSeconds * 1_000_000_000))
                    if self.webrtc.viewerCount() == 0 {
                        if self.isCapturing {
                            await self.capture.stopCapture()
                            self.isCapturing = false
                            self.activeWindowMatch = nil
                            await MainActor.run { self.status = "idle" }
                            print("[agent] stopped capture (no viewers)")
                        }
                    }
                }
            }

        default:
            break
        }
    }
    
    
    /// Unified handler for all control messages coming from viewers.
    /// - Parameters:
    ///   - viewerId: which viewer sent the event
    ///   - payload: JSON dictionary (same shape for WS + data channel)
    private func handleControlPayload(viewerId: String, payload: [String: Any]) {
        guard let type = payload["type"] as? String else { return }

        // Optional safety: ignore input from non-controller viewers.
        if let ctrl = currentControllerId, ctrl != viewerId {
            print("[control] ignored from non-controller viewerId=\(viewerId) type=\(type) currentController=\(ctrl)")
            return
        }

        switch type {
        case "pointer":
            let x = payload["x"] as? Double ?? -1
            let y = payload["y"] as? Double ?? -1
            let kind = payload["kind"] as? String ?? "?"
            let buttons = payload["buttons"] as? Int ?? 0
            print("[control] pointer viewerId=\(viewerId) kind=\(kind) x=\(x) y=\(y) buttons=\(buttons)")

            // iOS simulator: translate down/move/up into a single tap or swipe via Appium.
            // NOTE: x/y are normalized (0..1) within the screen hole (ScreenIOS.tsx getNorm).
            Task { [weak self] in
                await self?.handlePointer(kind: kind, xNorm: x, yNorm: y)
            }

        case "key":
            let action = payload["action"] as? String ?? "?"
            let code = payload["code"] as? String ?? "?"
            let key = payload["key"] as? String ?? "?"
            print("[control] key viewerId=\(viewerId) action=\(action) code=\(code) key=\(key)")

            // For iOS sims, we send key presses via Appium.
            // We only act on keyDown to avoid double firing.
            if action == "down" {
                Task { [weak self] in
                    await self?.handleKey(code: code, key: key)
                }
            }

        case "text":
            let text = payload["text"] as? String ?? ""
            print("[control] text viewerId=\(viewerId) \(text.debugDescription)")

            Task { [weak self] in
                await self?.handleText(text)
            }
        case "home":
            print("[control] home viewerId=\(viewerId)")
            Task { [weak self] in
                await self?.handleHome()
            }
        default:
            break
        }
    }

    // MARK: - Appium control (iOS simulator)

    private func ensureAppiumSession() async -> String? {
        // Only for iOS sims (you can extend later for Android)
        if lastPlatformStr.lowercased() != "ios" {
            return nil
        }
        guard let udid = appiumUdid, !udid.contains("<PUT_UDID_HERE>") else {
            print("[appium] ❌ missing UDID for deviceId=\(deviceId) (set DeviceConfig.udid)")
            return nil
        }

        // If we already have a session, reuse it.
        if let sid = appiumSessionId {
            if appiumWindowRect == nil {
                do {
                    let rect = try await appium.getWindowRect(sessionId: sid)
                    appiumWindowRect = (rect.width, rect.height)
                    print("[appium] windowRect w=\(rect.width) h=\(rect.height)")
                } catch {
                    print("[appium] ❌ getWindowRect failed:", error.localizedDescription)
                }
            }
            return sid
        }

        do {
            let sid = try await appium.createIOSSession(udid: udid, deviceName: deviceId)
            appiumSessionId = sid
            print("[appium] ✅ session created sessionId=\(sid) udid=\(udid)")

            let rect = try await appium.getWindowRect(sessionId: sid)
            appiumWindowRect = (rect.width, rect.height)
            print("[appium] ✅ windowRect w=\(rect.width) h=\(rect.height)")
            return sid
        } catch {
            print("[appium] ❌ create session failed:", error.localizedDescription)
            appiumSessionId = nil
            appiumWindowRect = nil
            return nil
        }
    }

    private func stopAppiumSession(reason: String) async {
        guard let sid = appiumSessionId else { return }
        appiumSessionId = nil
        appiumWindowRect = nil

        do {
            try await appium.deleteSession(sessionId: sid)
            print("[appium] 🛑 session deleted sessionId=\(sid) reason=\(reason)")
        } catch {
            print("[appium] ⚠️ delete session failed sessionId=\(sid) reason=\(reason) err=\(error.localizedDescription)")
        }
    }

    private func startAppiumKeepAlive() {
        stopAppiumKeepAlive()
        // Keep session alive during manual control (Appium newCommandTimeout)
        appiumKeepAliveTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            guard let self else { return }
            guard self.appiumSessionId != nil else { return }
            // Only keepalive while someone owns control
            guard self.currentControllerId != nil else { return }
            Task { [weak self] in
                guard let self else { return }
                // Force a cheap command so Appium doesn't time out
                if let sid = self.appiumSessionId {
                    _ = try? await self.appium.getWindowRect(sessionId: sid)
                }
            }
        }
    }

    private func stopAppiumKeepAlive() {
        appiumKeepAliveTimer?.invalidate()
        appiumKeepAliveTimer = nil
    }


    private func toDeviceXY(xNorm: Double, yNorm: Double) -> (x: Int, y: Int)? {
        guard let rect = appiumWindowRect else { return nil }
        let x = Int(max(0, min(1, xNorm)) * rect.width)
        let y = Int(max(0, min(1, yNorm)) * rect.height)
        return (x, y)
    }

    private func handlePointer(kind: String, xNorm: Double, yNorm: Double) async {
        webrtc.noteInteraction()

        guard let _ = await ensureAppiumSession() else { return }
        guard toDeviceXY(xNorm: xNorm, yNorm: yNorm) != nil else {
            print("[appium] ⚠️ no window rect yet; dropping pointer")
            return
        }

        let now = CACurrentMediaTime()

        switch kind {
        case "down":
            pointerDown = (xNorm, yNorm, now)
            pointerLast = (xNorm, yNorm)

        case "move":
            pointerLast = (xNorm, yNorm)

        case "up":
            guard let down = pointerDown else { return }
            let end = pointerLast ?? (xNorm, yNorm)
            pointerDown = nil
            pointerLast = nil

            let dx = end.x - down.x
            let dy = end.y - down.y
            let dist = sqrt(dx*dx + dy*dy)

            let TAP_THRESH = 0.02

            if dist <= TAP_THRESH {
                guard let xy = toDeviceXY(xNorm: end.x, yNorm: end.y),
                      let sid = appiumSessionId else { return }
                do {
                    try await appium.tap(sessionId: sid, x: xy.x, y: xy.y)
                    print("[appium] tap x=\(xy.x) y=\(xy.y)")
                } catch {
                    print("[appium] ❌ tap failed:", error.localizedDescription)
                    await stopAppiumSession(reason: "tap-failed")
                }
            } else {
                guard let startXY = toDeviceXY(xNorm: down.x, yNorm: down.y),
                      let endXY = toDeviceXY(xNorm: end.x, yNorm: end.y),
                      let sid = appiumSessionId else { return }

                let dt = max(0.08, min(0.8, now - down.t))
                let ms = Int(dt * 1000)

                do {
                    try await appium.swipe(sessionId: sid, x1: startXY.x, y1: startXY.y, x2: endXY.x, y2: endXY.y, durationMs: ms)
                    print("[appium] swipe (\(startXY.x),\(startXY.y)) -> (\(endXY.x),\(endXY.y)) ms=\(ms)")
                } catch {
                    print("[appium] ❌ swipe failed:", error.localizedDescription)
                    await stopAppiumSession(reason: "swipe-failed")
                }
            }

        default:
            break
        }
    }

    private func handleText(_ text: String) async {
        webrtc.noteInteraction()

        guard !text.isEmpty else { return }
        guard let sid = await ensureAppiumSession() else { return }
        do {
            try await appium.sendKeys(sessionId: sid, text: text)
            print("[appium] keys textLen=\(text.count)")
        } catch {
            print("[appium] ❌ sendKeys failed:", error.localizedDescription)
            await stopAppiumSession(reason: "keys-failed")
        }
    }

    func handleKey(code: String, key: String) async {
        webrtc.noteInteraction()

        // 1️⃣ Ignore pure modifier keys; let the text path handle case
        let isModifier =
            key == "Shift" || key == "ShiftLeft" || key == "ShiftRight" ||
            key == "Alt" || key == "AltLeft" || key == "AltRight" ||
            key == "Control" || key == "ControlLeft" || key == "ControlRight" ||
            key == "Meta" || key == "MetaLeft" || key == "MetaRight" ||
            key == "Command"
        if isModifier {
            // No direct text; browser’s "text" events already include the effect
            return
        }

        guard let sid = await ensureAppiumSession() else { return }

        let v = AppiumDriver.specialKeyValue(code: code, key: key) ?? key
        do {
            try await appium.sendKeyValue(sessionId: sid, value: v)
            print("[appium] key code=\(code) key=\(key)")
        } catch {
            print("[appium] ❌ key failed:", error.localizedDescription)
            await stopAppiumSession(reason: "key-failed")
        }
    }
    
    private func handleHome() async {
        webrtc.noteInteraction()

        guard let sid = await ensureAppiumSession() else { return }
        do {
            try await appium.pressHome(sessionId: sid)
            print("[appium] home pressed")
        } catch {
            print("[appium] ❌ home failed:", error.localizedDescription)
            await stopAppiumSession(reason: "home-failed")
        }
    }

    private func restartCapture(platformStr: String, windowMatch: String?) {
        // Cancel any pending stop timer
        captureStopTask?.cancel()
        captureStopTask = nil

        Task { [weak self] in
            guard let self else { return }

            // Stop existing capture if running
            if self.isCapturing {
                await self.capture.stopCapture()
                self.isCapturing = false
                print("[agent] capture stopped (restart)")
            }

            self.isCapturing = true
            await MainActor.run { self.status = "capturing" }

            let platform: ScreenCaptureSource.Platform = (platformStr.lowercased() == "android") ? .emulator : .simulator

            do {
                try await self.capture.startCapture(
                    platform: platform,
                    windowMatch: windowMatch,
                    fps: 24,
                    maxLongEdgePixels: 1280
                )
                print("[agent] capture started platform=\(platformStr) windowMatch=\(windowMatch ?? "nil")")
            } catch {
                print("[agent] ❌ capture start failed:", error.localizedDescription)
                self.isCapturing = false
                await MainActor.run { self.status = "idle" }
            }
        }
    }
}

// Simple config describing each device this host serves.

// MARK: - Minimal Appium v2 HTTP client (XCUITest iOS Simulator)
// This runs inside the macOS agent so Appium can stay on localhost.
final class AppiumDriver {
    private var baseUrl: URL = URL(string: "http://127.0.0.1:4723")!

    func setBaseUrl(_ urlStr: String) {
        if let u = URL(string: urlStr) { self.baseUrl = u }
    }

    struct WindowRect {
        let x: Double
        let y: Double
        let width: Double
        let height: Double
    }

    enum AppiumError: Error, LocalizedError {
        case badResponse(String)
        var errorDescription: String? {
            switch self {
            case .badResponse(let s): return s
            }
        }
    }

    // Appium v2 W3C session create
    func createIOSSession(udid: String, deviceName: String) async throws -> String {
        let url = baseUrl.appendingPathComponent("session")

        let alwaysMatch: [String: Any] = [
            "platformName": "iOS",
            "appium:automationName": "XCUITest",
            "appium:udid": udid,
            "appium:deviceName": deviceName,
            "appium:noReset": true,
            "appium:newCommandTimeout": 600,
        ]

        let body: [String: Any] = [
            "capabilities": [
                "alwaysMatch": alwaysMatch,
                "firstMatch": [[:]]
            ]
        ]

        let json = try await requestJSON(method: "POST", url: url, body: body)

        if let v = json["value"] as? [String: Any] {
            if let sid = v["sessionId"] as? String { return sid }
        }
        if let sid = json["sessionId"] as? String { return sid }

        throw AppiumError.badResponse("missing sessionId in response: \(json)")
    }

    func deleteSession(sessionId: String) async throws {
        let url = baseUrl.appendingPathComponent("session").appendingPathComponent(sessionId)
        _ = try await requestJSON(method: "DELETE", url: url, body: nil)
    }

    func getWindowRect(sessionId: String) async throws -> WindowRect {
        let url = baseUrl
            .appendingPathComponent("session")
            .appendingPathComponent(sessionId)
            .appendingPathComponent("window")
            .appendingPathComponent("rect")

        let json = try await requestJSON(method: "GET", url: url, body: nil)

        if let v = json["value"] as? [String: Any],
           let x = v["x"] as? Double,
           let y = v["y"] as? Double,
           let w = v["width"] as? Double,
           let h = v["height"] as? Double {
            return WindowRect(x: x, y: y, width: w, height: h)
        }

        throw AppiumError.badResponse("missing window rect in response: \(json)")
    }

    // Tap via W3C pointer actions
    func tap(sessionId: String, x: Int, y: Int) async throws {
        try await performPointer(sessionId: sessionId, steps: [
            ["type": "pointerMove", "duration": 0, "x": x, "y": y],
            ["type": "pointerDown", "button": 0],
            ["type": "pause", "duration": 40],
            ["type": "pointerUp", "button": 0],
        ])
    }

    func swipe(sessionId: String, x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Int) async throws {
        let dur = max(50, min(1500, durationMs))
        try await performPointer(sessionId: sessionId, steps: [
            ["type": "pointerMove", "duration": 0, "x": x1, "y": y1],
            ["type": "pointerDown", "button": 0],
            ["type": "pointerMove", "duration": dur, "x": x2, "y": y2],
            ["type": "pointerUp", "button": 0],
        ])
    }

    func sendKeys(sessionId: String, text: String) async throws {
        let url = baseUrl
            .appendingPathComponent("session")
            .appendingPathComponent(sessionId)
            .appendingPathComponent("keys")

        let body: [String: Any] = ["value": text]
        _ = try await requestJSON(method: "POST", url: url, body: body)
    }

    func sendKeyValue(sessionId: String, value: String) async throws {
        let url = baseUrl
            .appendingPathComponent("session")
            .appendingPathComponent(sessionId)
            .appendingPathComponent("actions")

        let body: [String: Any] = [
            "actions": [
                [
                    "type": "key",
                    "id": "keyboard",
                    "actions": [
                        ["type": "keyDown", "value": value],
                        ["type": "keyUp", "value": value],
                    ]
                ]
            ]
        ]
        _ = try await requestJSON(method: "POST", url: url, body: body)
    }

    static func specialKeyValue(code: String, key: String) -> String? {
        switch code {
        case "Enter", "NumpadEnter": return "\u{E007}"
        case "Backspace": return "\u{E003}"
        case "Tab": return "\u{E004}"
        case "Escape": return "\u{E00C}"
        case "ArrowLeft": return "\u{E012}"
        case "ArrowUp": return "\u{E013}"
        case "ArrowRight": return "\u{E014}"
        case "ArrowDown": return "\u{E015}"
        case "Delete": return "\u{E017}"
        default: break
        }
        if key == "Enter" { return "\u{E007}" }
        if key == "Backspace" { return "\u{E003}" }
        if key == "Tab" { return "\u{E004}" }
        if key == "Escape" { return "\u{E00C}" }
        return nil
    }
    
    func pressHome(sessionId: String) async throws {
        // Appium 2 / W3C execute endpoint: POST /session/:sessionId/execute/sync
        let url = baseUrl
            .appendingPathComponent("session")
            .appendingPathComponent(sessionId)
            .appendingPathComponent("execute")
            .appendingPathComponent("sync")

        let body: [String: Any] = [
            "script": "mobile: pressButton",
            "args": [
                ["name": "home"]
            ]
        ]

        _ = try await requestJSON(method: "POST", url: url, body: body)
    }

    // MARK: - Private HTTP

    private func performPointer(sessionId: String, steps: [[String: Any]]) async throws {
        let url = baseUrl
            .appendingPathComponent("session")
            .appendingPathComponent(sessionId)
            .appendingPathComponent("actions")

        let body: [String: Any] = [
            "actions": [
                [
                    "type": "pointer",
                    "id": "finger1",
                    "parameters": ["pointerType": "touch"],
                    "actions": steps
                ]
            ]
        ]
        _ = try await requestJSON(method: "POST", url: url, body: body)
    }

    private func requestJSON(method: String, url: URL, body: [String: Any]?) async throws -> [String: Any] {
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 20
        req.setValue("application/json", forHTTPHeaderField: "Accept")

        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        }

        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw AppiumError.badResponse("no http response")
        }
        guard (200...299).contains(http.statusCode) else {
            let s = String(data: data, encoding: .utf8) ?? ""
            throw AppiumError.badResponse("HTTP \(http.statusCode) \(method) \(url.path) body=\(s)")
        }

        if data.isEmpty { return [:] }
        let any = try JSONSerialization.jsonObject(with: data, options: [])
        return any as? [String: Any] ?? [:]
    }
}


struct DeviceConfig: Identifiable {
    let id: String      // MUST match device.id in devices.ts / server side
    let label: String   // Human-friendly name
    let platform: String  // "ios" or "android"
    let udid: String?     // iOS simulator UDID (required for Appium control on iOS)
    let appiumUrl: String // e.g. "http://127.0.0.1:4723"

    var deviceId: String { id }
}

struct DeviceRowView: View {
    let config: DeviceConfig
    let hostPort: String

    // Each row owns its own AgentApp for that deviceId
    @StateObject private var app: AgentApp

    init(config: DeviceConfig, hostPort: String) {
        self.config = config
        self.hostPort = hostPort
        _app = StateObject(
            wrappedValue: AgentApp(
                config: config,
                hostPort: hostPort
            )
        )
    }

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(config.label)
                    .font(.headline)
                Text("deviceId: \(config.id)")
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 2) {
                Text(app.status)
                    .font(.subheadline)

                Text("\(app.viewerCount) viewer\(app.viewerCount == 1 ? "" : "s")")
                    .font(.caption)
                    .foregroundColor(.secondary)

                if app.frameWidth > 0 && app.frameHeight > 0 {
                    Text("\(app.frameWidth)x\(app.frameHeight)")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                    Text(String(format: "%.1f fps", app.fps))
                        .font(.caption2)
                        .foregroundColor(.secondary)
                } else {
                    Text("no signal")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

struct ContentView: View {
    // Signaling host:port for THIS Mac
    private let hostPort = "192.168.86.25:8080" // adjust if needed

    // ⚠️ IMPORTANT:
    // These deviceIds MUST match what your web client / server uses
    // for this host (see devices.ts on the Node side).
    private let devices: [DeviceConfig] = [
        DeviceConfig(id: "sim-ios-16-pro",     label: "iPhone 16 Pro (sim)", platform: "ios", udid: "9DBCF8EC-9376-480F-8962-582E653696BC", appiumUrl: "http://127.0.0.1:4723"),
        DeviceConfig(id: "sim-ios-16-pro-max", label: "iPhone 16 Pro Max (sim)", platform: "ios", udid: "6CFB845C-E7B4-4542-9A7D-22A7E9B954B8", appiumUrl: "http://127.0.0.1:4723"),
        DeviceConfig(id: "sim-android-1",      label: "Android Emulator #1", platform: "android", udid: nil, appiumUrl: "http://127.0.0.1:4723"),
        DeviceConfig(id: "sim-android-2",      label: "Android Emulator #2", platform: "android", udid: nil, appiumUrl: "http://127.0.0.1:4723"),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("SimWebRTCStreamer")
                .font(.title2)

            Text("Devices on this host")
                .font(.subheadline)
                .foregroundColor(.secondary)

            List(devices) { cfg in
                DeviceRowView(config: cfg, hostPort: hostPort)
            }
            .listStyle(.plain)
        }
        .padding(20)
        .frame(minWidth: 450, minHeight: 280)
    }
}
