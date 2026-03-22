import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";

// Listening port
const PORT = 8080;

// Max inbound message payload size
const MAX_MSG_BYTES = 256 * 1024;

// Heartbeat sweeper interval timer (30 secs)
const HEARTBEAT_MS = 30000;

// If a viewer connection has no heartbeats or traffic for 2 mins, treat as dead and clean up
const VIEWER_LIVENESS_TTL_MS = 120000;

// Runs liveness sweep every 5 seconds
const VIEWER_SWEEP_MS = 5000;

// Session inactivity
const SESSION_INACTIVITY_MS = 60 * 1000; // 60 seconds for testing
const SESSION_SWEEP_MS = 10000; // sweep every 10s

// Map of active capture agent WebSockets for each device id
const agents = new Map();

// Maps each device ID to another Map of viewers (viewer id -> viewer WS)
const viewersByDevice = new Map();

// Stores metadata by viewer WS
// { deviceId, viewerId, clientSessionId, mode, lastSeenMs, lastActivityMs }
const viewerMeta = new Map();

// Tracks which viewer currently owns manual control for a device
const controllerByDevice = new Map();

// Tracks current interaction state (starting / ready / error / idle) per device
const interactionStateByDevice = new Map();

// Preserved manual lease across reload/disconnect.
// deviceId -> { clientSessionId, lastActivityMs, preservedAtMs }
const reclaimableControllerByDevice = new Map();

// Placeholder for future automation-run occupancy.
const automationRunningByDevice = new Set();

