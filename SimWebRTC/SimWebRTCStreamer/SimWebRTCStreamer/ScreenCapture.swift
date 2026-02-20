import Foundation
import ScreenCaptureKit
import CoreMedia
import WebRTC
import QuartzCore // for CACurrentMediaTime()

final class ScreenCaptureSource: NSObject, SCStreamOutput, SCStreamDelegate {

    enum Platform {
        case simulator
        case emulator
    }

    private let q = DispatchQueue(label: "capture.q")                 // SCStream output queue
    private let deliverQ = DispatchQueue(label: "capture.deliver.q")  // don’t block SCStream output
    private var stream: SCStream?
    private var frameCount = 0

    private var lastFrame: RTCVideoFrame?
    private var repeatTimer: DispatchSourceTimer?
    private var targetFps: Int = 30

    // When the Simulator is visually idle, ScreenCaptureKit may deliver frames very sparsely.
    // Late-joining WebRTC viewers can stay black until something changes on-screen.
    // To fix that, we "gap-fill" by re-sending the last frame at a low rate ONLY when
    // no real frames have arrived recently.
    private var lastRealFrameNs: Int64 = 0
    private let keepAliveFps: Int = 2          // low CPU: 2fps while idle
    private let keepAliveGapMs: Int64 = 600    // only fill if no real frame for ~600ms

    // Store the active config so pickers can use cfg.windowMatch
    private var cfg: (platform: Platform, windowMatch: String?) = (.simulator, nil)

    var onFrame: ((RTCVideoFrame) -> Void)?

    // Log only once so we don't spam
    private var didLogFirstFrame = false

    // Monotonic timestamp tracking
    private var lastTimestampNs: Int64 = 0

    // DEBUG: enumerate windows
    private func enumerateWindowsLog(_ content: SCShareableContent) {
        print("[sc] windows count =", content.windows.count)
        for w in content.windows {
            let bid = w.owningApplication?.bundleIdentifier ?? "?"
            let name = w.owningApplication?.applicationName ?? "?"
            let title = w.title ?? ""
            let f = w.frame
            print(String(
                format: "[sc] win: app=%@ (%@)  title='%@'  frame=(%.0f,%.0f,%.0f,%.0f)  onScreen=%@",
                name, bid, title,
                f.origin.x, f.origin.y, f.size.width, f.size.height,
                w.isOnScreen.description
            ))
        }
    }

    private func pickWindow(for platform: Platform, content: SCShareableContent) -> SCWindow? {
        switch platform {
        case .simulator:
            return pickSimulatorWindow(from: content)
        case .emulator:
            return pickEmulatorWindow(from: content)
        }
    }

    /// Picks the best iOS Simulator window to capture.
    /// 1. Filter to Simulator windows on-screen.
    /// 2. If cfg.windowMatch is set:
    ///    - Prefer exact (case-insensitive) title match.
    ///    - Else fall back to a "contains" match.
    /// 3. If still nothing, fall back to the tallest portrait window.
    private func pickSimulatorWindow(from content: SCShareableContent) -> SCWindow? {
        let candidates = content.windows.filter {
            ($0.owningApplication?.bundleIdentifier == "com.apple.iphonesimulator") && $0.isOnScreen
        }
        if candidates.isEmpty {
            print("[sc] no Simulator windows on screen")
            return nil
        }

        if let matchRaw = cfg.windowMatch, !matchRaw.isEmpty {
            let match = matchRaw.lowercased()

            if let exact = candidates.first(where: { ($0.title ?? "").lowercased() == match }) {
                print("[sc] Using windowMatch EXACT '\(match)': \((exact.title ?? ""))")
                return exact
            }

            if let partial = candidates.first(where: { ($0.title ?? "").lowercased().contains(match) }) {
                print("[sc] Using windowMatch CONTAINS '\(match)': \((partial.title ?? ""))")
                return partial
            }

            print("[sc] windowMatch '\(match)' did not match any Simulator titles; falling back to heuristic")
        }

        let chosen = candidates.max(by: { a, b in
            func score(_ w: SCWindow) -> CGFloat {
                let r = w.frame
                let aspect = r.height > 0 ? r.width / r.height : 0
                let portraitBonus: CGFloat = (aspect < 0.8) ? 2000 : 0
                return r.height + portraitBonus
            }
            return score(a) < score(b)
        })

        if let chosen {
            print("[sc] fallback chosen Simulator window title='\(chosen.title ?? "")' frame=\(chosen.frame)")
        }
        return chosen
    }

