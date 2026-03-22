import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { Box, Button, CircularProgress, Divider, IconButton, MenuItem, Select, Slider, Tooltip, Typography } from '@mui/material'
import HomeRoundedIcon from '@mui/icons-material/HomeRounded'
import PowerSettingsNewRoundedIcon from '@mui/icons-material/PowerSettingsNewRounded'
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded'
import { devices } from '../devices'
import { APP_LIBRARY } from './appLibrary'

// Builds the WebSocket endpoint for signaling
function computeSignalUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const port = 8080
  return `${proto}//192.168.86.29:${port}/signal`
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

type ArtifactPlatform = 'ios' | 'android'

type AppArtifact = {
  id: string
  code: string
  platform: ArtifactPlatform
}

type AppRelease = {
  id: string
  label: string
  date?: string
  artifacts: AppArtifact[]
}

type LabApp = {
  id: string
  name: string
  summary: string
  releases: AppRelease[]
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n))
}

function pickBezelKind(deviceName: string): keyof typeof BEZELS {
  const n = (deviceName || '').toLowerCase()
  if (n.includes('max')) return 'proMax'
  return 'pro'
}

type ScreenIOSProps = {
  deviceId?: string
  clientSessionId: string
  isActive?: boolean
  viewOnly?: boolean
  onReleased?: (info: { reason: string; silent?: boolean }) => void
}

