import Foundation
import QuartzCore
import WebRTC

// Simple capturer used to satisfy RTCVideoSource capturer callbacks.
final class DummyCapturer: RTCVideoCapturer {}

final class WebRTCManager: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate {

    // MARK: - Version banner (so you can confirm you’re running the right binary)
    private let buildTag = "WEBRTC_MANAGER_WAN_UI_v1"

    // MARK: - Public callbacks (wired by ContentView)
    var onLocalIce: ((_ viewerId: String, _ candidate: RTCIceCandidate) -> Void)?
    var onAnswer: ((_ viewerId: String, _ sdp: RTCSessionDescription) -> Void)?

    // DataChannel (viewer -> agent) for low-latency control
    var onControlMessage: ((_ viewerId: String, _ text: String) -> Void)?

    // MARK: - WebRTC core
    private let factory: RTCPeerConnectionFactory
    private let config: RTCConfiguration
    private let constraints: RTCMediaConstraints

    // One PC per viewer
    private var dataChannels: [String: RTCDataChannel] = [:]

    private var pcs: [String: RTCPeerConnection] = [:]
    private var viewerIdByPC: [ObjectIdentifier: String] = [:]

    // ICE candidates that arrive before remoteDescription is set
    private var pendingCandidates: [String: [RTCIceCandidate]] = [:]

    // Stats timers
    private var statsTimers: [String: DispatchSourceTimer] = [:]

    // MARK: - WAN tuning (sharp text without latency drift)
    private struct VideoTuneState {
        var maxBitrateBps: Int
        var maxFramerate: Int
        var baselineMaxBitrateBps: Int
        var baselineMaxFramerate: Int
        var lastGoodTs: TimeInterval = 0
        var lastBadTs: TimeInterval = 0
        var lastBytesSent: Int64 = 0
        var lastPacketsSent: Int64 = 0
        var lastPacketsLost: Int64 = 0
    }
    private var tuneByViewer: [String: VideoTuneState] = [:]

    // Interaction-aware mode (for smooth scroll vs. sharp idle)
    private var interactionActive: Bool = false
    private var interactionTimer: DispatchSourceTimer?
    private let interactionHoldSeconds: TimeInterval = 0.9
    private let interactionQueue = DispatchQueue(label: "webrtc.interaction.q")

    // Local media (VideoSource is a “fake capturer” we push frames into)
    private let capturer = DummyCapturer()
    private let localVideoSource: RTCVideoSource
    private let localVideoTrack: RTCVideoTrack

    // Debug frame counters
    private var pushedFrames = 0
    private var didLogFirstPush = false

    // Sender tuning state (avoid re-tuning every frame)
    private var lastTuneKey: String? = nil

    override init() {
        RTCInitializeSSL()

        let encoderFactory = RTCDefaultVideoEncoderFactory()
        let decoderFactory = RTCDefaultVideoDecoderFactory()
        self.factory = RTCPeerConnectionFactory(encoderFactory: encoderFactory,
                                                decoderFactory: decoderFactory)

        let rtcConfig = RTCConfiguration()
        rtcConfig.sdpSemantics = .unifiedPlan
        rtcConfig.continualGatheringPolicy = .gatherContinually
        rtcConfig.iceTransportPolicy = .all
        rtcConfig.tcpCandidatePolicy = .enabled // allow TCP ICE fallback when UDP is blocked (no TURN)
        rtcConfig.iceServers = [
            RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"])
        ]
        self.config = rtcConfig

        self.constraints = RTCMediaConstraints(
            mandatoryConstraints: nil,
            optionalConstraints: ["DtlsSrtpKeyAgreement": "true"]
        )

        self.localVideoSource = factory.videoSource()
        self.localVideoTrack = factory.videoTrack(with: localVideoSource, trackId: "agent_video")

        super.init()

        print("✅ [agent] \(buildTag)")
        print("✅ [agent] local video track created trackId=agent_video")
    }

    deinit {
        for (_, t) in statsTimers { t.cancel() }
        statsTimers.removeAll()

        for (_, pc) in pcs { pc.close() }
        pcs.removeAll()
        viewerIdByPC.removeAll()
        pendingCandidates.removeAll()

        RTCCleanupSSL()
    }

