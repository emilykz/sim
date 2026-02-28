import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";

const PORT = 8080;
const MAX_MSG_BYTES = 256 * 1024;
const HEARTBEAT_MS = 30000;

const VIEWER_LIVENESS_TTL_MS = 120000; // 2 minutes // if no heartbeat/traffic within this, treat viewer as gone
const VIEWER_SWEEP_MS = 5000;

// deviceId -> agent ws
const agents = new Map();

// deviceId -> Map(viewerId -> viewer ws)
const viewersByDevice = new Map();

// viewer ws -> { deviceId, viewerId, lastSeenMs }
const viewerMeta = new Map();

// deviceId -> current controller viewerId (or null)
const controllerByDevice = new Map();

// Broadcast a message to all viewers on a device
function broadcastToViewers(deviceId, msg) {
  const m = viewersByDevice.get(deviceId);
  if (!m) return;
  for (const vws of m.values()) {
    send(vws, msg);
  }
}

function getController(deviceId) {
  const id = controllerByDevice.get(deviceId);
  return id ?? null;
}

function setController(deviceId, viewerIdOrNull) {
  if (!deviceId) return;

  if (viewerIdOrNull) {
    controllerByDevice.set(deviceId, viewerIdOrNull);
  } else {
    controllerByDevice.delete(deviceId);
  }

  const controllerId = viewerIdOrNull ?? null;

  // Notify all viewers so they can update their "canInteract" UI
  broadcastToViewers(deviceId, { type: "control-state", deviceId, controllerId });

  // Also notify the agent so it can enforce control server-side if desired
  const agent = agents.get(deviceId);
  if (agent) {
    send(agent, { type: "control-state", deviceId, controllerId });
  }
}

function markAlive(ws) { ws.isAlive = true; }

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
    viewerMeta.delete(vws);
    try { vws.terminate(); } catch {}
  }

  if (m) {
    m.delete(viewerId);
    if (m.size === 0) viewersByDevice.delete(deviceId);
  }

  // If this viewer was the current controller, clear controller for this device.
  if (getController(deviceId) === viewerId) {
    setController(deviceId, null);   // ✅ your “controller = null on disconnect” requirement
  }

  const agent = agents.get(deviceId);
  if (agent) {
    console.log("[route] viewer-left -> agent", { deviceId, viewerId, reason });
    send(agent, { type: "viewer-left", deviceId, viewerId, reason });
    notifyViewerCount(deviceId);
  }
}


const httpServer = http.createServer((req, res) => {
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

  const touch = () => {
    if (deviceId && viewerId) {
      viewerMeta.set(ws, { deviceId, viewerId, lastSeenMs: Date.now() });
    }
  };

  ws.on("message", (buf) => {
    if (buf.length > MAX_MSG_BYTES) { try { ws.close(1009, "message too big"); } catch {} return; }
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    console.log("[/signal] msg", msg.type, "deviceId=", msg.deviceId, "viewerId=", msg.viewerId);

    // App-level heartbeat (recommended). Any traffic also counts as liveness.
    if (msg.type === "heartbeat") {
      if (!deviceId) deviceId = msg.deviceId;
      if (!viewerId) viewerId = msg.viewerId;
      touch();
      return;
    }

    if (msg.type === "obs" || msg.type === "obs-ttff") {
      console.log("[obs]", { deviceId: msg.deviceId, viewerId: msg.viewerId, type: msg.type, ttffMs: msg.ttffMs, qos: msg.qos, ice: msg.ice });
      return;
    }

    if (msg.type === "iam-viewer") {
      deviceId = msg.deviceId;
      viewerId = msg.viewerId ?? crypto.randomUUID();
    
      const m = getViewersMap(deviceId);
      m.set(viewerId, ws);
    
      ws._viewerDetached = false;
      viewerMeta.set(ws, { deviceId, viewerId, lastSeenMs: Date.now() });
    
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
      } else {
        send(ws, { type: "control-state", deviceId, controllerId: current });
      }
    
      console.log("[viewer] registered", { deviceId, viewerId });
      return;
    }
      

    if (!deviceId) deviceId = msg.deviceId;

    // Any message from a registered viewer counts as liveness.
    touch();

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
