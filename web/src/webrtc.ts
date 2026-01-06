export async function connectSimpleWebRTC(videoEl: HTMLVideoElement, signalUrl: string, deviceId: string) {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
    const ws = new WebSocket(signalUrl)
  
    pc.ontrack = (e) => {
      const [stream] = e.streams
      if (stream) {
        videoEl.srcObject = stream
        videoEl.autoplay = true
        videoEl.playsInline = true
        videoEl.muted = true
        ;(videoEl as any).disablePictureInPicture = true
      }
    }
  
    ws.onopen = async () => {
      ws.send(JSON.stringify({ type: 'iam-viewer', deviceId }))
      const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: false })
      await pc.setLocalDescription(offer)
      ws.send(JSON.stringify({ type: 'offer', deviceId, sdp: offer.sdp }))
    }
  
    ws.onmessage = async (ev) => {
      let msg: any; try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.type === 'answer' && msg.deviceId === deviceId) {
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
      } else if (msg.type === 'ice' && msg.deviceId === deviceId && msg.candidate) {
        try { await pc.addIceCandidate(msg.candidate) } catch {}
      }
    }
  
    pc.onicecandidate = (ev) => {
      if (ev.candidate) ws.send(JSON.stringify({ type: 'ice', deviceId, candidate: ev.candidate }))
    }
  
    return {
      close() { try { ws.close() } catch {} try { pc.close() } catch {} }
    }
  }
  