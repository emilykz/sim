/**
 
 SimTcpStreamer.swift — I420 over TCP + control channel + CGEvent injection (verbose)
  
 This class is the engine that your Mac app uses to:

    Connect to Node over TCP (video + control).
    Use ScreenCaptureKit to capture the iOS Simulator window.
    Convert frames to I420 format (what Node expects).
    Pack each frame into a small binary protocol and send it over TCP:9001.
    Listen on TCP:9002 for JSON control messages:
        { type: "stream", action: "start" | "stop" }
        (later: pointer, key, text)
    Start/stop capture based on those control messages.

 Think of it as:
    “A headless agent that watches the sim/em windows and pushes video frames and listens for remote commands.”
 
 General Terminology:
    *CVPixelBuffer – A Core Video buffer, basically “a frame of pixels”.
 
    ScreenCaptureKit may give you NV12 or BGRA.
        You normalize everything to I420, then send that to Node.
 
    Many macOS/iOS frameworks (ScreenCaptureKit included) are written in Objective-C under the hood.
    NSObject is the root Obj-C class.
    You inherit from NSObject when:
     ✔ You need Objective-C compatibility (delegates, selectors, KVO)
     ✔ You want lifecycle integration
     ✔ You use Apple APIs expecting Obj-C types
     ✔ You need your class to work with NS-based APIs (like runloops)
        
    Specific to ScreenCaptureKit:
        SCStream, SCContentFilter, SCStreamOutput all expect objects that inherit from NSObject.
        
    Responsibility    Protocol
        Receive frame data    SCStreamOutput
        Receive lifecycle events    SCStreamDelegate
 
    SimTcpStreamer implements both because it needs:
        Frames for streaming (output)
        Error handling (delegate)
 
    Apple and WebRTC both strongly recommend using dedicated queues for media pipelines.
 
    guard is a control statement used to:
        check a condition early, and
        exit the function early if the condition is not met.
 
    Your control TCP stream (ctlBuffer) is just a continuous stream of bytes.
    You need to carve it into individual messages.
        Your protocol for each message is:
            First 4 bytes: a UInt32 length, big-endian (len)
            Next len bytes: the message payload

        So the byte layout is:
             [0..3]    → 4-byte big-endian length (UInt32)
             [4..4+len) → message bytes
             [then repeats] → next length + message, etc.
 
    NSRunningApplication -> Represents a running process on macOS, such as:
        iOS Simulator
         Finder
         Safari
         Terminal
        
     SCShareableContent?
        It’s a ScreenCaptureKit structure that lists:
            All shareable windows
            All shareable applications
            All shareable displays
        
    Data – A Swift container for raw bytes (like Uint8Array / Buffer).
 */

import Foundation
import ScreenCaptureKit
import AppKit
import Network
import VideoToolbox


//Private helpers: Convert integers to big-endian byte arrays. Used when building your TCP packet headers.
fileprivate func be16(_ v: UInt16) -> [UInt8] { withUnsafeBytes(of: v.bigEndian, Array.init) }
fileprivate func be32(_ v: UInt32) -> [UInt8] { withUnsafeBytes(of: v.bigEndian, Array.init) }
fileprivate func be64(_ v: UInt64) -> [UInt8] { withUnsafeBytes(of: v.bigEndian, Array.init) }

//Clamp an Int into the 0–255 range and return as UInt8. Used in color conversion.
@inline(__always) private func clamp8(_ x: Int) -> UInt8 { x < 0 ? 0 : (x > 255 ? 255 : UInt8(x)) }

//Pads a string with spaces up to length n
private func pad(_ s: String, _ n: Int) -> String { s.count >= n ? s : s + String(repeating: " ", count: n - s.count) }


// ---- BGRA → I420 (fallback) ----
/**
 I420: A YUV pixel format: all Y (luma) first, then U and V chroma planes.
 
 Parameters:
 UnsafePointer<UInt8> – A raw pointer to bytes in memory (like C pointer uint8_t*).

 Data – A Swift container for raw bytes (like Uin-P=t8Array / Buffer).
 
 Logic:
     Checks the width/height are even (precondition(w % 2 == 0 && h % 2 == 0)).
     Allocates three planes: Y, U, V.
     Loops through BGRA pixels, converts to YUV.
     Packs them into Data as [Y-plane][U-plane][V-plane].
     Returns that Data, which is the I420 frame.
 */