    private func pickEmulatorWindow(from content: SCShareableContent) -> SCWindow? {
        let candidates = content.windows.filter { w in
            let appId = w.owningApplication?.bundleIdentifier
            let processName = w.owningApplication?.applicationName.lowercased() ?? ""
            let isQemu = processName.contains("qemu") || (appId?.contains("android") ?? false)
            return isQemu && w.isOnScreen
        }

        guard !candidates.isEmpty else {
            print("[sc] no Emulator windows on screen")
            return nil
        }

        if let match = cfg.windowMatch?.lowercased(), !match.isEmpty {
            if let chosen = candidates.first(where: { ($0.title ?? "").lowercased().contains(match) }) {
                print("[sc] emulator windowMatch → \(chosen.title ?? "")")
                return chosen
            }
        }

        let chosen = candidates.max { a, b in a.frame.height < b.frame.height }
        print("[sc] picked emulator window → \(chosen?.title ?? "")")
        return chosen
    }

    // ✅ This matches ContentView.swift
    func startCapture(platform: Platform, windowMatch: String?, fps: Int = 30, maxLongEdgePixels: Int? = 1280, cropTopPoints: CGFloat = 50, fixedOutputWidthPx: Int? = nil, fixedOutputHeightPx: Int? = nil) async throws {
        self.cfg = (platform: platform, windowMatch: windowMatch)
        self.didLogFirstFrame = false
        self.frameCount = 0
        self.lastTimestampNs = 0
        self.lastRealFrameNs = 0

        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)

        // DEBUG window list every time
        enumerateWindowsLog(content)

