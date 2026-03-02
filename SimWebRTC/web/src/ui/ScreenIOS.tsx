import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { Box, Button, Slider, Typography } from '@mui/material'
import { devices } from '../devices'

// Prefer same-host signaling: viewer opened at http://<HOST>:5173
// -> signaling goes to ws://<HOST>:8080/signal
function computeSignalUrl() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.hostname // IMPORTANT: NOT "localhost"
    const port = 8080
    return `${proto}//${host}:${port}/signal`
}

//Signaling URL to connect to Node for establishing webrtc connection & control
const SIGNAL_URL = computeSignalUrl()

// Never auto-zoom beyond this (prevents giant device on big monitors)
const AUTO_MAX_FIT = 2.0

// ----- Bezel assets (served from /public/frames/*) -----
const BEZELS = {
    pro: '/frames/iPhone_16_Pro_bezel.png',
    proMax: '/frames/iPhone_16_Pro_Max_bezel.png',
} as const

// Fractions are relative to the bezel image size (naturalWidth/naturalHeight).
// These are starting values — you can tweak slightly if your bezel PNG has different padding.
const BEZEL_INSETS_FRAC = {
    pro: { left: 0.060, right: 0.060, top: 0.025, bottom: 0.024 },
    proMax: { left: 0.045, top: 0.035, right: 0.045, bottom: 0.035 },
} as const

// Corner radius of the *screen hole* as a fraction of the streamed screen's short edge.
// This must match the bezel PNG's screen corner curvature, otherwise you will see
// small square wedges at the corners.
const SCREEN_CORNER_RADIUS_FRAC = {
    pro: 0.080,
    proMax: 0.085,
} as const

function clamp(n: number, lo: number, hi: number) {
    return Math.max(lo, Math.min(hi, n))
}

// You can swap this logic later to use device model from your backend/device list.
function pickBezelKind(deviceName: string): keyof typeof BEZELS {
    const n = (deviceName || '').toLowerCase()
    console.log("pick bezel....", n);
    if (n.includes('max')) return 'proMax'
    return 'pro'
}