private func bgraToI420(width w: Int, height h: Int, src: UnsafePointer<UInt8>, srcStride: Int) -> Data {
    precondition(w % 2 == 0 && h % 2 == 0, "I420 requires even dimensions")
    let ySize = w * h, cW = w >> 1, cH = h >> 1, cSize = cW * cH
    var Y = Data(count: ySize), U = Data(count: cSize), V = Data(count: cSize)

    Y.withUnsafeMutableBytes { yRaw in
        U.withUnsafeMutableBytes { uRaw in
            V.withUnsafeMutableBytes { vRaw in
                let yPtr = yRaw.baseAddress!.assumingMemoryBound(to: UInt8.self)
                let uPtr = uRaw.baseAddress!.assumingMemoryBound(to: UInt8.self)
                let vPtr = vRaw.baseAddress!.assumingMemoryBound(to: UInt8.self)

                var yOut = yPtr
                for row in 0..<h {
                    let sRow = src.advanced(by: row * srcStride)
                    for col in 0..<w {
                        let p = sRow.advanced(by: col * 4)
                        let b = Int(p[0]), g = Int(p[1]), r = Int(p[2])
                        let yv = ((66*r + 129*g + 25*b + 128) >> 8) + 16
                        yOut.pointee = clamp8(yv)
                        yOut = yOut.advanced(by: 1)
                    }
                }

                var ui = 0, vi = 0
                for j in 0..<(h >> 1) {
                    let y0 = 2*j, y1 = y0+1
                    let row0 = src.advanced(by: y0 * srcStride)
                    let row1 = src.advanced(by: y1 * srcStride)
                    for i in 0..<(w >> 1) {
                        let x0 = 2*i, x1 = x0+1
                        let o00 = x0*4, o01 = x1*4
                        let b00 = Int(row0[o00+0]), g00 = Int(row0[o00+1]), r00 = Int(row0[o00+2])
                        let b01 = Int(row0[o01+0]), g01 = Int(row0[o01+1]), r01 = Int(row0[o01+2])
                        let b10 = Int(row1[o00+0]), g10 = Int(row1[o00+1]), r10 = Int(row1[o00+2])
                        let b11 = Int(row1[o01+0]), g11 = Int(row1[o01+1]), r11 = Int(row1[o01+2])
                        let r = (r00 + r01 + r10 + r11) >> 2
                        let g = (g00 + g01 + g10 + g11) >> 2
                        let b = (b00 + b01 + b10 + b11) >> 2
                        let uu = ((-38*r - 74*g + 112*b + 128) >> 8) + 128
                        let vv = ((112*r - 94*g - 18*b + 128) >> 8) + 128
                        uPtr[ui] = clamp8(uu); vPtr[vi] = clamp8(vv)
                        ui &+= 1; vi &+= 1
                    }
                }
            }
        }
    }

    var out = Data(capacity: Y.count + U.count + V.count)
    out.append(Y); out.append(U); out.append(V)
    return out
}

// ---- NV12 → I420 (fast path) ----
/**
 NV12 – A YUV format with:
    plane 0: full Y
    plane 1: interleaved U/V.
 
 Logic:
    Gets width/height.
    Ensures 2 planes and even dims.
    Locks the pixel buffer (CVPixelBufferLockBaseAddress – like mapping GPU/CPU memory).

    Copies:
    Plane 0 → Y plane.
    Plane 1 (UV interleaved) → splits into U and V planes.
 */
private func nv12ToI420(px: CVPixelBuffer) -> (data: Data, w: Int, h: Int)? {
    let w = CVPixelBufferGetWidth(px), h = CVPixelBufferGetHeight(px)
    guard (w & 1) == 0, (h & 1) == 0, CVPixelBufferGetPlaneCount(px) == 2 else { return nil }

    CVPixelBufferLockBaseAddress(px, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(px, .readOnly) }

    let yBase = CVPixelBufferGetBaseAddressOfPlane(px, 0)!.assumingMemoryBound(to: UInt8.self)
    let yStride = CVPixelBufferGetBytesPerRowOfPlane(px, 0)
    let uvBase = CVPixelBufferGetBaseAddressOfPlane(px, 1)!.assumingMemoryBound(to: UInt8.self)
    let uvStride = CVPixelBufferGetBytesPerRowOfPlane(px, 1)

    let ySize = w * h, cW = w >> 1, cH = h >> 1, cSize = cW * cH
    var Y = Data(count: ySize), U = Data(count: cSize), V = Data(count: cSize)

    Y.withUnsafeMutableBytes { yRaw in
        U.withUnsafeMutableBytes { uRaw in
            V.withUnsafeMutableBytes { vRaw in
                let yDst = yRaw.baseAddress!.assumingMemoryBound(to: UInt8.self)
                let uDst = uRaw.baseAddress!.assumingMemoryBound(to: UInt8.self)
                let vDst = vRaw.baseAddress!.assumingMemoryBound(to: UInt8.self)

                for row in 0..<h {
                    let src = yBase.advanced(by: row * yStride)
                    let dst = yDst.advanced(by: row * w)
                    dst.assign(from: src, count: w)
                }

                var ui = 0, vi = 0
                for row in 0..<(h >> 1) {
                    let uvRow = uvBase.advanced(by: row * uvStride)
                    var p = uvRow
                    for _ in 0..<(w >> 1) {
                        uDst[ui] = p.pointee; p = p.advanced(by: 1)
                        vDst[vi] = p.pointee; p = p.advanced(by: 1)
                        ui &+= 1; vi &+= 1
                    }
                }
            }
        }
    }

    var out = Data(capacity: Y.count + U.count + V.count)
    out.append(Y); out.append(U); out.append(V)
    return (out, w, h)
}


