/*
Main entry point (@main)
When this app runs, create a Scene (container of one or more windows) that contains a window group

App: Defines the entry point of your app
Scene: Describes the visible content area
Window Group: Represents a window or collection of windows
ContentView: Root UI Component/Actual app interace

App  →  Scene(s)  →  WindowGroup(s) / DocumentGroup(s)  →  Window(s)  →  View(s)

1️⃣ App — the whole application (like a process).
2️⃣ Scene — a top-level section of UI state in your app (like a screen, document, or window collection). The system-managed logical container (declared by your body)
3️⃣ WindowGroup — a container that manages one or more windows showing the same kind of content
4️⃣ Window — the actual physical window (the thing the user can drag, close, minimize)
5️⃣ View — your actual UI components (buttons, text, etc.)

 */

import SwiftUI

@main
struct SimTcpStreamerApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()   // no config passed in
        }
    }
}
