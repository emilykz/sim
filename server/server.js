// server/server.js
import http from 'http';
import net from 'net';
import { WebSocketServer } from 'ws';
import wrtc from '@roamhq/wrtc';
import jpeg from 'jpeg-js';
import { v4 as uuidv4 } from 'uuid';

import { spawn, execFileSync } from 'child_process';

// --- ADB path resolution (Android only) ---
let ADB = process.env.ADB || process.env.adb || 'adb';
try {
  const found = execFileSync('which', ['adb'], { encoding: 'utf8' }).trim();
  if (found) ADB = found;
} catch (_) {
  // ignore; keep fallback
}
log('[env] adb=', ADB);


const VERBOSE = process.env.VERBOSE === '1';

function log(...a) { console.log(...a) }
function warn(...a) { console.warn(...a) }
function err(...a) { console.error(...a) }

/**
 * For each device:
 *    * source – RTCVideoSource (WebRTC frame source).
 *      track – MediaStreamTrack created from source.
 *      viewers – Set of active WebRTC viewers { pc, ws, id }.
 *      count – number of frames pushed so far.
 *      pending – latest video frame buffer { w, h, data } in I420.
 *      pusher – used to represent “pushing enabled” (no longer setInterval).
 *      seeded – whether we’ve already received at least one real frame.
 *
 * CHANGE (PERF): Push is now event-driven (push only when a NEW frame arrives),
 * instead of setInterval pushing the same pending frame repeatedly (forces re-encode).
 */
const sims = new Map(); // deviceId -> { source, track, viewers:Set, count, pending, pusher, seeded, ... }

function room(id) {
  if (!sims.has(id)) {
    sims.set(id, {
      source: null,
      track: null,
      viewers: new Set(),
      count: 0,
      pending: null,
      pusher: null,
      seeded: false,
      controllerId: null, // viewer.id that currently owns control


      // CHANGE (PERF): event-driven scheduling state
      pendingSeq: 0,
      lastPushedSeq: 0,
      pushTimer: null,
      lastPushMs: 0,
      fps: 24,

      // CHANGE (PERF): adaptive quality state (shared per device)
      qualityState: null,

      // CHANGE (DEBUG): basic counters to verify we’re not over-pushing
      stats: {
        framesIn: 0,
        framesPushed: 0,
        i420Ok: 0,
        i420Bad: 0,
        lastLog: Date.now(),
      },
    });
  }
  return sims.get(id);
}

function ensureSource(r) {
  if (!r.source) {
    r.source = new wrtc.nonstandard.RTCVideoSource();
    r.track = r.source.createTrack();
    log('[video] created RTCVideoSource/Track');
  }
}

/**
 * “Enable pushing” and schedule pushes only when new frames arrive.
 *
 */
function ensurePusher(r, fps = 15) {
  // “pusher” now means “pushing enabled”
  r.pusher = true;
  r.fps = fps || 24;
}

/**
 * 
 * Push one frame into WebRTC, but never more than fps. If frames arrive faster, 
 * we drop intermediate and only push latest pending.
 * 
 */
function schedulePush(r) {
  if (!r.pusher) return;                 // pushing not enabled
  if (r.viewers.size === 0) return;      // no viewers -> don't push
  if (!r.source) return;

  // If a timer is already scheduled, we’ll let it fire and pick up the latest pending then.
  if (r.pushTimer) return;

  const intervalMs = Math.max(1, Math.floor(1000 / (r.fps || 24)));
  const now = Date.now();
  const sinceLast = now - (r.lastPushMs || 0);
  const delay = Math.max(0, intervalMs - sinceLast);

  r.pushTimer = setTimeout(() => {
    r.pushTimer = null;

    const p = r.pending;
    if (!p) return;

    // Only push if a NEW frame arrived since last push.
    if (r.lastPushedSeq === r.pendingSeq) return;
    r.lastPushedSeq = r.pendingSeq;

    // pushes frame to webrtc
    r.source.onFrame({ width: p.w, height: p.h, data: p.data });
    r.count++;
    r.lastPushMs = Date.now();

    // DEBUG counters: in vs pushed, plus I420 size sanity
    r.stats.framesPushed++;
    const exp = (p.w * p.h * 3) >> 1;
    if (p.data && p.data.length === exp) r.stats.i420Ok++;
    else r.stats.i420Bad++;

    // Log every ~5s per device (lightweight)
    const t = Date.now();
    if (t - r.stats.lastLog >= 5000) {
      r.stats.lastLog = t;
      // log(`[stats] pushed=${r.stats.framesPushed} in=${r.stats.framesIn} i420Ok=${r.stats.i420Ok} i420Bad=${r.stats.i420Bad} viewers=${r.viewers.size} fps=${r.fps}`);
    }

    // If another new frame arrived while we were pushing (seq advanced), schedule again.
    if (r.pending && r.lastPushedSeq !== r.pendingSeq) {
      schedulePush(r);
    }
  }, delay);
}