export default function ScreenIOS(props: ScreenIOSProps) {
  const routeId = useParams<{ deviceId: string }>().deviceId || ''
  const deviceId = props.deviceId || routeId

  const onReleasedRef = useRef<ScreenIOSProps['onReleased']>(props.onReleased)
  useEffect(() => {
    onReleasedRef.current = props.onReleased
  }, [props.onReleased])

  const isActive = props.isActive ?? true
  const isActiveRef = useRef(isActive)

  useEffect(() => {
    isActiveRef.current = isActive
    if (!isActive && plusRef.current) {
      plusRef.current.style.opacity = '0'
    }
  }, [isActive])

  const device = useMemo(() => {
    return devices.find((currentDevice) => currentDevice.id === deviceId)
  }, [deviceId])

  const videoRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const iceRef = useRef<HTMLSpanElement>(null)
  const screenClipRef = useRef<HTMLDivElement>(null)
  const plusRef = useRef<HTMLDivElement>(null)
  const plusRafRef = useRef<number | null>(null)

  const setTouchDotPressed = (pressed: boolean) => {
    const el = plusRef.current
    if (!el) return
    el.style.width = pressed ? '18px' : '14px'
    el.style.height = pressed ? '18px' : '14px'
    el.style.opacity = '1'
  }

  const [streamReady, setStreamReady] = useState(false)
  const [layoutReady, setLayoutReady] = useState(false)
  const [releaseOverlay, setReleaseOverlay] = useState<string | null>(null)
  const releaseReasonRef = useRef<string | null>(null)
  const releaseActionReasonRef = useRef<string | null>(null)

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

  const inactivityLastActivityRef = useRef<number | null>(null)
  const inactivityTimeoutMsRef = useRef<number | null>(null)
  const inactivityTickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [remainingInactivityMs, setRemainingInactivityMs] = useState<number | null>(null)


  const pcRef = useRef<RTCPeerConnection | null>(null)
  const dcRef = useRef<RTCDataChannel | null>(null)

  const stopStreamingTransport = useCallback(() => {
    intentionalCloseRef.current = true
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }

    const sock = wsRef.current
    if (sock) {
      sock.onopen = null
      sock.onmessage = null
      sock.onclose = null
      sock.onerror = null
      sock.close()
      wsRef.current = null
    }

    const pc = pcRef.current
    if (pc) {
      pc.close()
    }
  }, [])

  const startedRef = useRef(false)

  const [controllerId, setControllerId] = useState<string | null>(null)
  const [interactionState, setInteractionState] = useState<'idle' | 'starting' | 'ready' | 'error'>('idle')

  const canControl = !!viewerId && !!controllerId && viewerId === controllerId
  const canInteract = canControl && interactionState === 'ready'
  const isWarmingControl = canControl && interactionState === 'starting'
  const hasControllerError = canControl && interactionState === 'error'
  const canInteractRef = useRef(false)

  useEffect(() => {
    canInteractRef.current = !!canInteract
  }, [canInteract])

  useEffect(() => {
    if (inactivityTickRef.current) {
      clearInterval(inactivityTickRef.current)
      inactivityTickRef.current = null
    }

    if (!canControl || !inactivityLastActivityRef.current || !inactivityTimeoutMsRef.current) {
      setRemainingInactivityMs(null)
      return
    }

    const tick = () => {
      const lastActivityMs = inactivityLastActivityRef.current
      const timeoutMs = inactivityTimeoutMsRef.current

      if (!lastActivityMs || !timeoutMs) {
        setRemainingInactivityMs(null)
        return
      }

      const remaining = Math.max(0, timeoutMs - (Date.now() - lastActivityMs))
      setRemainingInactivityMs(remaining)
    }

    tick()
    inactivityTickRef.current = setInterval(tick, 500)

    return () => {
      if (inactivityTickRef.current) {
        clearInterval(inactivityTickRef.current)
        inactivityTickRef.current = null
      }
    }
  }, [canControl])


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

  const updateFitScale = useCallback((value: number) => {
    const clamped = clamp(value, ZMIN, ZMAX)
    fitScaleRef.current = clamped
    setFitScale(clamped)
  }, [])

  const userZoomedRef = useRef(false)

  const acknowledgeRelease = useCallback(() => {
    if (!releaseOverlay) return

    const reason =
      releaseActionReasonRef.current ||
      releaseReasonRef.current ||
      'released'

    releaseActionReasonRef.current = null
    releaseReasonRef.current = null
    setReleaseOverlay(null)

    setTimeout(() => {
      try {
        onReleasedRef.current?.({ reason, silent: false })
      } catch { }
    }, 0)
  }, [releaseOverlay])


  const baseSizeRef = useRef<{ w: number; h: number } | null>(null)
  const setBaseSizeOnce = useCallback((w: number, h: number) => {
    if (!w || !h) return
    if (!baseSizeRef.current) baseSizeRef.current = { w, h }
  }, [])

  const [bezelNatural, setBezelNatural] = useState<{ w: number; h: number } | null>(null)
  const hasBezel = device?.platform === 'ios'

  const bezelKind = pickBezelKind(device?.name || '')
  const bezelSrc = BEZELS[bezelKind]
  const insetsFrac = BEZEL_INSETS_FRAC[bezelKind]

  useEffect(() => {
    if (!hasBezel) {
      setBezelNatural(null)
      return
    }
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
  }, [bezelSrc, hasBezel])

  const computeFrame = useCallback(() => {
    const base = baseSizeRef.current
    if (!base) return null
    if (!hasBezel) return null
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
  }, [bezelNatural, insetsFrac, bezelSrc, hasBezel])

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

        const rFrac = device?.platform === 'android' ? 0.05 : 0.035
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
    [computeFrame, bezelKind, device?.platform]
  )

  const MIN_RELATIVE_ZOOM = 0.4
  const applyZoom = useCallback(
    (z: number, reason: 'user' | 'auto' = 'user') => {
      const minScale = Math.max(ZMIN, fitScaleRef.current * MIN_RELATIVE_ZOOM)
      const nz = clamp(z, minScale, ZMAX)
      if (reason === 'user') userZoomedRef.current = true
      setScale(nz)
      localStorage.setItem('emuZoom', String(nz))
      applyLayout(nz)
    },
    [applyLayout]
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
  }, [device])

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
    releaseReasonRef.current = null
    setInteractionState('idle')
    setViewerId(null)
    setControllerId(null)

    offerSentRef.current = false
    userZoomedRef.current = false
    baseSizeRef.current = null

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    })
    pcRef.current = pc

    // Add transceiver only once for this PC
    const tx = pc.addTransceiver('video', { direction: 'recvonly' })
    preferH264OnTransceiver(pc, tx)

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

    const bindWsHandlers = (sock: WebSocket) => {
      sock.onopen = async () => {
        wsAttempt = 0
        sock.send(
          JSON.stringify({
            type: 'iam-viewer',
            deviceId: device.id,
            clientSessionId: props.clientSessionId,
            mode: props.viewOnly ? 'watch' : 'manual',
            viewOnly: !!props.viewOnly,
          })
        )
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

          if (typeof msg.sessionTimeoutMs === 'number' && msg.sessionTimeoutMs > 0) {
            inactivityTimeoutMsRef.current = msg.sessionTimeoutMs
          }

          if (typeof msg.lastActivityMs === 'number' && msg.lastActivityMs > 0) {
            inactivityLastActivityRef.current = msg.lastActivityMs

            if (typeof msg.sessionTimeoutMs === 'number' && msg.sessionTimeoutMs > 0) {
              const remaining = Math.max(0, msg.sessionTimeoutMs - (Date.now() - msg.lastActivityMs))
              setRemainingInactivityMs(remaining)
            }
          } else {
            inactivityLastActivityRef.current = null
            setRemainingInactivityMs(null)
          }

          if (msg.resumeRejected && msg.resumeReason === 'taken_by_other_user') {
            releaseActionReasonRef.current = 'resume_failed_taken_by_other_user'
            releaseReasonRef.current = 'Control could not be resumed because another user took the device'
            setReleaseOverlay('Control could not be resumed because another user took the device')
            stopStreamingTransport()
            return
          }


          if (offerSentRef.current) return
          offerSentRef.current = true

          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)

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
        else if (msg.type === 'control-state' && msg.deviceId === device.id) {
          setControllerId(msg.controllerId || null)
        } else if (msg.type === 'interaction-state' && msg.deviceId === device.id) {
          const nextState =
            msg.state === 'starting' || msg.state === 'ready' || msg.state === 'error'
              ? msg.state
              : 'idle'
          setInteractionState(nextState)
        } else if (msg.type === 'control-denied' && msg.deviceId === device.id) {
          setControllerId(msg.controllerId || null)
        } else if (msg.type === 'session-released' && msg.deviceId === device.id) {
          const reasonRaw = (msg.reason || '').toString().toLowerCase()

          let reasonMessage = 'This session has been released.'
          if (reasonRaw.includes('inactive') || reasonRaw.includes('idle')) {
            reasonMessage = 'Session released due to inactivity.'
          } else if (reasonRaw.includes('replaced')) {
            reasonMessage = 'This device is now being used by someone else.'
          }

          releaseReasonRef.current = reasonMessage
          setReleaseOverlay(reasonMessage)
          inactivityLastActivityRef.current = null
          setRemainingInactivityMs(null)
          stopStreamingTransport()
        }
      }

      sock.onerror = () => {
        try {
          sock.close()
        } catch { }
      }

      sock.onclose = () => {
        if (disposed || intentionalCloseRef.current) return
        scheduleReconnect()
      }
    }

    bindWsHandlers(ws)

    const dc = pc.createDataChannel('control', { ordered: true })
    dcRef.current = dc
    dc.onopen = () => console.log('[dc] open')
    dc.onclose = () => console.log('[dc] close')
    dc.onerror = (e) => console.log('[dc] error', e)

    const sendControl = (obj: any) => {
      if (canControl && !props.viewOnly && inactivityTimeoutMsRef.current) {
        const now = Date.now()
        inactivityLastActivityRef.current = now
        setRemainingInactivityMs(inactivityTimeoutMsRef.current)
      }

      const s = JSON.stringify(obj)
      if (dc.readyState === 'open') dc.send(s)
      else if (ws.readyState === WebSocket.OPEN) ws.send(s)
    }


    const stopHud = () => { }

    pc.oniceconnectionstatechange = () => console.log('[viewer] ice=', pc.iceConnectionState)
    pc.onconnectionstatechange = () => console.log('[viewer] conn=', pc.connectionState)
    pc.onicegatheringstatechange = () => console.log('[viewer] gathering=', pc.iceGatheringState)

    pc.ontrack = (event) => {
      console.log('[viewer] ontrack streams=', event.streams?.length, 'track=', event.track.kind, event.track.id)

      const [stream] = event.streams
      if (!stream) return

      video.srcObject = stream
      video.autoplay = true
      video.playsInline = true
      video.muted = true
        ; (video as any).disablePictureInPicture = true

      video.play().catch((e) => console.warn('video.play() failed:', e))
    }

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

    const getNorm = (ev: MouseEvent) => {
      const videoEl = videoRef.current
      const containerEl = screenClipRef.current || videoEl
      if (!containerEl) return { x: 0, y: 0 }

      const rect = containerEl.getBoundingClientRect()

      let contentLeft = rect.left
      let contentTop = rect.top
      let contentWidth = rect.width
      let contentHeight = rect.height

      if (videoEl && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
        const videoAspect = videoEl.videoWidth / videoEl.videoHeight
        const boxAspect = rect.width / rect.height

        if (boxAspect > videoAspect) {
          contentHeight = rect.height
          contentWidth = rect.height * videoAspect
          contentLeft = rect.left + (rect.width - contentWidth) / 2
          contentTop = rect.top
        } else if (boxAspect < videoAspect) {
          contentWidth = rect.width
          contentHeight = rect.width / videoAspect
          contentLeft = rect.left
          contentTop = rect.top + (rect.height - contentHeight) / 2
        }
      }

      const x = (ev.clientX - contentLeft) / contentWidth
      const y = (ev.clientY - contentTop) / contentHeight

      return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) }
    }

    const onDown = (ev: MouseEvent) => {
      if (!isActiveRef.current) return
      if (!canInteractRef.current) return
      setPlusFromMouse(ev, true)
      setTouchDotPressed(true)
      const { x, y } = getNorm(ev)
      sendControl({ type: 'pointer', deviceId: device.id, kind: 'down', x, y, buttons: ev.buttons | 1 })
    }

    const onMove = (ev: MouseEvent) => {
      if (!isActiveRef.current) return
      if (!canInteractRef.current) return
      if ((ev.buttons & 1) === 0) return
      const { x, y } = getNorm(ev)
      sendControl({ type: 'pointer', deviceId: device.id, kind: 'move', x, y, buttons: ev.buttons | 1 })
    }

    const onUp = (ev: MouseEvent) => {
      if (!isActiveRef.current) return
      if (!canInteractRef.current) return
      setPlusFromMouse(ev, true)
      setTouchDotPressed(false)
      const { x, y } = getNorm(ev)
      sendControl({ type: 'pointer', deviceId: device.id, kind: 'up', x, y, buttons: 0 })
    }

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
      setTouchDotPressed(false)
      setPlusFromMouse(ev, true)
    }

    const onLeavePlus = () => {
      if (plusRafRef.current != null) {
        cancelAnimationFrame(plusRafRef.current)
        plusRafRef.current = null
      }
      setTouchDotPressed(false)
      if (plusRef.current) plusRef.current.style.opacity = '0'
    }

    const onMovePlus = (ev: MouseEvent) => {
      if (!isActiveRef.current) return
      if ((ev.buttons & 1) === 0) {
        setTouchDotPressed(false)
      }
      setPlusFromMouse(ev, true)
    }

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

    const host = view
    host.tabIndex = 0
    const isMod = (e: KeyboardEvent) => e.metaKey || e.ctrlKey

    const onPaste = (e: ClipboardEvent) => {
      if (!isActiveRef.current) return
      if (!canInteractRef.current) return

      const text = e.clipboardData?.getData('text') ?? ''
      if (!text) return

      e.preventDefault()

      sendControl({
        type: 'text',
        deviceId: device.id,
        text,
      })
    }

    const onKeyDown = async (e: KeyboardEvent) => {
      if (!isActiveRef.current) return
      if (!canInteractRef.current) return

      if (isMod(e) && (e.key === 'v' || e.key === 'V')) {
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
    host.addEventListener('paste', onPaste)

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
      applyLayoutRef.current(scaleRef.current)
      setLayoutReady(true)

      const geom = computeFrameRef.current()
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
        ; (iceRef.current as any).className = `badge ${cls}`
    }

    setIce('connecting…', 'warn')

    const onVideoConnected = () => {
      setIce('connected', 'ok')
      setStreamReady(true)
    }
    video.addEventListener('playing', onVideoConnected, { once: true })

    return () => {
      stopHud?.()
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
      host.removeEventListener('paste', onPaste)

      if (plusRafRef.current != null) {
        cancelAnimationFrame(plusRafRef.current)
        plusRafRef.current = null
      }
      setTouchDotPressed(false)
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
      } catch { }

      try {
        ws.close()
      } catch { }
      try {
        pc.close()
      } catch { }

      wsRef.current = null
      startedRef.current = false
      offerSentRef.current = false
    }
  }, [deviceId, device, props.clientSessionId, props.viewOnly, setBaseSizeOnce, stopStreamingTransport])

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
    return () => { }
  }

  if (!device) {
    return (
      <Box sx={{ p: 3 }}>
        <Typography variant="h5">Device not found</Typography>
      </Box>
    )
  }

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
                  border: hasBezel ? 'none' : '1px solid var(--border)',
                  boxShadow: hasBezel ? 'none' : '0 10px 30px rgba(0,0,0,0.22)',
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

              {hasBezel && (
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
              )}

              <Box
                ref={plusRef}
                sx={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  transform: 'translate3d(0, 0, 0) translate(-50%, -50%)',
                  zIndex: 5,
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  border: '2px solid rgba(0, 255, 247, 0.95)',
                  boxShadow: '0 0 10px rgba(0, 255, 247, 0.45)',
                  background: 'rgba(0, 255, 247, 0.10)',
                  pointerEvents: 'none',
                  userSelect: 'none',
                  opacity: 0,
                  willChange: 'transform, opacity',
                  '&::after': {
                    content: '""',
                    position: 'absolute',
                    left: '50%',
                    top: '50%',
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: 'rgba(0, 255, 247, 0.98)',
                    transform: 'translate(-50%, -50%)',
                    boxShadow: '0 0 6px rgba(0, 255, 247, 0.7)',
                  },
                }}
              />

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

              {releaseOverlay && <></>}
            </Box>

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
              </Box>
            )}
          </Box>
        </Box>

        <Box
          sx={{
            borderLeft: '1px solid var(--border)',
            bgcolor: 'var(--panel)',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
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
            <Box className={`modeCard ${canControl ? 'interact' : 'viewonly'}`}>
              <span className={`modeDot ${canControl ? 'interact' : 'viewonly'}`} />
              <Box sx={{ flex: 1 }}>
                <Box className="modeTitle">
                  {canInteract
                    ? 'Interactive access'
                    : canControl
                      ? 'Controller access'
                      : 'View-only access'}
                  <span className="modePill">
                    {canInteract ? 'LIVE' : isWarmingControl ? 'WARMING' : hasControllerError ? 'ERROR' : canControl ? 'ASSIGNED' : 'LOCKED'}
                  </span>
                </Box>
                <Box className="modeDesc">
                  {canInteract
                    ? 'You control touch, keys, and scroll.'
                    : isWarmingControl
                      ? 'Your control session is starting. Input is temporarily blocked.'
                      : hasControllerError
                        ? 'You are the controller, but device input is not ready yet.'
                        : canControl
                          ? 'You own this control slot. Input is currently unavailable.'
                          : 'Another user is controlling this device.'}
                </Box>
              </Box>
            </Box>

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