        // Last pushed frame dimensions (used to pick sane default bitrate caps)
    private var lastFrameWidth: Int = 0
    private var lastFrameHeight: Int = 0

    /// Choose a sensible baseline max bitrate for screen content based on resolution.
    /// These are intentionally higher than camera defaults because UI text needs bits during scroll.
    private func defaultBaselineMaxBitrateBps() -> Int {
        let w = max(1, lastFrameWidth)
        let h = max(1, lastFrameHeight)
        let pixels = w * h

        // ~720p
        if pixels <= 1_000_000 { return 6_000_000 }      // 6 Mbps
        // ~1080p
        if pixels <= 2_200_000 { return 10_000_000 }     // 10 Mbps
        // tall iPhone sim (~1300x2796 ~= 3.6M px)
        if pixels <= 4_200_000 { return 14_000_000 }     // 14 Mbps
        return 18_000_000                               // very high res
    }
// MARK: - Public API expected by ContentView.swift

    func viewerCount() -> Int { pcs.count }

    func removeViewer(_ viewerId: String) {
        close(viewerId: viewerId)
        // Re-evaluate tuning for remaining viewers when one disconnects.
        retuneForViewerCountChange()
    }


    /// Called by your ScreenCapture pipeline.
    func pushFrame(_ frame: RTCVideoFrame) {
        pushedFrames += 1

        if !didLogFirstPush {
            didLogFirstPush = true
            print("[webrtc] first frame pushed w=\(frame.width) h=\(frame.height)")
            // Retune sender bitrate/FPS based on first observed frame size
            maybeRetuneAllSendersForSharpness(frameWidth: Int(frame.width), frameHeight: Int(frame.height))
        }
        if pushedFrames % 10 == 0 {
            print("[webrtc] pushedFrames=\(pushedFrames)")
        }

        localVideoSource.capturer(capturer, didCapture: frame)
    }
    /// Called whenever a user interacts (pointer/key/text).
    /// Temporarily bias encoder toward smooth motion, then snap back to sharp idle.
    func noteInteraction() {
        interactionQueue.async { [weak self] in
            guard let self else { return }

            self.interactionActive = true

            // Re-apply current tuning so degradationPreference switches to maintainFramerate.
            for (viewerId, pc) in self.pcs {
                if let state = self.tuneByViewer[viewerId] {
                    self.applyTune(viewerId: viewerId,
                                   pc: pc,
                                   maxBitrateBps: state.maxBitrateBps,
                                   maxFramerate: state.maxFramerate)
                }
            }

            self.interactionTimer?.cancel()
            self.interactionTimer = nil

            let t = DispatchSource.makeTimerSource(queue: self.interactionQueue)
            t.schedule(deadline: .now() + self.interactionHoldSeconds)
            t.setEventHandler { [weak self] in
                guard let self else { return }
                self.interactionActive = false
                self.interactionTimer?.cancel()
                self.interactionTimer = nil
                self.forceIdleSharpen()
            }
            t.resume()
            self.interactionTimer = t
        }
    }

    /// After a short idle period, restore crisp text by snapping back to baseline bitrate/fps
    /// and switching degradationPreference to maintainResolution.
    private func forceIdleSharpen() {
        print("[agent][idle] no interaction → sharpening all senders")

        for (viewerId, pc) in pcs {
            guard var state = tuneByViewer[viewerId] else { continue }

            state.maxBitrateBps = state.baselineMaxBitrateBps
            state.maxFramerate = state.baselineMaxFramerate
            tuneByViewer[viewerId] = state

            applyTune(viewerId: viewerId,
                      pc: pc,
                      maxBitrateBps: state.maxBitrateBps,
                      maxFramerate: state.maxFramerate)
        }
    }