// Stops pushing if there are no viewers
function maybeStopPusher(r) {
  if (r.viewers.size === 0 && r.pusher) {
    if (r.pushTimer) {
      clearTimeout(r.pushTimer);
      r.pushTimer = null;
    }
    r.pusher = null;
    r.seeded = false;
    r.pending = null;
    r.pendingSeq = 0;
    r.lastPushedSeq = 0;
    log('[push] stopped pusher (no viewers)');
  }
}

/* ------------ control sockets (input) ------------ */
const controlSockets = new Map(); // deviceId -> net.Socket

// CHANGE (PERF/HARDEN): queue control messages until the device control socket arrives.
// This fixes the race where the viewer connects before the Mac agent has completed its SIMK hello.
const pendingCtl = new Map(); // deviceId -> Buffer[]

function _encodeCtl(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  return [header, payload];
}

function sendCtl(deviceId, obj) {
  const sock = controlSockets.get(deviceId);
  const parts = _encodeCtl(obj);

  if (!sock) {
    const q = pendingCtl.get(deviceId) || [];
    q.push(...parts);
    pendingCtl.set(deviceId, q);
    return false;
  }
  try {
    for (const b of parts) sock.write(b);
    return true;
  } catch (e) {
    err('[ctl] write error for', deviceId, e?.message || e);
    return false;
  }
}

function flushCtl(deviceId) {
  const sock = controlSockets.get(deviceId);
  const q = pendingCtl.get(deviceId);
  if (!sock || !q || q.length === 0) return;
  try {
    for (const b of q) sock.write(b);
  } catch (e) {
    err('[ctl] flush error for', deviceId, e?.message || e);
  }
  pendingCtl.delete(deviceId);
}

// helper: send a stream start/stop command to the Mac streamer
function sendStreamCommand(deviceId, action) {
  const msg = { type: 'stream', action, deviceId };
  const ok = sendCtl(deviceId, msg);
  if (!ok) {
    warn('[ctl] no control socket for', deviceId, '— queued stream', action);
  } else {
    log('[ctl] →', deviceId, 'stream', action);
  }
}

function sendQuality(deviceId, q) {
  const msg = { type: 'quality', ...q, deviceId };
  const ok = sendCtl(deviceId, msg);
  if (!ok) {
    warn('[ctl] no control socket for', deviceId, '— queued quality', JSON.stringify(q));
  } else {
    log('[ctl] →', deviceId, 'quality', JSON.stringify(q));
  }
}

// CHANGE (PERF): adaptive quality (no TURN/SFU required).
// We use sender-side WebRTC stats (RTT + packet loss) and apply:
//   1) WebRTC sender caps (maxBitrate/maxFramerate)
//   2) Capture-side request (fps + maxWidth) via control socket
// With hysteresis + min time between changes to avoid oscillation.

const QUALITY_PROFILES = {
  high: { name: 'high', maxWidth: 1080, fps: 30, maxBitrate: 2_500_000, maxFramerate: 30 },
  med: { name: 'med', maxWidth: 960, fps: 24, maxBitrate: 1_600_000, maxFramerate: 24 },
  low: { name: 'low', maxWidth: 720, fps: 15, maxBitrate: 900_000, maxFramerate: 15 },
};

const QUALITY_HYSTERESIS = {
  // downgrade quickly
  toLow: { rttMs: 220, loss: 0.030 },
  toMed: { rttMs: 140, loss: 0.015 },
  // upgrade conservatively
  toHigh: { rttMs: 110, loss: 0.010 },
  toMedUp: { rttMs: 180, loss: 0.025 },
};

function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

