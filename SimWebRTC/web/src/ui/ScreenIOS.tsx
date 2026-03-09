import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { Box, Button, CircularProgress, Divider, IconButton, MenuItem, Select, Slider, Tooltip, Typography } from '@mui/material'
import HomeRoundedIcon from '@mui/icons-material/HomeRounded'
import PowerSettingsNewRoundedIcon from '@mui/icons-material/PowerSettingsNewRounded'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import { devices } from '../devices'
import { APP_LIBRARY } from './appLibrary'

//Builds the WebSocket endpoint for signaling
function computeSignalUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.hostname 
  const port = 8080
  return `${proto}//${host}:${port}/signal`
}
const SIGNAL_URL = computeSignalUrl()

const AUTO_MAX_FIT = 2.0

// ----- Bezel assets (served from /public/frames/*) -----
const BEZELS = {
  pro: '/frames/iPhone_16_Pro_bezel.png',
  proMax: '/frames/iPhone_16_Pro_Max_bezel.png',
} as const

// Fractions are relative to the bezel image size
const BEZEL_INSETS_FRAC = {
  pro: { left: 0.057, right: 0.057, top: 0.019, bottom: 0.020 },
  proMax: { left: 0.045, top: 0.035, right: 0.045, bottom: 0.035 },
} as const

// Corner radius of frames
const SCREEN_CORNER_RADIUS_FRAC = {
  pro: 0.10,
  proMax: 0.085,
} as const

//Supported App Builds platform
type ArtifactPlatform = 'ios' | 'android' 

//Single downloadable app build 
type AppArtifact = {
  id: string
  code: string // build identifier shown in the list (e.g., 26.04.2)
  platform: ArtifactPlatform
}

//Single app release (26.02), which groups all builds under this release
type AppRelease = {
  id: string
  label: string
  date?: string
  artifacts: AppArtifact[]
}

//Lab App -> AppRelease[] -> AppArtifact[]
type LabApp = {
  id: string
  name: string
  summary: string
  releases: AppRelease[]
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n))
}

//Picks the phone bezel based on the device name 
function pickBezelKind(deviceName: string): keyof typeof BEZELS {
  const n = (deviceName || '').toLowerCase()
  if (n.includes('max')) return 'proMax'
  return 'pro'
}

/**
 * isActive: tells whether this device screen is currently visible session 
 * onActivity: Callback whenever the user actually interacts with device -> resets its inactivity timer 
 * onReleased: invoked when the session is released 
 * pendingReleaseReasion: Lab can set this when its own inactivity sweep decices to release a session 
 *      * ScreenIOS watches the prop to stop streaming immediately and show pop ups for inactivity 
 */
type ScreenIOSProps = {
  deviceId?: string
  isActive?: boolean
  onActivity?: () => void
  onReleased?: (info: { reason: string; silent?: boolean }) => void
  pendingReleaseReason?: string | null
}

