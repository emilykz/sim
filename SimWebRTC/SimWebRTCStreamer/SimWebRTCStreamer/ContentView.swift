import SwiftUI

final class AgentApp: ObservableObject {
    @Published var status: String = "idle"
   
    private var signaling: SignalingClient?
    private let webrtc = WebRTCManager()
    private let capture = ScreenCaptureSource()

    private let deviceId: String
    private let hostPort: String  // e.g. "192.168.86.21:8080"

    private var isCapturing = false
    private var activeWindowMatch: String? = nil
    private var captureStopTask: Task<Void, Never>?
    private let stopGraceSeconds: Double = 15

    init(deviceId: String, hostPort: String) {
        self.deviceId = deviceId
        self.hostPort = hostPort

        signaling = SignalingClient(hostPort: hostPort, path: "/agent")
        signaling?.onMessage = { [weak self] msg in
            self?.handle(msg: msg)
        }

        capture.onFrame = { [weak self] frame in
            self?.webrtc.pushFrame(frame)
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

        signaling?.connect()
        signaling?.send([
            "type": "iam-agent",
            "deviceId": deviceId
        ])
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

        case "ice":
            guard let viewerId = msg["viewerId"] as? String,
                  let cand = msg["candidate"] as? [String: Any] else { return }
            webrtc.addIce(viewerId: viewerId, cand: cand)

        case "viewer-left":
            // server.js sends "viewer-left"
            guard let viewerId = msg["viewerId"] as? String else { return }
            print("👋 viewer left viewerId=\(viewerId)")
            webrtc.removeViewer(viewerId)

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

struct ContentView: View {
    // Agent ID should match one entry in devices.ts
    @StateObject private var app = AgentApp(deviceId: "sim-ios-16-pro",
                                           hostPort: "192.168.86.25:8080")

    var body: some View {
        VStack(spacing: 12) {
            Text("SimWebRTCStreamer").font(.title2)
            Text("status: \(app.status)")
        }
        .padding(20)
        .frame(minWidth: 360, minHeight: 200)
    }
}