function pickProfile(currentName, rttMs, loss) {
  const cur = currentName || 'med';

  // Downgrades
  if (rttMs >= QUALITY_HYSTERESIS.toLow.rttMs || loss >= QUALITY_HYSTERESIS.toLow.loss) return 'low';
  if (rttMs >= QUALITY_HYSTERESIS.toMed.rttMs || loss >= QUALITY_HYSTERESIS.toMed.loss) return 'med';

  // Upgrades (hysteresis)
  if (cur === 'low') {
    // only upgrade out of low when clearly better than the low thresholds
    if (rttMs <= QUALITY_HYSTERESIS.toMedUp.rttMs && loss <= QUALITY_HYSTERESIS.toMedUp.loss) return 'med';
    return 'low';
  }
  if (cur === 'med') {
    if (rttMs <= QUALITY_HYSTERESIS.toHigh.rttMs && loss <= QUALITY_HYSTERESIS.toHigh.loss) return 'high';
    return 'med';
  }
  return 'high';
}

async function readOutboundRttLoss(pc, memo) {
  // Returns { rttMs, loss } best-effort.
  // In Chromium-style stats, RTT is often on `remote-inbound-rtp` for the video sender.
  let rttMs = 0;
  let loss = 0;

  try {
    const stats = await pc.getStats();
    let bestRemote = null;
    stats.forEach((s) => {
      if (s.type === 'remote-inbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) {
        bestRemote = s;
      }
    });

    if (bestRemote) {
      const rttSec = bestRemote.roundTripTime || bestRemote.totalRoundTripTime;
      if (typeof rttSec === 'number') rttMs = Math.round(rttSec * 1000);

      // loss estimate using cumulative packetsLost/packetsReceived deltas
      const lost = Number(bestRemote.packetsLost || 0);
      const recv = Number(bestRemote.packetsReceived || 0);
      if (!memo.last) memo.last = { lost, recv };
      const dLost = Math.max(0, lost - memo.last.lost);
      const dRecv = Math.max(0, recv - memo.last.recv);
      const denom = dLost + dRecv;
      if (denom > 0) loss = clamp01(dLost / denom);
      memo.last = { lost, recv };
    }
  } catch (_) {
    // ignore
  }

  return { rttMs, loss };
}

