import SwiftUI
import Foundation
import QuartzCore

private enum CaptureDefaults {
    // Middle ground: slightly higher source detail without the startup penalty of 1600+/30fps.
    static let fps: Int = 24
    static let maxLongEdgePx: Int = 1440
}

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
    private let adb = ADBDriver()
    private var adbSerial: String? = nil
    private var androidInputRect: (left: Double, top: Double, width: Double, height: Double)? = nil
    private var lastPlatformStr: String = "ios"

    private enum AppiumLeaseState: Equatable {
        case idle
        case starting
        case ready
        case stopping
        case error(String)
    }

    private var appiumState: AppiumLeaseState = .idle
    private var appiumStartTask: Task<String?, Never>? = nil
    private var appiumConsecutiveFailures: Int = 0
    private let maxTransientAppiumFailures: Int = 3

    // Pointer aggregation (down/move/up -> tap/swipe)
    private var pointerDown: (x: Double, y: Double, t: CFTimeInterval)? = nil
    private var pointerLast: (x: Double, y: Double)? = nil

    private let tapMoveThreshold: Double = 0.02
    private let longPressMinSeconds: Double = 0.45
    private let longPressMaxMoveThreshold: Double = 0.02

    
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
        self.adbSerial = config.adbSerial
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

            let gainedControl = controllerId != nil && prev != controllerId
            let lostOrTransferredControl = controllerId == nil || (prev != nil && prev != controllerId)

            // If control was released or transferred, end the current Appium session.
            if lostOrTransferredControl {
                pointerDown = nil
                pointerLast = nil
                notifyInteractionState("idle")
                Task { [weak self] in
                    await self?.stopAppiumSession(reason: "control-state-changed")
                }
            }

            // iOS needs an Appium warm-up. Android can mark ready as soon as ADB is reachable.
            if gainedControl {
                if platformIsAndroid {
                    Task { [weak self] in
                        await self?.ensureAndroidReady()
                    }
                } else {
                    notifyInteractionState("starting")
                    Task { [weak self] in
                        _ = await self?.ensureAppiumSession()
                    }
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
        guard currentControllerId == viewerId else {
            print("[control] ignored from non-controller viewerId=\(viewerId) type=\(type) currentController=\(currentControllerId ?? "nil")")
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
            if kind == "down" {
                reportControllerActivity(viewerId: viewerId)
            }
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
                reportControllerActivity(viewerId: viewerId)
                Task { [weak self] in
                    await self?.handleKey(code: code, key: key)
                }
            }

        case "text":
            let text = payload["text"] as? String ?? ""
            print("[control] text viewerId=\(viewerId) \(text.debugDescription)")

            if !text.isEmpty {
                reportControllerActivity(viewerId: viewerId)
            }
            Task { [weak self] in
                await self?.handleText(text)
            }
        case "home":
            print("[control] home viewerId=\(viewerId)")
            reportControllerActivity(viewerId: viewerId)
            Task { [weak self] in
                await self?.handleHome()
            }
        default:
            break
        }
    }
    
    private func notifyInteractionState(_ state: String, reason: String? = nil) {
        var msg: [String: Any] = [
            "type": "interaction-state",
            "deviceId": deviceId,
            "state": state
        ]
        if let reason = reason, !reason.isEmpty {
            msg["reason"] = reason
        }
        signaling?.send(msg)
    }
    
    private func reportControllerActivity(viewerId: String) {
        signaling?.send([
            "type": "controller-activity",
            "deviceId": deviceId,
            "viewerId": viewerId
        ])
    }
    
    private func recordAppiumSuccess() {
        appiumConsecutiveFailures = 0
    }

    private func recordAppiumFailure(_ reason: String) async {
        appiumConsecutiveFailures += 1
        print("[appium] failure count=\(appiumConsecutiveFailures) reason=\(reason)")
        if appiumConsecutiveFailures >= maxTransientAppiumFailures {
            await stopAppiumSession(reason: "too-many-failures-\(reason)")
        }
    }

    private var platformIsAndroid: Bool {
        lastPlatformStr.lowercased() == "android"
    }
    
    // MARK: - Appium control (iOS simulator)

    private func ensureAppiumSession() async -> String? {
        // Only for iOS sims (you can extend later for Android)
        if lastPlatformStr.lowercased() != "ios" {
            return nil
        }
        guard let udid = appiumUdid, !udid.contains("<PUT_UDID_HERE>") else {
            print("[appium] ❌ missing UDID for deviceId=\(deviceId) (set DeviceConfig.udid)")
            appiumState = .error("missing-udid")
            notifyInteractionState("error", reason: "missing-udid")
            return nil
        }

        // If we already have a ready session, reuse it.
        if let sid = appiumSessionId, appiumState == .ready {
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

        // Singleflight: if a start is already in progress, await it.
        if appiumState == .starting, let task = appiumStartTask {
            return await task.value
        }

        appiumState = .starting
        notifyInteractionState("starting")

        let task = Task<String?, Never> { [weak self] in
            guard let self else { return nil }

            do {
                let sid = try await self.appium.createIOSSession(udid: udid, deviceName: self.deviceId)
                self.appiumSessionId = sid
                print("[appium] ✅ session created sessionId=\(sid) udid=\(udid)")

                let rect = try await self.appium.getWindowRect(sessionId: sid)
                self.appiumWindowRect = (rect.width, rect.height)
                print("[appium] ✅ windowRect w=\(rect.width) h=\(rect.height)")

                self.appiumState = .ready
                self.recordAppiumSuccess()
                self.startAppiumKeepAlive()
                self.notifyInteractionState("ready")
                return sid
            } catch {
                print("[appium] ❌ create session failed:", error.localizedDescription)
                self.appiumSessionId = nil
                self.appiumWindowRect = nil
                self.stopAppiumKeepAlive()
                self.appiumState = .error(error.localizedDescription)
                self.notifyInteractionState("error", reason: error.localizedDescription)
                return nil
            }
        }

        appiumStartTask = task
        let sid = await task.value
        appiumStartTask = nil
        return sid
    }

    private func stopAppiumSession(reason: String) async {
        stopAppiumKeepAlive()
        appiumStartTask = nil
        appiumState = .stopping

        guard let sid = appiumSessionId else {
            appiumWindowRect = nil
            appiumState = .idle
            notifyInteractionState("idle", reason: reason)
            return
        }

        appiumSessionId = nil
        appiumWindowRect = nil

        do {
            try await appium.deleteSession(sessionId: sid)
            print("[appium] 🛑 session deleted sessionId=\(sid) reason=\(reason)")
        } catch {
            print("[appium] ⚠️ delete session failed sessionId=\(sid) reason=\(reason) err=\(error.localizedDescription)")
        }

        appiumState = .idle
        notifyInteractionState("idle", reason: reason)
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
                    do {
                        _ = try await self.appium.getWindowRect(sessionId: sid)
                        self.recordAppiumSuccess()
                    } catch {
                        print("[appium] keepalive failed:", error.localizedDescription)
                        await self.recordAppiumFailure("keepalive")
                    }
                }
            }
        }
    }

    private func stopAppiumKeepAlive() {
        appiumKeepAliveTimer?.invalidate()
        appiumKeepAliveTimer = nil
    }

    private func ensureAndroidReady() async {
        guard platformIsAndroid else { return }
        guard let serial = adbSerial, !serial.isEmpty else {
            notifyInteractionState("error", reason: "missing-adb-serial")
            return
        }
        
        notifyInteractionState("starting")
        do {
            let size = try await adb.getDisplaySize(serial: serial)
            androidInputRect = (
                left: 0,
                top: 0,
                width: Double(size.width),
                height: Double(size.height)
            )
            print("[adb] wm size w=\(size.width) h=\(size.height)")
            notifyInteractionState("ready")
        } catch {
            print("[adb] wm size failed:", error.localizedDescription)
            
            // fallback only if needed
            do {
                let rect = try await adb.getInputViewport(serial: serial)
                androidInputRect = (
                    left: Double(rect.left),
                    top: Double(rect.top),
                    width: Double(rect.width),
                    height: Double(rect.height)
                )
                print("[adb] fallback input viewport left=\(rect.left) top=\(rect.top) w=\(rect.width) h=\(rect.height)")
                notifyInteractionState("ready")
            } catch {
                print("[adb] fallback input viewport also failed:", error.localizedDescription)
                notifyInteractionState("error", reason: error.localizedDescription)
            }
        }
    }

    private func toDeviceXY(xNorm: Double, yNorm: Double) -> (x: Int, y: Int)? {
        let rect: (left: Double, top: Double, width: Double, height: Double)?

        if platformIsAndroid {
            rect = androidInputRect
        } else if let r = appiumWindowRect {
            rect = (left: 0, top: 0, width: r.width, height: r.height)
        } else {
            rect = nil
        }

        guard let rect else { return nil }
        guard rect.width.isFinite, rect.height.isFinite,
              rect.left.isFinite, rect.top.isFinite,
              rect.width > 0, rect.height > 0,
              rect.width <= Double(Int.max), rect.height <= Double(Int.max) else {
            print("[control] invalid device rect left=\(rect.left) top=\(rect.top) w=\(rect.width) h=\(rect.height); dropping pointer")
            return nil
        }

        let safeXNorm = xNorm.isFinite ? max(0, min(1, xNorm)) : 0
        let safeYNorm = yNorm.isFinite ? max(0, min(1, yNorm)) : 0

        let xDouble = rect.left + (safeXNorm * rect.width)
        let yDouble = rect.top + (safeYNorm * rect.height)

        guard xDouble.isFinite, yDouble.isFinite,
              xDouble <= Double(Int.max), yDouble <= Double(Int.max) else {
            print("[control] invalid pointer conversion x=\(xDouble) y=\(yDouble); dropping pointer")
            return nil
        }

        return (x: Int(xDouble.rounded()), y: Int(yDouble.rounded()))
    }

    private func handlePointer(kind: String, xNorm: Double, yNorm: Double) async {
        webrtc.noteInteraction()

        if platformIsAndroid {
            guard let serial = adbSerial, !serial.isEmpty else { return }
            if androidInputRect == nil {
                do {
                    let size = try await adb.getDisplaySize(serial: serial)
                    androidInputRect = (
                        left: 0,
                        top: 0,
                        width: Double(size.width),
                        height: Double(size.height)
                    )
                    print("[adb] pointer wm size w=\(size.width) h=\(size.height)")
                } catch {
                    do {
                        let rect = try await adb.getInputViewport(serial: serial)
                        androidInputRect = (
                            left: Double(rect.left),
                            top: Double(rect.top),
                            width: Double(rect.width),
                            height: Double(rect.height)
                        )
                        print("[adb] pointer fallback viewport left=\(rect.left) top=\(rect.top) w=\(rect.width) h=\(rect.height)")
                    } catch {
                        print("[adb] ❌ wm size / input viewport failed:", error.localizedDescription)
                        return
                    }
                }
            }
        } else {
            guard let _ = await ensureAppiumSession() else { return }
        }

        guard toDeviceXY(xNorm: xNorm, yNorm: yNorm) != nil else {
            print("[control] ⚠️ no device rect yet; dropping pointer")
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
            let dist = sqrt(dx * dx + dy * dy)
            let heldSeconds = max(0, now - down.t)
            let heldMs = Int(heldSeconds * 1000)

            let isStationaryEnoughForTapLike = dist <= tapMoveThreshold
            let isLongPress = heldSeconds >= longPressMinSeconds && dist <= longPressMaxMoveThreshold

            if isLongPress {
                guard let xy = toDeviceXY(xNorm: end.x, yNorm: end.y) else { return }

                if platformIsAndroid {
                    guard let serial = adbSerial else { return }
                    do {
                        try await adb.longPress(serial: serial, x: xy.x, y: xy.y, durationMs: heldMs)
                        print("[adb] longPress x=\(xy.x) y=\(xy.y) ms=\(heldMs)")
                    } catch {
                        print("[adb] ❌ longPress failed:", error.localizedDescription)
                    }
                } else {
                    guard let sid = appiumSessionId else { return }
                    do {
                        try await appium.longPress(sessionId: sid, x: xy.x, y: xy.y, durationMs: heldMs)
                        recordAppiumSuccess()
                        print("[appium] longPress x=\(xy.x) y=\(xy.y) ms=\(heldMs)")
                    } catch {
                        print("[appium] ❌ longPress failed:", error.localizedDescription)
                        await recordAppiumFailure("longPress")
                    }
                }
            } else if isStationaryEnoughForTapLike {
                guard let xy = toDeviceXY(xNorm: end.x, yNorm: end.y) else { return }

                if platformIsAndroid {
                    guard let serial = adbSerial else { return }
                    do {
                        try await adb.tap(serial: serial, x: xy.x, y: xy.y)
                        print("[adb] tap x=\(xy.x) y=\(xy.y)")
                    } catch {
                        print("[adb] ❌ tap failed:", error.localizedDescription)
                    }
                } else {
                    guard let sid = appiumSessionId else { return }
                    do {
                        try await appium.tap(sessionId: sid, x: xy.x, y: xy.y)
                        recordAppiumSuccess()
                        print("[appium] tap x=\(xy.x) y=\(xy.y)")
                    } catch {
                        print("[appium] ❌ tap failed:", error.localizedDescription)
                        await recordAppiumFailure("tap")
                    }
                }
            } else {
                guard let startXY = toDeviceXY(xNorm: down.x, yNorm: down.y),
                      let endXY = toDeviceXY(xNorm: end.x, yNorm: end.y) else { return }

                let ms = Int(max(80, min(800, heldSeconds * 1000)))

                if platformIsAndroid {
                    guard let serial = adbSerial else { return }
                    do {
                        try await adb.swipe(
                            serial: serial,
                            x1: startXY.x,
                            y1: startXY.y,
                            x2: endXY.x,
                            y2: endXY.y,
                            durationMs: ms
                        )
                        print("[adb] swipe (\(startXY.x),\(startXY.y)) -> (\(endXY.x),\(endXY.y)) ms=\(ms)")
                    } catch {
                        print("[adb] ❌ swipe failed:", error.localizedDescription)
                    }
                } else {
                    guard let sid = appiumSessionId else { return }
                    do {
                        try await appium.swipe(
                            sessionId: sid,
                            x1: startXY.x,
                            y1: startXY.y,
                            x2: endXY.x,
                            y2: endXY.y,
                            durationMs: ms
                        )
                        recordAppiumSuccess()
                        print("[appium] swipe (\(startXY.x),\(startXY.y)) -> (\(endXY.x),\(endXY.y)) ms=\(ms)")
                    } catch {
                        print("[appium] ❌ swipe failed:", error.localizedDescription)
                        await recordAppiumFailure("swipe")
                    }
                }
            }

        default:
            break
        }
    }

    private func handleText(_ text: String) async {
        webrtc.noteInteraction()

        guard !text.isEmpty else { return }
        if platformIsAndroid {
            guard let serial = adbSerial else { return }
            do {
                try await adb.sendText(serial: serial, text: text)
                print("[adb] text len=\(text.count)")
            } catch {
                print("[adb] ❌ text failed:", error.localizedDescription)
            }
            return
        }

        guard let sid = await ensureAppiumSession() else { return }
        do {
            try await appium.sendKeys(sessionId: sid, text: text)
            recordAppiumSuccess()
            print("[appium] keys textLen=\(text.count)")
        } catch {
            print("[appium] ❌ sendKeys failed:", error.localizedDescription)
            await recordAppiumFailure("keys")
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

        if platformIsAndroid {
            guard let serial = adbSerial else { return }
            do {
                if let keyCode = ADBDriver.androidKeyCode(code: code, key: key) {
                    try await adb.sendKeyEvent(serial: serial, keyCode: keyCode)
                } else if !key.isEmpty {
                    try await adb.sendText(serial: serial, text: key)
                }
                print("[adb] key code=\(code) key=\(key)")
            } catch {
                print("[adb] ❌ key failed:", error.localizedDescription)
            }
            return
        }

        guard let sid = await ensureAppiumSession() else { return }

        let v = AppiumDriver.specialKeyValue(code: code, key: key) ?? key
        do {
            try await appium.sendKeyValue(sessionId: sid, value: v)
            recordAppiumSuccess()
            print("[appium] key code=\(code) key=\(key)")
        } catch {
            print("[appium] ❌ key failed:", error.localizedDescription)
            await recordAppiumFailure("key")
        }
    }
    
    private func handleHome() async {
        webrtc.noteInteraction()

        if platformIsAndroid {
            guard let serial = adbSerial else { return }
            do {
                try await adb.pressHome(serial: serial)
                print("[adb] home pressed")
            } catch {
                print("[adb] ❌ home failed:", error.localizedDescription)
            }
            return
        }

        guard let sid = await ensureAppiumSession() else { return }
        do {
            try await appium.pressHome(sessionId: sid)
            recordAppiumSuccess()
            print("[appium] home pressed")
        } catch {
            print("[appium] ❌ home failed:", error.localizedDescription)
            await recordAppiumFailure("home")
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
                    fps: CaptureDefaults.fps,
                    maxLongEdgePixels: CaptureDefaults.maxLongEdgePx
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
           let x = parseDouble(v["x"]),
           let y = parseDouble(v["y"]),
           let w = parseDouble(v["width"]),
           let h = parseDouble(v["height"]),
           x.isFinite, y.isFinite, w.isFinite, h.isFinite,
           w > 0, h > 0, w <= 100_000, h <= 100_000 {
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
    
    func longPress(sessionId: String, x: Int, y: Int, durationMs: Int) async throws {
        let dur = max(450, min(3000, durationMs))
        try await performPointer(sessionId: sessionId, steps: [
            ["type": "pointerMove", "duration": 0, "x": x, "y": y],
            ["type": "pointerDown", "button": 0],
            ["type": "pause", "duration": dur],
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

    private func parseDouble(_ value: Any?) -> Double? {
        switch value {
        case let number as NSNumber:
            return number.doubleValue
        case let double as Double:
            return double
        case let int as Int:
            return Double(int)
        case let string as String:
            return Double(string)
        default:
            return nil
        }
    }
}

final class ADBDriver {
    struct DisplaySize {
        let width: Int
        let height: Int
    }
    
    struct InputViewport {
        let left: Int
        let top: Int
        let width: Int
        let height: Int
    }
    

    enum ADBError: Error, LocalizedError {
        case adbNotFound
        case commandFailed(String)
        case badResponse(String)

        var errorDescription: String? {
            switch self {
            case .adbNotFound:
                return "adb not found"
            case .commandFailed(let message):
                return message
            case .badResponse(let message):
                return message
            }
        }
    }
    
   
    func getInputViewport(serial: String) async throws -> InputViewport {
        print("getting input viewport")
        let output = try await run(
            serial: serial,
            args: ["shell", "sh", "-c", "dumpsys input | grep -m 1 logicalFrame"]
        )

        print("[adb] filtered dumpsys input:", output)

        if let rect = parseLogicalFrameRect(output) {
            return rect
        }

        throw ADBError.badResponse("missing logicalFrame in filtered dumpsys input output: \(output)")
    }
    private func parseLogicalFrameRect(_ text: String) -> InputViewport? {
        let ns = text as NSString

        let patterns = [
            #"logicalFrame=\[(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]"#,
            #"logicalFrame=Rect\((\d+),\s*(\d+)\s*-\s*(\d+),\s*(\d+)\)"#
        ]

        for pattern in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else { continue }
            let range = NSRange(location: 0, length: ns.length)
            if let match = regex.firstMatch(in: text, options: [], range: range),
               match.numberOfRanges == 5 {
                let values: [Int] = (1..<5).compactMap { idx in
                    let r = match.range(at: idx)
                    guard r.location != NSNotFound else { return nil }
                    return Int(ns.substring(with: r))
                }
                if values.count == 4 {
                    let left = values[0]
                    let top = values[1]
                    let right = values[2]
                    let bottom = values[3]
                    let width = right - left
                    let height = bottom - top
                    if width > 0 && height > 0 {
                        return InputViewport(left: left, top: top, width: width, height: height)
                    }
                }
            }
        }

        return nil
    }

    func getDisplaySize(serial: String) async throws -> DisplaySize {
        let output = try await run(serial: serial, args: ["shell", "wm", "size"])
        let numbers = output
            .components(separatedBy: CharacterSet.decimalDigits.inverted)
            .compactMap { Int($0) }
        if numbers.count >= 2 {
            return DisplaySize(width: numbers[0], height: numbers[1])
        }
        throw ADBError.badResponse("missing display size in output: \(output)")
    }

    func tap(serial: String, x: Int, y: Int) async throws {
        _ = try await run(serial: serial, args: ["shell", "input", "tap", String(x), String(y)])
    }

    func swipe(serial: String, x1: Int, y1: Int, x2: Int, y2: Int, durationMs: Int) async throws {
        _ = try await run(serial: serial, args: [
            "shell", "input", "swipe",
            String(x1), String(y1), String(x2), String(y2), String(max(50, durationMs))
        ])
    }
    
    func longPress(serial: String, x: Int, y: Int, durationMs: Int) async throws {
        let dur = max(450, min(3000, durationMs))
        _ = try await run(serial: serial, args: [
            "shell", "input", "swipe",
            String(x), String(y), String(x), String(y), String(dur)
        ])
    }
    

    func sendText(serial: String, text: String) async throws {
        let escaped = escapeText(text)
        guard !escaped.isEmpty else { return }
        _ = try await run(serial: serial, args: ["shell", "input", "text", escaped])
    }

    func sendKeyEvent(serial: String, keyCode: Int) async throws {
        _ = try await run(serial: serial, args: ["shell", "input", "keyevent", String(keyCode)])
    }

    func pressHome(serial: String) async throws {
        try await sendKeyEvent(serial: serial, keyCode: 3)
    }

    static func androidKeyCode(code: String, key: String) -> Int? {
        switch code {
        case "Enter", "NumpadEnter": return 66
        case "Backspace": return 67
        case "Tab": return 61
        case "Escape": return 111
        case "ArrowLeft": return 21
        case "ArrowUp": return 19
        case "ArrowRight": return 22
        case "ArrowDown": return 20
        case "Delete": return 112
        case "Home": return 3
        default: break
        }
        switch key {
        case "Enter": return 66
        case "Backspace": return 67
        case "Tab": return 61
        case "Escape": return 111
        default: return nil
        }
    }

    private func escapeText(_ text: String) -> String {
        text
            .replacingOccurrences(of: " ", with: "%s")
            .replacingOccurrences(of: "&", with: "\\&")
            .replacingOccurrences(of: "<", with: "\\<")
            .replacingOccurrences(of: ">", with: "\\>")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "(", with: "\\(")
            .replacingOccurrences(of: ")", with: "\\)")
    }

    private func run(serial: String, args: [String]) async throws -> String {
        let adbPath = try resolveADBPath()
        print("[adb] using path:", adbPath)
        return try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: adbPath)
            process.arguments = ["-s", serial] + args

            let outputPipe = Pipe()
            let errorPipe = Pipe()
            process.standardOutput = outputPipe
            process.standardError = errorPipe

            process.terminationHandler = { proc in
                let out = String(data: outputPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                let err = String(data: errorPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                if proc.terminationStatus == 0 {
                    continuation.resume(returning: out.trimmingCharacters(in: .whitespacesAndNewlines))
                } else {
                    continuation.resume(throwing: ADBError.commandFailed("adb failed (\(proc.terminationStatus)): \(err.isEmpty ? out : err)"))
                }
            }

            do {
                try process.run()
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }

    private func resolveADBPath() throws -> String {
        let candidates = adbPathCandidates()

        let fm = FileManager.default
        for candidate in candidates {
            let resolved = URL(fileURLWithPath: candidate).resolvingSymlinksInPath().path
            if fm.fileExists(atPath: candidate) {
                return candidate
            }
            if resolved != candidate, fm.fileExists(atPath: resolved) {
                return resolved
            }
        }

        if let discovered = try? discoverADBOnPath(), !discovered.isEmpty {
            let resolved = URL(fileURLWithPath: discovered).resolvingSymlinksInPath().path
            if fm.fileExists(atPath: discovered) {
                return discovered
            }
            if fm.fileExists(atPath: resolved) {
                return resolved
            }
        }

        print("[adb] no executable found; candidates=", candidates)
        throw ADBError.adbNotFound
    }

    private func discoverADBOnPath() throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        process.arguments = ["adb"]

        let outputPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = Pipe()

        try process.run()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else { return "" }
        let out = String(data: outputPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func adbPathCandidates() -> [String] {
        let env = ProcessInfo.processInfo.environment
        let realHome = FileManager.default.homeDirectoryForCurrentUser.path
        return [
            env["ADB_PATH"],
            env["ANDROID_SDK_ROOT"].map { "\($0)/platform-tools/adb" },
            env["ANDROID_HOME"].map { "\($0)/platform-tools/adb" },
            "\(realHome)/Library/Android/sdk/platform-tools/adb",
            "\(NSHomeDirectory())/Library/Android/sdk/platform-tools/adb",
            "/opt/homebrew/bin/adb",
            "/usr/local/bin/adb"
        ]
        .compactMap { $0 }
    }
}


struct DeviceConfig: Identifiable {
    let id: String      // MUST match device.id in devices.ts / server side
    let label: String   // Human-friendly name
    let platform: String  // "ios" or "android"
    let udid: String?     // iOS simulator UDID (required for Appium control on iOS)
    let adbSerial: String? // Android emulator/device serial used by adb
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
    private let hostPort = "192.168.86.29:8080" // adjust if needed

    // ⚠️ IMPORTANT:
    // These deviceIds MUST match what your web client / server uses
    // for this host (see devices.ts on the Node side).
    private let devices: [DeviceConfig] = [
        DeviceConfig(id: "sim-ios-16-pro",     label: "iPhone 16 Pro (sim)", platform: "ios", udid: "9DBCF8EC-9376-480F-8962-582E653696BC", adbSerial: nil, appiumUrl: "http://127.0.0.1:4723"),
        DeviceConfig(id: "sim-ios-16-pro-max", label: "iPhone 16 Pro Max (sim)", platform: "ios", udid: "6CFB845C-E7B4-4542-9A7D-22A7E9B954B8", adbSerial: nil, appiumUrl: "http://127.0.0.1:4723"),
        DeviceConfig(id: "sim-android-1",      label: "Android Emulator #1", platform: "android", udid: nil, adbSerial: "emulator-5554", appiumUrl: "http://127.0.0.1:4723"),
        DeviceConfig(id: "sim-android-2",      label: "Android Emulator #2", platform: "android", udid: nil, adbSerial: "emulator-5556", appiumUrl: "http://127.0.0.1:4723"),
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