//CLASS
/**
 Declares a class that:
     ✔ cannot be subclassed (final)
     ✔ is a reference type (class)
     ✔ is Objective-C compatible (NSObject)
     ✔ receives video frames (SCStreamOutput)
     ✔ receives stream lifecycle events (SCStreamDelegate)
 */
final class SimTcpStreamer: NSObject, SCStreamOutput, SCStreamDelegate {
    
    enum Platform: String, Codable {
            case simulator
            case emulator
        }
    
    //Simple struct grouping your startup settings (host/port/deviceId/fps).
    struct Config: Codable {
        let host: String
        let port: UInt16
        let deviceId: String
        let fps: Int
        let platform: Platform
        let windowMatch: String?
    }

    
    private var scStream: SCStream? //Optional ScreenCaptureKit stream
    private var conn: NWConnection? //The video TCP connection
    private var cfg: Config!

    // control connection
    private var ctlConn: NWConnection? //The control TCP connection.
    private var ctlBuffer = Data() //Buffer accumulating incoming control bytes

    //GCD queue for doing work off the main thread - a dedicated worker thread
    private let q = DispatchQueue(label: "simcast.tcp.stream")

    // frame pacing - Used to throttle frames (respect target FPS) and log counts
    private var lastSentNs: Int64 = 0
    private var frameIntervalNs: Int64 = 0
    private var sentCount = 0

    // CHANGE (PERF): dynamic quality knobs (can be updated at runtime via control channel)
    private var requestedFps: Int = 30
    private var requestedMaxWidth: Int = 540
    private var pendingReconfigure: DispatchWorkItem?

    // keep-alive - a GCD timer that fires periodically.
    // These help send repeated frames even if capture stalls (keep WebRTC alive)
    private var keepAliveTimer: DispatchSourceTimer?
    private var lastI420: Data?
    private var lastW = 0, lastH = 0

    // mapping for input (future)
    private var simWindowFrame: CGRect = .zero // in POINTS
    private var cropYPoints: CGFloat = 0       // in POINTS
    private var streamWidth: Int = 0           // in PIXELS (post-crop)
    private var streamHeight: Int = 0          // in PIXELS (post-crop)
    private var screenScale: CGFloat = 2.0

    // activation - track if Simulator was brought to front
    private var simulatorActivated = false

    // capture state - check if streaming is active
    private var isCapturing = false

    // MARK: - Public API
    // Connect + immediately start capture.
    func start(_ cfg: Config) async throws {
        try await connect(cfg)
        try await startCaptureInternal()
    }
   
    //Only connect to Node (TCP ingest + control). Capture will be started/stopped via control messages.
    func connect(_ cfg: Config) async throws {
        self.cfg = cfg //saves config
        // CHANGE (PERF): initialize quality knobs from config (server may later override via control)
        self.requestedFps = max(1, cfg.fps)
        self.requestedMaxWidth = 540

        self.frameIntervalNs = Int64(1_000_000_000 / max(1, self.requestedFps)) //target nanoseconds between frames
        self.sentCount = 0

        print("[connect] host=\(cfg.host):\(cfg.port) deviceId=\(cfg.deviceId) fps=\(cfg.fps)")
        try startTCP()
        try startControl()
    }
    //Gracefully shuts everything down
    func stop() {
        print("[stop] stopping capture + TCP")
        stopCaptureIfNeeded()
        keepAliveTimer?.cancel();
        keepAliveTimer = nil
        conn?.cancel();
        conn = nil
        ctlConn?.cancel();
        ctlConn = nil
        print("[stop] done")
    }

    // Start capture if not already capturing (called from control "stream/start")
    private func startCaptureIfNeeded() async {
        guard !isCapturing else { return }
        do {
            try await startCaptureInternal()
        } catch {
            print("[sc] startCapture error:", error.localizedDescription)
        }
    }

    // Stop capture but keep TCP connections alive (called from control "stream/stop")
    private func stopCaptureIfNeeded() {
        guard isCapturing else { return }
        print("[sc] stopping capture")
        keepAliveTimer?.cancel();
        keepAliveTimer = nil
        Task { try?
            await scStream?.stopCapture()
        } //Start a new async task
        scStream = nil
        isCapturing = false
    }

