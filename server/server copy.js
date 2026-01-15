// server/server.js
import http from 'http';
import net from 'net';
import { WebSocketServer } from 'ws';
import wrtc from '@roamhq/wrtc';
import jpeg from 'jpeg-js';
import { v4 as uuidv4 } from 'uuid';
import { spawn } from 'child_process';


const VERBOSE = process.env.VERBOSE === '1';

function log(...a) { console.log(...a) }
function warn(...a) { console.warn(...a) }
function err(...a) { console.error(...a) }

/** 
 * For each device:
    * source – RTCVideoSource (WebRTC frame source).
      track – MediaStreamTrack created from source.
      viewers – Set of active WebRTC viewers { pc, ws, id }.
      count – number of frames pushed so far.
      pending – latest video frame buffer { w, h, data } in I420.
      pusher – setInterval timer that pushes pending frames into source.
      seeded – whether we’ve already received at least one real frame.
 **/
const sims = new Map(); // deviceId -> { source, track, viewers:Set, count, pending, pusher, seeded }
function room(id) {
  if (!sims.has(id)) sims.set(id, { source: null, track: null, viewers: new Set(), count: 0, pending: null, pusher: null, seeded: false });
  return sims.get(id);
}
function ensureSource(r) {
  if (!r.source) {
    r.source = new wrtc.nonstandard.RTCVideoSource();
    r.track = r.source.createTrack();
    log('[video] created RTCVideoSource/Track');
  }
}
function ensurePusher(r, fps = 24) {
  if (r.pusher) return;

  //Starts a timer that fires every ~1000/fps ms.
  const interval = Math.max(1, Math.floor(1000 / fps));

  //On each interval/tick/timer
  r.pusher = setInterval(() => {

    //Get the latest video frame buffer 
    const p = r.pending;

    //If there is nothing to push -> return/exit
    if (!p) return;

    //pushes frame to webrtc 
    r.source.onFrame({ width: p.w, height: p.h, data: p.data });
    r.count++;

    //Log every 60 frames
    if (r.count % 60 === 0) log(`[push] frames=${r.count} (I420, w=${p.w}, h=${p.h})`);

  }, interval);
}

//Stops the push interval timer if there are no viewers 
function maybeStopPusher(r) {
  if (r.viewers.size === 0 && r.pusher) {
    clearInterval(r.pusher);
    r.pusher = null;
    r.seeded = false;
    r.pending = null;
    log('[push] stopped pusher (no viewers)');
  }
}

/* ------------ control sockets (input) ------------ */
const controlSockets = new Map(); // deviceId -> net.Socket

// helper: send a stream start/stop command to the Mac streamer
function sendStreamCommand(deviceId, action) {
  const sock = controlSockets.get(deviceId);
  if (!sock) {
    warn('[ctl] no control socket for', deviceId, '— cannot send stream', action);
    return;
  }
  const msg = { type: 'stream', action, deviceId };
  try {
    //Message format (4-byte big-endian length. + payload/message itself)
    const payload = Buffer.from(JSON.stringify(msg), 'utf8');
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(payload.length, 0);
    sock.write(header);
    sock.write(payload);
    log('[ctl] →', deviceId, 'stream', action);
  } catch (e) {
    err('[ctl] stream command error for', deviceId, e?.message || e);
  }
}

