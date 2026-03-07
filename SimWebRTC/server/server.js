import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";

//Listening port
const PORT = 8080;

//Max inboud message payload size 
const MAX_MSG_BYTES = 256 * 1024;

//Heartbeat sweeper interval timer (30 secs)
const HEARTBEAT_MS = 30000;

// If a viewer connection has no heartbeats  or traffic for 2 mins, treat as dead and clean up
const VIEWER_LIVENESS_TTL_MS = 120000; 

//Runs liveness sweep every 5 seconds 
const VIEWER_SWEEP_MS = 5000;

// Session inactivity 
const SESSION_INACTIVITY_MS = 15 * 60 * 1000; // 15 minutes
const SESSION_SWEEP_MS = 10000; // sweep every  10s
const RELEASE_CONTROLLER_ONLY = true; // keep watchers; release only controller

// Map of active capture agent WebSockets for each device id 
// Ex: {"iPhone 16 Pro": <WebSocket#111>} 
const agents = new Map();

// Maps each device ID to another Map of viewers (viewer id -> viewer WS)
// Ex: {"iPhone 16 Pro" : { "viewerOne": <WebSocket#111">, "viewerTwo": <WebSocket#222>} }
const viewersByDevice = new Map();

// Stores metadata by the viewer WS ..... { device ID, viewer id, lastSeen<s, lastActivityMs}
// Ex: { <WebSocket#111> : { deviceId: "IPhone 16  Pro", viewerId: "viewerOne", lastSeenMS...}}
const viewerMeta = new Map();

// A map that tracks which viewerID currently owns control for each device ID 
// Ex: {"iPhone 16 Pro": "null", "iPhone 16 Pro Max": "viewerOne"} 
const controllerByDevice = new Map();

// Tracks whether the current controller is warming/ready/error for interaction
const interactionStateByDevice = new Map();


/** 
 * Broadcast a message to all viewers watching this device
 * Used for control state updates, stop  stream, agent updates, etc
*/
function broadcastToViewers(deviceId, msg) {
  const viewersForThisDevice = viewersByDevice.get(deviceId);
  if (!viewersForThisDevice) return;
  for (const viewer of viewersForThisDevice.values()) {
    send(viewer, msg);
  }
}


function getController(deviceId) {
  const id = controllerByDevice.get(deviceId);
  return id ?? null;
}

function getInteractionState(deviceId) {
  return interactionStateByDevice.get(deviceId) || { state: "idle" };
}

function setInteractionState(deviceId, state, extra = {}) {
  if (!deviceId) return;

  const payload = { type: "interaction-state", deviceId, state, ...extra };

  if (state === "idle") {
    interactionStateByDevice.delete(deviceId);
  } else {
    interactionStateByDevice.set(deviceId, { state, ...extra });
  }

  broadcastToViewers(deviceId, payload);

  const agent = agents.get(deviceId);
  if (agent) {
    send(agent, payload);
  }
}

function setController(deviceId, viewerIdOrNull) {
  if (!deviceId) return;

  if (viewerIdOrNull) {
    controllerByDevice.set(deviceId, viewerIdOrNull);
  } else {
    controllerByDevice.delete(deviceId);
  }

  const controllerId = viewerIdOrNull ?? null;

  // Controller ownership changed, so reset readiness until agent says otherwise.
  if (controllerId) {
    interactionStateByDevice.set(deviceId, { state: "starting" });
  } else {
    interactionStateByDevice.delete(deviceId);
  }

  // Notify all viewers so they can update their "canInteract" UI
  broadcastToViewers(deviceId, { type: "control-state", deviceId, controllerId });
  broadcastToViewers(deviceId, {
    type: "interaction-state",
    deviceId,
    state: controllerId ? "starting" : "idle"
  });

  // Also notify the agent so it can enforce control server-side if desired
  const agent = agents.get(deviceId);
  if (agent) {
    send(agent, { type: "control-state", deviceId, controllerId });
    send(agent, {
      type: "interaction-state",
      deviceId,
      state: controllerId ? "starting" : "idle"
    });
  }
}

function markAlive(ws) { 
  ws.isAlive = true; 
}