        guard let window = pickWindow(for: platform, content: content) else {
            throw NSError(
                domain: "ScreenCaptureSource",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "No matching window found (platform=\(platform), windowMatch=\(windowMatch ?? "nil"))"]
            )
        }

        let conf = SCStreamConfiguration()
        conf.capturesAudio = false
        conf.showsCursor = false
        conf.queueDepth = 3  // low-latency: keep buffers small to avoid drift
        conf.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, fps)))
        conf.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange // NV12

        let full = window.frame // points

        // Your crops (points)
        let cropTopWanted: CGFloat = cropTopPoints
        let cropLRWanted: CGFloat = 0  // ✅ trim rounded-corner black pixels (was 0)
        let cropBottomWanted: CGFloat = 10

        // Clamp crops so we never go to/under 0 size
        let cropTop = min(max(0, cropTopWanted), full.height - 2)
        let cropLR = min(max(0, cropLRWanted), (full.width - 2) / 2)
        let cropBottom = min(max(0, cropBottomWanted), full.height - cropTop - 2)

        // Build the *actual* capture rect (points)
        let sourceRect = CGRect(
            x: cropLR,
            y: cropTop,
            width: full.width - (cropLR * 2),
            height: full.height - cropTop - cropBottom
        )

        conf.sourceRect = sourceRect

        // Size output from the SAME rect, but in *native pixels*
        let srcWpt = sourceRect.width
        let srcHpt = sourceRect.height

        // Simulator windows on Retina are effectively 2x.
        let backingScale: CGFloat = 2.0

        let nativeWpx = srcWpt * backingScale
        let nativeHpx = srcHpt * backingScale

        func even(_ x: Int) -> Int { (x / 2) * 2 }

        if let fw = fixedOutputWidthPx, let fh = fixedOutputHeightPx {
            // ✅ Decouple output dimensions from Simulator window size.
            // This keeps the browser/video intrinsic size stable even if someone resizes the Simulator window.
            conf.width  = max(2, even(fw))
            conf.height = max(2, even(fh))

            let scaleX = CGFloat(conf.width)  / max(1.0, nativeWpx)
            let scaleY = CGFloat(conf.height) / max(1.0, nativeHpx)
            let up = max(scaleX, scaleY)
            if up > 1.05 {
                print(String(format: "[sc] ⚠️ source smaller than fixed output (native=%.0fx%.0f → out=%dx%d, up=%.2fx). Window likely shrunk; video may look softer.",
                             nativeWpx, nativeHpx, conf.width, conf.height, up))
            } else {
                print(String(format: "[sc] fixed out=%dx%d (native=%.0fx%.0f scale≈%.2fx)", conf.width, conf.height, nativeWpx, nativeHpx, up))
            }
        } else {
            // Cap the long edge (ONLY downscale, never upscale)
            let capLong: CGFloat = CGFloat(maxLongEdgePixels ?? 1280)
            let nativeLong = max(nativeWpx, nativeHpx)
            let down = min(1.0, capLong / max(1.0, nativeLong))

            conf.width  = max(2, even(Int(round(nativeWpx * down))))
            conf.height = max(2, even(Int(round(nativeHpx * down))))

            print(String(format: "[sc] native=%.0fx%.0f cap=%.0f down=%.3f out=%dx%d",
                         nativeWpx, nativeHpx, capLong, down, conf.width, conf.height))
        }

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let s = SCStream(filter: filter, configuration: conf, delegate: self)
        self.stream = s

        try await s.addStreamOutput(self, type: .screen, sampleHandlerQueue: q)
        try await s.startCapture()

        self.targetFps = fps

        // Gap-fill keep-alive (low-rate) so late-joining viewers don't stay black when the
        // Simulator is idle. This does NOT spam duplicates while real frames are flowing.
        startRepeater()
    }

    func stopCapture() async {
        guard let s = stream else { return }
        do { try await s.stopCapture() } catch { }
        stopRepeater()
        stream = nil
        lastFrame = nil
        didLogFirstFrame = false
        frameCount = 0
        lastTimestampNs = 0
        lastRealFrameNs = 0
    }

    // MARK: - Frame callback

    func stream(_ stream: SCStream,
                didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of outputType: SCStreamOutputType) {

        guard outputType == .screen else { return }
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        guard let pb = sampleBuffer.imageBuffer else { return }

        // ✅ Use MONOTONIC time for WebRTC timestamps.
        var ns = Int64(CACurrentMediaTime() * 1_000_000_000.0)
        if ns <= lastTimestampNs {
            ns = lastTimestampNs + 1
        }
        lastTimestampNs = ns
        lastRealFrameNs = ns

        if !didLogFirstFrame {
            didLogFirstFrame = true
            let fmt = CVPixelBufferGetPixelFormatType(pb)
            let w = CVPixelBufferGetWidth(pb)
            let h = CVPixelBufferGetHeight(pb)
            print("[sc] first frame delivered; sizePx=\(w)x\(h)  pixelFormat=\(fmt) (expect NV12=\(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange))")
        }

        let rtcPB = RTCCVPixelBuffer(pixelBuffer: pb)
        let frame = RTCVideoFrame(buffer: rtcPB, rotation: ._0, timeStampNs: ns)

        frameCount += 1
        if frameCount % 30 == 0 {
            print("[sc] frames delivered=\(frameCount) tsNs=\(ns)")
        }

        // ✅ Don’t block the SCStream output queue.
        deliverQ.async { [weak self] in
            self?.onFrame?(frame)
        }

        self.lastFrame = frame
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        print("[sc] stopped with error:", error.localizedDescription)
    }

    private func startRepeater() {
        stopRepeater()
        let timer = DispatchSource.makeTimerSource(queue: deliverQ)
        // Keep-alive at a low rate (independent of targetFps).
        let intervalMs = max(1, 1000 / max(1, keepAliveFps))
        timer.schedule(deadline: .now() + .milliseconds(intervalMs),
                       repeating: .milliseconds(intervalMs))

        timer.setEventHandler { [weak self] in
            guard let self, let f = self.lastFrame else { return }
            let nowNs = Int64(CACurrentMediaTime() * 1_000_000_000.0)

            // Only fill gaps: if real frames are flowing, do nothing.
            if self.lastRealFrameNs != 0 {
                let gapMs = (nowNs - self.lastRealFrameNs) / 1_000_000
                if gapMs < self.keepAliveGapMs { return }
            }

            // Duplicate last frame with a fresh *monotonic* timestamp.
            var ns = nowNs
            if ns <= self.lastTimestampNs { ns = self.lastTimestampNs + 1 }
            self.lastTimestampNs = ns

            let dup = RTCVideoFrame(buffer: f.buffer, rotation: f.rotation, timeStampNs: ns)
            self.onFrame?(dup)
        }
        repeatTimer = timer
        timer.resume()
    }

    private func stopRepeater() {
        repeatTimer?.cancel()
        repeatTimer = nil
    }
}



