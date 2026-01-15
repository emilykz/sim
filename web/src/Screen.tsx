// src/Screen.tsx
import React, { useEffect, useRef, useState } from 'react';

type Props = {
  deviceId: string;
  signalUrl: string;            // e.g. ws://192.168.86.30:8080/signal
  videoWidthPx?: number;        // optional CSS width (default 360)
};

export default function Screen({ deviceId, signalUrl, videoWidthPx = 360 }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  const [plus, setPlus] = useState<{ x: number; y: number; on: boolean }>({
    x: 0,
    y: 0,
    on: false,
  });
  
  
  useEffect(() => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    const ws = new WebSocket(signalUrl);

    pc.ontrack = (e) => {
      const [stream] = e.streams;
      if (videoRef.current && stream) {
        videoRef.current.srcObject = stream;
        videoRef.current.autoplay = true;
        videoRef.current.playsInline = true;
        videoRef.current.muted = true;
        (videoRef.current as any).disablePictureInPicture = true;
        videoRef.current.style.width = `${videoWidthPx}px`;
        videoRef.current.style.height = 'auto';
        videoRef.current.style.objectFit = 'contain';
      }
    };

    ws.onopen = async () => {
      ws.send(JSON.stringify({ type: 'iam-viewer', deviceId }));
      const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: false });
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'offer', deviceId, sdp: offer.sdp }));
    };

    ws.onmessage = async (ev) => {
      let msg: any; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'answer' && msg.deviceId === deviceId) {
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      } else if (msg.type === 'ice' && msg.deviceId === deviceId && msg.candidate) {
        try { await pc.addIceCandidate(msg.candidate); } catch {}
      }
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) ws.send(JSON.stringify({ type: 'ice', deviceId, candidate: ev.candidate }));
    };

    return () => { try { ws.close(); } catch {} try { pc.close(); } catch {} };
  }, [deviceId, signalUrl, videoWidthPx]);

  return (
    <div
    ref={wrapRef}
    style={{
      position: 'relative',
      display: 'inline-block',
      cursor: 'none', // 👈 hide system cursor
    }}
    onMouseEnter={() => setPlus(p => ({ ...p, on: true }))}
    onMouseLeave={() => setPlus(p => ({ ...p, on: false }))}
    onMouseMove={(e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      setPlus({
        on: true,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    }}
  >
    <video ref={videoRef} />
  
    {/* + cursor overlay */}
    {plus.on && (
      <div
        style={{
          position: 'absolute',
          left: plus.x,
          top: plus.y,
          transform: 'translate(-50%, -50%)',
          fontSize: 22,
          fontWeight: 700,
          color: 'rgba(0, 255, 255, 0.95)',
          textShadow: '0 0 6px rgba(0,0,0,0.8)',
          pointerEvents: 'none',
          userSelect: 'none',
          lineHeight: 1,
        }}
      >
        +
      </div>
    )}
  </div>
  
  );
}