// ---- Static device catalog (temporary) ----
const DEVICE_CATALOG = [
  { id: "sim-ios-16-pro",     name: "iPhone 16 Pro",       platform: "ios",     osVersion: "18.3.1" },
  { id: "sim-ios-16-pro-max", name: "iPhone 16 Pro Max",   platform: "ios",     osVersion: "18.3.1" },
  { id: "sim-android-1",      name: "Android Emulator #1", platform: "android", osVersion: "14" },
  { id: "sim-android-2",      name: "Android Emulator #2", platform: "android", osVersion: "14" },
];

// status rules (simple)
function getDeviceStatus(deviceId) {
  const controllerId = getController(deviceId);
  if (controllerId) return "in_use";
  const agentOnline = agents.has(deviceId);
  if (!agentOnline) return "error";
  return "available";
}

function getDeviceCatalogSnapshot() {
  return DEVICE_CATALOG.map((d) => ({
    ...d,
    status: getDeviceStatus(d.id),
    controllerId: getController(d.id),
    agentOnline: agents.has(d.id),
    viewerCount: viewerCount(d.id),
  }));
}

function send(ws, obj) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify(obj));
}

function getViewersMap(deviceId) {
  let m = viewersByDevice.get(deviceId);
  if (!m) {
    m = new Map();
    viewersByDevice.set(deviceId, m);
  }
  return m;
}

function viewerCount(deviceId) {
  return viewersByDevice.get(deviceId)?.size ?? 0;
}

function notifyViewerCount(deviceId) {
  const agent = agents.get(deviceId);
  if (!agent) return;
  send(agent, { type: "viewer-count", deviceId, count: viewerCount(deviceId) });
}

function detachViewer(deviceId, viewerId, reason = "") {
  if (!deviceId || !viewerId) return;

  const m = viewersByDevice.get(deviceId);
  const vws = m?.get(viewerId);
  if (vws) {
    // Mark so that if ws "close" fires later we don't double-handle
    vws._viewerDetached = true;
    viewerMeta.delete(vws); //delete metadata so no more sweeps and checks 
    try { vws.terminate(); } catch {} //terminate WS
  }

  //Deletes the viewer from view list 
  if (m) {
    m.delete(viewerId); 
    if (m.size === 0) viewersByDevice.delete(deviceId);
  }

  // If this viewer was the current controller, clear controller for this device.
  if (getController(deviceId) === viewerId) {
    setController(deviceId, null);   
  }

  const agent = agents.get(deviceId);
  if (agent) {
    console.log("[route] viewer-left -> agent", { deviceId, viewerId, reason });
    send(agent, { type: "viewer-left", deviceId, viewerId, reason });
    notifyViewerCount(deviceId);
    if (viewerCount(deviceId) === 0) {
      send(agent, { type: "stop-stream", deviceId, reason: reason || "no-viewers" });
    }
  }
}