    /// Tune video senders for **WAN P2P UI testing**:
    /// - Prioritize sharp text (maintain resolution)
    /// - Avoid latency drift by keeping bitrate reasonable
    /// Call this once when we learn the first frame size, and again only if resolution changes.
    private func maybeRetuneAllSendersForSharpness(frameWidth: Int, frameHeight: Int) {
        let longEdge = max(frameWidth, frameHeight)
        let key = "\(frameWidth)x\(frameHeight)"
        if lastTuneKey == key { return }
        lastTuneKey = key

        // Global-friendly bitrate ladder (still sharp, but won’t explode on WAN)
        // 720p: 2.5–3.5 Mbps
        // 1080p: 4.0–5.5 Mbps (only if you actually capture that high)
        let targetBitrate: Int
        if longEdge <= 1280 {
            targetBitrate = 3_500_000
        } else if longEdge <= 1920 {
            targetBitrate = 5_500_000
        } else {
            // Tall iPhone sims (e.g., 1300x2796) need more headroom to stay sharp during fast scroll.
            targetBitrate = 12_000_000
        }
        let targetFps = 30

        for (viewerId, pc) in pcs {
            for sender in pc.senders where sender.track?.kind == "video" {
                tuneVideoSender(sender, viewerId: viewerId, maxBitrateBps: targetBitrate, maxFramerate: targetFps)
            }
        }

        print("[webrtc] tuned senders for \(key) longEdge=\(longEdge) → \(targetBitrate/1_000_000)Mbps @ \(targetFps)fps (WAN UI baseline)")
    }

    // MARK: - PC lifecycle

    private func ensurePC(for viewerId: String) -> RTCPeerConnection {
        if let existing = pcs[viewerId] { return existing }

        guard let pc = factory.peerConnection(with: config, constraints: constraints, delegate: self) else {
            fatalError("Failed to create RTCPeerConnection")
        }

        pcs[viewerId] = pc
        viewerIdByPC[ObjectIdentifier(pc)] = viewerId

        print("✅ [agent] created PC for viewerId=\(viewerId)")
        print("[agent][stats] starting outbound stats viewer=\(viewerId)")
        startOutboundStats(viewerId: viewerId, pc: pc)

        // IMPORTANT:
        // Do NOT addTrack/addTransceiver here (before setRemoteDescription).
        // That creates a second sender with blank mid in UnifiedPlan.
        return pc
    }

    private func close(viewerId: String) {
        if let t = statsTimers.removeValue(forKey: viewerId) { t.cancel() }

        if let pc = pcs.removeValue(forKey: viewerId) {
            viewerIdByPC.removeValue(forKey: ObjectIdentifier(pc))
            pc.close()
            print("🧹 [agent] closed PC for viewerId=\(viewerId)")
        }
        pendingCandidates.removeValue(forKey: viewerId)
        if let dc = dataChannels.removeValue(forKey: viewerId) {
            dc.delegate = nil
            dc.close()
        }
    }

    // MARK: - Offer / Answer