export default function ScreenIOS(props: ScreenIOSProps = {}) {

  const routeId = useParams<{ deviceId: string }>().deviceId || ''
  const deviceId = props.deviceId || routeId

  // ✅ IMPORTANT: store callbacks in refs so they don't restart the stream on each render
  const onActivityRef = useRef<ScreenIOSProps['onActivity']>(props.onActivity)
  const onReleasedRef = useRef<ScreenIOSProps['onReleased']>(props.onReleased)
  useEffect(() => {
    onActivityRef.current = props.onActivity
  }, [props.onActivity])
  useEffect(() => {
    onReleasedRef.current = props.onReleased
  }, [props.onReleased])


  const isActive = props.isActive ?? true
  const isActiveRef = useRef(isActive)

  //Registers user activity via onActivity callback 
  const registerActivity = useCallback(() => {
    if (!isActiveRef.current) return
    onActivityRef.current?.()
  }, [])
  useEffect(() => {
    isActiveRef.current = isActive
    if (!isActive && plusRef.current) {
      plusRef.current.style.opacity = '0'
    }
    if (isActive) registerActivity()
  }, [isActive, registerActivity])

  //Gets the devices based on device ID 
  const device = useMemo(() => {
    return devices.find((currentDevice) => currentDevice.id === deviceId)
  }, [deviceId])

  // Refs for video, stage, view, etc.
  const videoRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const iceRef = useRef<HTMLSpanElement>(null)
  const screenClipRef = useRef<HTMLDivElement>(null)
  const plusRef = useRef<HTMLDivElement>(null)
  const plusRafRef = useRef<number | null>(null)

  const [streamReady, setStreamReady] = useState(false)
  const [layoutReady, setLayoutReady] = useState(false)
  const [releaseOverlay, setReleaseOverlay] = useState<string | null>(null)
  const pendingReleaseReasonRef = useRef<string | null>(null)
  const [appsExpanded, setAppsExpanded] = useState(false)
  const [selectedAppId, setSelectedAppId] = useState(APP_LIBRARY[0]?.id ?? '')
  const [selectedReleaseId, setSelectedReleaseId] = useState(APP_LIBRARY[0]?.releases[0]?.id ?? '')
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>('')

  const wsRef = useRef<WebSocket | null>(null)
  const offerSentRef = useRef(false)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intentionalCloseRef = useRef(false)

  const [viewerId, setViewerId] = useState<string | null>(null)
  const viewerIdRef = useRef<string | null>(null)
  useEffect(() => {
    viewerIdRef.current = viewerId
  }, [viewerId])

  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)

  /**
   * Handler that  cleanly shits down the viewer's signaling and webrtc connections 
   * Calls whenever a session is released - either by the server or the linactivity sweep 
   */
  const stopStreamingTransport = useCallback(() => {
    intentionalCloseRef.current = true
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    const sock = wsRef.current
    if (sock) {
      try {
        sock.onopen = null
        sock.onmessage = null
        sock.onclose = null
        sock.onerror = null
      } catch {}
      try {
        sock.close()
      } catch {}
      wsRef.current = null
    }
    const pc = pcRef.current
    if (pc) {
      try {
        pc.close()
      } catch {}
    }
  }, [])
  const startedRef = useRef(false)

  //Controller State & Handling 
  const [controllerId, setControllerId] = useState<string | null>(null)
  const [interactionState, setInteractionState] = useState<'idle' | 'starting' | 'ready' | 'error'>('idle')

  const canControl = !!viewerId && !!controllerId && viewerId === controllerId
  const canInteract = canControl && interactionState === 'ready'
  const isWarmingControl = canControl && interactionState === 'starting'
  const canInteractRef = useRef(false)
  useEffect(() => {
    canInteractRef.current = !!canInteract
  }, [canInteract])
  useEffect(() => {
    if (canInteract) registerActivity()
  }, [canInteract, registerActivity])

  // Zoom settings
  const ZMIN = 0.25
  const ZMAX = 3.0
  const [scale, setScale] = useState<number>(() => parseFloat(localStorage.getItem('emuZoom') || '1') || 1)
  const scaleRef = useRef(scale)
  useEffect(() => {
    scaleRef.current = scale
  }, [scale])
  const [fitScale, setFitScale] = useState(1)
  const fitScaleRef = useRef(fitScale)
  useEffect(() => {
    fitScaleRef.current = fitScale
  }, [fitScale])
  const updateFitScale = useCallback(
    (value: number) => {
      const clamped = clamp(value, ZMIN, ZMAX)
      fitScaleRef.current = clamped
      setFitScale(clamped)
    },
    [ZMIN, ZMAX]
  )

  const userZoomedRef = useRef(false)

  //Hnalders closing the inactivity/release overlay 
  const acknowledgeRelease = useCallback(() => {

    //If no overlay -> exit 
    if (!releaseOverlay) return

    //Clears the overlay 
    setReleaseOverlay(null)

    //Resets the pendingReleaseReason to prevent reshows 
    const reason = pendingReleaseReasonRef.current || 'released'
    pendingReleaseReasonRef.current = null
    setTimeout(() => {
      try {
        onReleasedRef.current?.({ reason, silent: true })
      } catch {}
    }, 0)
  }, [releaseOverlay])

  useEffect(() => {
    if (!props.pendingReleaseReason) return
    pendingReleaseReasonRef.current = props.pendingReleaseReason
    stopStreamingTransport()
    if (!isActiveRef.current) return
    if (releaseOverlay) return
    setReleaseOverlay(props.pendingReleaseReason)
  }, [props.pendingReleaseReason, releaseOverlay, stopStreamingTransport])

  useEffect(() => {
    if (!pendingReleaseReasonRef.current) return
    if (!isActiveRef.current) return
    if (releaseOverlay) return
    setReleaseOverlay(pendingReleaseReasonRef.current)
  }, [isActive, releaseOverlay])

  // Base (locked) VIDEO intrinsic size (screen-only) in pixels.
  const baseSizeRef = useRef<{ w: number; h: number } | null>(null)
  const setBaseSizeOnce = useCallback((w: number, h: number) => {
    if (!w || !h) return
    if (!baseSizeRef.current) baseSizeRef.current = { w, h }
  }, [])

  // Bezel PNG natural size
  const [bezelNatural, setBezelNatural] = useState<{ w: number; h: number } | null>(null)

  const bezelKind = pickBezelKind(device?.name || '')
  const bezelSrc = BEZELS[bezelKind]
  const insetsFrac = BEZEL_INSETS_FRAC[bezelKind]

  // Load bezel image once to get naturalWidth/Height
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

  const computeFrame = useCallback(() => {
    const base = baseSizeRef.current
    if (!base) return null
    if (!bezelNatural) return null

    const fracW = 1 - insetsFrac.left - insetsFrac.right
    const fracH = 1 - insetsFrac.top - insetsFrac.bottom
    if (fracW <= 0 || fracH <= 0) return null

    const frameW = base.w / fracW
    const frameH = base.h / fracH

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

  const applyLayout = useCallback(
    (newZoom: number) => {
      const stage = stageRef.current
      const screenClip = screenClipRef.current
      const video = videoRef.current
      if (!stage || !screenClip || !video) return

      const geom = computeFrame()

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

      stage.style.width = Math.round(geom.frameW * newZoom) + 'px'
      stage.style.height = Math.round(geom.frameH * newZoom) + 'px'

      screenClip.style.left = Math.round(geom.insetLeft * newZoom) + 'px'
      screenClip.style.top = Math.round(geom.insetTop * newZoom) + 'px'
      screenClip.style.width = Math.round(geom.screenW * newZoom) + 'px'
      screenClip.style.height = Math.round(geom.screenH * newZoom) + 'px'

      const rFrac = (SCREEN_CORNER_RADIUS_FRAC as any)[bezelKind] ?? 0.038
      const r = Math.round(Math.min(geom.screenW, geom.screenH) * rFrac * newZoom)
      screenClip.style.borderRadius = r + 'px'

      video.style.width = '100%'
      video.style.height = '100%'
    },
    [computeFrame, bezelKind]
  )

  const MIN_RELATIVE_ZOOM = 0.4
  const applyZoom = useCallback(
    (z: number, reason: 'user' | 'auto' = 'user') => {
      const minScale = Math.max(ZMIN, fitScaleRef.current * MIN_RELATIVE_ZOOM)
      const nz = clamp(z, minScale, ZMAX)
      if (reason === 'user') userZoomedRef.current = true
      if (reason === 'user') registerActivity()
      setScale(nz)
      localStorage.setItem('emuZoom', String(nz))
      applyLayout(nz)
    },
    [applyLayout, registerActivity]
  )
  const computeFrameRef = useRef(computeFrame)
  const applyLayoutRef = useRef(applyLayout)
  const applyZoomRef = useRef(applyZoom)
  const updateFitScaleRef = useRef(updateFitScale)
  useEffect(() => {
    computeFrameRef.current = computeFrame
  }, [computeFrame])
  useEffect(() => {
    applyLayoutRef.current = applyLayout
  }, [applyLayout])
  useEffect(() => {
    applyZoomRef.current = applyZoom
  }, [applyZoom])
  useEffect(() => {
    updateFitScaleRef.current = updateFitScale
  }, [updateFitScale])

  // ✅ Fit: auto-fit to view (device + bezel)
  const fitToWindow = useCallback(() => {
    const view = viewRef.current
    if (!view) return

    const PAD = 16
    const geom = computeFrame()
    const base = baseSizeRef.current

    const frameW = geom?.frameW ?? base?.w
    const frameH = geom?.frameH ?? base?.h
    if (!frameW || !frameH) return

    const availW = Math.max(0, view.clientWidth - PAD * 2)
    const availH = Math.max(0, view.clientHeight - PAD * 2)
    const raw = Math.min(availW / frameW, availH / frameH)

    userZoomedRef.current = false
    const clamped = clamp(raw, ZMIN, ZMAX)
    updateFitScale(clamped)
    applyZoom(clamped, 'auto')
  }, [applyZoom, computeFrame, updateFitScale])

  const sendHome = useCallback(() => {
    if (!device) return
    if (!isActiveRef.current) return
    if (!canInteractRef.current) return
    registerActivity()

    const ws = wsRef.current
    if (!ws) return

    const payload = JSON.stringify({
      type: 'home',
      deviceId: device.id,
      viewerId: viewerIdRef.current,
    })

    if (dcRef.current && dcRef.current.readyState === 'open') {
      dcRef.current.send(payload)
    } else if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload)
    }
  }, [device, registerActivity])

  // --- MAIN CONNECT / STREAM SETUP ---
  useEffect(() => {
    if (!device) return
    if (startedRef.current) return
    startedRef.current = true

    const video = videoRef.current!
    const stage = stageRef.current!
    const view = viewRef.current!
    setStreamReady(false)
    setLayoutReady(false)
    setReleaseOverlay(null)
    pendingReleaseReasonRef.current = null
    setInteractionState('idle')

    offerSentRef.current = false
    userZoomedRef.current = false
    baseSizeRef.current = null

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })
    pcRef.current = pc

    console.log('WS url', SIGNAL_URL)
    let wsAttempt = 0

    let disposed = false
    intentionalCloseRef.current = false
    reconnectTimerRef.current = null

    const makeWs = () => {
      const w = new WebSocket(SIGNAL_URL)
      wsRef.current = w
      return w
    }
    let ws = makeWs()

    //Handles automatic viewer reconnection when the signaling WS  drops inexpectedly 
    const scheduleReconnect = () => {
      if (disposed || intentionalCloseRef.current) return
      const wait = Math.min(15000, 300 * Math.pow(2, wsAttempt++)) + Math.random() * 250
      console.warn(`[ws] closed; reconnecting in ${Math.round(wait)}ms`)
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = window.setTimeout(() => {
        if (disposed || intentionalCloseRef.current) return
        ws = makeWs()
        bindWsHandlers(ws)
      }, wait)
    }

    //Wires up the lifecycle events for the viewer's signaling WS 
    const bindWsHandlers = (sock: WebSocket) => {

      //When the socket opens, we send a message to server for viewing! 
      sock.onopen = async () => {
        wsAttempt = 0
        sock.send(JSON.stringify({ type: 'iam-viewer', deviceId: device.id }))

        //Adds a video transciever for our PC to recieve video only 
        const tx = pc.addTransceiver('video', { direction: 'recvonly' })
        preferH264OnTransceiver(pc, tx)
      }

      //Processes messages over websocket 
      sock.onmessage = async (event) => {

        //Parse the WS message 
        const msg: any = JSON.parse(event.data)

        //Sets the remote SDP/answer when the agent responds to our offer  
        if (msg.type === 'answer' && msg.deviceId === device.id) {
          await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
        } 
        //Adds ICE candidates to our PC  
        else if (msg.type === 'ice' && msg.deviceId === device.id && msg.candidate) {
          try {
            await pc.addIceCandidate(msg.candidate)
          } catch {}
        }
        else if (msg.type === 'viewer-id' && msg.deviceId === device.id) {

          //Records the assigned viewer ID established from server
          setViewerId(msg.viewerId)

          //Checks if ofer has been sent 
          if (!offerSentRef.current) {

            //Offer has not be sent -> send one 
            offerSentRef.current = true

            //Create offer and set it locally 
            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)

            //Send offer to server for agent 
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
        }
        //Updates controller state to determine whether user can interact 
        else if (msg.type === 'control-state' && msg.deviceId === device.id) {
          setControllerId(msg.controllerId || null)
        }
        else if (msg.type === 'interaction-state' && msg.deviceId === device.id) {
          const nextState =
            msg.state === 'starting' || msg.state === 'ready' || msg.state === 'error'
              ? msg.state
              : 'idle'
          setInteractionState(nextState)
        }
         //Updates controller state to determine whether user can interact  
        else if (msg.type === 'control-denied' && msg.deviceId === device.id) {
          setControllerId(msg.controllerId || null)
        } 
        //Server tells us the controller was release (inactivity)
        //Show overlay & stop streaming 
        else if (msg.type === 'session-released' && msg.deviceId === device.id) {
          const reasonRaw = (msg.reason || '').toString().toLowerCase()
          let reasonMessage = 'This session has been released.'
          if (reasonRaw.includes('inactive') || reasonRaw.includes('idle')) {
            reasonMessage = 'Session released due to inactivity.'
          } 
          if (canInteractRef.current) {
            pendingReleaseReasonRef.current = msg.reason || 'released'
            setReleaseOverlay(reasonMessage)
          } else {
            try {
              onReleasedRef.current?.({ reason: msg.reason || 'released', silent: false })
            } catch {}
          }
          stopStreamingTransport()
        }
      }

      sock.onerror = () => {
        try {
          sock.close()
        } catch {}
      }

      sock.onclose = () => {
        if (disposed || intentionalCloseRef.current) return
        scheduleReconnect()
      }
    }

    //Calls the binding method on our newly created Web Socket 
    bindWsHandlers(ws)

    // P2P control channel
    const dc = pc.createDataChannel('control', { ordered: true })
    dcRef.current = dc
    dc.onopen = () => console.log('[dc] open')
    dc.onclose = () => console.log('[dc] close')
    dc.onerror = (e) => console.log('[dc] error', e)

    //Sends interaction events from viewer to agent 
    const sendControl = (obj: any) => {
      const s = JSON.stringify(obj)
      if (dc.readyState === 'open') dc.send(s)
      else if (ws.readyState === WebSocket.OPEN) ws.send(s)
    }

    // Stats HUD -> signaling (only when active)
    const stopHud = () => {}

    pc.oniceconnectionstatechange = () => console.log('[viewer] ice=', pc.iceConnectionState)
    pc.onconnectionstatechange = () => console.log('[viewer] conn=', pc.connectionState)
    pc.onicegatheringstatechange = () => console.log('[viewer] gathering=', pc.iceGatheringState)

    //Fires everytime the agent sends us a media tracl
    pc.ontrack = (event) => {
      console.log('[viewer] ontrack streams=', event.streams?.length, 'track=', event.track.kind, event.track.id)
      
      //Grabs the stream 
      const [stream] = event.streams
      if (!stream) return

      //Attaches the stream to the video element 
      video.srcObject = stream
      video.autoplay = true
      video.playsInline = true
      video.muted = true
      ;(video as any).disablePictureInPicture = true

      video.play().catch((e) => console.warn('video.play() failed:', e))

      // TTFF observer disabled for now
    }

    // const statsInterval = setInterval(async () => {
    //   if (!isActiveRef.current) return
    //   try {
    //     await pc.getStats()
    //   } catch (e) {
    //     console.warn('[stats] getStats failed', e)
    //   }
    // }, 1000)

    //Fires when PC discovers new ICE Candidate -> forward to server to agent  
    pc.onicecandidate = (event) => {
      if (!event.candidate) return
      const payload: any = {
        type: 'ice',
        deviceId: device.id,
        candidate: event.candidate,
      }
      if (viewerIdRef.current) payload.viewerId = viewerIdRef.current
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload))
      }
    }

    // Normalize relative to the screen hole
    const getNorm = (ev: MouseEvent) => {
      const screenEl = screenClipRef.current || video
      const rect = screenEl.getBoundingClientRect()
      const x = (ev.clientX - rect.left) / rect.width
      const y = (ev.clientY - rect.top) / rect.height
      return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) }
    }

    const onDown = (ev: MouseEvent) => {
      if (!isActiveRef.current) return
      if (!canInteractRef.current) return
      onActivityRef.current?.()
      const { x, y } = getNorm(ev)
      sendControl({ type: 'pointer', deviceId: device.id, kind: 'down', x, y, buttons: ev.buttons | 1 })
    }

    const onMove = (ev: MouseEvent) => {
      if (!isActiveRef.current) return
      if (!canInteractRef.current) return
      if ((ev.buttons & 1) === 0) return
      onActivityRef.current?.()
      const { x, y } = getNorm(ev)
      sendControl({ type: 'pointer', deviceId: device.id, kind: 'move', x, y, buttons: ev.buttons | 1 })
    }

    const onUp = (ev: MouseEvent) => {
      if (!isActiveRef.current) return
      if (!canInteractRef.current) return
      onActivityRef.current?.()
      const { x, y } = getNorm(ev)
      sendControl({ type: 'pointer', deviceId: device.id, kind: 'up', x, y, buttons: 0 })
    }

    // Update the hover pointer outside React so it stays smooth while the stream is live.
    const setPlusFromMouse = (ev: MouseEvent, on: boolean) => {
      const plusEl = plusRef.current
      if (!plusEl) return
      const stageRect = stage.getBoundingClientRect()
      const x = ev.clientX - stageRect.left
      const y = ev.clientY - stageRect.top

      if (plusRafRef.current != null) {
        cancelAnimationFrame(plusRafRef.current)
      }
      plusRafRef.current = requestAnimationFrame(() => {
        plusRafRef.current = null
        plusEl.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`
        plusEl.style.opacity = on ? '1' : '0'
      })
    }

    const onEnterPlus = (ev: MouseEvent) => {
      if (!isActiveRef.current) return
      setPlusFromMouse(ev, true)
    }
    const onLeavePlus = () => {
      if (plusRafRef.current != null) {
        cancelAnimationFrame(plusRafRef.current)
        plusRafRef.current = null
      }
      if (plusRef.current) plusRef.current.style.opacity = '0'
    }
    const onMovePlus = (ev: MouseEvent) => {
      if (!isActiveRef.current) return
      setPlusFromMouse(ev, true)
    }

    // Wheel debounce
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
      if (ws.readyState !== WebSocket.OPEN) return

      ws.send(JSON.stringify({ type: 'pointer', deviceId: device.id, kind: 'scroll', x: 0.5, y: 0.5, dx, dy }))
      wheelCooldownUntil = performance.now() + WHEEL_COOLDOWN_MS
    }

    const onWheel = (ev: WheelEvent) => {
      if (!isActiveRef.current) return
      if (!canInteractRef.current) return
      onActivityRef.current?.()
      ev.preventDefault()
      const now = performance.now()
      if (now < wheelCooldownUntil) return

      wheelAccDx += ev.deltaX
      wheelAccDy += ev.deltaY

      if (wheelTimer) clearTimeout(wheelTimer)
      wheelTimer = setTimeout(flushWheel, WHEEL_DEBOUNCE_MS)
    }

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
      if (!isActiveRef.current) return
      if (!canInteractRef.current) return
      onActivityRef.current?.()

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
      if (!isActiveRef.current) return
      if (!canInteractRef.current) return

      if (e.key.length === 1 && !e.metaKey) {
        e.preventDefault()
        return
      }

      sendControl({ type: 'key', deviceId: device.id, action: 'up', code: e.code, key: e.key })
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
      const clamped = clamp(s, ZMIN, ZMAX)
      updateFitScaleRef.current(clamped)
      applyZoomRef.current(clamped, 'auto')
    }

    const resizeObserver = new ResizeObserver(() => {
      if (!isActiveRef.current) return
      if (userZoomedRef.current) return

      const geom = computeFrameRef.current()
      if (geom) doAutoFit(geom.frameW, geom.frameH)
    })
    resizeObserver.observe(view)

    const maybeInitFromVideoDims = () => {
      const w = video.videoWidth
      const h = video.videoHeight
      if (!w || !h) return false

      setBaseSizeOnce(w, h)

      const geom = computeFrameRef.current()
      if (geom) {
        applyLayoutRef.current(scaleRef.current)
        setLayoutReady(true)
      }
      if (!didAutoFit && !userZoomedRef.current && geom) {
        didAutoFit = true
        doAutoFit(geom.frameW, geom.frameH)
      }
      return true
    }

    const onLoadedMetadata = () => {
      maybeInitFromVideoDims()
    }
    video.addEventListener('loadedmetadata', onLoadedMetadata)

    const onResize = () => {
      if (!isActiveRef.current) return
      if (userZoomedRef.current) return
      const geom = computeFrameRef.current()
      if (geom) doAutoFit(geom.frameW, geom.frameH)
    }
    window.addEventListener('resize', onResize)

    const setIce = (txt: string, cls: 'ok' | 'warn' | 'err' = 'warn') => {
      if (!iceRef.current) return
      iceRef.current.textContent = txt
      ;(iceRef.current as any).className = `badge ${cls}`
    }
    setIce('connecting…', 'warn')
    const onVideoConnected = () => {
      setIce('connected', 'ok')
      setStreamReady(true)
    }
    video.addEventListener('playing', onVideoConnected, { once: true })

    return () => {
      stopHud?.()
      //clearInterval(statsInterval)
      if (wheelTimer) clearTimeout(wheelTimer)

      window.removeEventListener('resize', onResize)
      resizeObserver.disconnect()
      video.removeEventListener('loadedmetadata', onLoadedMetadata)
      video.removeEventListener('playing', onVideoConnected)

      screenEl.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      screenEl.removeEventListener('mouseenter', onEnterPlus)
      screenEl.removeEventListener('mouseleave', onLeavePlus)
      screenEl.removeEventListener('mousemove', onMovePlus)
      screenEl.removeEventListener('wheel', onWheel as any)

      host.removeEventListener('keydown', onKeyDown)
      host.removeEventListener('keyup', onKeyUp)
      if (plusRafRef.current != null) {
        cancelAnimationFrame(plusRafRef.current)
        plusRafRef.current = null
      }
      if (plusRef.current) plusRef.current.style.opacity = '0'

      disposed = true
      intentionalCloseRef.current = true
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }

      try {
        ws.onopen = null
        ws.onmessage = null
        ws.onclose = null
        ws.onerror = null
      } catch {}

      try {
        ws.close()
      } catch {}
      try {
        pc.close()
      } catch {}

      wsRef.current = null
      startedRef.current = false
      offerSentRef.current = false
    }
  }, [deviceId, device, setBaseSizeOnce, stopStreamingTransport])

  // Re-apply layout whenever bezel loads
  useEffect(() => {
    if (!baseSizeRef.current) return
    applyLayout(scaleRef.current)
    setLayoutReady(true)

    if (!userZoomedRef.current && viewRef.current) {
      const geom = computeFrame()
      if (geom) {
        const PAD = 16
        const availW = Math.max(0, viewRef.current.clientWidth - PAD * 2)
        const availH = Math.max(0, viewRef.current.clientHeight - PAD * 2)
        const raw = Math.min(availW / geom.frameW, availH / geom.frameH)
        const s = Math.min(AUTO_MAX_FIT, raw)
        const nz = clamp(s, ZMIN, ZMAX)
        updateFitScale(nz)
        setScale(nz)
        localStorage.setItem('emuZoom', String(nz))
        applyLayout(nz)
      }
    }
  }, [bezelNatural, computeFrame, applyLayout, updateFitScale])

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

  function startStatsHud() {
    return () => {}
  }

  if (!device) {
    return (
      <Box sx={{ p: 3 }}>
        <Typography variant="h5">Device not found</Typography>
      </Box>
    )
  }

  // ✅ Proportional toolbar sizing: tied to zoom
  const safeFitScale = fitScale || 1
  const relativeZoom = scale / safeFitScale
  const displayZoomPct = Math.round(relativeZoom * 100)
  const deltaFromFit = scale - safeFitScale
  const minScaleAllowed = Math.max(ZMIN, safeFitScale * MIN_RELATIVE_ZOOM)
  const maxDelta = Math.max(safeFitScale - minScaleAllowed, ZMAX - safeFitScale)
  const sliderMin = minScaleAllowed - safeFitScale
  const sliderMax = maxDelta
  const sliderValue = clamp(deltaFromFit, sliderMin, sliderMax)
  const targetPlatform = device?.platform as ArtifactPlatform | undefined

  const selectedApp = useMemo(() => APP_LIBRARY.find((app) => app.id === selectedAppId) || APP_LIBRARY[0], [selectedAppId])
  const releaseOptions = useMemo(() => {
    if (!selectedApp) return []
    if (!targetPlatform) return selectedApp.releases
    const filtered = selectedApp.releases.filter((rel) => rel.artifacts.some((artifact) => artifact.platform === targetPlatform))
    return filtered.length ? filtered : selectedApp.releases
  }, [selectedApp, targetPlatform])

  useEffect(() => {
    if (!releaseOptions.length) {
      if (selectedReleaseId) setSelectedReleaseId('')
      return
    }
    if (!releaseOptions.some((rel) => rel.id === selectedReleaseId)) {
      setSelectedReleaseId(releaseOptions[0].id)
    }
  }, [releaseOptions, selectedReleaseId])

  const formatReleaseVersion = useCallback((rel?: AppRelease | null) => {
    if (!rel) return ''
    if (rel.date) {
      const dt = new Date(rel.date)
      if (!isNaN(dt.getTime())) {
        const month = String(dt.getMonth() + 1).padStart(2, '0')
        return `${dt.getFullYear()}.${month}`
      }
    }
    return rel.label.replace(/^v/i, '')
  }, [])

  const selectedRelease = releaseOptions.find((rel) => rel.id === selectedReleaseId) || releaseOptions[0]
  const releaseArtifacts = useMemo(() => {
    if (!selectedRelease) return []
    return (selectedRelease.artifacts ?? []).filter((artifact) => artifact.platform === targetPlatform)
  }, [selectedRelease, targetPlatform])
  useEffect(() => {
    if (!releaseArtifacts.length) {
      setSelectedArtifactId('')
      return
    }
    setSelectedArtifactId((prev) => (releaseArtifacts.some((art) => art.id === prev) ? prev : releaseArtifacts[0].id))
  }, [releaseArtifacts])
  const artifactsScrollable = releaseArtifacts.length > 5
  const noArtifactsMessage = targetPlatform
    ? `No ${targetPlatform.toUpperCase()} builds available for this release.`
    : 'No builds available for this release.'

  const bezelGeom = computeFrame()
  const screenBasis = bezelGeom?.screenW ?? baseSizeRef.current?.w ?? 390
  const railW = Math.round(clamp(screenBasis * scale * 0.12, 14, 70))
  const railPadY = Math.round(clamp(6 * scale, 2, 10))
  const iconBox = Math.round(clamp(30 * scale, 14, 42))
  const iconSize = Math.round(clamp(20 * scale, 12, 26))
  const railRadius = 0
  const railGap = Math.round(clamp(6 * scale, 3, 10))
  const spinnerSize = Math.round(clamp(screenBasis * scale * 0.14, 32, 88))

  return (
    <>
      <style>{`
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

        .modeCard.interact{
          border-color: color-mix(in srgb, var(--brandBtn) 60%, transparent);
          box-shadow:
            0 0 0 1px color-mix(in srgb, var(--brandBtn) 35%, transparent),
            0 12px 30px color-mix(in srgb, var(--brandBtn) 20%, transparent);
        }
        .modeDot.interact{
          background: var(--brandBtn);
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--brandBtn) 25%, transparent);
        }

        .modeCard.viewonly{
          border-color: rgba(255, 190, 90, 0.35);
          box-shadow: 0 0 0 1px rgba(255, 190, 90, 0.10), 0 12px 30px rgba(255, 190, 90, 0.05);
        }
        .modeDot.viewonly{ background: rgba(255, 190, 90, 0.95); }
      `}</style>

      <Box
        sx={{
          position: 'relative',
          width: '100%',
          height: '100%',
          display: 'grid',
          gridTemplateColumns: '1fr 360px',
          bgcolor: 'var(--bg)',
          color: 'var(--text)',
          minHeight: 0,
        }}
      >
        {/* LEFT SIDE */}
        <Box
          ref={viewRef}
          sx={{
            display: 'grid',
            placeItems: 'center',
            bgcolor: 'var(--panel)',
            overflow: 'auto',
            outline: 'none',
          }}
        >
          {/* Wrapper anchors toolbar to stage so it stays docked during zoom */}
          <Box sx={{ position: 'relative', display: 'inline-block' }}>
            <Box
              id="stage"
              ref={stageRef}
              sx={{
                position: 'relative',
                overscrollBehavior: 'contain',
                opacity: layoutReady ? 1 : 0,
                transition: layoutReady ? 'opacity 120ms ease-out' : 'none',
              }}
            >
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

              <Box
                ref={plusRef}
                sx={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  transform: 'translate3d(0, 0, 0) translate(-50%, -50%)',
                  zIndex: 5,
                  color: '#00fff7',
                  fontSize: 30,
                  fontWeight: 800,
                  textShadow: '0 0 8px rgba(0,0,0,0.85)',
                  pointerEvents: 'none',
                  userSelect: 'none',
                  lineHeight: 1,
                  opacity: 0,
                  willChange: 'transform, opacity',
                }}
              >
                +
              </Box>

              {isWarmingControl && !releaseOverlay && (
                <Box
                  sx={{
                    position: 'absolute',
                    inset: 0,
                    zIndex: 6,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    bgcolor: 'rgba(6, 10, 16, 0.68)',
                    pointerEvents: 'auto',
                  }}
                >
                  <CircularProgress
                    size={spinnerSize}
                    thickness={4}
                    sx={{
                      color: 'var(--brandBtn)',
                      filter: 'drop-shadow(0 0 14px rgba(0, 200, 255, 0.3))',
                    }}
                  />
                </Box>
              )}

              {releaseOverlay && (
                <></>
              )}
            </Box>

            {/* ✅ iOS-emulator style rail: only show once stream is live */}
            {streamReady && (
              <Box
                sx={{
                  position: 'absolute',
                  top: '8%',
                  left: '100%',
                  ml: 0,
                  height: '40%',
                  width: railW,
                  bgcolor: '#f3f4f6',
                  border: '1px solid #cbd5e1',
                  borderRadius: railRadius,
                  boxShadow: '0 10px 22px rgba(0,0,0,0.16)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'flex-start',
                  gap: `${railGap}px`,
                  pt: `${railPadY}px`,
                  pb: `${Math.max(railPadY - 4, 2)}px`,
                  zIndex: 10,
                  pointerEvents: 'auto',
                }}
              >
                <Tooltip title="Home" placement="left">
                  <span>
                    <IconButton
                      onClick={sendHome}
                      disabled={!canInteract}
                      sx={{
                        width: iconBox,
                        height: iconBox,
                        borderRadius: 0,
                        color: canInteract ? '#475569' : '#94a3b8',
                        '&:hover': { bgcolor: 'rgba(15,23,42,0.06)', color: '#334155' },
                        '&.Mui-disabled': { color: 'rgba(148,163,184,0.55)' },
                      }}
                    >
                      <HomeRoundedIcon sx={{ fontSize: iconSize }} />
                    </IconButton>
                  </span>
                </Tooltip>

                {/* <Tooltip title="Power" placement="left">
                  <span>
                    <IconButton
                      onClick={sendPower}
                      disabled
                      sx={{
                        width: iconBox,
                        height: iconBox,
                        borderRadius: 0,
                        color: '#94a3b8',
                        '&:hover': { bgcolor: 'rgba(15,23,42,0.06)', color: '#64748b' },
                        '&.Mui-disabled': { color: 'rgba(148,163,184,0.55)' },
                      }}
                    >
                      <PowerSettingsNewRoundedIcon sx={{ fontSize: iconSize }} />
                    </IconButton>
                  </span>
                </Tooltip> */}
              </Box>
            )}
          </Box>
        </Box>

        {/* RIGHT PANEL */}
        <Box
          sx={{
            borderLeft: '1px solid var(--border)',
            bgcolor: 'var(--panel)',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          {/* Header */}
          <Box sx={{ px: 2, pt: 2, pb: 1.5, borderBottom: '1px solid var(--border)' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography sx={{ fontWeight: 700, fontSize: 16, flex: 1 }}>{device.name}</Typography>

              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Box
                  sx={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    bgcolor: '#22c55e',
                    boxShadow: '0 0 0 3px rgba(34,197,94,0.2)',
                  }}
                />
                <Typography sx={{ fontSize: 12.5, fontWeight: 700 }}>Connected</Typography>
              </Box>
            </Box>
          </Box>

          <Box
            sx={{
              flex: 1,
              overflow: 'auto',
              px: 2,
              py: 2,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            {/* Interaction status */}
            <Box className={`modeCard ${canInteract ? 'interact' : isWarmingControl ? 'interact' : 'viewonly'}`}>
              <span className={`modeDot ${canInteract ? 'interact' : isWarmingControl ? 'interact' : 'viewonly'}`} />
              <Box sx={{ flex: 1 }}>
                <Box className="modeTitle">
                  {canInteract ? 'Interactive access' : isWarmingControl ? 'Preparing interactive access' : 'View-only access'}
                  <span className="modePill">{canInteract ? 'LIVE' : isWarmingControl ? 'WARMING' : 'LOCKED'}</span>
                </Box>
                <Box className="modeDesc">
                  {canInteract
                    ? 'You control touch, keys, and scroll.'
                    : isWarmingControl
                      ? 'Your control session is starting. Input is temporarily blocked.'
                      : 'Another user is controlling this device.'}
                </Box>
              </Box>
            </Box>

            {/* Zoom */}
            <Box>
              <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
                <Typography sx={{ fontSize: 12, fontWeight: 800, color: 'var(--muted)' }}>Zoom</Typography>
                <Box sx={{ flex: 1 }} />
                <Typography sx={{ fontSize: 12.5, fontWeight: 700, ml: 1 }}>{displayZoomPct}%</Typography>
              </Box>

              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Button size="small" sx={btnSx} onClick={() => applyZoom(scaleRef.current / 1.1, 'user')}>
                  −
                </Button>

                <Slider
                  value={sliderValue}
                  min={sliderMin}
                  max={sliderMax}
                  step={0.05}
                  onChange={(_, v) => {
                    const delta = Array.isArray(v) ? v[0] : (v as number)
                    const target = fitScaleRef.current + delta
                    applyZoom(target, 'user')
                  }}
                  sx={{
                    flex: 1,
                    '& .MuiSlider-track': { bgcolor: 'var(--brandBtn)' },
                    '& .MuiSlider-rail': { bgcolor: 'var(--chip-border)' },
                    '& .MuiSlider-thumb': { bgcolor: 'var(--brandBtn)' },
                  }}
                />

                <Button size="small" sx={btnSx} onClick={() => applyZoom(scaleRef.current * 1.1, 'user')}>
                  +
                </Button>
                <Button size="small" sx={{ ...btnSx, minWidth: 48 }} onClick={fitToWindow}>
                  Fit
                </Button>
              </Box>
            </Box>

            <Divider sx={{ borderColor: 'var(--border)', mt: 0.5, mb: 1 }} />

            {/* App installs */}
            {canInteract && (
              <>
                <Box>
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      cursor: 'pointer',
                      py: 0.5,
                    }}
                    onClick={() => {
                      registerActivity()
                      setAppsExpanded((prev) => !prev)
                    }}
                  >
                    <Box>
                      <Typography sx={{ fontSize: 12, fontWeight: 800, color: 'var(--text)', textTransform: 'uppercase', letterSpacing: 0.6 }}>
                        Install Apps
                      </Typography>
                      <Typography sx={{ fontSize: 12, color: 'var(--muted-light, rgba(255,255,255,0.75))' }}>
                        Push curated builds to this device.
                      </Typography>
                    </Box>
                    <Typography sx={{ fontSize: 22, lineHeight: 1, color: 'var(--muted)', transform: appsExpanded ? 'rotate(180deg)' : 'none' }}>
                      ˅
                    </Typography>
                  </Box>

                  {appsExpanded && (
                    <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
                      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'nowrap' }}>
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Typography sx={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>App</Typography>
                          <Select
                            fullWidth
                            size="small"
                            value={selectedAppId}
                            onChange={(e) => {
                              registerActivity()
                              setSelectedAppId(e.target.value)
                            }}
                            sx={{
                              mt: 0.5,
                              borderRadius: 0,
                              bgcolor: 'rgba(255,255,255,0.06)',
                              '& .MuiSelect-select': { color: 'var(--text)' },
                            }}
                          >
                            {APP_LIBRARY.map((app) => (
                              <MenuItem key={app.id} value={app.id}>
                                {app.name}
                              </MenuItem>
                            ))}
                          </Select>
                        </Box>

                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Typography sx={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>Release</Typography>
                          <Select
                            fullWidth
                            size="small"
                            value={selectedRelease?.id || ''}
                            disabled={!releaseOptions.length}
                            onChange={(e) => {
                              registerActivity()
                              setSelectedReleaseId(e.target.value)
                            }}
                            sx={{
                              mt: 0.5,
                              borderRadius: 0,
                              bgcolor: 'rgba(255,255,255,0.06)',
                              '& .MuiSelect-select': { color: 'var(--text)' },
                            }}
                          >
                            {releaseOptions.map((rel) => (
                              <MenuItem key={rel.id} value={rel.id}>
                                {formatReleaseVersion(rel)}
                              </MenuItem>
                            ))}
                          </Select>
                        </Box>
                      </Box>

                      <Divider sx={{ borderColor: 'var(--chip-border)' }} />

                      <Box
                        sx={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 0.6,
                          maxHeight: artifactsScrollable ? 200 : 'none',
                          overflowY: artifactsScrollable ? 'auto' : 'visible',
                          pr: artifactsScrollable ? 0.5 : 0,
                        }}
                      >
                        {releaseArtifacts.length ? (
                          releaseArtifacts.map((artifact) => {
                            const isSelected = artifact.id === selectedArtifactId
                            return (
                              <Box
                                key={artifact.id}
                                onClick={() => {
                                  registerActivity()
                                  setSelectedArtifactId(artifact.id)
                                }}
                                sx={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  py: 0.6,
                                  px: 0.75,
                                  border: '1px solid var(--chip-border)',
                                  borderRadius: 1,
                                  cursor: 'pointer',
                                  bgcolor: isSelected ? 'rgba(104,160,255,0.12)' : 'transparent',
                                  color: isSelected ? 'var(--text)' : 'var(--muted)',
                                  fontFamily: 'monospace',
                                  fontSize: 15,
                                  fontWeight: 700,
                                }}
                              >
                                <Typography sx={{ fontFamily: 'inherit', fontSize: 'inherit', fontWeight: 'inherit' }}>{artifact.code}</Typography>
                                <IconButton
                                  size="small"
                                  sx={{ color: 'var(--text)' }}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    registerActivity()
                                    setSelectedArtifactId(artifact.id)
                                  }}
                                >
                                  <DownloadRoundedIcon fontSize="small" />
                                </IconButton>
                              </Box>
                            )
                          })
                        ) : (
                          <Typography sx={{ fontSize: 12.5, color: 'var(--muted)' }}>{noArtifactsMessage}</Typography>
                        )}
                      </Box>
                    </Box>
                  )}
                </Box>

                <Divider sx={{ borderColor: 'var(--border)', mt: 1.5 }} />
              </>
            )}
          </Box>
        </Box>
      </Box>

      {releaseOverlay && isActive && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            bgcolor: 'rgba(2,6,23,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 99,
          }}
        >
          <Box
            sx={{
              width: 320,
              bgcolor: '#fff',
              borderRadius: 2,
              p: 3,
              boxShadow: '0 25px 60px rgba(0,0,0,0.45)',
              textAlign: 'center',
              color: '#0f172a',
              display: 'flex',
              flexDirection: 'column',
              gap: 1.5,
            }}
          >
            <Typography sx={{ fontSize: 22, fontWeight: 800 }}>We are sorry…</Typography>
            <Typography sx={{ fontSize: 15, fontWeight: 600 }}>Your device is no longer available.</Typography>
            <Typography sx={{ fontSize: 14, color: '#475569' }}>{releaseOverlay}</Typography>
            <Button
              variant="contained"
              onClick={acknowledgeRelease}
              sx={{
                mt: 1,
                textTransform: 'uppercase',
                fontWeight: 800,
                borderRadius: 1.5,
              }}
            >
              OK, take me to my devices page
            </Button>
          </Box>
        </Box>
      )}
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