const httpServer = http.createServer((req, res) => {
  if (req.url === "/api/devices") {
    const body = JSON.stringify({ devices: getDeviceCatalogSnapshot() });
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(body);
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok");
});

// Keep signaling/control light—compression adds latency/CPU for tiny frequent messages.
const wssViewers = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const wssAgents  = new WebSocketServer({ noServer: true, perMessageDeflate: false });

httpServer.on("upgrade", (req, socket, head) => {
  const { url } = req;

  if (url === "/signal") {
    wssViewers.handleUpgrade(req, socket, head, (ws) => wssViewers.emit("connection", ws, req));
    return;
  }
  if (url === "/agent") {
    wssAgents.handleUpgrade(req, socket, head, (ws) => wssAgents.emit("connection", ws, req));
    return;
  }

  socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
  socket.destroy();
});

wssViewers.on("connection", (ws, req) => {
  console.log("[/signal] connected from", req.socket.remoteAddress);

  ws.isAlive = true;
  ws.on("pong", () => {
    markAlive(ws);
    const meta = viewerMeta.get(ws);
    if (meta) meta.lastSeenMs = Date.now();   // <- key line
  });

  let deviceId = null;
  let viewerId = null;

  //Hanlder for updating seen field 
  const touchSeen = () => {
    if (deviceId && viewerId) {
      const prev = viewerMeta.get(ws) || { deviceId, viewerId };
      viewerMeta.set(ws, { ...prev, deviceId, viewerId, lastSeenMs: Date.now() });
    }
  };

  //Handler for updating viewer user activity 
  const touchActivity = () => {
    if (deviceId && viewerId) {
      const prev = viewerMeta.get(ws) || { deviceId, viewerId };
      viewerMeta.set(ws, { ...prev, deviceId, viewerId, lastSeenMs: Date.now(), lastActivityMs: Date.now() });
    }
  };

  ws.on("message", (buf) => {

    if (buf.length > MAX_MSG_BYTES) { 
      try { 
        ws.close(1009, "message too big");
       } catch {} 
       return; 
    }
    
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    console.log("[/signal] msg", msg.type, "deviceId=", msg.deviceId, "viewerId=", msg.viewerId);

    // App-level heartbeat (recommended). Any traffic also counts as liveness.
    if (msg.type === "heartbeat") {
      if (!deviceId) deviceId = msg.deviceId;
      if (!viewerId) viewerId = msg.viewerId;
      touchSeen();
      return;
    }

    if (msg.type === "obs" || msg.type === "obs-ttff") {
      touchSeen();
      console.log("[obs]", { deviceId: msg.deviceId, viewerId: msg.viewerId, type: msg.type, ttffMs: msg.ttffMs, qos: msg.qos, ice: msg.ice });
      return;
    }

    if (msg.type === "iam-viewer") {
      deviceId = msg.deviceId;
      viewerId = msg.viewerId ?? crypto.randomUUID();
    
      const m = getViewersMap(deviceId);
      m.set(viewerId, ws);
    
      ws._viewerDetached = false;
      viewerMeta.set(ws, { deviceId, viewerId, lastSeenMs: Date.now(), lastActivityMs: Date.now() });
    
      send(ws, { type: "viewer-id", deviceId, viewerId });
      send(ws, { type: "agent-state", deviceId, online: agents.has(deviceId) });
    
      // Server-owned viewer-count (push to agent). Agent can use this to start/stop capture.
      notifyViewerCount(deviceId);
    
      // Controller semantics:
      // - If no controller yet, first viewer becomes controller.
      // - Otherwise, just send the current controller snapshot to this viewer.
      const current = getController(deviceId);
      if (!current) {
        setController(deviceId, viewerId);
        const interaction = getInteractionState(deviceId);
        send(ws, { type: "interaction-state", deviceId, ...interaction });
      } else {
        send(ws, { type: "control-state", deviceId, controllerId: current });
        const interaction = getInteractionState(deviceId);
        send(ws, { type: "interaction-state", deviceId, ...interaction });
      }
    
      console.log("[viewer] registered", { deviceId, viewerId });
      return;
    }
      

    if (!deviceId) deviceId = msg.deviceId;

    // Distinguish liveness vs user activity (so stats/heartbeats don't keep sessions alive forever)
    const isUserActivity =
      msg.type === "pointer" ||
      msg.type === "key" ||
      msg.type === "text" ||
      msg.type === "home";

    if (isUserActivity) touchActivity();
    else touchSeen();

    const agent = agents.get(deviceId);
    if (!agent) {
      send(ws, { type: "error", deviceId, message: "agent-offline" });
      return;
    }

    if (viewerId && !msg.viewerId) msg.viewerId = viewerId;

    console.log("[route] viewer->agent", msg.type, "deviceId=", deviceId, "viewerId=", msg.viewerId);
    send(agent, msg);
  });

  ws.on("close", () => {
    console.log("[/signal] closed");
    // If we already detached due to TTL sweep, do nothing.
    if (ws._viewerDetached) return;
    if (deviceId && viewerId) detachViewer(deviceId, viewerId, "ws-close");
  });

  ws.on("error", (e) => console.log("[/signal] error", e?.message || e));
});

wssAgents.on("connection", (ws, req) => {
  console.log("[/agent] connected from", req.socket.remoteAddress);

  ws.isAlive = true;
  ws.on("pong", () => { //maybe delete 
    markAlive(ws);
    const meta = viewerMeta.get(ws);
    if (meta) meta.lastSeenMs = Date.now();   // <- key line
  });

  let deviceId = null;

  ws.on("message", (buf) => {
    if (buf.length > MAX_MSG_BYTES) { try { ws.close(1009, "message too big"); } catch {} return; }
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    console.log("[/agent] msg", msg.type, "deviceId=", msg.deviceId, "viewerId=", msg.viewerId);

    if (msg.type === "iam-agent") {
      deviceId = msg.deviceId;
      agents.set(deviceId, ws);
      console.log("[agent] registered", deviceId);

      const m = viewersByDevice.get(deviceId);
      if (m) for (const vws of m.values()) send(vws, { type: "agent-state", deviceId, online: true });

      // Server-owned viewer-count snapshot (useful if viewers were already connected)
      notifyViewerCount(deviceId);
      return;
    }

    if (msg.type === "interaction-state") {
      const d = msg.deviceId ?? deviceId;
      if (!d) return;
      setInteractionState(d, msg.state || "idle", msg.reason ? { reason: msg.reason } : {});
      return;
    }

    const d = msg.deviceId ?? deviceId;
    const vId = msg.viewerId;
    if (!d || !vId) return;

    const m = viewersByDevice.get(d);
    const vws = m?.get(vId);
    if (!vws) return;

    console.log("[route] agent->viewer", msg.type, "deviceId=", d, "viewerId=", vId);
    send(vws, msg);
  });

  ws.on("close", () => {
    console.log("[/agent] closed");
    if (deviceId && agents.get(deviceId) === ws) {
      agents.delete(deviceId);
      const m = viewersByDevice.get(deviceId);
      if (m) for (const vws of m.values()) send(vws, { type: "agent-state", deviceId, online: false });
    }
  });

  ws.on("error", (e) => console.log("[/agent] error", e?.message || e));
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`signaling server on :${PORT}`);
  console.log(`  viewers: ws://<host>:${PORT}/signal`);
  console.log(`  agent:   ws://<host>:${PORT}/agent`);
});

