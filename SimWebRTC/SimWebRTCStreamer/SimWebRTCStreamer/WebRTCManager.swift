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
        var lastGoodTs: TimeInterval = 0
        var lastBadTs: TimeInterval = 0
        var lastBytesSent: Int64 = 0
        var lastPacketsSent: Int64 = 0
        var lastPacketsLost: Int64 = 0
    }
    private var tuneByViewer: [String: VideoTuneState] = [:]

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

    // MARK: - Public API expected by ContentView.swift

    func viewerCount() -> Int { pcs.count }

    func removeViewer(_ viewerId: String) {
        close(viewerId: viewerId)
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
            targetBitrate = 6_500_000
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
            tuneVideoSender(sender, viewerId: viewerId)
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
            tuneByViewer[viewerId] = VideoTuneState(maxBitrateBps: 3_500_000, maxFramerate: 30)
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

                var state = self.tuneByViewer[viewerId] ?? VideoTuneState(maxBitrateBps: 3_500_000, maxFramerate: 30)
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
                let isBad = (rttMs > 250.0) || (lossRate > 0.02) || (bitrateBps < Double(state.maxBitrateBps) * 0.55)

                if isBad {
                    state.lastBadTs = now
                } else {
                    state.lastGoodTs = now
                }

                if now - state.lastBadTs < 3.0 {
                    // grace window
                } else if isBad {
                    if state.maxFramerate > 20 {
                        state.maxFramerate = 20
                        self.applyTune(viewerId: viewerId, pc: pc, maxBitrateBps: state.maxBitrateBps, maxFramerate: state.maxFramerate)
                        print("[agent][adapt] viewer=\(viewerId) BAD → fps 20 (keep res for readability)")
                    } else if state.maxBitrateBps > 2_500_000 {
                        state.maxBitrateBps = 2_500_000
                        self.applyTune(viewerId: viewerId, pc: pc, maxBitrateBps: state.maxBitrateBps, maxFramerate: state.maxFramerate)
                        print("[agent][adapt] viewer=\(viewerId) BAD → cap 2.5Mbps")
                    } else if state.maxBitrateBps > 2_000_000 {
                        state.maxBitrateBps = 2_000_000
                        self.applyTune(viewerId: viewerId, pc: pc, maxBitrateBps: state.maxBitrateBps, maxFramerate: state.maxFramerate)
                        print("[agent][adapt] viewer=\(viewerId) BAD → cap 2.0Mbps")
                    }
                } else {
                    let goodFor = now - state.lastGoodTs
                    if goodFor > 10.0 {
                        if state.maxFramerate < 30 {
                            state.maxFramerate = 30
                            self.applyTune(viewerId: viewerId, pc: pc, maxBitrateBps: state.maxBitrateBps, maxFramerate: state.maxFramerate)
                            print("[agent][adapt] viewer=\(viewerId) GOOD → fps 30")
                        } else if state.maxBitrateBps < 3_500_000 {
                            state.maxBitrateBps = 3_500_000
                            self.applyTune(viewerId: viewerId, pc: pc, maxBitrateBps: state.maxBitrateBps, maxFramerate: state.maxFramerate)
                            print("[agent][adapt] viewer=\(viewerId) GOOD → cap 3.5Mbps")
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
        let params = sender.parameters
        guard var enc = params.encodings.first else {
            print("[webrtc] no encodings found")
            return
        }

        enc.maxBitrateBps = NSNumber(value: maxBitrateBps)
        enc.maxFramerate = NSNumber(value: maxFramerate)

        var newParams = params
        newParams.encodings = [enc]
        newParams.degradationPreference = NSNumber(value: 2) // maintainResolution (drop FPS before res)


        sender.parameters = newParams

        if tuneByViewer[viewerId] == nil {
            tuneByViewer[viewerId] = VideoTuneState(maxBitrateBps: maxBitrateBps, maxFramerate: maxFramerate)
        } else {
            tuneByViewer[viewerId]?.maxBitrateBps = maxBitrateBps
            tuneByViewer[viewerId]?.maxFramerate = maxFramerate
        }

        print("[webrtc] sender tuned viewer=\(viewerId) maxBitrate=\(maxBitrateBps) fps=\(maxFramerate) degradation=maintainResolution")
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