/**
 * Broadcast a message to all viewers watching this device
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
    reclaimableControllerByDevice.delete(deviceId);
  } else {
    controllerByDevice.delete(deviceId);
  }

  const controllerId = viewerIdOrNull ?? null;

  if (controllerId) {
    interactionStateByDevice.set(deviceId, { state: "starting" });
  } else {
    interactionStateByDevice.delete(deviceId);
  }

  broadcastToViewers(deviceId, { type: "control-state", deviceId, controllerId });
  broadcastToViewers(deviceId, {
    type: "interaction-state",
    deviceId,
    state: controllerId ? "starting" : "idle",
  });

  const agent = agents.get(deviceId);
  if (agent) {
    send(agent, { type: "control-state", deviceId, controllerId });
    send(agent, {
      type: "interaction-state",
      deviceId,
      state: controllerId ? "starting" : "idle",
    });
  }
}

function markAlive(ws) {
  ws.isAlive = true;
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

function isLeaseStillActive(lastActivityMs) {
  if (!lastActivityMs) return false;
  return Date.now() - lastActivityMs <= SESSION_INACTIVITY_MS;
}

function getValidReclaim(deviceId) {
  const reclaim = reclaimableControllerByDevice.get(deviceId);
  if (!reclaim) return null;

  if (!isLeaseStillActive(reclaim.lastActivityMs)) {
    reclaimableControllerByDevice.delete(deviceId);
    return null;
  }

  return reclaim;
}

function touchViewerSeenByWs(ws) {
  const meta = viewerMeta.get(ws);
  if (!meta) return;
  meta.lastSeenMs = Date.now();
}

function touchViewerActivityByViewerId(deviceId, viewerId) {
  const m = viewersByDevice.get(deviceId);
  const ws = m?.get(viewerId);
  if (!ws) return false;

  const meta = viewerMeta.get(ws);
  if (!meta) return false;

  const now = Date.now();
  meta.lastSeenMs = now;
  meta.lastActivityMs = now;
  return true;
}

// ---- Static device catalog (temporary) ----
const DEVICE_CATALOG = [
  { id: "sim-ios-16-pro", name: "iPhone 16 Pro", platform: "ios", osVersion: "18.3.1" },
  { id: "sim-ios-16-pro-max", name: "iPhone 16 Pro Max", platform: "ios", osVersion: "18.3.1" },
  { id: "sim-android-1", name: "Android Emulator #1", platform: "android", osVersion: "14" },
  { id: "sim-android-2", name: "Android Emulator #2", platform: "android", osVersion: "14" },
];

function getDeviceStatus(deviceId) {
  if (automationRunningByDevice.has(deviceId)) return "automation_running";

  const controllerId = getController(deviceId);
  if (controllerId) return "manual_in_use";

  const reclaim = getValidReclaim(deviceId);
  if (reclaim) return "manual_in_use";

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

function detachViewer(deviceId, viewerId, reason = "", opts = {}) {
  if (!deviceId || !viewerId) return;

  const { preserveReclaim = false } = opts;

  const m = viewersByDevice.get(deviceId);
  const vws = m?.get(viewerId);
  const meta = vws ? viewerMeta.get(vws) : null;

  if (vws) {
    vws._viewerDetached = true;
    viewerMeta.delete(vws);
    try {
      vws.terminate();
    } catch { }
  }

  if (m) {
    m.delete(viewerId);
    if (m.size === 0) viewersByDevice.delete(deviceId);
  }

  const wasController = getController(deviceId) === viewerId;

  if (wasController) {
    const canPreserve =
      preserveReclaim &&
      meta &&
      meta.mode === "manual" &&
      meta.clientSessionId &&
      meta.lastActivityMs &&
      isLeaseStillActive(meta.lastActivityMs);

    if (canPreserve) {
      reclaimableControllerByDevice.set(deviceId, {
        clientSessionId: meta.clientSessionId,
        lastActivityMs: meta.lastActivityMs,
        preservedAtMs: Date.now(),
      });

      console.log("[reclaim] preserved manual lease", {
        deviceId,
        viewerId,
        clientSessionId: meta.clientSessionId,
        lastActivityMs: meta.lastActivityMs,
        idleMs: Date.now() - meta.lastActivityMs,
        reason,
      });
    } else {
      reclaimableControllerByDevice.delete(deviceId);

      console.log("[reclaim] not preserved", {
        deviceId,
        viewerId,
        reason,
        hasMeta: !!meta,
        mode: meta?.mode ?? null,
        hasClientSessionId: !!meta?.clientSessionId,
        lastActivityMs: meta?.lastActivityMs ?? null,
      });
    }

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

const wssViewers = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const wssAgents = new WebSocketServer({ noServer: true, perMessageDeflate: false });

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
    touchViewerSeenByWs(ws);
  });

  let deviceId = null;
  let viewerId = null;

  const touchSeen = () => {
    if (deviceId && viewerId) {
      const prev = viewerMeta.get(ws) || { deviceId, viewerId };
      viewerMeta.set(ws, { ...prev, deviceId, viewerId, lastSeenMs: Date.now() });
    }
  };

  ws.on("message", (buf) => {
    if (buf.length > MAX_MSG_BYTES) {
      try {
        ws.close(1009, "message too big");
      } catch { }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }

    console.log("[/signal] msg", msg.type, "deviceId=", msg.deviceId, "viewerId=", msg.viewerId);

    if (msg.type === "heartbeat") {
      if (!deviceId) deviceId = msg.deviceId;
      if (!viewerId) viewerId = msg.viewerId;
      touchSeen();
      return;
    }

    if (msg.type === "obs" || msg.type === "obs-ttff") {
      touchSeen();
      console.log("[obs]", {
        deviceId: msg.deviceId,
        viewerId: msg.viewerId,
        type: msg.type,
        ttffMs: msg.ttffMs,
        qos: msg.qos,
        ice: msg.ice,
      });
      return;
    }

    if (msg.type === "iam-viewer") {
      deviceId = msg.deviceId;
      viewerId = crypto.randomUUID();

      const requestedMode = msg.mode === "watch" ? "watch" : "manual";
      const clientSessionId = typeof msg.clientSessionId === "string" ? msg.clientSessionId : null;
      const resumeOnly = !!msg.resumeOnly;
      const reclaim = getValidReclaim(deviceId);
      const currentController = getController(deviceId);
      const automationRunning = automationRunningByDevice.has(deviceId);

      const reclaimMatches =
        requestedMode === "manual" &&
        !!clientSessionId &&
        !!reclaim &&
        reclaim.clientSessionId === clientSessionId;

      const reclaimReservedForSomeoneElse =
        requestedMode === "manual" &&
        !!reclaim &&
        (!clientSessionId || reclaim.clientSessionId !== clientSessionId);

      let effectiveMode = "watch";

      if (automationRunning) {
        effectiveMode = "watch";
      } else if (currentController) {
        effectiveMode = "watch";
      } else if (reclaimMatches) {
        effectiveMode = "manual";
      } else if (reclaimReservedForSomeoneElse) {
        effectiveMode = "watch";
      } else if (requestedMode === "manual" && resumeOnly) {
        // Resume attempt failed because preserved lease no longer exists.
        // Do not silently grant a brand new manual lease.
        effectiveMode = "watch";
      } else {
        effectiveMode = requestedMode === "manual" ? "manual" : "watch";
      }

      const initialLastActivityMs =
        effectiveMode === "manual"
          ? reclaimMatches
            ? reclaim.lastActivityMs
            : Date.now()
          : null;

      const m = getViewersMap(deviceId);
      m.set(viewerId, ws);

      ws._viewerDetached = false;
      viewerMeta.set(ws, {
        deviceId,
        viewerId,
        clientSessionId,
        mode: effectiveMode,
        lastSeenMs: Date.now(),
        lastActivityMs: initialLastActivityMs,
      });

      const resumeRejected =
        requestedMode === "manual" &&
        !!clientSessionId &&
        (
          (resumeOnly && !reclaimMatches) ||
          currentController ||
          reclaimReservedForSomeoneElse ||
          automationRunning
        );

      const currentStatus = getDeviceStatus(deviceId);

      const now = Date.now();

      const resumedLastActivityMs =
        effectiveMode === "manual" && reclaimMatches
          ? reclaim.lastActivityMs
          : initialLastActivityMs;

      const remainingMs =
        resumedLastActivityMs && effectiveMode === "manual"
          ? Math.max(0, SESSION_INACTIVITY_MS - (now - resumedLastActivityMs))
          : null;


      let resumeReason = null;
      if (resumeRejected) {
        if (automationRunning) {
          resumeReason = "automation_running";
        } else if (currentController || reclaimReservedForSomeoneElse) {
          resumeReason = "taken_by_other_user";
        } else if (resumeOnly && !reclaimMatches) {
          resumeReason = "session_expired";
        }
      }


      send(ws, {
        type: "viewer-id",
        deviceId,
        viewerId,
        mode: effectiveMode,
        deviceStatus: currentStatus,
        resumeRejected,
        resumeReason,
        sessionTimeoutMs: effectiveMode === "manual" ? SESSION_INACTIVITY_MS : null,
        lastActivityMs: resumedLastActivityMs ?? null,
        remainingMs,
        resumedFromPreservedLease: reclaimMatches,
      });

      send(ws, { type: "agent-state", deviceId, online: agents.has(deviceId) });
      notifyViewerCount(deviceId);

      const current = getController(deviceId);

      if (!current && effectiveMode === "manual" && reclaimMatches) {
        reclaimableControllerByDevice.delete(deviceId);
        setController(deviceId, viewerId);
        const interaction = getInteractionState(deviceId);
        send(ws, { type: "interaction-state", deviceId, ...interaction });
      } else if (!current && effectiveMode === "manual" && !reclaimMatches) {
        reclaimableControllerByDevice.delete(deviceId);
        setController(deviceId, viewerId);
        const interaction = getInteractionState(deviceId);
        send(ws, { type: "interaction-state", deviceId, ...interaction });
      } else {
        send(ws, { type: "control-state", deviceId, controllerId: current ?? null });
        const interaction = getInteractionState(deviceId);
        send(ws, { type: "interaction-state", deviceId, ...interaction });
      }

      console.log("[viewer] registered", {
        deviceId,
        viewerId,
        requestedMode,
        effectiveMode,
        clientSessionId,
        reclaimMatches,
        preservedLastActivityMs: reclaimMatches ? reclaim?.lastActivityMs : null,
      });
      return;
    }

    if (!deviceId) deviceId = msg.deviceId;

    touchSeen();

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
    if (ws._viewerDetached) return;
    if (deviceId && viewerId) {
      detachViewer(deviceId, viewerId, "ws-close", { preserveReclaim: true });
    }
  });

  ws.on("error", (e) => console.log("[/signal] error", e?.message || e));
});

wssAgents.on("connection", (ws, req) => {
  console.log("[/agent] connected from", req.socket.remoteAddress);

  ws.isAlive = true;
  ws.on("pong", () => {
    markAlive(ws);
  });

  let deviceId = null;

  ws.on("message", (buf) => {
    if (buf.length > MAX_MSG_BYTES) {
      try {
        ws.close(1009, "message too big");
      } catch { }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }

    console.log("[/agent] msg", msg.type, "deviceId=", msg.deviceId, "viewerId=", msg.viewerId);

    if (msg.type === "iam-agent") {
      deviceId = msg.deviceId;
      agents.set(deviceId, ws);
      console.log("[agent] registered", deviceId);

      const m = viewersByDevice.get(deviceId);
      if (m) {
        for (const vws of m.values()) send(vws, { type: "agent-state", deviceId, online: true });
      }

      notifyViewerCount(deviceId);
      return;
    }

    if (msg.type === "interaction-state") {
      const d = msg.deviceId ?? deviceId;
      if (!d) return;
      setInteractionState(d, msg.state || "idle", msg.reason ? { reason: msg.reason } : {});
      return;
    }

    if (msg.type === "controller-activity") {
      const d = msg.deviceId ?? deviceId;
      const vId = msg.viewerId;
      if (!d || !vId) return;

      const controllerId = getController(d);
      if (!controllerId || controllerId !== vId) {
        console.log("[activity] ignored; viewer is not current controller", { deviceId: d, viewerId: vId, controllerId });
        return;
      }

      const updated = touchViewerActivityByViewerId(d, vId);
      if (updated) {
        console.log("[activity] updated lastActivityMs", { deviceId: d, viewerId: vId });
      }
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
      if (m) {
        for (const vws of m.values()) send(vws, { type: "agent-state", deviceId, online: false });
      }
    }
  });

  ws.on("error", (e) => console.log("[/agent] error", e?.message || e));
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`signaling server on :${PORT}`);
  console.log(`  viewers: ws://<host>:${PORT}/signal`);
  console.log(`  agent:   ws://<host>:${PORT}/agent`);
});

// Heartbeat: detect dead sockets
setInterval(() => {
  const sweep = (wss) => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        try {
          ws.terminate();
        } catch { }
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch { }
    }
  };
  sweep(wssViewers);
  sweep(wssAgents);
}, HEARTBEAT_MS);

// Viewer liveness sweep
setInterval(() => {
  const now = Date.now();
  for (const [ws, meta] of viewerMeta.entries()) {
    if (!meta?.deviceId || !meta?.viewerId) continue;
    if (now - meta.lastSeenMs <= VIEWER_LIVENESS_TTL_MS) continue;

    const { deviceId, viewerId } = meta;
    console.log("[liveness] expiring viewer", { deviceId, viewerId, ageMs: now - meta.lastSeenMs });

    detachViewer(deviceId, viewerId, "ttl-expired", { preserveReclaim: true });
    try {
      ws.terminate();
    } catch { }
  }
}, VIEWER_SWEEP_MS);

// Cleanup preserved manual leases whose inactivity window has expired
setInterval(() => {
  const now = Date.now();
  for (const [deviceId, reclaim] of reclaimableControllerByDevice.entries()) {
    if (!reclaim || isLeaseStillActive(reclaim.lastActivityMs)) continue;

    console.log("[reclaim] expired preserved lease", {
      deviceId,
      lastActivityMs: reclaim.lastActivityMs,
      idleMs: now - (reclaim.lastActivityMs || 0),
    });

    reclaimableControllerByDevice.delete(deviceId);
  }
}, 2000);

// Session inactivity sweep
setInterval(() => {
  const now = Date.now();

  for (const [ws, meta] of viewerMeta.entries()) {
    if (!meta?.deviceId || !meta?.viewerId) continue;
    if (meta.mode !== "manual") continue;

    const { deviceId, viewerId } = meta;
    const lastAct = meta.lastActivityMs ?? 0;
    if (!lastAct) continue;

    const controllerId = getController(deviceId);
    if (!controllerId || controllerId !== viewerId) continue;

    if (now - lastAct <= SESSION_INACTIVITY_MS) continue;

    console.log("[session] releasing due to inactivity", { deviceId, viewerId, idleMs: now - lastAct });

    try {
      send(ws, { type: "session-released", deviceId, viewerId, reason: "inactivity" });
    } catch { }

    detachViewer(deviceId, viewerId, "inactivity", { preserveReclaim: false });

    try {
      ws.terminate();
    } catch { }
  }
}, SESSION_SWEEP_MS);