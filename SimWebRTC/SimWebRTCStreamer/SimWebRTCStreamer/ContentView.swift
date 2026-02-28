import SwiftUI
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
    
    private var isCapturing = false
    private var activeWindowMatch: String? = nil
    private var captureStopTask: Task<Void, Never>?
    private let stopGraceSeconds: Double = 15
    
    private var fpsFrameCount: Int = 0
    private var fpsWindowStartTime: CFTimeInterval = CACurrentMediaTime()

    init(deviceId: String, hostPort: String) {
        self.deviceId = deviceId
        self.hostPort = hostPort

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

        webrtc.onAnswer = { [weak self] viewerId, sdp in
            self?.signaling?.send([
                "type": "answer",
                "deviceId": deviceId,
                "viewerId": viewerId,
                "sdp": sdp.sdp
            ])
        }

        webrtc.onLocalIce = { [weak self] viewerId, cand in
            self?.signaling?.send([
                "type": "ice",
                "deviceId": deviceId,
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
            currentControllerId = controllerId
            print("[agent] control-state deviceId=\(deviceId) controllerId=\(controllerId ?? "nil")")

        case "pointer", "key", "text":
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

            // TODO: Here is where we’ll map normalized x/y to sim/em coordinates
            // and call into WDA (for iOS) or adb (for Android).

        case "key":
            let action = payload["action"] as? String ?? "?"
            let code = payload["code"] as? String ?? "?"
            let key = payload["key"] as? String ?? "?"
            print("[control] key viewerId=\(viewerId) action=\(action) code=\(code) key=\(key)")

            // TODO: Hook to WDA/adb key events.

        case "text":
            let text = payload["text"] as? String ?? ""
            print("[control] text viewerId=\(viewerId) \(text.debugDescription)")

            // TODO: send text into focused element via WDA/adb.

        default:
            break
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
                    fps: 30,
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
struct DeviceConfig: Identifiable {
    let id: String      // MUST match device.id in devices.ts / server side
    let label: String   // Human-friendly name

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
                deviceId: config.id,
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
        DeviceConfig(id: "sim-ios-16-pro",     label: "iPhone 16 Pro (sim)"),
        DeviceConfig(id: "sim-ios-16-pro-max", label: "iPhone 16 Pro Max (sim)"),
        DeviceConfig(id: "sim-android-1",      label: "Android Emulator #1"),
        DeviceConfig(id: "sim-android-2",      label: "Android Emulator #2"),
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