/* ------------ helpers ------------ */
function makeI420Slate(w, h, y = 32, u = 128, v = 128) {
  const ySize = w * h, uvSize = (w >> 1) * (h >> 1);
  const buf = Buffer.allocUnsafe(ySize + uvSize * 2);
  buf.fill(y, 0, ySize);
  buf.fill(u, ySize, ySize + uvSize);
  buf.fill(v, ySize + uvSize);
  return { w, h, data: buf };
}
function clamp(v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }
function rgbaToI420(width, height, rgba) {
  const ySize = width * height, uvSize = (width >> 1) * (height >> 1);
  const i420 = Buffer.allocUnsafe(ySize + uvSize * 2);
  const Y = i420.subarray(0, ySize), U = i420.subarray(ySize, ySize + uvSize), V = i420.subarray(ySize + uvSize);
  let yi = 0;
  for (let j = 0; j < height; j++) {
    const row = j * width;
    for (let i = 0; i < width; i++) {
      const idx = (row + i) * 4;
      const r = rgba[idx], g = rgba[idx + 1], b = rgba[idx + 2];
      Y[yi++] = clamp(((66 * r + 129 * g + 25 * b + 128) >> 8) + 16);
    }
  }
  let ui = 0, vi = 0;
  for (let j = 0; j < height; j += 2) {
    const r0 = j * width, r1 = (j + 1) * width;
    for (let i = 0; i < width; i += 2) {
      const idxs = [(r0 + i) * 4, (r0 + i + 1) * 4, (r1 + i) * 4, (r1 + i + 1) * 4];
      let rs = 0, gs = 0, bs = 0;
      for (const idx of idxs) { rs += rgba[idx]; gs += rgba[idx + 1]; bs += rgba[idx + 2]; }
      const r = rs >> 2, g = gs >> 2, b = bs >> 2;
      U[ui++] = clamp(((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128);
      V[vi++] = clamp(((112 * r - 94 * g - 18 * b + 128) >> 8) + 128);
    }
  }
  return i420;
}
function bgraToI420(width, height, bgra) {
  const rgba = Buffer.from(bgra);
  for (let i = 0; i < rgba.length; i += 4) {
    const b = rgba[i], g = rgba[i + 1], r = rgba[i + 2], a = rgba[i + 3];
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
  }
  return rgbaToI420(width, height, rgba);
}

/* ------------ TCP ingest (video) ------------ */
const TCP_PORT = 9001;
const tcp = net.createServer((socket) => {
  let state = 'hello';
  let deviceId = '';
  let buf = Buffer.alloc(0);

  //When TCP socket receives data -> process 
  socket.on('data', (chunk) => {

    //Accumulating incoming bytes 
    buf = Buffer.concat([buf, chunk]);

    try {

      //If state is hello -> parse handshake from Swift Application ("SIMC")
      /**
       * When your Swift streamer connects to Node’s TCP port 9001, it first sends a hello header:
          Field	Size	Meaning
          "SIMC"	4 bytes	Magic identifier
          ver	1 byte	Protocol version
          idLen	2 bytes	Length of deviceId
          deviceId	idLen bytes	UTF-8 string
       */
      if (state === 'hello') {
        if (buf.length < 4 + 1 + 2) return;

        //Get the magic header 
        const magic = buf.subarray(0, 4).toString('ascii');

        //Check if the header is correct (SIMC)
        if (magic !== 'SIMC') {
          err('[tcp] bad magic');
          socket.destroy();
          return;
        }
        //Consume those bytes 
        buf = buf.subarray(4);

        //Get the version protocol and consume it 
        const ver = buf[0];
        buf = buf.subarray(1);

        //Get the payload/message length/size 
        const idLen = buf.readUInt16BE(0);
        buf = buf.subarray(2);

        //Is the payload/message complete -> if not, return
        if (buf.length < idLen) return;

        //Get the device id  and consume it 
        deviceId = buf.subarray(0, idLen).toString('utf8');
        buf = buf.subarray(idLen);

        //Prepare the WebRTC source and pusher for this room/device id
        const r = room(deviceId);
        ensureSource(r);
        ensurePusher(r, 24);

        //Set state to frames to start receiving frames....
        state = 'frames';
        log(`[tcp] hello from deviceId=${deviceId} ver=${ver}`);
      }

      /**
       * Frame parsing logic - parse as many frames in frame buffer right now
       * 
       * per-frame header layout is:
            Field	Size (bytes)	Offset
            frameLen	4 (UInt32 BE)	0
            width	4 (UInt32 BE)	4
            height	4 (UInt32 BE)	8
            tsNs	8 (UInt64 BE)	12
            payload	frameLen	20

            frameLen → length of the payload that follows.
            width, height → supposed frame dimensions.
            tsNs → timestamp in nanoseconds, as a 64-bit big-endian integer.

        For each frame in the TCP buffer:
            Read header: frameLen, width, height, tsNs.
            Slice out frameLen bytes as payload.
            Detect format:
              I420 (exact or padded)
              BGRA
              JPEG
            Fix mistakes:
              Bad height in header
              Slightly mis-sized I420 payloads
            Convert everything to I420.
            Save into room(deviceId).pending for WebRTC.
            Repeat if there’s more data in buf.
       */
      while (state === 'frames') {

        //If we don’t even have the full header yet, stop and wait for more bytes.
        if (buf.length < 4 + 4 + 4 + 8) return;


        const frameLen = buf.readUInt32BE(0);
        let width = buf.readUInt32BE(4);
        let height = buf.readUInt32BE(8);
        const tsNs = Number(buf.readBigUInt64BE(12));

        //If we don’t have 20 + frameLen bytes yet: We have a partial frame → stop and wait for more.
        if (buf.length < 20 + frameLen) return;

        //Get the payload and consume header
        const payload = buf.subarray(20, 20 + frameLen);
        buf = buf.subarray(20 + frameLen);

        //Get the room for this device 
        const r = room(deviceId);
        ensureSource(r);
        ensurePusher(r, 24);

        //Detect frame type & compute expected sizes        
        const isJPEG = payload.length >= 3 && payload[0] === 0xFF && payload[1] === 0xD8 && payload[2] === 0xFF;
        const expRGBA = width * height * 4;
        let expI420 = (width * height * 3) >> 1;
        const looksRaw = !isJPEG && (payload.length % 4 === 0);

        //Choose how to interpret payload & convert to I420
        try {
          let i420;

          //Try to fix I420 header mismatch if payload length doesn’t match
          if (!isJPEG && payload.length !== expI420) {
            const num = payload.length * 2, den = 3 * width;
            if (den > 0 && num % den === 0) {
              const inferredH = num / den;
              if ((inferredH & 1) === 0) {
                warn(`[tcp] I420 header mismatch: len=${payload.length} for ${width}x${height} → inferring height=${inferredH}`);
                height = inferredH;
                expI420 = (width * height * 3) >> 1;
              }
            }
          }
          //Exact I420 
          if (!isJPEG && payload.length === expI420) {
            if (VERBOSE) log(`[tcp] I420 direct len=${payload.length} w=${width} h=${height} ts=${tsNs}`);
            i420 = Buffer.from(payload);
          }
          //Slightly-too-long I420 (extra padding)
          else if (!isJPEG && payload.length > expI420 && payload.length - expI420 <= width) {
            warn(`[tcp] I420 len=${payload.length} > exp=${expI420} — clamping`);
            i420 = Buffer.from(payload.subarray(0, expI420));
          }
          // BGRA raw frame
          else if (looksRaw && payload.length === expRGBA) {
            warn('[tcp] got BGRA — converting to I420');
            i420 = bgraToI420(width, height, payload);
          }
          // JPEG compressed frame  JPEG → decode → I420
          else if (isJPEG) {
            const raw = jpeg.decode(payload, { useTArray: true });
            const rgba = Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength);
            i420 = rgbaToI420(raw.width, raw.height, rgba);
            width = raw.width; height = raw.height;
            const expFromJpeg = (width * height * 3) >> 1;
            if (i420.length !== expFromJpeg) i420 = Buffer.from(i420.subarray(0, expFromJpeg));
            if (VERBOSE) log(`[tcp] JPEG len=${payload.length} → I420 ${width}x${height}`);
          }
          // Case 5: unknown format, drop
          else {
            warn(`[tcp] unknown payload len=${payload.length}, dropping`);
            continue;
          }

          //Updates the latest frame for this device id 
          room(deviceId).pending = { w: width, h: height, data: i420 };
          room(deviceId).seeded = true;

        } catch (e) {
          err('[tcp] ingest error for', deviceId, e?.message || e);
        }
      }
    } catch (e) {
      err('[tcp] parse error', e);
      socket.destroy();
    }
  });

  socket.on('close', () => { if (deviceId) log(`[tcp] closed ${deviceId}`); });
});
tcp.listen(TCP_PORT, () => log(`TCP ingest :${TCP_PORT}`));

/* ------------ Control TCP (downstream to Swift) ------------ */
const CONTROL_PORT = 9002;
const ctlServer = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  let deviceId = '';

  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!deviceId) {
      if (buf.length < 4 + 1 + 2) return;
      const magic = buf.subarray(0, 4).toString('ascii');
      if (magic !== 'SIMK') { sock.destroy(); return; }
      buf = buf.subarray(4);
      const ver = buf[0]; 
      buf = buf.subarray(1);
      const idLen = buf.readUInt16BE(0); 
      buf = buf.subarray(2);
      if (buf.length < idLen) return;
      deviceId = buf.subarray(0, idLen).toString('utf8'); 
      buf = buf.subarray(idLen);
      controlSockets.set(deviceId, sock);
      log('[ctl] hello from', deviceId, 'ver', ver);
    }
  });

  sock.on('close', () => {
    if (deviceId && controlSockets.get(deviceId) === sock) {
      controlSockets.delete(deviceId);
      log('[ctl] closed', deviceId);
    }
  });
});
ctlServer.listen(CONTROL_PORT, () => log(`Control TCP :${CONTROL_PORT}`));