    // CHANGE (PERF): debounce capture restarts when quality changes.
    // We restart only when maxWidth changes (fps changes are handled by pacing).
    private func scheduleReconfigureCapture() {
        pendingReconfigure?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            guard self.isCapturing else { return }

            print("[sc] reconfigure capture (maxWidth=\(self.requestedMaxWidth), fps=\(self.requestedFps))")

            // Stop + start in order, ensuring ScreenCaptureKit resources are released.
            Task {
                do {
                    if let sc = self.scStream {
                        try await sc.stopCapture()
                    }
                } catch {
                    print("[sc] stopCapture during reconfigure error:", error.localizedDescription)
                }
                self.scStream = nil
                self.isCapturing = false
                try? await self.startCaptureInternal()
            }
        }
        pendingReconfigure = work
        q.asyncAfter(deadline: .now() + .milliseconds(250), execute: work)
    }

    // MARK: TCP video
    /**
     Turn cfg.host and cfg.port into a NWConnection target (throw if invalid port).
     Create a TCP client connection object and store it.
     Set up a callback (stateUpdateHandler) to:
        log connection state
        send a “hello” message when ready
        stop capture on failure or cancellation
     Set up another callback (viabilityUpdateHandler) to log network health.
     Start the connection on a dedicated serial queue so all TCP work is ordered and thread-safe.
     */
    private func startTCP() throws {
        
        //Build the host and port Network.framework types
        let host = NWEndpoint.Host(cfg.host)
        guard let port = NWEndpoint.Port(rawValue: cfg.port) else {
            throw NSError(domain: "SimTcpStreamer", code: -10, userInfo: [NSLocalizedDescriptionKey: "Invalid port"])
        }
        
        // CHANGE (PERF): disable Nagle for low-latency video
        let tcpOptions = NWProtocolTCP.Options()
        tcpOptions.noDelay = true
        let params = NWParameters(tls: nil, tcp: tcpOptions)
        let c = NWConnection(host: host, port: port, using: params);
        
        //Stores the connection to be used in other methods
        self.conn = c
        
        //Gets called when the connection state updates
        c.stateUpdateHandler = { [weak self] st in
            guard let self else { return }
            
            //st is of type NWConnection.State
            switch st {
            case .preparing:
                print("[tcp] state: preparing")
            case .ready:
                print("[tcp] state: ready — sending hello");
                self.sendHello()
            case .waiting(let e):
                print("[tcp] state: waiting (\(e.localizedDescription))")
            case .failed(let e):
                print("[tcp] state: failed (\(e.localizedDescription))")
                self.stopCaptureIfNeeded()
            case .setup:
                print("[tcp] state: setup")
            case .cancelled:
                print("[tcp] state: cancelled")
                self.stopCaptureIfNeeded()
            @unknown default: print("[tcp] state: unknown")
            }
        }
        
       // This closure is called when Network.framework decides whether this path is “viable”.
        c.viabilityUpdateHandler = {
            ok in print("[tcp] viability:", ok) }
        
        //Begin the actual TCP connection process and deliver all connection events (state changes, incoming data, viability updates) onto this queue q
        c.start(queue: q)
    }

    /**
        Constructs & Sends a "Hello" packet, detailing the device id - TCP handshake
        Format:
            4 bytes:  "SIMC"
            1 byte:   0x01                // version
            2 bytes:  0x00 0x05           // deviceId length = 5
            5 bytes:  "s" "i" "m" "-" "1" // deviceId bytes
     */
    private func sendHello() {
        guard let conn else { return }
        var bytes = [UInt8]() //build a binary packet in memory
        bytes += Array("SIMC".utf8) //MAGIC header...for determining this is SIMCast client
        bytes.append(1) //add protocol version byte
        let id = Array(cfg.deviceId.utf8) //convert the device id to bytes
        bytes += be16(UInt16(id.count)) // 2 bytes: deviceId length (big-endian)
        bytes += id //append the device id
        
        //Sends the bytes over the video TCP connection
        conn.send(content: Data(bytes), completion: .contentProcessed { err in
            if let err { print("[tcp] hello send error:", err.localizedDescription) }
            else { print("[tcp] hello sent for deviceId=\(self.cfg.deviceId)") }
        })
    }

    // MARK: Control TCP
    /**
     Turn cfg.host and cfg.port into a NWConnection target (throw if invalid port).
     Create a TCP client connection object and store it.
     Set up a callback (stateUpdateHandler) to:
        log connection state
        send a “hello” message when ready
        stop capture on failure or cancellation
     Set up another callback (viabilityUpdateHandler) to log network health.
     Start the connection on a dedicated serial queue so all TCP work is ordered and thread-safe.
     */
    private func startControl() throws {
        let host = NWEndpoint.Host(cfg.host)
        guard let port = NWEndpoint.Port(rawValue: 9002) else {
            throw NSError(domain: "SimTcpStreamer", code: -20, userInfo: [NSLocalizedDescriptionKey: "Invalid control port"])
        }
        // CHANGE (PERF): disable Nagle for low-latency control
        let tcpOptions = NWProtocolTCP.Options()
        tcpOptions.noDelay = true
        let params = NWParameters(tls: nil, tcp: tcpOptions)
        let c = NWConnection(host: host, port: port, using: params);
        self.ctlConn = c
        
        c.stateUpdateHandler = { [weak self] st in
            guard let self else { return }
            switch st {
            case .ready:
                print("[ctl] state: ready — sending hello")
                var bytes = [UInt8]()
                bytes += Array("SIMK".utf8)
                bytes.append(1)
                let id = Array(self.cfg.deviceId.utf8)
                bytes += be16(UInt16(id.count))
                bytes += id
                c.send(content: Data(bytes), completion: .contentProcessed { err in
                    if let err { print("[ctl] hello send error:", err.localizedDescription) }
                })
                // Start reading control messages
                self.readControl()
            case .waiting(let e): print("[ctl] state: waiting (\(e.localizedDescription))")
            case .failed(let e):  print("[ctl] state: failed (\(e.localizedDescription))")
            default: break
            }
        }
        c.start(queue: q)
    }

    /**
      minimumIncompleteLength: 1 -> Give me data as soon as there’s at least 1 byte.
      maximumLength: 4096 -> “At most, give me 4096 bytes in this read.”
     { [weak self] data, _, isComplete, error in ... } -> grts called when some data arrives, or the connection ends, or an error happens.
     */
    private func readControl() {
        guard let c = ctlConn else { return }
        
        //Receive – single asynchronous receive request to read some bytes from TCP.
        c.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let error = error {
                print("[ctl] receive error:", error.localizedDescription)
                return
            }
            // checks data is not null or empty  or remote peer closed connection
            guard let data = data, !data.isEmpty else {
                if isComplete { print("[ctl] closed by peer") }
                return
            }
            
            //Append incoming bytes to our control buffer
            self.ctlBuffer.append(data)
            
            //Process control buffer
            self.processControlBuffer()
            
            // Continue reading
            self.readControl()
        }
    }
    
    /**
     Implements length-prefixed messages:
        First 4 bytes = big-endian length.
        Next len bytes = JSON payload.
        It loops while there is at least 1 full message in the buffer.
     
        
     */
    private func processControlBuffer() {
        
        //While buffer contains more than 4 bytes, process
        while ctlBuffer.count >= 4 {
            
            //Get the length of the payload by reading the first 4 bytes and convert it to Int
            let len = ctlBuffer.prefix(4).withUnsafeBytes { ptr -> Int in
                let be = ptr.load(as: UInt32.self)
                return Int(UInt32(bigEndian: be))
            }
            
            //Checks if the buffer has complete message (4 bytes + (payload - (len) bytes)
            //If not complete message -> break/exit
            if ctlBuffer.count < 4 + len { break }
            
            //Get the complete payload message by gettting the data at index 4 to the end of the complete mess.
            let msgData = ctlBuffer.subdata(in: 4..<(4 + len))
            
            //Remove the processed bytes
            ctlBuffer.removeSubrange(0..<(4 + len))
            
            //Passes the complete payload message to be handed
            handleControlMessage(msgData)
        }
    }

    /**
        Processes the payload/message in bytes
            
     */
    private func handleControlMessage(_ data: Data) {
        
        //Parses the raw bytes as JSON to dictory [String: Any] and tries to extract the message type
        //Ignore message if these connditions are not valid
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else {
            print("[ctl] invalid JSON message")
            return
        }
        
        //Switch statement to handle the different message types:
        switch type {
        case "stream":
            //Checks if the action field is present. if not -> ignore
            guard let action = obj["action"] as? String else { return }
            if action == "start" {
                print("[ctl] stream start requested")
                Task { await self.startCaptureIfNeeded() }
            } else if action == "stop" {
                print("[ctl] stream stop requested")
                self.stopCaptureIfNeeded()
            }
        case "quality":
            // Expected payload: { type: "quality", fps: Int, maxWidth: Int }
            let newFps = max(1, (obj["fps"] as? Int) ?? self.requestedFps)
            let newMaxW = max(2, (obj["maxWidth"] as? Int) ?? self.requestedMaxWidth)

            // Update pacing immediately
            self.requestedFps = newFps
            self.frameIntervalNs = Int64(1_000_000_000 / max(1, newFps))

            // If only fps changed, we can keep capture running (keepalive already paces send).
            // If maxWidth changed, we need to restart ScreenCaptureKit with a new configuration.
            if newMaxW != self.requestedMaxWidth {
                self.requestedMaxWidth = newMaxW
                print("[ctl] quality update → fps=\(newFps) maxWidth=\(newMaxW) (reconfigure)")
                self.scheduleReconfigureCapture()
            } else {
                print("[ctl] quality update → fps=\(newFps) maxWidth=\(newMaxW)")
            }
        case "pointer":
            // TODO: map pointer events to CGEvents for input injection
            break
        case "key":
            // TODO: key events
            break
        case "text":
            // TODO: text input
            break
        default:
            break
        }
    }
    
    /**
        Attempts to bring the iOS Simulator window to the front, making it active on the screen.
         
        Why?
         ScreenCaptureKit often captures only active windows more reliably.
         Event injection (pointer, keyboard) requires the active app to receive events.
         Some macOS permissions/behaviors depend on the target window being focused.
     
        app.activate(options:) tells macOS:
            “Make this app the frontmost app right now. Bring its windows forward.”
     */
    private func activateSimulator() {
        
        //If we have already activated the simulator before, do nothing
        guard !simulatorActivated else { return }
        
        //Searches all running apps for a specific bundle ID ("com.apple.iphonesimulator")
        if let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.iphonesimulator").first {
            let ok = app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
            print("[ctl] activate Simulator:", ok ? "OK" : "NO")
            simulatorActivated = ok
        } else {
            print("[ctl] Simulator app not found to activate")
        }
    }

    // MARK: Capture
    /**
     Print every shareable window on the Mac, along with metadata, so you can see what ScreenCaptureKit sees before you decide which window to capture.
     
     SCShareableContent?
        It’s a ScreenCaptureKit structure that lists:
         All shareable windows
         All shareable applications
         All shareable displays
     */
    private func enumerateWindowsLog(_ content: SCShareableContent) {
        
        print("[sc] windows count =", content.windows.count)
        
        //Loop over all windows and print each window details
        for w in content.windows {
            let bid = w.owningApplication?.bundleIdentifier ?? "?"
            let name = w.owningApplication?.applicationName ?? "?"
            let title = w.title ?? ""
            let f = w.frame
            print(String(format:"[sc] win: app=%@ (%@)  title='%@'  frame=(%.0f,%.0f,%.0f,%.0f)  onScreen=%@", name, bid, title, f.origin.x, f.origin.y, f.size.width, f.size.height, w.isOnScreen.description))
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

    
    /**
        Filters windows belonging to the iOS Simulator app.
         
         Looks at all windows ScreenCaptureKit can see.
         Filters only simulator windows (bundle ID = "com.apple.iphonesimulator").
         Filters only windows that are currently on screen.
         Among those, uses a scoring function to choose the best candidate:
         Prefers largest height (device window is tall).
         Gives a bonus to portrait-shaped windows (height ≫ width).
        Sort them from “most likely device window” to “least likely”.
        Pick the N-th one in that sorted list (windowIndex = N).
         Returns the single best match — the main device screen window.
     */
    /// Picks the best iOS Simulator window to capture.
    /// 1. Filter to Simulator windows on-screen.
    /// 2. If cfg.windowMatch is set:
    ///    - Prefer an exact (case-insensitive) title match.
    ///    - Else fall back to a "contains" match.
    /// 3. If still nothing, fall back to the tallest portrait window.
    private func pickSimulatorWindow(from content: SCShareableContent) -> SCWindow? {
        // 1) Filter to iOS Simulator windows that are visible
        let candidates = content.windows.filter {
            ($0.owningApplication?.bundleIdentifier == "com.apple.iphonesimulator") && $0.isOnScreen
        }
        if candidates.isEmpty {
            print("[sc] no Simulator windows on screen")
            return nil
        }

        // 2) If we have a windowMatch hint, use it
        if let matchRaw = cfg.windowMatch, !matchRaw.isEmpty {
            let match = matchRaw.lowercased()

            // 2a) Prefer exact match (case-insensitive) on title
            if let exact = candidates.first(where: {
                ($0.title ?? "").lowercased() == match
            }) {
                print("[sc] Using windowMatch EXACT '\(match)': \((exact.title ?? ""))")
                return exact
            }

            // 2b) Fallback: substring match
            if let partial = candidates.first(where: {
                ($0.title ?? "").lowercased().contains(match)
            }) {
                print("[sc] Using windowMatch CONTAINS '\(match)': \((partial.title ?? ""))")
                return partial
            }

            print("[sc] windowMatch '\(match)' did not match any Simulator titles; falling back to heuristic")
        }

        // 3) No match or no windowMatch: choose the "best-looking" portrait Emulator window
        let chosen = candidates.max(by: { a, b in
            func score(_ w: SCWindow) -> CGFloat {
                let r = w.frame
                let aspect = r.height > 0 ? r.width / r.height : 0
                let portraitBonus: CGFloat = (aspect < 0.8) ? 2000 : 0 // tall & narrow
                return r.height + portraitBonus
            }
            return score(a) < score(b)
        })

        if let title = chosen?.title {
            print("[sc] fallback chosen Simulator window title='\(title)' frame=\(chosen!.frame)")
        } else {
            print("[sc] fallback chosen Simulator window (no title) frame=\(chosen!.frame)")
        }
        return chosen
    }

    
    private func pickEmulatorWindow(from content: SCShareableContent) -> SCWindow? {
        let candidates = content.windows.filter { w in
            let appId = w.owningApplication?.bundleIdentifier
            let processName = w.owningApplication?.applicationName.lowercased() ?? ""

            let isQemu = processName.contains("qemu") ||
                         (appId?.contains("android") ?? false)

            return isQemu && w.isOnScreen
        }

        guard !candidates.isEmpty else { return nil }

        // First try windowMatch (title match)
        if let match = cfg.windowMatch?.lowercased(), !match.isEmpty {
            if let chosen = candidates.first(where: {
                ($0.title ?? "").lowercased().contains(match)
            }) {
                print("[sc] emulator windowMatch → \(chosen.title ?? "")")
                return chosen
            }
        }

        // Fallback: choose the biggest emulator window (usually correct)
        let chosen = candidates.max { a, b in
            a.frame.height < b.frame.height
        }

        print("[sc] picked emulator window → \(chosen?.title ?? "")")
        return chosen
    }
    
    /**
       Heart of ScreenCaptureKit integration.
     
     
     
         startCaptureInternal() does:
             Ask ScreenCaptureKit: what windows are capturable?
             Log all visible windows.
             Pick the correct simulator device window.
             Compute cropping and scaling so:
                No toolbar
             Reasonable resolution (≤ 540px wide)
             Even dimensions for encoder
             Build a SCStreamConfiguration.
             Build a SCContentFilter for just that window.
             Create an SCStream and register as its output.
             Start capture, so your SCStreamOutput method begins receiving frames on queue q.
             Start keepalive + mark state as capturing.
         
        
        Gets all windows you can capture.
        Picks the simulator screen
        Stores the window & screen scale
        Create & Config. SCStreamConfiguration:
             configures how ScreenCaptureKit outputs frames:
             minimumFrameInterval = 1/30 → target ~30 fps (1 frame every 1/30s).
             capturesAudio = false → video-only capture.
             showsCursor = false → do not draw the mouse cursor over the simulator feed.
             queueDepth = 2 → small frame queue; keeps latency low (don’t buffer many frames).
             colorSpaceName = sRGB → standard color space.
             pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarFullRange:
             This is NV12 (Y plane + interleaved CbCr).
             Good for hardware encoders (e.g., H.264).
             Low bandwidth; standard for video pipelines.
        
        
     
     */
    private func startCaptureInternal() async throws {
            print("[sc] enumerating shareable content…")
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)

            // Log everything we can see (one-time diagnostic)
            enumerateWindowsLog(content)
            
            //Picks the simulator screen
            guard let window = pickWindow(for: cfg.platform, content: content) else {
                print("No window found")
                return
            }

            // Store window frame and screen scale
            let r = window.frame //The window’s rectangle in points (macOS coordinate space).
            self.simWindowFrame = r
            self.screenScale = NSScreen.main?.backingScaleFactor ?? 2.0
            print(String(format:"[sc] SELECTED Simulator window: frame=(%.0f,%.0f,%.0f,%.0f) scale=%.2f",
                         r.origin.x, r.origin.y, r.size.width, r.size.height, self.screenScale))
            
            //Create and configure SCStreamConfiguration
            let conf = SCStreamConfiguration()
            // CHANGE (PERF): allow server-driven FPS (quality messages)
            conf.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, self.requestedFps)))
            conf.capturesAudio = false
            conf.showsCursor = false
            conf.queueDepth = 2

            conf.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
           // conf.colorSpaceName = nil

            // crop top toolbar (~7%)
            let toolbarPct: CGFloat = 0.07
            var cropY: CGFloat
            var cropH: CGFloat

            switch cfg.platform {
            case .simulator:
                // crop off the simulator chrome at the top
                cropY = r.height * toolbarPct
                cropH = r.height * (1.0 - toolbarPct)
                let crop = CGRect(
                    x: 0,
                    y: cropY,
                    width: r.width,
                    height: cropH
                )
                conf.sourceRect = crop
                print("[sc] simulator crop sourceRect =", crop)

            case .emulator:
                // ❗ Do NOT crop – capture full emulator window
                cropY = 0
                cropH = r.height
                let full = CGRect(
                    x: 0,
                    y: 0,
                    width: r.width,
                    height: r.height
                )
                conf.sourceRect = full
                print("[sc] emulator full sourceRect =", full)
            }

            self.cropYPoints = cropY

            // CHANGE (PERF): scale to even dims ≤ requestedMaxWidth (server-driven)
            let srcW = Int(r.width * self.screenScale)
            let srcH = Int(cropH * self.screenScale)
            var w = min(srcW, max(2, self.requestedMaxWidth))
            var h = (w * srcH) / srcW
            if (w & 1) != 0 { w -= 1 }
            if (h & 1) != 0 { h -= 1 }
            conf.width = max(2, w)
            conf.height = max(2, h)
            self.streamWidth  = conf.width
            self.streamHeight = conf.height

            print("[sc] config width=\(conf.width) height=\(conf.height) cropY(points)=\(Int(cropY)) (NV12 requested)")

            /**
             Build the content filter and stream
             SCContentFilter(desktopIndependentWindow: simWin):
                Tells ScreenCaptureKit:
                    “Capture this specific window (the simulator device window), regardless of which desktop/space it's on.”
             SCStream(filter: configuration: delegate:):
                Creates the capture stream.
                    filter – what to capture (that simulator window).
                    configuration – how to capture (fps, size, pixel format).
                    delegate: self – this object handles stream-level events.
            */
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let sc = SCStream(filter: filter, configuration: conf, delegate: self)
            self.scStream = sc
            
            //Send .screen frames (video frames) to self, calling the SCStreamOutput method on queue q.
            try sc.addStreamOutput(self, type: .screen, sampleHandlerQueue: q)
            
            //Start the screen capture
            try await sc.startCapture()
            print("[sc] startCapture() OK — streaming I420…")

            startKeepAlive()
            isCapturing = true
        }


    // MARK: Keepalive pacing
    private func startKeepAlive() {
        let intervalMs = max(10, Int(1000 / max(1, self.requestedFps)))
        let t = DispatchSource.makeTimerSource(queue: q)
        t.schedule(deadline: .now() + .milliseconds(intervalMs), repeating: .milliseconds(intervalMs))
        t.setEventHandler { [weak self] in
            guard let self, let data = self.lastI420, self.lastW > 0, self.lastH > 0 else { return }
            let now = Int64(DispatchTime.now().uptimeNanoseconds)
            if now - self.lastSentNs >= self.frameIntervalNs {
                self.sendPacket(data, width: self.lastW, height: self.lastH, tsNs: now)
                self.lastSentNs = now
                self.sentCount &+= 1
                if self.sentCount % 120 == 0 {
                    print("[tx-keepalive] frames=\(self.sentCount) w=\(self.lastW) h=\(self.lastH)")
                }
            }
        }
        t.resume()
        keepAliveTimer = t
    }

    private func sendPacket(_ data: Data, width: Int, height: Int, tsNs: Int64) {
        guard let conn else { return }
        var pkt = Data(capacity: 4+4+4+8 + data.count)
        pkt.append(contentsOf: be32(UInt32(data.count)))
        pkt.append(contentsOf: be32(UInt32(width)))
        pkt.append(contentsOf: be32(UInt32(height)))
        pkt.append(contentsOf: be64(UInt64(tsNs)))
        pkt.append(data)
        conn.send(content: pkt, completion: .contentProcessed { err in
            if let err { print("[tcp] send error:", err.localizedDescription) }
        })
    }

    // MARK: SCStreamOutput
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        print("[sc] didStopWithError:", error.localizedDescription)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, CMSampleBufferIsValid(sb), let px = sb.imageBuffer else { return }

        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        let ns = Int64(CMTimeGetSeconds(pts) * 1_000_000_000)
        if ns - lastSentNs < frameIntervalNs { return }

        var outI420: Data? = nil
        var w = 0, h = 0

        if CVPixelBufferGetPlaneCount(px) == 2, let t = nv12ToI420(px: px) {
            outI420 = t.data; w = t.w; h = t.h
        } else {
            let fmt = CVPixelBufferGetPixelFormatType(px)
            guard fmt == kCVPixelFormatType_32BGRA else { return }
            CVPixelBufferLockBaseAddress(px, .readOnly)
            guard let base = CVPixelBufferGetBaseAddress(px) else {
                CVPixelBufferUnlockBaseAddress(px, .readOnly); return
            }
            w = CVPixelBufferGetWidth(px)
            h = CVPixelBufferGetHeight(px)
            if (w | h) & 1 != 0 { CVPixelBufferUnlockBaseAddress(px, .readOnly); return }
            let stride = CVPixelBufferGetBytesPerRow(px)
            outI420 = base.withMemoryRebound(to: UInt8.self, capacity: stride * h) { p in
                bgraToI420(width: w, height: h, src: p, srcStride: stride)
            }
            CVPixelBufferUnlockBaseAddress(px, .readOnly)
        }

        guard let i420 = outI420 else { return }
        sendPacket(i420, width: w, height: h, tsNs: ns)
        lastSentNs = ns
        lastI420 = i420
        lastW = w; lastH = h
        sentCount &+= 1
        if sentCount % 60 == 0 { print("[tx] I420 frames=\(sentCount) size=\(i420.count) w=\(w) h=\(h)") }
    }
}


