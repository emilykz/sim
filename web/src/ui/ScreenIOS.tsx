import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { Box, Button, Slider, Typography } from '@mui/material'
import { devices } from '../devices'

//Signaling URL to connect to Node for establishing webrtc connection & control
const SIGNAL_URL = `ws://${window.location.hostname}:8080/signal`
const AUTO_MAX_FIT = 0.7; // never auto-zoom beyond 70%

export default function ScreenIOS() {

    //Determines the device based on the device id req. param
    const deviceId = useParams<{ deviceId: string }>().deviceId || ''
    const device = useMemo(() => {
        return devices.find(currentDevice => currentDevice.id === deviceId)
    }, [deviceId])

    //Refs for video, stage, view, etc. 
    const videoRef = useRef<HTMLVideoElement>(null) //video element ref
    const stageRef = useRef<HTMLDivElement>(null) //container around the video, used to adjust width/height
    const viewRef = useRef<HTMLDivElement>(null) //viewport of stage/left side containing stage & video
    const iceRef = useRef<HTMLSpanElement>(null) //ICE Connected badge

    //Sets the theme mode based on stored user session & updates the UI everytime mode is changed
    const [themeMode, setThemeMode] = useState<'dark' | 'light'>(() =>
        (localStorage.getItem('emuTheme') as any) || 'dark'
    )
    useEffect(() => {
        const root =  document.documentElement; 
        root.setAttribute('data-theme', themeMode)
        localStorage.setItem('emuTheme', themeMode)
    }, [themeMode])

    //Zoom settings 
    const ZMIN = 0.25
    const ZMAX = 3.0
    const [scale, setScale] = useState<number>(() => 
        parseFloat(localStorage.getItem('emuZoom') || '1') || 1)
    const scaleRef = useRef(scale)
    useEffect(() => { 
        scaleRef.current = scale 
    }, [scale])

    //Apply the zoom scale to video eleemtn & update container size
    const updateTransforms = useCallback((newZoom: number) => {
        const video = videoRef.current
        const stage = stageRef.current
        if (!video || !stage) return
        video.style.transform = `scale(${newZoom}) translateZ(0)`
        const w = video.videoWidth
        const h = video.videoHeight
        if (w && h) {
            stage.style.width = Math.round(w * newZoom) + 'px'
            stage.style.height = Math.round(h * newZoom) + 'px'
        }
    }, [])
    const applyZoom = useCallback((z: number) => {
        const nz = Math.min(Math.max(z, ZMIN), ZMAX)
        setScale(nz)
        localStorage.setItem('emuZoom', String(nz))
        updateTransforms(nz)
    }, [updateTransforms])

    //Fires when component mounts - main logic!
    useEffect(() => {
        if (!device) return
        const video = videoRef.current!
        const stage = stageRef.current!
        const view = viewRef.current!

        //Create peer connection & web socket for signaling/control
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
        const ws = new WebSocket(SIGNAL_URL)

        //Fires when client recieves a track
        pc.ontrack = (event) => {

            //Gets the MediaStream objects (MediaStream has a video track which contains our video)
            const [stream] = event.streams
            if (stream) {

                //Play this webrtc stream as video
                video.srcObject = stream
                video.autoplay = true
                video.playsInline = true
                video.muted = true
                    ; (video as any).disablePictureInPicture = true
            }
        }

        //Fires when websocket connects immediately to our node server 
        ws.onopen = async () => {

            //Sending msg to node server to tell them to add viewer to list of viewers for this device
            ws.send(JSON.stringify({ type: 'iam-viewer', deviceId: device.id }))

            //Create Webrtc offer -> Send SDP offer to Node via WS
            const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: false })
            await pc.setLocalDescription(offer)
            ws.send(JSON.stringify({ type: 'offer', deviceId: device.id, sdp: offer.sdp }))
        }

        //Fires when websocket recieves a message (handle websocket signaling)
        //Node sends: answer & ice candidates 
        ws.onmessage = async (event) => {
            let msg: any;
            msg = JSON.parse(event.data)
            //Completes Webrtc negotiation 
            if (msg.type === 'answer' && msg.deviceId === device.id) {
                await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
            } 
            //Allows Node & Node to ginf a working UDP path
            else if (msg.type === 'ice' && msg.deviceId === device.id && msg.candidate) {
                try { await pc.addIceCandidate(msg.candidate) } catch { }
            }
        }

        //Sends ICE candidates to Node 
        pc.onicecandidate = (event) => {
            if (event.candidate) 
                ws.send(JSON.stringify({ type: 'ice', deviceId: device.id, candidate: event.candidate }))
        }

        // pointer → WS (normalized)
        const getNorm = (ev: MouseEvent) => {
            const rect = video.getBoundingClientRect()
            const x = (ev.clientX - rect.left) / rect.width
            const y = (ev.clientY - rect.top) / rect.height
            return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }
        }
        const onDown = (ev: MouseEvent) => {
            const { x, y } = getNorm(ev)
            ws.send(JSON.stringify({ type: 'pointer', deviceId: device.id, kind: 'down', x, y, buttons: ev.buttons | 1 }))
        }

        //Only send move events while the user is dragging with the left mouse/button down 
        const onMove = (ev: MouseEvent) => {
            if ((ev.buttons & 1) === 0) return //left mouse button is not down
            const { x, y } = getNorm(ev)
            ws.send(JSON.stringify({ type: 'pointer', deviceId: device.id, kind: 'move', x, y, buttons: ev.buttons | 1 }))
        }
        const onUp = (ev: MouseEvent) => {
            const { x, y } = getNorm(ev)
            ws.send(JSON.stringify({ type: 'pointer', deviceId: device.id, kind: 'up', x, y, buttons: 0 }))
        }

        //X=0.5 → center horizontally Y=0.5 → center vertically 
        // deltaX (left/right scroll) deltaY (vertical scroll)
        // Scroll up → negative deltaY   Scroll down → positive deltaY
        const onWheel = (ev: WheelEvent) => {
            ws.send(JSON.stringify({ type: 'pointer', deviceId: device.id, kind: 'scroll', x: 0.5, y: 0.5, dx: ev.deltaX, dy: ev.deltaY }))
        }

        video.addEventListener('mousedown', onDown)
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
        video.addEventListener('wheel', onWheel, { passive: true })

        // keyboard
        const host = view // panel must be focusable
        host.tabIndex = 0
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key.length === 1 && !e.metaKey) {
                ws.send(JSON.stringify({ type: 'text', deviceId: device.id, text: e.key }))
            } else {
                ws.send(JSON.stringify({ type: 'key', deviceId: device.id, action: 'down', code: e.code, key: e.key }))
            }
            e.preventDefault()
        }
        const onKeyUp = (e: KeyboardEvent) => {
            ws.send(JSON.stringify({ type: 'key', deviceId: device.id, action: 'up', code: e.code, key: e.key }))
            e.preventDefault()
        }
        host.addEventListener('keydown', onKeyDown)
        host.addEventListener('keyup', onKeyUp)

        // Auto fit the simulator on first frame + keep layout in sync with actual video size
        //Callback/recursion -> calls this resizing/fit logic per video frame 
        let firstFrame = false;
        const onFrame = (_: any, meta: any) => {
          if (!meta?.width || !meta?.height) return;
        
          if (!firstFrame) {
            firstFrame = true;
        
            // Set natural size before zoom
            stage.style.width = meta.width + 'px';
            stage.style.height = meta.height + 'px';
        
            requestAnimationFrame(() => {
                const PAD = 16;
                const availW = Math.max(0, view.clientWidth - PAD * 2);
                const availH = Math.max(0, view.clientHeight - PAD * 2);
              
                // raw "fit" scale
                const raw = Math.min(availW / meta.width, availH / meta.height);
              
                // do NOT auto-upscale; max 1x
                const s = Math.min(AUTO_MAX_FIT, raw);
              
                applyZoom(Math.min(Math.max(s, 0.25), 3.0));
              });
              
          } else {
            stage.style.width = Math.round(meta.width * scaleRef.current) + 'px';
            stage.style.height = Math.round(meta.height * scaleRef.current) + 'px';
          }
        
          video.requestVideoFrameCallback(onFrame);
        };
        
        if ('requestVideoFrameCallback' in (video as any)) {
            ; (video as any).requestVideoFrameCallback(onFrame)
        } else {
            video.addEventListener('loadedmetadata', () => applyZoom(scaleRef.current))
        }

        // Simple ICE badge
        const setIce = (txt: string, cls: 'ok' | 'warn' | 'err' = 'warn') => {
            if (!iceRef.current) return
            iceRef.current.textContent = txt; 
            (iceRef.current as any).className = `badge ${cls}`
        }
        setIce('connecting…', 'warn')
        video.addEventListener('playing', () => setIce('connected', 'ok'), { once: true })

        const onResize = () => {
            if (!firstFrame) return
            const PAD = 16
            const w = video.videoWidth
            const h = video.videoHeight
            if (!w || !h) return
            const availW = Math.max(0, view.clientWidth - PAD * 2)
            const availH = Math.max(0, view.clientHeight - PAD * 2)
            const raw = Math.min(availW / w, availH / h);
            const s = Math.min(AUTO_MAX_FIT, raw);
            applyZoom(Math.min(Math.max(s, 0.25), 3.0));
        }
        window.addEventListener('resize', onResize)

        return () => {
            window.removeEventListener('resize', onResize)
            video.removeEventListener('mousedown', onDown)
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
            video.removeEventListener('wheel', onWheel)
            host.removeEventListener('keydown', onKeyDown)
            host.removeEventListener('keyup', onKeyUp)
            try { ws.close() } catch { }
            try { pc.close() } catch { }
        }
    }, [device, applyZoom])

    if (!device) {
        return <Box sx={{ p: 3 }}><Typography variant="h5">Device not found</Typography></Box>
    }

    return (
        <>
            <style>{`
        :root{ --bg:#0b0d10; --panel:#0f1217; --border:#1d2430; --text:#e7ecf2; --muted:#9aa8bf; --chip-bg:#151a22; --chip-border:#2a3241; color-scheme:dark; }
        :root[data-theme="light"]{ --bg:#f7f9fc; --panel:#ffffff; --border:#d9e1ee; --text:#0b1020; --muted:#55637d; --chip-bg:#eef2f8; --chip-border:#c7d2e5; color-scheme:light; }
        #stage > .layer{ position:absolute; top:0; left:0; transform-origin:top left; background:#000; }
        .badge{ font-size:12px; padding:2px 8px; border-radius:999px; border:1px solid var(--chip-border); background:var(--chip-bg); }
        .badge.ok{ outline:2px solid #68a0ff; outline-offset:1px }
      `}</style>

            <Box sx={{
                position: 'fixed', inset: 0, display: 'grid',
                gridTemplateColumns: '1fr 360px',
                bgcolor: 'var(--bg)', color: 'var(--text)', fontFamily: 'ui-sans-serif,system-ui,Segoe UI,Roboto,Arial',
            }}>
                <Box ref={viewRef} sx={{ display: 'grid', placeItems: 'center', bgcolor: 'var(--panel)', overflow: 'auto', outline: 'none' }}>
                    <Box id="stage" ref={stageRef} sx={{ position: 'relative' }}>
                        <video ref={videoRef} className="layer" autoPlay playsInline muted style={{ zIndex: 1 }} />
                    </Box>
                </Box>

                <Box sx={{ borderLeft: '1px solid var(--border)', p: 1.5, bgcolor: 'var(--panel)' }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                        <Typography sx={{ fontWeight: 700 }}>{device.name}</Typography>
                        <span ref={iceRef} className="badge">ICE: —</span>
                    </Box>

                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 1 }}>
                        <Button size="small" onClick={() => setThemeMode(t => t === 'dark' ? 'light' : 'dark')} sx={btnSx}>
                            {themeMode === 'dark' ? 'Dark' : 'Light'}
                        </Button>
                    </Box>

                    <Typography variant="subtitle2" sx={{ mb: 0.5, color: 'var(--muted)' }}>Zoom</Typography>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                        <Button size="small" sx={btnSx} onClick={() => applyZoom(scaleRef.current / 1.1)}>−</Button>
                        <Slider
                            value={scale} min={0.25} max={3.0} step={0.05}
                            onChange={(_, v) => applyZoom(Array.isArray(v) ? v[0] : v as number)}
                            sx={{
                                width: 160, mx: 1,
                                '& .MuiSlider-track': { bgcolor: 'var(--chip-border)' },
                                '& .MuiSlider-rail': { bgcolor: 'var(--chip-border)' },
                                '& .MuiSlider-thumb': { bgcolor: 'var(--text)' },
                            }}
                        />
                        <Button size="small" sx={btnSx} onClick={() => applyZoom(scaleRef.current * 1.1)}>+</Button>
                        <Box sx={{ minWidth: 48, textAlign: 'right' }}>{Math.round(scale * 100)}%</Box>
                    </Box>

                    <Typography variant="subtitle2" sx={{ mb: 0.5, color: 'var(--muted)' }}>View (placeholders)</Typography>
                    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                        <Button size="small" sx={btnSx} disabled>Fit</Button>
                        <Button size="small" sx={btnSx} disabled>Fill</Button>
                        <Button size="small" sx={btnSx} disabled>1×</Button>
                        <Button size="small" sx={btnSx} disabled>Rotate</Button>
                    </Box>
                </Box>
            </Box>
        </>
    )
}

const btnSx = {
    background: 'var(--chip-bg)',
    border: '1px solid var(--chip-border)',
    color: 'var(--text)',
    borderRadius: '8px',
    px: 1.25,
    py: 0.5,
    fontSize: 13,
    textTransform: 'none',
    minWidth: 0,
    '&:active': { transform: 'translateY(1px)' },
} as const