/* ------------ adb manager (Android only) ------------ */

// deviceId -> { proc, queue: string[], busy: boolean }
const adbSessions = new Map();
// simple pointer state: deviceId -> { downX, downY, downTime }
const pointerState = new Map();

/**
 * Map logical deviceId to adb serial.
 * For now, we assume deviceId == adb serial.
 * If your emulator adb name is different (e.g. "emulator-5554"),
 * adjust this to map "sim-android-36" -> "emulator-5554" or similar.
 */
function adbSerialFor(deviceId) {

  if (deviceId === 'sim-android-36') return 'emulator-5554';
  return deviceId;
}

/**
 * Decide if this deviceId should use adb (Android/emulator)
 * vs Swift control socket (iOS).
 *
 * Your Android ids look like: "sim-android-36"
 */
function isAndroidDevice(deviceId) {
  const id = (deviceId || '').toLowerCase();
  return id.startsWith('sim-android-') || id.startsWith('android-');
}

let sessions = 0;
/**
 * Ensure a single long-running `adb -s <serial> shell` per deviceId.
 */
function ensureAdbSession(deviceId) {
  let sess = adbSessions.get(deviceId);
  if (sess && sess.proc && !sess.proc.killed) return sess;

  const serial = adbSerialFor(deviceId);
  log('[adb]', deviceId, 'starting adb shell for', serial);

  const proc = spawn('adb', ['-s', serial, 'shell'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  sessions++;
  console.log("Android session spawning", sessions);

  proc.stdout.on('data', (chunk) => {
    if (VERBOSE) log('[adb]', deviceId, 'stdout:', chunk.toString().trim());
  });
  proc.stderr.on('data', (chunk) => {
    warn('[adb]', deviceId, 'stderr:', chunk.toString().trim());
  });
  proc.on('exit', (code, signal) => {
    warn('[adb]', deviceId, 'adb shell exited', { code, signal });
    const s = adbSessions.get(deviceId);
    if (s && s.proc === proc) {
      adbSessions.delete(deviceId);
    }
  });

  sess = { proc, queue: [], busy: false };
  adbSessions.set(deviceId, sess);
  return sess;
}

/**
 * Enqueue a single adb shell command (no newline; we append it).
 */
function enqueueAdbCommand(deviceId, command) {
  const sess = ensureAdbSession(deviceId);
  sess.queue.push(command);
  drainAdbQueue(deviceId);
}

function drainAdbQueue(deviceId) {
  const sess = adbSessions.get(deviceId);
  if (!sess || !sess.proc || sess.proc.killed) return;
  if (sess.busy) return;

  const cmd = sess.queue.shift();
  if (!cmd) return;

  sess.busy = true;
  if (VERBOSE) log('[adb]', deviceId, '>>', cmd);

  sess.proc.stdin.write(cmd + '\n', (err) => {
    sess.busy = false;
    if (err) {
      console.error('[adb]', deviceId, 'stdin error:', err.message || err);
      return;
    }
    setImmediate(() => drainAdbQueue(deviceId));
  });
}

/**
 * Convert normalized x,y (0..1) to pixel coords for this device's current frame.
 */
function normToPixels(deviceId, x, y) {
  const r = room(deviceId);
  const pw = 1080 || r.pending?.w || 1080;
  const ph = 2424 || r.pending?.h || 2400;
  const px = Math.max(0, Math.min(pw - 1, Math.round(x * pw)));
  const py = Math.max(0, Math.min(ph - 1, Math.round(y * ph)));
  return { x: px, y: py };
}

function handleAndroidPointer(deviceId, msg) {
  const { kind, x, y, dy } = msg;
  const now = Date.now();
  let state = pointerState.get(deviceId) || null;

  if (kind === 'down') {
    const { x: px, y: py } = normToPixels(deviceId, x, y);
    state = { downX: px, downY: py, downTime: now };
    pointerState.set(deviceId, state);
    return;
  }

  if (kind === 'move') {
    // For now ignore continuous move; we interpret on 'up'.
    return;
  }

  if (kind === 'up') {
    if (!state) return;
    const { x: upx, y: upy } = normToPixels(deviceId, x, y);
    const dt = now - state.downTime;
    const dxp = Math.abs(upx - state.downX);
    const dyp = Math.abs(upy - state.downY);

    const TAP_DIST = 10;
    const TAP_TIME = 250;

    if (dxp <= TAP_DIST && dyp <= TAP_DIST && dt <= TAP_TIME) {
      // Tap
      enqueueAdbCommand(deviceId, `input tap ${state.downX} ${state.downY}`);
    } else {
      // Swipe
      const duration = Math.min(Math.max(dt, 80), 600);
      enqueueAdbCommand(
        deviceId,
        `input swipe ${state.downX} ${state.downY} ${upx} ${upy} ${duration}`,
      );
    }
    pointerState.delete(deviceId);
    return;
  }

  if (kind === 'scroll') {
    // Map wheel scroll to swipe near center of screen
    const r = room(deviceId);
    const ph = 2424 || r.pending?.h || 2400;
    const { x: cx, y: cy } = normToPixels(deviceId, 0.5, 0.5);
    const DIST = Math.round(ph * 0.15);
    const duration = 200;

    let x1 = cx;
    let y1 = cy;
    let x2 = cx;
    let y2 = cy;

    if (typeof dy === 'number' && dy > 0) {
      // scroll down => swipe up
      y2 = Math.max(0, y1 - DIST);
    } else if (typeof dy === 'number' && dy < 0) {
      // scroll up => swipe down
      y2 = Math.min(ph - 1, y1 + DIST);
    }

    enqueueAdbCommand(
      deviceId,
      `input swipe ${x1} ${y1} ${x2} ${y2} ${duration}`,
    );
  }
}

function escapeAdbText(text) {
  // basic escaping: spaces & quotes
  return text.replace(/ /g, '%s').replace(/"/g, '\\"');
}

function handleAndroidText(deviceId, msg) {
  if (!msg.text) return;
  const t = escapeAdbText(msg.text);
  enqueueAdbCommand(deviceId, `input text "${t}"`);
}

function mapKeyToAdbKeycode(msg) {
  const k = (msg.key || '').toLowerCase();
  const code = msg.code;

  if (k === 'enter') return 'KEYCODE_ENTER';
  if (k === 'backspace' || code === 'Backspace') return 'KEYCODE_DEL';
  if (k === 'escape' || code === 'Escape') return 'KEYCODE_BACK';
  if (code === 'ArrowUp') return 'KEYCODE_DPAD_UP';
  if (code === 'ArrowDown') return 'KEYCODE_DPAD_DOWN';
  if (code === 'ArrowLeft') return 'KEYCODE_DPAD_LEFT';
  if (code === 'ArrowRight') return 'KEYCODE_DPAD_RIGHT';
  if (code === 'Home') return 'KEYCODE_HOME';

  return null;
}

function handleAndroidKey(deviceId, msg) {
  const keycode = mapKeyToAdbKeycode(msg);
  if (!keycode) return;
  if (msg.action === 'down') {
    enqueueAdbCommand(deviceId, `input keyevent ${keycode}`);
  }
}



/* ------------ signaling (WS) ------------ */

const httpServer = http.createServer();
const wss = new WebSocketServer({ server: httpServer, path: '/signal' });

wss.on('connection', (ws) => {
  let deviceId = null;
  let viewer = null;

  log('[signal] viewer WS connected');

  ws.on('message', async (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (!deviceId) deviceId = (msg.deviceId || '').toString();

    // control from browser → Swift (with logs)
    if (msg.type === 'pointer' || msg.type === 'key' || msg.type === 'text') {
      // DEBUG: log every incoming control event
      log(
        '[signal] ctl',
        'deviceId=' + deviceId,
        'type=' + msg.type,
        'kind=' + (msg.kind || ''),
        'key=' + (msg.key || ''),
        'code=' + (msg.code || ''),
        'x=' + (msg.x ?? ''),
        'y=' + (msg.y ?? '')
      );

      // Android/emulator path: use adb input commands
      if (isAndroidDevice(deviceId)) {
        if (msg.type === 'pointer') {
          handleAndroidPointer(deviceId, msg);
        } else if (msg.type === 'text') {
          handleAndroidText(deviceId, msg);
        } else if (msg.type === 'key') {
          handleAndroidKey(deviceId, msg);
        }
        return;
      }

      // iOS/Swift path: forward to control TCP socket
      const sock = controlSockets.get(deviceId);
      if (!sock) {
        warn('[ctl] no control socket for', deviceId, '— cannot forward', msg.type);
        return;
      }
      try {
        const payload = Buffer.from(JSON.stringify(msg), 'utf8');
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32BE(payload.length, 0);
        sock.write(header); sock.write(payload);
        log(
          '[ctl] →',
          deviceId,
          msg.type,
          msg.kind || msg.action || (msg.text ? 'text' : ''),
          msg.code || '',
          msg.key || '',
          msg.x && msg.x.toFixed ? msg.x.toFixed(3) : '',
          msg.y && msg.y.toFixed ? msg.y.toFixed(3) : ''
        );
      } catch (e) {
        err('[ctl] forward error for', deviceId, e && e.message ? e.message : e);
      }
      return;
    }

    if (msg.type === 'iam-viewer') {
      const r = room(deviceId);
      const wasEmpty = r.viewers.size === 0;
      ensureSource(r);
      ensurePusher(r, 24);
      log('[signal] viewer for', deviceId);

      // FIRST viewer: ensure we have something to show (slate if needed)
      if (!r.seeded && !r.pending) {
        r.pending = makeI420Slate(360, 640, 32, 128, 128);
        log('[signal] seeding slate for', deviceId);
      }

      const pc = new wrtc.RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });
      const stream = new wrtc.MediaStream();
      const sender = pc.addTrack(r.track, stream);
      if (sender) {
        const p = sender.getParameters();
        p.degradationPreference = 'maintain-framerate';
        p.encodings = [{ maxBitrate: 1_200_000, maxFramerate: 24, priority: 'high' }];
        try { await sender.setParameters(p); } catch { }
      }
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          ws.send(JSON.stringify({ type: 'ice', deviceId, candidate: e.candidate }));
        }
      };

      viewer = { id: uuidv4(), pc, ws };
      r.viewers.add(viewer);

      if (wasEmpty) {
        // FIRST viewer: tell Mac to start streaming
        sendStreamCommand(deviceId, 'start');
      }
      return;
    }

    if (msg.type === 'offer' && viewer) {
      log('[signal] offer for', deviceId);
      await viewer.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      const answer = await viewer.pc.createAnswer();
      await viewer.pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'answer', deviceId, sdp: answer.sdp }));
      log('[signal] answer sent for', deviceId);
      return;
    }

    if (msg.type === 'ice' && viewer) {
      try { await viewer.pc.addIceCandidate(msg.candidate); } catch { }
      return;
    }
  });

  ws.on('close', () => {
    if (!deviceId || !viewer) return;
    const r = room(deviceId);
    try { viewer.pc.close(); } catch { }
    r.viewers.delete(viewer);
    log('[signal] viewer closed for', deviceId);

    if (r.viewers.size === 0) {
      // LAST viewer: tell Mac to stop streaming
      sendStreamCommand(deviceId, 'stop');
      maybeStopPusher(r);
    }
  });
});

const WS_PORT = 8080;
httpServer.listen(WS_PORT, () => {
  log(`Signal WS :${WS_PORT}  (ws://<ip>:${WS_PORT}/signal)`);
});