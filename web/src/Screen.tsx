// src/Screen.tsx
import React, { useEffect, useRef } from 'react';

type Props = {
  deviceId: string;
  signalUrl: string;            // e.g. ws://192.168.86.30:8080/signal
  videoWidthPx?: number;        // optional CSS width (default 360)
};

export default function Screen({ deviceId, signalUrl, videoWidthPx = 360 }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

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
    <div style={{ display: 'inline-block' }}>
      <video ref={videoRef} />
      <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
        {deviceId} • width {videoWidthPx}px
      </div>
    </div>
  );
}
