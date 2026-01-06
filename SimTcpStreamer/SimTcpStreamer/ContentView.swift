/**
 In Swift, a struct is like a Java class but with value semantics.

 @State = A persistent, reactive stored variable inside a View.
 
 
 | Term                              | Meaning                                                    |
 | -------------------------- | ---------------------------------------------------------- |
 | `struct ContentView: View` | A SwiftUI UI component (like a React functional component) |
 | `@State`                                         | A reactive piece of UI state; changes re-render the view   |
 | `VStack`                                         | Vertical container (like flex column)                      |
 | `.padding()`                                 Adds spacing around view                                   |
 | `.task {}`                                     | Run async code when view appears                           |
 | `.onDisappear {}`                     | Cleanup when view closes                                   |
 | `@Sendable`                                  | Marks closure/function as thread-safe for concurrency      |
 | `async`, `await`                          | Swift concurrency primitives                               |
 | `.foregroundStyle()`       | Setting text color                                         |
 | `.frame(width:)`           | Set explicit size of view                                  |
 | `Spacer()`                 | Flexible empty space (like flex-grow)                      |

 
 
 */
import SwiftUI
struct ContentView: View {
    
    // Simple status text to show what's happening
    @State private var status: String = "Idle"
    
    // Streamer instance
    private let streamer = SimTcpStreamer()

    var body: some View {
        
        VStack(alignment: .leading, spacing: 12) {
            Text("SimCast TCP Streamer")
                .font(.title2)

            Text(status)
                .foregroundStyle(
                    status.starts(with: "Error")
                    ? .red
                    : (status.contains("Streaming") ? .green : .secondary)
                )

            Spacer()

            Text("Grant Screen Recording in System Settings → Privacy & Security.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding()
        .frame(width: 480)
        // Connect to Node when this view appears
        .task {
            await connectToNode()
        }
        // Clean up when window/app closes
        .onDisappear {
            streamer.stop()
        }
    }

    // MARK: - Config loading

    /// Try to load SimTcpStreamer.Config from `--config <file.json>` CLI args.
    /// If anything fails, fall back to a hard-coded default.
    private func loadConfigFromArgs() -> SimTcpStreamer.Config {
        let args = CommandLine.arguments

        // Look for: --config-json "<json-string>"
        if let idx = args.firstIndex(of: "--config-json"), idx + 1 < args.count {
            let jsonString = args[idx + 1]
            print("[cfg] raw JSON arg =", jsonString)

            if let data = jsonString.data(using: .utf8) {
                do {
                    let cfg = try JSONDecoder().decode(SimTcpStreamer.Config.self, from: data)
                    print("[cfg] decoded OK → deviceId=\(cfg.deviceId) platform=\(cfg.platform) windowMatch=\(cfg.windowMatch ?? "(none)")")
                    return cfg
                } catch {
                    print("[cfg] FAILED to decode JSON:", error.localizedDescription)
                }
            } else {
                print("[cfg] cannot convert JSON string to UTF-8 data")
            }
        } else {
            print("[cfg] no --config-json arg found. args =", CommandLine.arguments)
        }

        // Fallback default if no --config-json or decode fails
        print("[cfg] using default hard-coded config")
        return SimTcpStreamer.Config(
            host: "127.0.0.1",
            port: 9001,
            deviceId: "sim-1",
            fps: 30,
            platform: .simulator,
            windowMatch: "iPhone 16 Pro"
        )
    }
    
   


    // MARK: - Connect
    @Sendable
    private func connectToNode() async {
        // 1) Load config (from CLI if provided, otherwise default)
        let cfg = loadConfigFromArgs()

        // 2) Show status + connect
        status = "Connecting to \(cfg.host):\(cfg.port) as \(cfg.deviceId)…"
        do {
            try await streamer.connect(cfg)
            status = "Connected as \(cfg.deviceId). Waiting for viewer…"
        } catch {
            status = "Error: \(error.localizedDescription)"
        }
    }

}