// Heartbeat: detect dead sockets (proxies, wifi drops) and clean up without waiting for close
setInterval(() => {
  const sweep = (wss) => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch {}
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  };
  sweep(wssViewers);
  sweep(wssAgents);
}, HEARTBEAT_MS);

// Viewer liveness sweep (app-level + traffic-based). This catches cases where the WS stays "open"
// but the tab is effectively gone (suspended/crashed) or intermediate network gear misbehaves.
setInterval(() => {
  const now = Date.now();
  for (const [ws, meta] of viewerMeta.entries()) {
    if (!meta?.deviceId || !meta?.viewerId) continue;
    if (now - meta.lastSeenMs <= VIEWER_LIVENESS_TTL_MS) continue;

    const { deviceId, viewerId } = meta;
    console.log("[liveness] expiring viewer", { deviceId, viewerId, ageMs: now - meta.lastSeenMs });

    // Proactively detach + notify agent. Also terminate the socket.
    detachViewer(deviceId, viewerId, "ttl-expired");
    try { ws.terminate(); } catch {}
  }
}, VIEWER_SWEEP_MS);


// Session inactivity sweep: release idle controller after 15 minutes (watchers remain)
setInterval(() => {
  const now = Date.now();

  for (const [ws, meta] of viewerMeta.entries()) {
    if (!meta?.deviceId || !meta?.viewerId) continue;

    const { deviceId, viewerId } = meta;
    const lastAct = meta.lastActivityMs ?? meta.lastSeenMs ?? 0;
    if (!lastAct) continue;

    if (RELEASE_CONTROLLER_ONLY) {
      const controllerId = getController(deviceId);
      if (!controllerId || controllerId !== viewerId) continue;
    }

    if (now - lastAct <= SESSION_INACTIVITY_MS) continue;

    console.log("[session] releasing due to inactivity", { deviceId, viewerId, idleMs: now - lastAct });

    // Notify the viewer UI before we terminate
    try {
      send(ws, { type: "session-released", deviceId, viewerId, reason: "inactivity" });
    } catch {}

    // Detach will clear controller and notify agent
    detachViewer(deviceId, viewerId, "inactivity");

    try { ws.terminate(); } catch {}
  }
}, SESSION_SWEEP_MS);