async function applySenderCaps(sender, profile) {
  if (!sender || !profile) return;
  try {
    const p = sender.getParameters() || {};
    p.degradationPreference = 'maintain-resolution'; // better text readability for device UIs
    if (!p.encodings || p.encodings.length === 0) p.encodings = [{}];
    p.encodings[0].maxBitrate = profile.maxBitrate;
    p.encodings[0].maxFramerate = profile.maxFramerate;
    await sender.setParameters(p);
  } catch (_) {
    // some builds may throw; safe to ignore
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

/**
 * Chunk queue that can read N bytes, zero-copy when possible.
 */
function makeChunkReader() {
  let chunks = [];
  let total = 0;

  function push(chunk) {
    if (!chunk || chunk.length === 0) return;
    chunks.push(chunk);
    total += chunk.length;
  }

  //If we don’t have enough bytes yet, return null.
  function read(n) {
    if (total < n) return null;

    //FAST PATH: if the first chunk alone satisfies the request, return a subarray (zero-copy)
    const first = chunks[0];
    if (first.length >= n) {
      const out = first.subarray(0, n);
      const rest = first.subarray(n);
      chunks[0] = rest;
      if (rest.length === 0) chunks.shift();
      total -= n;
      return out;
    }

    //SLOW PATH: spans multiple chunks -> copy into one buffer
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const c = chunks[0];
      const take = Math.min(c.length, n - off);
      c.copy(out, off, 0, take);
      off += take;

      if (take === c.length) {
        chunks.shift();
      } else {
        chunks[0] = c.subarray(take);
      }
      total -= take;
    }
    return out;
  }

  function available() { return total; }
  return { push, read, available };
}

/* ------------ TCP ingest (video) ------------ */
const TCP_PORT = 9001;
const tcp = net.createServer((socket) => {
  // CHANGE (PERF): reduce latency on lossy/long-haul links (avoid Nagle delays)
  try { socket.setNoDelay(true); } catch (_) { }

  let state = 'hello';
  let deviceId = '';

  //PERF: chunk reader instead of Buffer.concat
  const rdr = makeChunkReader();

  //HARDEN: if TCP splits header/payload, we stash the last header until full payload arrives
  let pendingFrameHeader = null; // { frameLen, width, height, tsNs }

  //When TCP socket receives data -> process
  socket.on('data', (chunk) => {

    //Accumulating incoming bytes
    rdr.push(chunk);

    try {

      //If state is hello -> parse handshake from Swift Application ("SIMC")
      /**
       * When your Swift streamer connects to Node’s TCP port 9001, it first sends a hello header:
       *    Field  Size    Meaning
       *    "SIMC" 4 bytes Magic identifier
       *    ver    1 byte  Protocol version
       *    idLen  2 bytes Length of deviceId
       *    deviceId idLen bytes UTF-8 string
       */
      if (state === 'hello') {
        if (rdr.available() < 4 + 1 + 2) return;

        //Get the magic header
        const magicBuf = rdr.read(4);
        const magic = magicBuf.toString('ascii');

        //Check if the header is correct (SIMC)
        if (magic !== 'SIMC') {
          err('[tcp] bad magic');
          socket.destroy();
          return;
        }

        //Get the version protocol and consume it
        const verBuf = rdr.read(1);
        const ver = verBuf[0];

        //Get the payload/message length/size
        const idLenBuf = rdr.read(2);
        const idLen = idLenBuf.readUInt16BE(0);

        //Is the payload/message complete -> if not, return
        if (rdr.available() < idLen) return;

        //Get the device id
        const idBuf = rdr.read(idLen);
        deviceId = idBuf.toString('utf8');

        //Prepare the WebRTC source for this room/device id
        //PERF: Do NOT start pusher here; only start when there is a viewer.
        const r = room(deviceId);
        ensureSource(r);

        //Set state to frames to start receiving frames....
        state = 'frames';
        log(`[tcp] hello from deviceId=${deviceId} ver=${ver}`);
      }

      /**
       * Frame parsing logic - parse as many frames in frame buffer right now
       *
       * per-frame header layout is:
       *    Field     Size (bytes) Offset
       *    frameLen  4 (UInt32 BE) 0
       *    width     4 (UInt32 BE) 4
       *    height    4 (UInt32 BE) 8
       *    tsNs      8 (UInt64 BE) 12
       *    payload   frameLen      20
       */
      while (state === 'frames') {

        //If we don’t even have the full header yet, stop and wait for more bytes.
        if (rdr.available() < 4 + 4 + 4 + 8) return;

        //Read (or reuse) header
        if (!pendingFrameHeader) {
          if (rdr.available() < 20) return;

          const hdr = rdr.read(20);
          const frameLen = hdr.readUInt32BE(0);
          const width = hdr.readUInt32BE(4);
          const height = hdr.readUInt32BE(8);
          const tsNs = Number(hdr.readBigUInt64BE(12));

          //Sanity checks (protect against desync / bogus lengths)
          //NOTE: if these trigger, we likely lost framing; safest is to drop the socket and reconnect.
          const MAX_FRAME_BYTES = 50 * 1024 * 1024; //50MB
          if (frameLen <= 0 || frameLen > MAX_FRAME_BYTES || width <= 0 || height <= 0 || width > 8192 || height > 8192) {
            warn(`[tcp] bad header frameLen=${frameLen} w=${width} h=${height} (dropping socket)`);
            socket.destroy();
            return;
          }

          pendingFrameHeader = { frameLen, width, height, tsNs };
        }

        //If we don’t have payload yet: We have a partial frame → stop and wait for more.
        //HARDEN: we stashed the parsed header so we won't lose framing across TCP packet boundaries.
        if (rdr.available() < pendingFrameHeader.frameLen) return;

        // NOTE: width/height are const within this scope for safety (don't mutate header vars)
        const { frameLen, width, height, tsNs } = pendingFrameHeader;
        pendingFrameHeader = null;

        //Get the payload
        const payload = rdr.read(frameLen);

        //Get the room for this device
        const r = room(deviceId);
        ensureSource(r);
        //PERF: Do NOT ensurePusher here; only start when there is a viewer.

        //Detect frame type & compute expected sizes
        const isJPEG = payload.length >= 3 && payload[0] === 0xFF && payload[1] === 0xD8 && payload[2] === 0xFF;
        const expRGBA = width * height * 4;
        let expI420 = (width * height * 3) >> 1;
        const looksRaw = !isJPEG && (payload.length % 4 === 0);

        //Choose how to interpret payload & convert to I420
        try {
          let i420;
          let outW = width;
          let outH = height;

          //Try to fix I420 header mismatch if payload length doesn’t match
          if (!isJPEG && payload.length !== expI420) {
            const num = payload.length * 2, den = 3 * width;
            if (den > 0 && num % den === 0) {
              const inferredH = num / den;
              if ((inferredH & 1) === 0) {
                warn(`[tcp] I420 header mismatch: len=${payload.length} for ${width}x${height} → inferring height=${inferredH}`);
                outH = inferredH;
                expI420 = (outW * outH * 3) >> 1;
              }
            }
          }

          //Exact I420
          if (!isJPEG && payload.length === expI420) {
            if (VERBOSE) log(`[tcp] I420 direct len=${payload.length} w=${outW} h=${outH} ts=${tsNs}`);
            //PERF: zero-copy (payload already a Buffer)
            i420 = payload;
          }
          //Slightly-too-long I420 (extra padding)
          else if (!isJPEG && payload.length > expI420 && payload.length - expI420 <= outW) {
            warn(`[tcp] I420 len=${payload.length} > exp=${expI420} — clamping`);
            //PERF: zero-copy slice
            i420 = payload.subarray(0, expI420);
          }
          // BGRA raw frame
          else if (looksRaw && payload.length === expRGBA) {
            warn('[tcp] got BGRA — converting to I420');
            i420 = bgraToI420(outW, outH, payload);
          }
          // JPEG compressed frame  JPEG → decode → I420
          else if (isJPEG) {
            const raw = jpeg.decode(payload, { useTArray: true });
            const rgba = Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength);
            i420 = rgbaToI420(raw.width, raw.height, rgba);
            outW = raw.width; outH = raw.height;
            const expFromJpeg = (outW * outH * 3) >> 1;
            if (i420.length !== expFromJpeg) i420 = i420.subarray(0, expFromJpeg);
            if (VERBOSE) log(`[tcp] JPEG len=${payload.length} → I420 ${outW}x${outH}`);
          }
          // Case 5: unknown format, drop
          else {
            warn(`[tcp] unknown payload len=${payload.length}, dropping`);
            continue;
          }

          //Updates the latest frame for this device id
          r.pending = { w: outW, h: outH, data: i420 };
          r.seeded = true;

          // CHANGE (DEBUG): count incoming frames and sanity-check I420 sizing
          r.stats.framesIn++;
          const exp = (outW * outH * 3) >> 1;
          if (i420 && i420.length === exp) r.stats.i420Ok++;
          else r.stats.i420Bad++;

          // CHANGE (PERF): Push only when a new frame arrives (and only if a viewer exists)
          r.pendingSeq++;
          schedulePush(r);

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
  // CHANGE (PERF): reduce latency for control channel (avoid Nagle delays)
  try { sock.setNoDelay(true); } catch (_) { }

  let deviceId = '';

  //PERF: chunk reader instead of Buffer.concat
  const rdr = makeChunkReader();

  sock.on('data', (chunk) => {
    rdr.push(chunk);

    if (!deviceId) {
      if (rdr.available() < 4 + 1 + 2) return;

      const magicBuf = rdr.read(4);
      const magic = magicBuf.toString('ascii');
      if (magic !== 'SIMK') { sock.destroy(); return; }

      const verBuf = rdr.read(1);
      const ver = verBuf[0];

      const idLenBuf = rdr.read(2);
      const idLen = idLenBuf.readUInt16BE(0);

      if (rdr.available() < idLen) return;

      const idBuf = rdr.read(idLen);
      deviceId = idBuf.toString('utf8');

      controlSockets.set(deviceId, sock);
      flushCtl(deviceId);
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
// emulator config data: deviceId -> { w, h, rotation, source, ts }
const androidInputInfo = new Map();


function parseWmSize(out) {
  // Examples:
  //   Physical size: 1080x2400
  //   Override size: 720x1600
  const override = /Override size:\s*(\d+)x(\d+)/i.exec(out);
  if (override) return { w: Number(override[1]), h: Number(override[2]), source: 'override' };
  const physical = /Physical size:\s*(\d+)x(\d+)/i.exec(out);
  if (physical) return { w: Number(physical[1]), h: Number(physical[2]), source: 'physical' };
  const any = /(\d+)x(\d+)/.exec(out);
  if (any) return { w: Number(any[1]), h: Number(any[2]), source: 'fallback' };
  return null;
}

function parseRotationFromDumpsys(out) {
  // Common patterns across Android versions
  //   mCurrentRotation=ROTATION_0 / ROTATION_1 ...
  //   mRotation=0
  //   rotation 0
  //   SurfaceOrientation: 0
  const m1 = /mCurrentRotation\s*=\s*ROTATION_(\d)/i.exec(out);
  if (m1) return Number(m1[1]) * 90;
  const m2 = /mRotation\s*=\s*(\d)/i.exec(out);
  if (m2) return Number(m2[1]) * 90;
  const m3 = /SurfaceOrientation\s*:\s*(\d)/i.exec(out);
  if (m3) return Number(m3[1]) * 90;
  const m4 = /\brotation\b\s*[:=]?\s*(\d+)/i.exec(out);
  if (m4) {
    const v = Number(m4[1]);
    if (v === 0 || v === 90 || v === 180 || v === 270) return v;
    if (v >= 0 && v <= 3) return v * 90;
  }
  return 0;
}

function ensureAndroidInputInfo(deviceId, serial) {
  const cached = androidInputInfo.get(deviceId);
  if (cached && cached.w && cached.h) return cached;

  try {
    // Query device once and cache.
    const wmOut = execFileSync(ADB, ['-s', serial, 'shell', 'wm', 'size'], { encoding: 'utf8' });
    const size = parseWmSize(wmOut || '');
    let w = size?.w || 1080;
    let h = size?.h || 2400;
    let source = size?.source || 'default';

    let rotation = 0;
    try {
      const dOut = execFileSync(ADB, ['-s', serial, 'shell', 'dumpsys', 'display'], { encoding: 'utf8' });
      rotation = parseRotationFromDumpsys(dOut || '');
    } catch (e) {
      rotation = 0;
    }

    const info = { w, h, rotation, source, ts: Date.now() };
    androidInputInfo.set(deviceId, info);

    // Useful debug: compare input space vs stream space
    const r = room(deviceId);
    const sw = r.pending?.w;
    const sh = r.pending?.h;
    log('[adb]', deviceId, `inputSpace=${w}x${h} (${source}) rotation=${rotation}` + (sw && sh ? ` stream=${sw}x${sh}` : ''));

    return info;
  } catch (e) {
    // Fall back to stream size if available.
    const r = room(deviceId);
    const w = r.pending?.w || 1080;
    const h = r.pending?.h || 2400;
    const info = { w, h, rotation: 0, source: 'fallback', ts: Date.now() };
    androidInputInfo.set(deviceId, info);
    warn('[adb]', deviceId, 'ensureAndroidInputInfo failed; using fallback', `${w}x${h}`, e?.message || e);
    return info;
  }
}

function rotateNorm(x, y, rotationDeg) {
  // rotation is 0/90/180/270
  switch ((rotationDeg || 0) % 360) {
    case 90: return { x: y, y: 1 - x };
    case 180: return { x: 1 - x, y: 1 - y };
    case 270: return { x: 1 - y, y: x };
    default: return { x, y };
  }
}



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

  // Cache input coordinate space (wm size / rotation) once per session.
  ensureAndroidInputInfo(deviceId, serial);

  const proc = spawn(ADB, ['-s', serial, 'shell'], {
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

  // CHANGE (BUGFIX): these were "1080 || ..." which always picked 1080
  let pw = r.pending?.w || 1080;
  let ph = r.pending?.h || 2400;

  const serial = adbSerialFor(deviceId);
  const info = ensureAndroidInputInfo(deviceId, serial);
  pw = info.w;
  ph = info.h;


  const px = Math.max(0, Math.min(pw - 1, Math.round(x * pw)));
  const py = Math.max(0, Math.min(ph - 1, Math.round(y * ph)));
  return { x: px, y: py };
}

function handleAndroidPointer(deviceId, msg) {
  const { kind, x, y, dx = 0, dy = 0 } = msg;
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
    const serial = adbSerialFor(deviceId);
    const info = ensureAndroidInputInfo(deviceId, serial);
    const ph = info.h;

    const total = -(dy || 0);
    if (!total) return;

    const { x: cx, y: cy } = normToPixels(deviceId, 0.5, 0.5);

    // Lighter scroll: ~6%..22% of screen height
    const mag = Math.min(1, Math.abs(total) / 320);
    const DIST = Math.max(40, Math.round(ph * (0.06 + 0.16 * mag)));

    const duration = 200;

    const x1 = cx;
    const y1 = cy;
    const x2 = cx;

    const y2 = total < 0
      ? Math.max(0, y1 - DIST)
      : Math.min(ph - 1, y1 + DIST);

    enqueueAdbCommand(deviceId, `input swipe ${x1} ${y1} ${x2} ${y2} ${duration}`);
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


// CHANGE (CONTROL LOCK): broadcast who has control
function broadcastControlState(deviceId) {
  const r = room(deviceId);
  const msg = JSON.stringify({
    type: 'control-state',
    deviceId,
    controllerId: r.controllerId || null,
  });
  for (const v of r.viewers) {
    try { v.ws.send(msg); } catch (_) { }
  }
}

// CHANGE (CONTROL LOCK): pick the “next” viewer in insertion order (Set preserves insertion order)
function pickNextControllerId(r) {
  for (const v of r.viewers) return v.id;
  return null;
}


wss.on('connection', (ws) => {
  let deviceId = null;
  let viewer = null;

  log('[signal] viewer WS connected');

  ws.on('message', async (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (!deviceId) deviceId = (msg.deviceId || '').toString();

    // control from browser → Swift (with logs)
    if (msg.type === 'pointer' || msg.type === 'key' || msg.type === 'text') {

      // CHANGE (CONTROL LOCK): only controller can send input
      const r = room(deviceId);
      if (!viewer || r.controllerId !== viewer.id) {
        // optional: tell the client it’s view-only
        try {
          ws.send(JSON.stringify({
            type: 'control-denied',
            deviceId,
            controllerId: r.controllerId || null,
          }));
        } catch (_) { }
        return;
      }


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
      const ok = sendCtl(deviceId, msg);
      if (!ok) {
        warn('[ctl] no control socket for', deviceId, '— queued forward', msg.type);
      } else {
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
      }
      return;
    }

    if (msg.type === 'iam-viewer') {
      if (viewer) {
        // already registered for this WS connection
        return;
      }
      const r = room(deviceId);
      const wasEmpty = r.viewers.size === 0;
      ensureSource(r);

      // CHANGE (PERF): default quality profile (can be auto-adjusted via WebRTC stats)
      if (!r.qualityState) {
        r.qualityState = { name: 'med', lastChangeMs: 0 };
      }
      const baseProfile = QUALITY_PROFILES[r.qualityState.name] || QUALITY_PROFILES.med;

      // CHANGE (PERF): enable event-driven pusher (no interval); drive cadence by profile.fps
      ensurePusher(r, baseProfile.fps);

      log('[signal] viewer for', deviceId);

      // FIRST viewer: ensure we have something to show (slate if needed)
      if (!r.seeded && !r.pending) {
        r.pending = makeI420Slate(360, 640, 32, 128, 128);
        r.pendingSeq++;
        log('[signal] seeding slate for', deviceId);
      }

      const pc = new wrtc.RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });
      const stream = new wrtc.MediaStream();
      const sender = pc.addTrack(r.track, stream);
      
      // Create viewer FIRST
      viewer = { id: uuidv4(), pc, ws };
      viewer.sender = sender;
      viewer.statsMemo = {};
      viewer.qualityTimer = null;

      // Start sender stats AFTER viewer exists (optional, but clean)
      const statsTimer = startSenderStats(pc, deviceId);
      viewer.statsTimer = statsTimer;

      r.viewers.add(viewer);
      // CHANGE (PERF): apply initial sender caps + ask capture agent to match
      if (sender) await applySenderCaps(sender, baseProfile);
      sendQuality(deviceId, { fps: baseProfile.fps, maxWidth: baseProfile.maxWidth });
      pc.onicecandidate = (e) => {
        if (e.candidate) {
          ws.send(JSON.stringify({ type: 'ice', deviceId, candidate: e.candidate }));
        }
      };
      // CHANGE (PERF): adaptive quality loop (per viewer)
      // Notes:
      // - This helps long-haul users (India/SF/Boston) by reducing loss + jitter.
      // - No TURN/SFU required: it simply adapts bitrate/FPS/resolution.
      const SAMPLE_MS = 2000;
      const MIN_CHANGE_MS = 8000;
      viewer.qualityTimer = setInterval(async () => {
        // viewer might be closed
        if (!viewer || !viewer.pc) return;

        const { rttMs, loss } = await readOutboundRttLoss(viewer.pc, viewer.statsMemo);
        if (!rttMs && !loss) return;

        const curName = r.qualityState?.name || 'med';
        const nextName = pickProfile(curName, rttMs, loss);

        // Hysteresis: don't flap
        const now = Date.now();
        const lastChange = r.qualityState?.lastChangeMs || 0;
        if (nextName !== curName && (now - lastChange) >= MIN_CHANGE_MS) {
          r.qualityState = { name: nextName, lastChangeMs: now };
          const prof = QUALITY_PROFILES[nextName];
          log('[qos]', deviceId, `rtt=${rttMs}ms loss=${(loss * 100).toFixed(1)}% → ${nextName} (fps=${prof.fps} w<=${prof.maxWidth})`);
          if (viewer.sender) await applySenderCaps(viewer.sender, prof);
          // drive capture + pusher
          r.fps = prof.fps;
          sendQuality(deviceId, { fps: prof.fps, maxWidth: prof.maxWidth });
        }
      }, SAMPLE_MS);

      // CHANGE (CONTROL LOCK): tell this client its viewerId
      try {
        ws.send(JSON.stringify({ type: 'viewer-id', deviceId, viewerId: viewer.id }));
      } catch (_) { }

      // CHANGE (CONTROL LOCK): first viewer becomes controller automatically
      if (!r.controllerId) {
        r.controllerId = viewer.id;
      }
      broadcastControlState(deviceId);

      if (wasEmpty) {
        // FIRST viewer: tell Mac to start streaming
        sendStreamCommand(deviceId, 'start');
      }

      // CHANGE (PERF): push immediately if we already have a pending frame (e.g., slate)
      schedulePush(r);

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

    // CHANGE (PERF): stop adaptive quality sampler
    if (viewer.qualityTimer) {
      try { clearInterval(viewer.qualityTimer); } catch (_) { }
      viewer.qualityTimer = null;
    }

    // ADD: stop sender stats loop (prevents getStats() on closed PC)
    if (viewer.statsTimer) {
      try { clearInterval(viewer.statsTimer); } catch (_) { }
      viewer.statsTimer = null;
    }


    r.viewers.delete(viewer);
    log('[signal] viewer closed for', deviceId);

    // CHANGE (CONTROL LOCK): if controller left, hand control to next viewer
    if (r.controllerId === viewer.id) {
      r.controllerId = pickNextControllerId(r);
      broadcastControlState(deviceId);
    }

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


function startSenderStats(pc, deviceId) {
  const memo = {};
  let stopped = false;

  const timer = setInterval(async () => {
    if (stopped) return;

    // HARD GUARDS (no crash, no silent death)
    if (!pc || pc.connectionState === 'closed') {
      clearInterval(timer);
      return;
    }

    try {
      const { rttMs, loss } = await readOutboundRttLoss(pc, memo);

      if (!Number.isFinite(rttMs)) return;

      const r = room(deviceId);
      const now = Date.now();

      if (!r.qualityState) {
        r.qualityState = { name: 'med', lastChangeMs: 0 };
      }

      // LOG EVERY TIME (temporarily – for debugging)
      log(
        `[qos-sender] ${deviceId}`,
        `rtt=${rttMs}ms`,
        `loss=${(loss * 100).toFixed(2)}%`,
        `viewers=${r.viewers.size}`,
        `profile=${r.qualityState.name}`
      );

      // Adaptive quality logic
      if (now - r.qualityState.lastChangeMs > 5000) {
        const next = pickProfile(r.qualityState.name, rttMs, loss);
        if (next !== r.qualityState.name) {
          r.qualityState = { name: next, lastChangeMs: now };
          const profile = QUALITY_PROFILES[next];

          sendQuality(deviceId, {
            fps: profile.fps,
            maxWidth: profile.maxWidth,
          });

          for (const v of r.viewers) {
            const sender = v.sender;
            if (sender) await applySenderCaps(sender, profile);
          }

          log(`[qos] ${deviceId} → ${next}`);
        }
      }
    } catch (e) {
      warn('[qos] stats read failed:', e.message);
    }
  }, 2000);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