    func handleOffer(viewerId: String, sdp: String) {
        print("➡️ [agent] \(buildTag) handleOffer viewerId=\(viewerId)")
        
        // If the viewer refreshes, treat it as a brand new session
        if pcs[viewerId] != nil {
            print("[webrtc] viewerId=\(viewerId) re-offer detected → recreating PC")
            removeViewer(viewerId)
        }
        
        let pc = ensurePC(for: viewerId)

        // Useful: log what the viewer actually offered.
        dumpVideoSection(from: sdp, header: "OFFER")

        let offer = RTCSessionDescription(type: .offer, sdp: sdp)
        pc.setRemoteDescription(offer) { [weak self] err in
            guard let self else { return }

            if let err {
                print("❌ [agent] setRemote(offer) failed viewerId=\(viewerId): \(err.localizedDescription)")
                return
            }

            // ✅ KEY FIX:
            // Bind the local video track using the supported API *after* setRemoteDescription,
            // which allows WebRTC to correctly attach to the already-offered m=video (recvonly) line.
            self.ensureVideoSenderBound(pc: pc, viewerId: viewerId)

            let answerConstraints = RTCMediaConstraints(
                mandatoryConstraints: [
                    "OfferToReceiveVideo": "true",
                    "OfferToReceiveAudio": "false"
                ],
                optionalConstraints: nil
            )

            pc.answer(for: answerConstraints) { [weak self] answer, err in
                guard let self else { return }

                if let err {
                    print("❌ [agent] createAnswer failed viewerId=\(viewerId): \(err.localizedDescription)")
                    return
                }
                guard let answer else {
                    print("❌ [agent] createAnswer returned nil viewerId=\(viewerId)")
                    return
                }

                // Fallback only: if answer video section comes out inactive for some reason, patch it.
                let patched = self.patchAnswerToSendOnlyIfNeeded(answerSdp: answer.sdp)
                let preferred = self.preferH264InSdp(patched)
                let finalAnswer = RTCSessionDescription(type: .answer, sdp: preferred)

                pc.setLocalDescription(finalAnswer) { [weak self] err in
                    guard let self else { return }

                    if let err {
                        print("❌ [agent] setLocal(answer) failed viewerId=\(viewerId): \(err.localizedDescription)")
                        return
                    }

                    print("[agent] sending answer viewerId=\(viewerId) sdpLen=\(finalAnswer.sdp.count)")
                    dumpVideoSection(from: finalAnswer.sdp, header: "ANSWER")
                    logTransceivers(pc)

                    // Flush queued ICE
                    if let queued = self.pendingCandidates.removeValue(forKey: viewerId) {
                        for c in queued {
                            pc.add(c) { e in
                                if let e {
                                    print("❌ [agent] addIce(queued) failed viewerId=\(viewerId): \(e.localizedDescription)")
                                }
                            }
                        }
                    }

                    self.onAnswer?(viewerId, finalAnswer)
                }
            }
        }
    }

    // MARK: - ICE

    func addIce(viewerId: String, cand: [String: Any]) {
        let pc = ensurePC(for: viewerId)

        guard let sdp = cand["candidate"] as? String else {
            print("❌ [agent] ICE missing candidate string: \(cand)")
            return
        }

        let sdpMid = cand["sdpMid"] as? String

        guard let idxAny = cand["sdpMLineIndex"] else {
            print("❌ [agent] ICE missing sdpMLineIndex: \(cand)")
            return
        }

        let idx: Int32
        if let i32 = idxAny as? Int32 { idx = i32 }
        else if let i = idxAny as? Int { idx = Int32(i) }
        else if let d = idxAny as? Double { idx = Int32(d) }
        else {
            print("❌ [agent] ICE bad sdpMLineIndex: \(idxAny) cand=\(cand)")
            return
        }

        let candidate = RTCIceCandidate(sdp: sdp, sdpMLineIndex: idx, sdpMid: sdpMid)

        if pc.remoteDescription == nil {
            pendingCandidates[viewerId, default: []].append(candidate)
            return
        }

        pc.add(candidate) { err in
            if let err {
                print("❌ [agent] pc.addIce failed viewerId=\(viewerId): \(err.localizedDescription)")
            }
        }
    }

    // MARK: - Track binding (the actual fix)

    private func ensureVideoSenderBound(pc: RTCPeerConnection, viewerId: String) {
        let hasVideoSender = pc.senders.contains { s in
            (s.track as? RTCVideoTrack) != nil
        }
        if hasVideoSender {
            print("[agent] video sender already bound (skip) viewerId=\(viewerId)")
            return
        }

        if let sender = pc.add(localVideoTrack, streamIds: ["stream"]) {
            // Pick a sane baseline bitrate for screen content based on the capture resolution.
            let base = defaultBaselineMaxBitrateBps()
            tuneVideoSender(sender, viewerId: viewerId, maxBitrateBps: base, maxFramerate: 24)
        }

        print("✅ [agent] bound local video using pc.add(track, streamIds:[\"stream\"]) viewerId=\(viewerId)")
    }

    // MARK: - SDP patch (fallback only)

    private func patchAnswerToSendOnlyIfNeeded(answerSdp: String) -> String {
        let normalized = answerSdp.replacingOccurrences(of: "\r\n", with: "\n")
        let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)

        var out: [String] = []
        var inVideo = false
        var changed = false