export default function ScreenIOS() {
    //Determines the device based on the device id req. param
    const deviceId = useParams<{ deviceId: string }>().deviceId || ''
    const device = useMemo(() => {
        return devices.find(currentDevice => currentDevice.id === deviceId)
    }, [deviceId])

    //Refs for video, stage, view, etc.
    const videoRef = useRef<HTMLVideoElement>(null) //video element ref
    const stageRef = useRef<HTMLDivElement>(null) //container around the video+bezel (FRAME size)
    const viewRef = useRef<HTMLDivElement>(null) //viewport of stage/left side containing stage & video
    const iceRef = useRef<HTMLSpanElement>(null) //ICE Connected badge
    const screenClipRef = useRef<HTMLDivElement>(null) //the “screen hole” rect for pointer mapping

    const [plus, setPlus] = useState<{ x: number; y: number; on: boolean }>({
        x: 0,
        y: 0,
        on: false,
    })

    const wsRef = useRef<WebSocket | null>(null)
    const offerSentRef = useRef(false)

    const [viewerId, setViewerId] = useState<string | null>(null)
    const viewerIdRef = useRef<string | null>(null)
    useEffect(() => {
        viewerIdRef.current = viewerId
    }, [viewerId])

    const pcRef = useRef<RTCPeerConnection | null>(null)

    // ✅ React 18 StrictMode guard (prevents double connect / close loops in dev)
    const startedRef = useRef(false)

    const [controllerId, setControllerId] = useState<string | null>(null)
    const canInteract = viewerId && controllerId && viewerId === controllerId
    const canInteractRef = useRef(false)
    useEffect(() => {
        canInteractRef.current = !!canInteract
    }, [canInteract])

    //Sets the theme mode based on stored user session & updates the UI everytime mode is changed
    const [themeMode, setThemeMode] = useState<'dark' | 'light'>(() => (localStorage.getItem('emuTheme') as any) || 'dark')
    useEffect(() => {
        const root = document.documentElement
        root.setAttribute('data-theme', themeMode)
        localStorage.setItem('emuTheme', themeMode)
    }, [themeMode])

    //Zoom settings
    const ZMIN = 0.25
    const ZMAX = 3.0
    const [scale, setScale] = useState<number>(() => parseFloat(localStorage.getItem('emuZoom') || '1') || 1)
    const scaleRef = useRef(scale)
    useEffect(() => {
        scaleRef.current = scale
    }, [scale])

    // Track whether user manually changed zoom (so resize/autofit doesn't fight them)
    const userZoomedRef = useRef(false)

    // Base (locked) VIDEO intrinsic size (screen-only) in pixels.
    const baseSizeRef = useRef<{ w: number; h: number } | null>(null)
    const setBaseSizeOnce = useCallback((w: number, h: number) => {
        if (!w || !h) return
        if (!baseSizeRef.current) baseSizeRef.current = { w, h }
    }, [])

    // Bezel PNG natural size
    const [bezelNatural, setBezelNatural] = useState<{ w: number; h: number } | null>(null)

    // Choose bezel based on device name (Pro vs Pro Max)
    const bezelKind = pickBezelKind(device?.name || '')
    const bezelSrc = BEZELS[bezelKind]
    const insetsFrac = BEZEL_INSETS_FRAC[bezelKind]

    // Load bezel image once to get naturalWidth/Height (so our math is stable)
    useEffect(() => {
        let cancelled = false
        const img = new Image()
        img.onload = () => {
            if (cancelled) return
            setBezelNatural({ w: img.naturalWidth, h: img.naturalHeight })
        }
        img.onerror = () => {
            if (cancelled) return
            console.warn('[bezel] failed to load', bezelSrc)
            setBezelNatural(null)
        }
        img.src = bezelSrc
        return () => {
            cancelled = true
        }
    }, [bezelSrc])

    // Compute frame/screen geometry from (base video size) + (bezel insets fractions) + (bezel natural size)
    const computeFrame = useCallback(() => {
        const base = baseSizeRef.current
        if (!base) return null
        if (!bezelNatural) return null

        // Using fractions of bezel image: screenW = frameW*(1-left-right)
        const fracW = 1 - insetsFrac.left - insetsFrac.right
        const fracH = 1 - insetsFrac.top - insetsFrac.bottom
        if (fracW <= 0 || fracH <= 0) return null

        // Scale bezel frame so that the screen-hole matches the streamed video size.
        // We assume the stream is already “screen-only rectangle” (no bezel).
        const frameW = base.w / fracW
        const frameH = base.h / fracH

        // Insets in *frame* pixels
        const insetLeft = frameW * insetsFrac.left
        const insetTop = frameH * insetsFrac.top
        const screenW = frameW - insetLeft - frameW * insetsFrac.right
        const screenH = frameH - insetTop - frameH * insetsFrac.bottom

        return {
            frameW,
            frameH,
            insetLeft,
            insetTop,
            screenW,
            screenH,
            bezelSrc,
            bezelNatural,
            insetsFrac,
        }
    }, [bezelNatural, insetsFrac, bezelSrc])

    // Apply sizes to the DOM: stage uses FRAME size, and screenClip+video uses SCREEN size.
    const applyLayout = useCallback(
        (newZoom: number) => {
            const stage = stageRef.current
            const screenClip = screenClipRef.current
            const video = videoRef.current
            if (!stage || !screenClip || !video) return

            const geom = computeFrame()

            // If we don’t have bezel geom yet, fall back to “just video”
            if (!geom) {
                const base = baseSizeRef.current
                if (!base) return
                stage.style.width = Math.round(base.w * newZoom) + 'px'
                stage.style.height = Math.round(base.h * newZoom) + 'px'

                screenClip.style.left = '0px'
                screenClip.style.top = '0px'
                screenClip.style.width = Math.round(base.w * newZoom) + 'px'
                screenClip.style.height = Math.round(base.h * newZoom) + 'px'


                const rFrac = 0.035
                const r = Math.round(Math.min(base.w, base.h) * rFrac * newZoom)
                screenClip.style.borderRadius = r + 'px'


                video.style.width = '100%'
                video.style.height = '100%'
                return
            }

            // FRAME drives the outer container size
            stage.style.width = Math.round(geom.frameW * newZoom) + 'px'
            stage.style.height = Math.round(geom.frameH * newZoom) + 'px'

            // SCREEN drives the hole where video goes
            screenClip.style.left = Math.round(geom.insetLeft * newZoom) + 'px'
            screenClip.style.top = Math.round(geom.insetTop * newZoom) + 'px'
            screenClip.style.width = Math.round(geom.screenW * newZoom) + 'px'
            screenClip.style.height = Math.round(geom.screenH * newZoom) + 'px'

            // Keep corner curvature consistent across zoom levels AND across different bezels.
            // Use a fraction of the *screen* short edge (not a fixed px value).
            const rFrac = (SCREEN_CORNER_RADIUS_FRAC as any)[bezelKind] ?? 0.038
            const r = Math.round(Math.min(geom.screenW, geom.screenH) * rFrac * newZoom)
            screenClip.style.borderRadius = r + 'px'

            // Put video inside the hole; don’t scale with CSS transform (avoids drifting/top-left issues)
            video.style.width = '100%'
            video.style.height = '100%'
        },
        [computeFrame]
    )

    // reason lets us differentiate user vs auto changes
    const applyZoom = useCallback(
        (z: number, reason: 'user' | 'auto' = 'user') => {
            const nz = clamp(z, ZMIN, ZMAX)
            if (reason === 'user') userZoomedRef.current = true
            setScale(nz)
            localStorage.setItem('emuZoom', String(nz))
            applyLayout(nz)
        },
        [applyLayout]
    )

    const sendHome = useCallback(() => {
        if (!device) return

        const ws = wsRef.current
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.warn('[control] Home pressed but WebSocket is not open')
            return
        }

        ws.send(JSON.stringify({
            type: 'home',
            deviceId: device.id,
        }))
    }, [device])

    //Fires when component mounts - main logic!
    useEffect(() => {
        if (!device) return
        if (startedRef.current) return
        startedRef.current = true

        const video = videoRef.current!
        const stage = stageRef.current!
        const view = viewRef.current!

        // Reset per-mount state
        let tOfferSent = 0
        let didReportTtff = false

        offerSentRef.current = false
        userZoomedRef.current = false
        baseSizeRef.current = null

        //Create peer connection & web socket for signaling/control
        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        })
        pcRef.current = pc

        console.log('WS url', SIGNAL_URL)
        let wsAttempt = 0

        // ---- PATCH: prevent ghost viewers on tab close/unmount ----
        let disposed = false
        let intentionalClose = false
        let reconnectTimer: any = null

        const makeWs = () => {
            const w = new WebSocket(SIGNAL_URL)
            wsRef.current = w
            return w
        }
        let ws = makeWs()

        const scheduleReconnect = () => {
            if (disposed || intentionalClose) return

            const wait = Math.min(15000, 300 * Math.pow(2, wsAttempt++)) + Math.random() * 250
            console.warn(`[ws] closed; reconnecting in ${Math.round(wait)}ms`)

            if (reconnectTimer) clearTimeout(reconnectTimer)

            reconnectTimer = window.setTimeout(() => {
                if (disposed || intentionalClose) return
                ws = makeWs()
                bindWsHandlers(ws)
            }, wait)
        }

        const bindWsHandlers = (sock: WebSocket) => {
            sock.onopen = async () => {
                wsAttempt = 0
                sock.send(JSON.stringify({ type: 'iam-viewer', deviceId: device.id }))
                const tx = pc.addTransceiver('video', { direction: 'recvonly' })
                preferH264OnTransceiver(pc, tx)
                // ✅ wait for server to send viewer-id before creating offer
            }

            sock.onmessage = async (event) => {
                const msg: any = JSON.parse(event.data)

                if (msg.type === 'answer' && msg.deviceId === device.id) {
                    await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
                } else if (msg.type === 'ice' && msg.deviceId === device.id && msg.candidate) {
                    try {
                        await pc.addIceCandidate(msg.candidate)
                    } catch { }
                } else if (msg.type === 'viewer-id' && msg.deviceId === device.id) {
                    setViewerId(msg.viewerId)

                    if (!offerSentRef.current) {
                        offerSentRef.current = true

                        const offer = await pc.createOffer()
                        await pc.setLocalDescription(offer)

                        tOfferSent = performance.now()
                        sock.send(
                            JSON.stringify({
                                type: 'offer',
                                deviceId: device.id,
                                viewerId: msg.viewerId,
                                sdp: offer.sdp,
                                deviceInfo: {
                                    platform: device.platform,
                                    windowMatch: device.windowMatch,
                                    id: device.id,
                                    name: device.name,
                                },
                            })
                        )
                    }
                } else if (msg.type === 'control-state' && msg.deviceId === device.id) {
                    setControllerId(msg.controllerId || null)
                } else if (msg.type === 'control-denied' && msg.deviceId === device.id) {
                    setControllerId(msg.controllerId || null)
                }
            }

            sock.onerror = () => {
                try { sock.close() } catch { }
            }

            sock.onclose = () => {
                if (disposed || intentionalClose) return
                scheduleReconnect()
            }
        }

        // Bind handlers for initial WebSocket
        bindWsHandlers(ws)

        // P2P control channel (removes VA/TX signaling latency from input when connected)
        const dc = pc.createDataChannel('control', { ordered: true })
        dc.onopen = () => console.log('[dc] open')
        dc.onclose = () => console.log('[dc] close')
        dc.onerror = (e) => console.log('[dc] error', e)

        const sendControl = (obj: any) => {
            const s = JSON.stringify(obj)
            if (dc.readyState === 'open') dc.send(s)
            else if (ws.readyState === WebSocket.OPEN) ws.send(s)
        }

        // Observability samples → signaling server (optional, but useful for success rate / QoS)
        const stopHud = startStatsHud(pc, deviceId, (qos, ice) => {
            const vId = viewerIdRef.current
            if (!vId) return
            if (ws.readyState !== WebSocket.OPEN) return
            ws.send(JSON.stringify({ type: 'obs', deviceId: device.id, viewerId: vId, qos, ice }))
        })

        pc.oniceconnectionstatechange = () => console.log('[viewer] ice=', pc.iceConnectionState)
        pc.onconnectionstatechange = () => console.log('[viewer] conn=', pc.connectionState)
        pc.onicegatheringstatechange = () => console.log('[viewer] gathering=', pc.iceGatheringState)

        // ✅ SINGLE ontrack handler
        pc.ontrack = (event) => {
            console.log('[viewer] ontrack streams=', event.streams?.length, 'track=', event.track.kind, event.track.id)
            const [stream] = event.streams
            if (!stream) return

            video.srcObject = stream
            video.autoplay = true
            video.playsInline = true
            video.muted = true
                ; (video as any).disablePictureInPicture = true

            video.play().catch((e) => {
                console.warn('video.play() failed:', e)
            })

            const onPlaying = () => {
                if (didReportTtff) return
                if (!tOfferSent) return
                didReportTtff = true
                const ttffMs = Math.round(performance.now() - tOfferSent)
                console.log(`[obs] TTFF=${ttffMs}ms`)
                const vId = viewerIdRef.current
                if (vId && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'obs-ttff', deviceId: device.id, viewerId: vId, ttffMs }))
                }
            }
            video.addEventListener('playing', onPlaying, { once: true })
        }

        // DEBUG: inbound video stats (temporary)
        const statsInterval = setInterval(async () => {
            try {
                const stats = await pc.getStats()
                const candidatesById: Record<string, any> = {}
                let selectedPair: any = null
                let foundAny = false

                stats.forEach((r: any) => {
                    if (r.type === 'local-candidate' || r.type === 'remote-candidate') {
                        candidatesById[r.id] = r
                    }
                    if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) {
                        selectedPair = selectedPair ?? r
                    }
                    const isInboundVideo = r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')
                    if (isInboundVideo) {
                        foundAny = true
                        // console.log('[inbound video]', r.bytesReceived, r.framesDecoded)
                    }
                })

                if (!foundAny) {
                    const types = new Set<string>()
                    stats.forEach((r: any) => types.add(`${r.type}:${r.kind || r.mediaType || ''}`))
                    console.log('[stats] no inbound video yet. report types:', Array.from(types).slice(0, 12))
                }
            } catch (e) {
                console.warn('[stats] getStats failed', e)
            }
        }, 1000)

        pc.onicecandidate = (event) => {
            if (!event.candidate) return
            console.log('[viewer] local ICE:', event.candidate.candidate)

            const payload: any = {
                type: 'ice',
                deviceId: device.id,
                candidate: event.candidate,
            }

            // ✅ include viewerId once known
            if (viewerIdRef.current) payload.viewerId = viewerIdRef.current

            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(payload))
            }
        }

        // pointer → WS (normalized)
        // IMPORTANT: normalize relative to the screen hole, not the bezel/frame.
        const getNorm = (ev: MouseEvent) => {
            const screenEl = screenClipRef.current || video
            const rect = screenEl.getBoundingClientRect()
            const x = (ev.clientX - rect.left) / rect.width
            const y = (ev.clientY - rect.top) / rect.height
            return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) }
        }

        const onDown = (ev: MouseEvent) => {
            if (!canInteractRef.current) return
            const { x, y } = getNorm(ev)
            sendControl({ type: 'pointer', deviceId: device.id, kind: 'down', x, y, buttons: ev.buttons | 1 })
        }

        //Only send move events while the user is dragging with the left mouse/button down
        const onMove = (ev: MouseEvent) => {
            if (!canInteractRef.current) return
            if ((ev.buttons & 1) === 0) return
            const { x, y } = getNorm(ev)
            sendControl({ type: 'pointer', deviceId: device.id, kind: 'move', x, y, buttons: ev.buttons | 1 })
        }

        const onUp = (ev: MouseEvent) => {
            if (!canInteractRef.current) return
            const { x, y } = getNorm(ev)
            sendControl({ type: 'pointer', deviceId: device.id, kind: 'up', x, y, buttons: 0 })
        }

        // --- "+" cursor overlay (visual only; does NOT change controls) ---
        const setPlusFromMouse = (ev: MouseEvent, on: boolean) => {
            const stageRect = stage.getBoundingClientRect()
            setPlus({
                on,
                x: ev.clientX - stageRect.left,
                y: ev.clientY - stageRect.top,
            })
        }

        const onEnterPlus = (ev: MouseEvent) => setPlusFromMouse(ev, true)
        const onLeavePlus = () => setPlus(p => ({ ...p, on: false }))
        const onMovePlus = (ev: MouseEvent) => setPlusFromMouse(ev, true)

        // --- wheel/trackpad debounce ---
        let wheelAccDx = 0
        let wheelAccDy = 0
        let wheelTimer: any = null
        let wheelCooldownUntil = 0

        const WHEEL_DEBOUNCE_MS = 60
        const WHEEL_COOLDOWN_MS = 180
        const WHEEL_MIN_TOTAL = 12

        const flushWheel = () => {
            wheelTimer = null
            const dx = wheelAccDx
            const dy = wheelAccDy
            wheelAccDx = 0
            wheelAccDy = 0
            if (Math.abs(dx) < WHEEL_MIN_TOTAL && Math.abs(dy) < WHEEL_MIN_TOTAL) return

            ws.send(
                JSON.stringify({
                    type: 'pointer',
                    deviceId: device.id,
                    kind: 'scroll',
                    x: 0.5,
                    y: 0.5,
                    dx,
                    dy,
                })
            )

            wheelCooldownUntil = performance.now() + WHEEL_COOLDOWN_MS
        }

        const onWheel = (ev: WheelEvent) => {
            if (!canInteractRef.current) return
            ev.preventDefault()
            const now = performance.now()
            if (now < wheelCooldownUntil) return

            wheelAccDx += ev.deltaX
            wheelAccDy += ev.deltaY

            if (wheelTimer) clearTimeout(wheelTimer)
            wheelTimer = setTimeout(flushWheel, WHEEL_DEBOUNCE_MS)
        }

        // Attach pointer listeners to the screen hole (so interactions match what you see)
        const screenEl = screenClipRef.current!
        screenEl.addEventListener('mousedown', onDown)
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
        screenEl.addEventListener('mouseenter', onEnterPlus)
        screenEl.addEventListener('mouseleave', onLeavePlus)
        screenEl.addEventListener('mousemove', onMovePlus)
        screenEl.addEventListener('wheel', onWheel, { passive: false } as any)

        // keyboard
        const host = view
        host.tabIndex = 0
        const isMod = (e: KeyboardEvent) => e.metaKey || e.ctrlKey

        const onKeyDown = async (e: KeyboardEvent) => {
            if (!canInteractRef.current) return

            if (isMod(e) && (e.key === 'v' || e.key === 'V')) {
                e.preventDefault()
                try {
                    const text = await navigator.clipboard.readText()
                    if (text) sendControl({ type: 'text', deviceId: device.id, text })
                } catch (err) {
                    console.warn('Clipboard read failed (need https or localhost permission):', err)
                }
                return
            }

            if (isMod(e) && (e.key === 'c' || e.key === 'C')) {
                e.preventDefault()
                return
            }

            if (e.key.length === 1 && !e.metaKey) {
                sendControl({ type: 'text', deviceId: device.id, text: e.key })
            } else {
                sendControl({ type: 'key', deviceId: device.id, action: 'down', code: e.code, key: e.key })
            }
            e.preventDefault()
        }

        const onKeyUp = (e: KeyboardEvent) => {
            // If it's a printable character, we already sent a "text" event on keydown.
            // No need to also send a key-up event for simple typing.
            if (e.key.length === 1 && !e.metaKey) {
                e.preventDefault()
                return
            }
        
            // For control/navigation keys, still send key-up
            sendControl({
                type: 'key',
                deviceId: device.id,
                action: 'up',
                code: e.code,
                key: e.key,
            })
            e.preventDefault()
        }

        host.addEventListener('keydown', onKeyDown)
        host.addEventListener('keyup', onKeyUp)

        // ---------- Auto-fit logic ----------
        let didAutoFit = false

        const doAutoFit = (frameW: number, frameH: number) => {
            const PAD = 16
            const availW = Math.max(0, view.clientWidth - PAD * 2)
            const availH = Math.max(0, view.clientHeight - PAD * 2)
            const raw = Math.min(availW / frameW, availH / frameH)
            const s = Math.min(AUTO_MAX_FIT, raw)
            applyZoom(clamp(s, ZMIN, ZMAX), 'auto')
        }

        // Re-fit when the left viewport changes size (window resize / sidebar resize)
        const resizeObserver = new ResizeObserver(() => {
            // Don’t fight the user if they manually zoomed
            if (userZoomedRef.current) return

            const geom = computeFrame()
            if (geom) {
                doAutoFit(geom.frameW, geom.frameH)
            } else {
                const base = baseSizeRef.current
                if (base) doAutoFit(base.w, base.h)
            }
        })
        resizeObserver.observe(view)


        const maybeInitFromVideoDims = () => {
            const w = video.videoWidth
            const h = video.videoHeight
            if (!w || !h) return false

            setBaseSizeOnce(w, h)

            // Layout once we know base; if bezel not loaded yet, we’ll relayout when it loads via effect
            applyLayout(scaleRef.current)

            // If we have bezel geometry, auto-fit based on FRAME, not BASE.
            const geom = computeFrame()
            if (!didAutoFit && !userZoomedRef.current) {
                didAutoFit = true
                if (geom) doAutoFit(geom.frameW, geom.frameH)
                else doAutoFit(w, h)
            }
            return true
        }

        const onLoadedMetadata = () => {
            maybeInitFromVideoDims()
        }

        video.addEventListener('loadedmetadata', onLoadedMetadata)

        // Keep stable sizing; only react if actual rotation/aspect changes (rare for simulator unless rotate)
        const onResize = () => {
            if (userZoomedRef.current) return
            const geom = computeFrame()
            if (geom) doAutoFit(geom.frameW, geom.frameH)
        }
        window.addEventListener('resize', onResize)

        // Simple ICE badge
        const setIce = (txt: string, cls: 'ok' | 'warn' | 'err' = 'warn') => {
            if (!iceRef.current) return
            iceRef.current.textContent = txt
                ; (iceRef.current as any).className = `badge ${cls}`
        }
        setIce('connecting…', 'warn')
        video.addEventListener('playing', () => setIce('connected', 'ok'), { once: true })

        return () => {
            stopHud?.()
            clearInterval(statsInterval)
            if (wheelTimer) clearTimeout(wheelTimer)

            window.removeEventListener('resize', onResize)
            resizeObserver.disconnect()
            video.removeEventListener('loadedmetadata', onLoadedMetadata)

            screenEl.removeEventListener('mousedown', onDown)
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
            screenEl.removeEventListener('mouseenter', onEnterPlus)
            screenEl.removeEventListener('mouseleave', onLeavePlus)
            screenEl.removeEventListener('mousemove', onMovePlus)
            screenEl.removeEventListener('wheel', onWheel as any)

            host.removeEventListener('keydown', onKeyDown)
            host.removeEventListener('keyup', onKeyUp)

            // ---- PATCH: prevent ws.onclose from scheduling reconnect during unmount ----
            disposed = true
            intentionalClose = true
            if (reconnectTimer) {
                clearTimeout(reconnectTimer)
                reconnectTimer = null
            }

            // optional but recommended: remove handlers so nothing fires during teardown
            try {
                ws.onopen = null
                ws.onmessage = null
                ws.onclose = null
                ws.onerror = null
            } catch { }

            try { ws.close() } catch { }
            try { pc.close() } catch { }

            wsRef.current = null
            startedRef.current = false
            offerSentRef.current = false
        }
    }, [device, applyZoom, setBaseSizeOnce, applyLayout, computeFrame])

    // Re-apply layout whenever bezel loads (this is what fixes “looks wrong until I zoom”)
    useEffect(() => {
        if (!baseSizeRef.current) return
        applyLayout(scaleRef.current)
        if (!userZoomedRef.current && viewRef.current) {
            const geom = computeFrame()
            if (geom) {
                const PAD = 16
                const availW = Math.max(0, viewRef.current.clientWidth - PAD * 2)
                const availH = Math.max(0, viewRef.current.clientHeight - PAD * 2)
                const raw = Math.min(availW / geom.frameW, availH / geom.frameH)
                const s = Math.min(AUTO_MAX_FIT, raw)
                setScale(clamp(s, ZMIN, ZMAX))
                localStorage.setItem('emuZoom', String(clamp(s, ZMIN, ZMAX)))
                applyLayout(clamp(s, ZMIN, ZMAX))
            }
        }
    }, [bezelNatural, computeFrame, applyLayout])



    function preferH264OnTransceiver(pc: RTCPeerConnection, transceiver: RTCRtpTransceiver) {
        const caps = (RTCRtpReceiver as any).getCapabilities?.('video')
        if (!caps?.codecs?.length) return
        const codecs = caps.codecs as RTCRtpCodecCapability[]
        const h264 = codecs.filter((c) => (c.mimeType || '').toLowerCase() === 'video/h264')
        const rest = codecs.filter((c) => (c.mimeType || '').toLowerCase() !== 'video/h264')
        const ordered = [...h264, ...rest]
        try {
            transceiver.setCodecPreferences(ordered as any)
            console.log('[codec] prefer H264; h264Count=', h264.length)
        } catch (e) {
            console.warn('[codec] setCodecPreferences failed (ok):', e)
        }
    }
    type QoS = {
        rttMs?: number
        jitterMs?: number
        lossPct?: number
        kbps?: number
        fps?: number
        framesDropped?: number
        framesDecoded?: number
    }

    function startStatsHud(
        pc: RTCPeerConnection,
        label = 'viewer',
        onSample?: (qos: QoS, ice?: { localType?: string; localProto?: string; remoteType?: string; remoteProto?: string; }) => void
    ) {
        let lastBytes = 0
        let lastTs = 0

        const iv = window.setInterval(async () => {
            const stats = await pc.getStats()

            const candidatesById: Record<string, any> = {}
            let selectedPair: any = null

            let rttMs: number | undefined
            let jitterMs: number | undefined
            let packetsLost = 0
            let packetsRecv = 0
            let bytesRecv = 0
            let fps: number | undefined
            let framesDropped: number | undefined
            let framesDecoded: number | undefined

            stats.forEach((r: any) => {
                if (r.type === 'local-candidate' || r.type === 'remote-candidate') {
                    candidatesById[r.id] = r
                }
                if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) {
                    selectedPair = selectedPair ?? r
                }
                if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
                    if (typeof r.currentRoundTripTime === 'number') rttMs = r.currentRoundTripTime * 1000
                }
                if (r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) {
                    if (typeof r.jitter === 'number') jitterMs = r.jitter * 1000
                    if (typeof r.packetsLost === 'number') packetsLost = r.packetsLost
                    if (typeof r.packetsReceived === 'number') packetsRecv = r.packetsReceived
                    if (typeof r.bytesReceived === 'number') bytesRecv = r.bytesReceived
                    if (typeof r.framesPerSecond === 'number') fps = r.framesPerSecond
                    if (typeof r.framesDropped === 'number') framesDropped = r.framesDropped
                    if (typeof r.framesDecoded === 'number') framesDecoded = r.framesDecoded
                }
            })

            const now = Date.now()
            let kbps: number | undefined
            if (lastTs && bytesRecv >= lastBytes) {
                const dt = (now - lastTs) / 1000
                const dBytes = bytesRecv - lastBytes
                kbps = (dBytes * 8) / 1000 / dt
            }
            lastBytes = bytesRecv
            lastTs = now

            const lossPct = packetsRecv + packetsLost > 0 ? (packetsLost / (packetsRecv + packetsLost)) * 100 : 0

            const qos: QoS = {
                rttMs: rttMs ? Math.round(rttMs) : undefined,
                jitterMs: jitterMs ? Math.round(jitterMs) : undefined,
                lossPct: Math.round(lossPct * 10) / 10,
                kbps: kbps ? Math.round(kbps) : undefined,
                fps,
                framesDropped,
                framesDecoded,
            }

            const ice = selectedPair
                ? (() => {
                    const local = candidatesById[selectedPair.localCandidateId]
                    const remote = candidatesById[selectedPair.remoteCandidateId]
                    return {
                        localType: local?.candidateType,
                        localProto: local?.protocol,
                        remoteType: remote?.candidateType,
                        remoteProto: remote?.protocol,
                    }
                })()
                : undefined

            onSample?.(qos, ice)
            // console.log(`[qos:${label}]`, qos, ice)
        }, 1000)

        return () => window.clearInterval(iv)
    }

    if (!device) {
        return (
            <Box sx={{ p: 3 }}>
                <Typography variant="h5">Device not found</Typography>
            </Box>
        )
    }

    return (
        <>
            <style>{`
        :root{ --bg:#0b0d10; --panel:#0f1217; --border:#1d2430; --text:#e7ecf2; --muted:#9aa8bf; --chip-bg:#151a22; --chip-border:#2a3241; color-scheme:dark; }
        :root[data-theme="light"]{ --bg:#f7f9fc; --panel:#ffffff; --border:#d9e1ee; --text:#0b1020; --muted:#55637d; --chip-bg:#eef2f8; --chip-border:#c7d2e5; color-scheme:light; }
        .badge{ font-size:12px; padding:2px 8px; border-radius:999px; border:1px solid var(--chip-border); background:var(--chip-bg); }
        .badge.ok{ outline:2px solid #68a0ff; outline-offset:1px }

        .modeCard{
          display:flex; gap:10px; align-items:flex-start;
          padding:10px 12px;
          border-radius:12px;
          border:1px solid var(--chip-border);
          background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(0,0,0,0.06));
        }
        .modeDot{
          width:10px; height:10px; border-radius:999px; margin-top:4px;
          box-shadow: 0 0 0 3px rgba(255,255,255,0.06);
          flex:0 0 auto;
        }
        .modeTitle{
          font-size:13px; font-weight:800; letter-spacing:0.2px;
          line-height:1.1;
        }
        .modeDesc{
          font-size:12px; color: var(--muted); margin-top:4px;
          line-height:1.25;
        }
        .modePill{
          display:inline-flex; align-items:center; gap:6px;
          font-size:12px; font-weight:700;
          padding:3px 10px;
          border-radius:999px;
          border:1px solid var(--chip-border);
          background: var(--chip-bg);
          margin-left:8px;
          white-space:nowrap;
        }
        .modePill svg{ width:14px; height:14px; opacity:0.95; }

        .modeCard.interact{
          border-color: rgba(0, 255, 255, 0.35);
          box-shadow: 0 0 0 1px rgba(0, 255, 255, 0.12), 0 12px 30px rgba(0, 255, 255, 0.06);
        }
        .modeDot.interact{ background: rgba(0, 255, 255, 0.95); }

        .modeCard.viewonly{
          border-color: rgba(255, 190, 90, 0.35);
          box-shadow: 0 0 0 1px rgba(255, 190, 90, 0.10), 0 12px 30px rgba(255, 190, 90, 0.05);
        }
        .modeDot.viewonly{ background: rgba(255, 190, 90, 0.95); }
      `}</style>

            <Box
                sx={{
                    position: 'fixed',
                    inset: 0,
                    display: 'grid',
                    gridTemplateColumns: '1fr 360px',
                    bgcolor: 'var(--bg)',
                    color: 'var(--text)',
                    fontFamily: 'ui-sans-serif,system-ui,Segoe UI,Roboto,Arial',
                }}
            >
                {/* LEFT SIDE (keep your UI layout) */}
                <Box ref={viewRef} sx={{ display: 'grid', placeItems: 'center', bgcolor: 'var(--panel)', overflow: 'auto', outline: 'none' }}>
                    {/* Stage is FRAME-sized (bezel size), centered by placeItems:'center' */}
                    <Box id="stage" ref={stageRef} sx={{ position: 'relative', overscrollBehavior: 'contain' }}>
                        {/* Screen hole: video lives here */}
                        <Box
                            ref={screenClipRef}
                            sx={{
                                position: 'absolute',
                                overflow: 'hidden',
                                background: '#000',
                                zIndex: 1,
                            }}
                        >
                            <video
                                ref={videoRef}
                                autoPlay
                                playsInline
                                muted
                                style={{
                                    width: '100%',
                                    height: '100%',
                                    display: 'block',
                                    objectFit: 'contain',
                                    objectPosition: 'center',
                                    cursor: canInteract ? 'none' : 'not-allowed',
                                }}
                            />
                        </Box>

                        {/* Bezel overlay */}
                        <img
                            src={bezelSrc}
                            alt="device frame"
                            style={{
                                position: 'absolute',
                                inset: 0,
                                width: '100%',
                                height: '100%',
                                objectFit: 'contain',
                                pointerEvents: 'none',
                                userSelect: 'none',
                                zIndex: 3,
                            }}
                        />

                        {/* Plus overlay (visual only) */}
                        {plus.on && (
                            <Box
                                sx={{
                                    position: 'absolute',
                                    left: plus.x,
                                    top: plus.y,
                                    transform: 'translate(-50%, -50%)',
                                    zIndex: 5,
                                    fontSize: 24,
                                    fontWeight: 800,
                                    color: 'rgba(0, 255, 255, 0.95)',
                                    textShadow: '0 0 8px rgba(0,0,0,0.85)',
                                    pointerEvents: 'none',
                                    userSelect: 'none',
                                    lineHeight: 1,
                                }}
                            >
                                +
                            </Box>
                        )}
                    </Box>
                </Box>

                {/* RIGHT PANEL (UNCHANGED UI) */}
                <Box sx={{ borderLeft: '1px solid var(--border)', p: 1.5, bgcolor: 'var(--panel)' }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                        <Typography sx={{ fontWeight: 700 }}>{device.name}</Typography>
                        <span ref={iceRef} className="badge">
                            ICE: —
                        </span>
                    </Box>

                    <Box sx={{ mb: 1.25 }}>
                        <Box className={`modeCard ${canInteract ? 'interact' : 'viewonly'}`}>
                            <span className={`modeDot ${canInteract ? 'interact' : 'viewonly'}`} />

                            <Box sx={{ flex: 1 }}>
                                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                                    <Box className="modeTitle">
                                        {canInteract ? 'Interactive access' : 'View-only access'}
                                        <span className="modePill">
                                            {canInteract ? (
                                                <>
                                                    <svg viewBox="0 0 24 24" fill="none">
                                                        <path d="M7 11l3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                                    </svg>
                                                    LIVE
                                                </>
                                            ) : (
                                                <>
                                                    <svg viewBox="0 0 24 24" fill="none">
                                                        <path d="M12 17a2 2 0 0 0 2-2v-2a2 2 0 1 0-4 0v2a2 2 0 0 0 2 2Z" stroke="currentColor" strokeWidth="2" />
                                                        <path d="M7 11V9a5 5 0 0 1 10 0v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                                        <path d="M6 11h12v9H6v-9Z" stroke="currentColor" strokeWidth="2" />
                                                    </svg>
                                                    LOCKED
                                                </>
                                            )}
                                        </span>
                                    </Box>
                                </Box>

                                <Box className="modeDesc">
                                    {canInteract
                                        ? 'You control touch, keys, and scroll. Others can watch without interfering.'
                                        : 'Someone else is controlling this device. You can watch, but input is disabled.'}
                                </Box>
                            </Box>
                        </Box>
                    </Box>

                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 1 }}>
                        <Button size="small" onClick={() => setThemeMode(t => (t === 'dark' ? 'light' : 'dark'))} sx={btnSx}>
                            {themeMode === 'dark' ? 'Dark' : 'Light'}
                        </Button>
                    </Box>

                    <Typography variant="subtitle2" sx={{ mb: 0.5, color: 'var(--muted)' }}>
                        Zoom
                    </Typography>

                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                        <Button size="small" sx={btnSx} onClick={() => applyZoom(scaleRef.current / 1.1, 'user')}>
                            −
                        </Button>
                        <Slider
                            value={scale}
                            min={0.25}
                            max={3.0}
                            step={0.05}
                            onChange={(_, v) => applyZoom(Array.isArray(v) ? v[0] : (v as number), 'user')}
                            sx={{
                                width: 160,
                                mx: 1,
                                '& .MuiSlider-track': { bgcolor: 'var(--chip-border)' },
                                '& .MuiSlider-rail': { bgcolor: 'var(--chip-border)' },
                                '& .MuiSlider-thumb': { bgcolor: 'var(--text)' },
                            }}
                        />
                        <Button size="small" sx={btnSx} onClick={() => applyZoom(scaleRef.current * 1.1, 'user')}>
                            +
                        </Button>
                        <Box sx={{ minWidth: 48, textAlign: 'right' }}>{Math.round(scale * 100)}%</Box>
                    </Box>

                    <Typography variant="subtitle2" sx={{ mb: 0.5, color: 'var(--muted)' }}>
                        View (placeholders)
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                         {/* Simple Home button to jump to simulator home screen */}
                         <Button
                            size="small"
                            sx={btnSx}
                            onClick={sendHome}
                        >
                            Home
                        </Button>
                        <Button size="small" sx={btnSx} disabled>
                            Fit
                        </Button>
                        <Button size="small" sx={btnSx} disabled>
                            1×
                        </Button>
                        <Button size="small" sx={btnSx} disabled>
                            Rotate
                        </Button>
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