        for line in lines {
            if line.hasPrefix("m=") {
                inVideo = line.hasPrefix("m=video")
                out.append(line)
                continue
            }

            if inVideo && line == "a=inactive" {
                out.append("a=sendonly")
                changed = true
                continue
            }

            out.append(line)
        }

        if changed {
            print("🩹 [agent] patched answer SDP: video a=inactive -> a=sendonly")
        }

        return out.joined(separator: "\r\n")
    }

    /// Prefer H264 in the SDP video m-line (better cross-browser support and typically better hardware paths).
    private func preferH264InSdp(_ sdp: String) -> String {
        let normalized = sdp.replacingOccurrences(of: "\r\n", with: "\n")
        let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)

        var h264Pts = Set<String>()
        for line in lines {
            if line.hasPrefix("a=rtpmap:") && line.uppercased().contains(" H264/") {
                let rest = line.dropFirst("a=rtpmap:".count)
                let pt = rest.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init)
                if let pt { h264Pts.insert(pt) }
            }
        }
        if h264Pts.isEmpty { return sdp }

        var out: [String] = []
        var inVideo = false

        for line in lines {
            if line.hasPrefix("m=") {
                inVideo = line.hasPrefix("m=video")
                if inVideo {
                    let parts = line.split(separator: " ")
                    if parts.count >= 4 {
                        let header = parts.prefix(3).map(String.init)
                        let pts = parts.dropFirst(3).map(String.init)

                        let h264First = pts.filter { h264Pts.contains($0) }
                        let restPts = pts.filter { !h264Pts.contains($0) }

                        out.append((header + h264First + restPts).joined(separator: " "))
                        continue
                    }
                }
            }
            out.append(line)
        }

        return out.joined(separator: "\r\n")
    }

    // MARK: - Stats + Adaptation

    private func startOutboundStats(viewerId: String, pc: RTCPeerConnection) {
        if let old = statsTimers[viewerId] { old.cancel() }

        if tuneByViewer[viewerId] == nil {
            let base = defaultBaselineMaxBitrateBps()
            tuneByViewer[viewerId] = VideoTuneState(maxBitrateBps: base, maxFramerate: 24, baselineMaxBitrateBps: base, baselineMaxFramerate: 24)
        }

        let q = DispatchQueue(label: "webrtc.stats.\(viewerId)")
        let t = DispatchSource.makeTimerSource(queue: q)
        t.schedule(deadline: .now() + 1.0, repeating: 1.0)

        t.setEventHandler { [weak self] in
            guard let self else { return }

            pc.statistics { report in
                var outBytes: Int64?
                var outPackets: Int64?
                var outLost: Int64?
                var framesEncoded: Int64?
                var rttSec: Double?

                for (_, stat) in report.statistics {
                    if stat.type == "outbound-rtp" {
                        let mediaType = (stat.values["mediaType"] as? String)
                            ?? (stat.values["kind"] as? String)
                            ?? ""
                        if !mediaType.isEmpty && mediaType != "video" { continue }

                        outBytes = self.numI64(stat.values["bytesSent"])
                        outPackets = self.numI64(stat.values["packetsSent"])
                        outLost = self.numI64(stat.values["packetsLost"])
                        framesEncoded = self.numI64(stat.values["framesEncoded"])
                    }

                    if stat.type == "candidate-pair" {
                        let selected = (stat.values["selected"] as? Bool)
                            ?? ((stat.values["selected"] as? String) == "true")
                        guard selected else { continue }

                        if let v = stat.values["currentRoundTripTime"] {
                            rttSec = self.numDouble(v)
                        } else if let v = stat.values["roundTripTime"] {
                            rttSec = self.numDouble(v)
                        }
                    }
                }

                guard let bytes = outBytes else {
                    var types = Set<String>()
                    for (_, s) in report.statistics {
                        let mt = (s.values["mediaType"] as? String) ?? (s.values["kind"] as? String) ?? ""
                        types.insert("\(s.type):\(mt)")
                    }
                    print("[agent][stats] viewer=\(viewerId) no outbound-rtp yet. types=\(Array(types).sorted().prefix(12))")
                    return
                }

                var state = self.tuneByViewer[viewerId] ?? {
                    let base = self.defaultBaselineMaxBitrateBps()
                    return VideoTuneState(maxBitrateBps: base, maxFramerate: 24, baselineMaxBitrateBps: base, baselineMaxFramerate: 24)
                }()
                let dBytes = max<Int64>(0, bytes - state.lastBytesSent)
                let bitrateBps = Double(dBytes) * 8.0
                state.lastBytesSent = bytes

                let pkts = outPackets ?? state.lastPacketsSent
                let lost = outLost ?? state.lastPacketsLost
                let dPkts = max<Int64>(0, pkts - state.lastPacketsSent)
                let dLost = max<Int64>(0, lost - state.lastPacketsLost)
                state.lastPacketsSent = pkts
                state.lastPacketsLost = lost

                let lossRate = (dPkts + dLost) > 0 ? Double(dLost) / Double(dPkts + dLost) : 0.0
                let now = CACurrentMediaTime()

                let rttMs = (rttSec ?? 0) * 1000.0
                let isBad = (rttMs > 300.0) || (lossRate > 0.05)

                if isBad {
                    state.lastBadTs = now
                } else {
                    state.lastGoodTs = now
                }

                // Adaptation policy:
                // - Never permanently clamp the sender to a low Mbps ceiling (that causes “stuck blurry” UI).
                // - Use baselineMaxBitrateBps as the recovery target.
                // - On genuinely bad network (high RTT/loss), step down conservatively and recover quickly.

                let baseBitrate = max(3_500_000, state.baselineMaxBitrateBps)
                let minBitrate = max(3_500_000, Int(Double(baseBitrate) * 0.60)) // don’t go below 60% of baseline
                let maxBitrate = baseBitrate

                if isBad {
                    // Only react if we are in sustained “bad” (avoid flapping)
                    if now - state.lastBadTs < 3.0 {
                        // grace window (do nothing)
                    } else {
                        // Prefer dropping framerate a bit first; only then drop bitrate.
                        if state.maxFramerate > 24 {
                            state.maxFramerate = 24
                            self.applyTune(viewerId: viewerId, pc: pc, maxBitrateBps: state.maxBitrateBps, maxFramerate: state.maxFramerate)
                            print("[agent][adapt] viewer=\(viewerId) BAD → fps 24")
                        } else if state.maxBitrateBps > minBitrate {
                            // step down 10% at a time
                            state.maxBitrateBps = max(minBitrate, Int(Double(state.maxBitrateBps) * 0.90))
                            self.applyTune(viewerId: viewerId, pc: pc, maxBitrateBps: state.maxBitrateBps, maxFramerate: state.maxFramerate)
                            print(String(format: "[agent][adapt] viewer=%@ BAD → cap %.2fMbps", viewerId, Double(state.maxBitrateBps)/1_000_000.0))
                        }
                    }
                } else {
                    // Good network: recover quickly toward baseline
                    let goodFor = now - state.lastGoodTs
                    if goodFor > 1.5 {
                        if state.maxFramerate < state.baselineMaxFramerate {
                            state.maxFramerate = state.baselineMaxFramerate
                            self.applyTune(viewerId: viewerId, pc: pc, maxBitrateBps: state.maxBitrateBps, maxFramerate: state.maxFramerate)
                            print("[agent][adapt] viewer=\(viewerId) GOOD → fps \(state.maxFramerate)")
                        } else if state.maxBitrateBps < maxBitrate {
                            // ramp up 15% at a time
                            state.maxBitrateBps = min(maxBitrate, Int(Double(state.maxBitrateBps) * 1.15) + 250_000)
                            self.applyTune(viewerId: viewerId, pc: pc, maxBitrateBps: state.maxBitrateBps, maxFramerate: state.maxFramerate)
                            print(String(format: "[agent][adapt] viewer=%@ GOOD → cap %.2fMbps", viewerId, Double(state.maxBitrateBps)/1_000_000.0))
                        }
                    }
                }

                self.tuneByViewer[viewerId] = state

                let fe = framesEncoded ?? -1
//                print(String(format: "[agent][outbound] viewer=%@ bitrate=%.2fMbps loss=%.2f%% rtt=%.0fms framesEncoded=%lld cap=%.2fMbps fps=%d",
//                             viewerId, bitrateBps/1_000_000.0, lossRate*100.0, rttMs, fe,
//                             Double(state.maxBitrateBps)/1_000_000.0, state.maxFramerate))
            }
        }

        t.resume()
        statsTimers[viewerId] = t
        print("[agent][stats] started outbound stats timer viewer=\(viewerId)")
    }


    /// Called whenever the viewer count changes (e.g., a viewer disconnects).
    /// We retune all remaining senders back toward the single-viewer (Mode A) baseline.
    private func retuneForViewerCountChange() {
        let viewerCount = pcs.count
        let baseBitrate = defaultBaselineMaxBitrateBps()
        let baseFps = 24

        print("[webrtc] viewerCount changed → \(viewerCount). Retuning remaining senders to baseline \(baseBitrate) @ \(baseFps)fps")

        for (viewerId, pc) in pcs {
            var state = tuneByViewer[viewerId] ?? VideoTuneState(
                maxBitrateBps: baseBitrate,
                maxFramerate: baseFps,
                baselineMaxBitrateBps: baseBitrate,
                baselineMaxFramerate: baseFps
            )

            state.baselineMaxBitrateBps = baseBitrate
            state.baselineMaxFramerate = baseFps
            state.maxBitrateBps = baseBitrate
            state.maxFramerate = baseFps
            tuneByViewer[viewerId] = state

            applyTune(viewerId: viewerId,
                      pc: pc,
                      maxBitrateBps: state.maxBitrateBps,
                      maxFramerate: state.maxFramerate)
        }
    }

    private func applyTune(viewerId: String, pc: RTCPeerConnection, maxBitrateBps: Int, maxFramerate: Int) {
        for sender in pc.senders where sender.track?.kind == "video" {
            tuneVideoSender(sender, viewerId: viewerId, maxBitrateBps: maxBitrateBps, maxFramerate: maxFramerate)
        }
    }

    private func numI64(_ v: Any?) -> Int64 {
        if let n = v as? NSNumber { return n.int64Value }
        if let i = v as? Int { return Int64(i) }
        if let d = v as? Double { return Int64(d) }
        if let s = v as? String, let i = Int64(s) { return i }
        return 0
    }

    private func numDouble(_ v: Any?) -> Double {
        if let n = v as? NSNumber { return n.doubleValue }
        if let d = v as? Double { return d }
        if let i = v as? Int { return Double(i) }
        if let s = v as? String, let d = Double(s) { return d }
        return 0
    }

    private func numString(_ v: Any?) -> String {
        if let n = v as? NSNumber { return n.stringValue }
        if let i = v as? Int { return String(i) }
        if let d = v as? Double { return String(Int(d)) }
        if let s = v as? String { return s }
        return "-"
    }

    // MARK: - Debug logs

    private func dumpVideoSection(from sdp: String, header: String) {
        print("=== [agent] \(header) video m-section dump ===")

        let lines = sdp
            .replacingOccurrences(of: "\r\n", with: "\n")
            .split(separator: "\n")
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }

        var inVideo = false
        var printed = 0

        for line in lines {
            if line.hasPrefix("m=") {
                inVideo = line.hasPrefix("m=video")
            }
            if inVideo {
                if line.hasPrefix("m=video")
                    || line == "a=sendonly"
                    || line == "a=sendrecv"
                    || line == "a=recvonly"
                    || line == "a=inactive"
                    || line.hasPrefix("a=mid:")
                    || line.hasPrefix("a=msid:")
                    || line.hasPrefix("a=rtpmap:")
                    || line.hasPrefix("a=fmtp:")
                    || line.hasPrefix("a=ssrc:")
                    || line.hasPrefix("a=ssrc-group:")
                {
                    print(line)
                    printed += 1
                    if printed >= 80 { break }
                }
            }
        }

        if printed == 0 {
            print("(no video lines printed — SDP may be empty)")
        }
    }

    private func logTransceivers(_ pc: RTCPeerConnection) {
        print("=== [agent] transceivers after setLocal === count=\(pc.transceivers.count)")
        for t in pc.transceivers {
            let mid = t.mid ?? "nil"
            let hasSenderTrack = (t.sender.track != nil)
            let kind = (t.sender.track as? RTCMediaStreamTrack)?.kind ?? "nil"
            print("mid=\(mid) senderTrack=\(hasSenderTrack) kind=\(kind)")
        }
    }

    
    private func tuneVideoSender(_ sender: RTCRtpSender,
                                 viewerId: String,
                                 maxBitrateBps: Int = 3_500_000,
                                 maxFramerate: Int = 30) {
        var params = sender.parameters
        guard var enc = params.encodings.first else {
            print("[webrtc] no encodings found")
            return
        }

        enc.maxBitrateBps = NSNumber(value: maxBitrateBps)
        enc.maxFramerate = NSNumber(value: maxFramerate)

        var newParams = params
        newParams.encodings = [enc]

        // Degradation preference:
        // - During active interaction (scroll/drag), prefer maintaining framerate so motion feels smooth.
        // - When idle, prefer maintaining resolution so text snaps back to sharp.
        if interactionActive {
            newParams.degradationPreference = NSNumber(value: 1) // maintainFramerate
        } else {
            newParams.degradationPreference = NSNumber(value: 2) // maintainResolution
        }

        sender.parameters = newParams

        if tuneByViewer[viewerId] == nil {
            tuneByViewer[viewerId] = VideoTuneState(
                maxBitrateBps: maxBitrateBps,
                maxFramerate: maxFramerate,
                baselineMaxBitrateBps: maxBitrateBps,
                baselineMaxFramerate: maxFramerate
            )
        } else {
            tuneByViewer[viewerId]?.maxBitrateBps = maxBitrateBps
            tuneByViewer[viewerId]?.maxFramerate = maxFramerate
            tuneByViewer[viewerId]?.baselineMaxBitrateBps = maxBitrateBps
            tuneByViewer[viewerId]?.baselineMaxFramerate = maxFramerate
        }

        print("[webrtc] sender tuned viewer=\(viewerId) maxBitrate=\(maxBitrateBps) fps=\(maxFramerate) interaction=\(interactionActive ? "on" : "off")")
    }

    // MARK: - RTCPeerConnectionDelegate

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {
        print("📶 signaling:", stateChanged.rawValue)
    }

    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {
        print("🔁 peerConnectionShouldNegotiate")
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        print("🧊 iceConn:", newState.rawValue)
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        print("🧊 iceGather:", newState.rawValue)
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        guard let viewerId = viewerIdByPC[ObjectIdentifier(peerConnection)] else {
            print("🧊 [agent] didGenerate ICE but no viewerId mapping yet")
            return
        }
        onLocalIce?(viewerId, candidate)
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        guard let viewerId = viewerIdByPC[ObjectIdentifier(peerConnection)] else {
            print("📡 [agent] didOpen dataChannel but no viewerId mapping yet")
            return
        }
        print("📡 [agent] dataChannel opened viewerId=\(viewerId) label=\(dataChannel.label)")
        dataChannel.delegate = self
        dataChannels[viewerId] = dataChannel
    }

    // Deprecated (Plan-B)
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}

    

// MARK: - RTCDataChannelDelegate (control path)
func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
    print("📡 [agent] dc state label=\(dataChannel.label) state=\(dataChannel.readyState.rawValue)")
}

func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
    guard let text = String(data: buffer.data, encoding: .utf8) else { return }
    if let (viewerId, _) = dataChannels.first(where: { $0.value === dataChannel }) {
        onControlMessage?(viewerId, text)
    } else {
        print("📡 [agent] dc message (unmapped viewer) len=\(text.count)")
    }
}
// Unified Plan: ontrack is handled in browser; agent is send-only.
    func peerConnection(_ peerConnection: RTCPeerConnection,
                        didAdd rtpReceiver: RTCRtpReceiver,
                        streams: [RTCMediaStream]) {}
}




