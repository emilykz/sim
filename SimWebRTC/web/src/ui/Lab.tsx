import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Tab, Tabs, Typography } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import DeviceCatalog from './DeviceCatalog'
import ScreenIOS from './ScreenIOS'
import { devices } from '../devices'

type SessionMode = 'manual' | 'watch'
type SessionConnectionState = 'parked' | 'live'

type Session = {
  sessionId: string
  deviceId: string
  name: string
  platform: 'ios' | 'android'
  mode: SessionMode
  openedAt: number
  connectionState: SessionConnectionState
  resumeOnly: boolean
}

// localStorage keys
const LS_SESSIONS = 'lab.sessions.v3'
const LS_ACTIVE = 'lab.activeDeviceId.v3'
const LS_VIEWMODE = 'lab.viewMode.v3'

function createSessionId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`
}

export default function Lab() {
  const [viewMode, setViewMode] = useState<'catalog' | 'viewer'>(() => {
    const v = localStorage.getItem(LS_VIEWMODE)
    return v === 'viewer' || v === 'catalog' ? v : 'catalog'
  })

  useEffect(() => {
    localStorage.setItem(LS_VIEWMODE, viewMode)
  }, [viewMode])

  /**
   * Important:
   * On restore after reload, all sessions come back as PARKED first.
   * We do not want reload storms that reconnect everything immediately.
   */
  const [sessions, setSessions] = useState<Session[]>(() => {
    try {
      const raw = localStorage.getItem(LS_SESSIONS)
      const parsed = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed)
        ? parsed
          .filter((s: any) => s?.deviceId && s?.name && s?.platform && s?.mode)
          .map((s: any) => ({
            sessionId: String(s.sessionId || createSessionId()),
            deviceId: String(s.deviceId),
            name: String(s.name),
            platform: s.platform === 'android' ? 'android' : 'ios',
            mode: s.mode === 'watch' ? 'watch' : 'manual',
            openedAt: Number(s.openedAt || Date.now()),
            connectionState: 'parked' as SessionConnectionState,
            resumeOnly: true,
          }))
        : []
    } catch {
      return []
    }
  })

  const sessionsRef = useRef<Session[]>([])
  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  useEffect(() => {
    localStorage.setItem(
      LS_SESSIONS,
      JSON.stringify(
        sessions.map((s) => ({
          sessionId: s.sessionId,
          deviceId: s.deviceId,
          name: s.name,
          platform: s.platform,
          mode: s.mode,
          openedAt: s.openedAt,
          // intentionally do NOT persist runtime live/parked exactly;
          // on reload we want restored tabs to come back parked
        }))
      )
    )
  }, [sessions])

  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(() => {
    return localStorage.getItem(LS_ACTIVE) || null
  })

  useEffect(() => {
    if (activeDeviceId) localStorage.setItem(LS_ACTIVE, activeDeviceId)
    else localStorage.removeItem(LS_ACTIVE)
  }, [activeDeviceId])

  const [confirmReleaseModal, setConfirmReleaseModal] = useState<{ open: boolean; deviceId?: string; deviceName?: string }>({
    open: false,
  })

  /**
   * Keep active tab valid when sessions change
   */
  useEffect(() => {
    if (activeDeviceId && !sessions.some((s) => s.deviceId === activeDeviceId)) {
      setActiveDeviceId(null)
      setViewMode('catalog')
    } else if (!activeDeviceId && sessions.length > 0) {
      setActiveDeviceId(sessions[0].deviceId)
    }
  }, [activeDeviceId, sessions])

  /**
   * After restore/reload:
   * only the ACTIVE session should auto-promote from parked -> live.
   * Already-live sessions during normal runtime stay live.
   */
  useEffect(() => {
    if (!activeDeviceId) return
    setSessions((prev) =>
      prev.map((s) =>
        s.deviceId === activeDeviceId && s.connectionState === 'parked'
          ? { ...s, connectionState: 'live' }
          : s
      )
    )
  }, [activeDeviceId])

  /**
   * DeviceCatalog still calls onOpen(deviceId, viewOnly?).
   *
   * viewOnly=false => manual
   * viewOnly=true  => watch
   *
   * For your current static JSON testing:
   * - available => DeviceCatalog should call onOpen(id, false)
   * - busy      => DeviceCatalog should call onOpen(id, true)
   */
  const openDevice = useCallback((deviceId: string, viewOnly = false) => {
    const foundDevice = devices.find((device) => device.id === deviceId)
    if (!foundDevice) return

    const mode: SessionMode = viewOnly ? 'watch' : 'manual'

    setSessions((prev) => {
      const existing = prev.find((s) => s.deviceId === deviceId)
      if (existing) {
        // If the tab already exists, keep the stable sessionId and ensure it's live.
        return prev.map((s) =>
          s.deviceId === deviceId
            ? {
              ...s,
              mode,
              connectionState: 'live',
              resumeOnly: s.connectionState === 'parked' ? s.resumeOnly : false,
            }
            : s
        )
      }

      const next: Session = {
        sessionId: createSessionId(),
        deviceId,
        name: foundDevice.name,
        platform: foundDevice.platform,
        mode,
        openedAt: Date.now(),
        connectionState: 'live',
        resumeOnly: false,
      }
      return [next, ...prev]
    })

    setActiveDeviceId(deviceId)
    setViewMode('viewer')
  }, [])

  const closeSession = useCallback((deviceId: string) => {
    setSessions((prev) => prev.filter((s) => s.deviceId !== deviceId))

    setActiveDeviceId((prevActive) => {
      if (prevActive !== deviceId) return prevActive
      const remaining = sessionsRef.current.filter((s) => s.deviceId !== deviceId)
      return remaining.length ? remaining[0].deviceId : null
    })
  }, [])

  /**
   * Selecting a tab:
   * - make it active
   * - if it was parked, promote it to live
   * - if already live, it stays connected (no reconnect-on-tab-switch)
   */
  const onSelectTab = useCallback((deviceId: string) => {
    setActiveDeviceId(deviceId)
    setViewMode('viewer')
    setSessions((prev) =>
      prev.map((s) =>
        s.deviceId === deviceId && s.connectionState === 'parked'
          ? { ...s, connectionState: 'live', resumeOnly: true }
          : s
      )
    )
  }, [])

  const hasSessions = sessions.length > 0

  const activeSession = useMemo(() => {
    if (!activeDeviceId) return null
    return sessions.find((s) => s.deviceId === activeDeviceId) || null
  }, [activeDeviceId, sessions])

  const liveSessions = useMemo(() => {
    return sessions.filter((s) => s.connectionState === 'live')
  }, [sessions])

  return (
    <Box
      sx={{
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'var(--bg)',
        color: 'var(--text)',
      }}
    >
      {/* Top bar */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1,
          py: 0.75,
          bgcolor: 'var(--panel)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <Box
          onClick={() => setViewMode('catalog')}
          role="button"
          tabIndex={0}
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 1,
            px: 1.25,
            height: 40,
            cursor: 'pointer',
            userSelect: 'none',
            color: 'var(--text)',
            borderBottom: viewMode === 'catalog' ? '3px solid var(--brandBtn)' : '3px solid transparent',
          }}
        >
          <Typography sx={{ fontWeight: 600, fontSize: 15 }}>My devices</Typography>
          <Typography sx={{ fontWeight: 600, fontSize: 14, opacity: 0.7 }}>({sessions.length})</Typography>
        </Box>

        <Box sx={{ flex: 1, overflowX: 'auto' }}>
          {sessions.length === 0 ? null : (
            <Tabs
              value={viewMode === 'viewer' ? activeDeviceId || false : false}
              onChange={(_, v) => onSelectTab(v)}
              variant="scrollable"
              scrollButtons="auto"
              sx={{
                minHeight: 40,
                '& .MuiTab-root': {
                  minHeight: 40,
                  textTransform: 'none',
                  color: 'var(--text)',
                  fontWeight: 500,
                  opacity: viewMode === 'viewer' ? 1 : 0.7,
                },
                '& .Mui-selected': {
                  color: 'var(--text)',
                  fontWeight: 600,
                },
                '& .MuiTabs-indicator': {
                  backgroundColor: 'var(--brandBtn)',
                  height: 3,
                },
              }}
            >
              {sessions.map((s) => (
                <Tab
                  key={s.deviceId}
                  value={s.deviceId}
                  onClick={() => onSelectTab(s.deviceId)}
                  label={
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <span style={{ opacity: 0.85 }}>{s.platform === 'ios' ? '' : '🤖'}</span>
                      <span>{s.name}</span>
                      {s.mode === 'watch' && (
                        <span style={{ opacity: 0.6, fontSize: 12 }}>[watch]</span>
                      )}
                      {s.connectionState === 'parked' && (
                        <span style={{ opacity: 0.5, fontSize: 12 }}>[parked]</span>
                      )}
                      <span
                        onClick={(e) => {
                          e.stopPropagation()
                          setConfirmReleaseModal({
                            open: true,
                            deviceId: s.deviceId,
                            deviceName: s.name,
                          })
                        }}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: 22,
                          height: 22,
                          borderRadius: 999,
                          border: '1px solid var(--chip-border)',
                          cursor: 'pointer',
                          opacity: 0.9,
                        }}
                        title="Close"
                      >
                        <CloseIcon sx={{ fontSize: 16 }} />
                      </span>
                    </Box>
                  }
                />
              ))}
            </Tabs>
          )}
        </Box>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {/* Catalog layer */}
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            minHeight: 0,
            display: 'flex',
            opacity: viewMode === 'catalog' ? 1 : 0,
            visibility: viewMode === 'catalog' ? 'visible' : 'hidden',
            pointerEvents: viewMode === 'catalog' ? 'auto' : 'none',
            transition: 'opacity 120ms ease',
          }}
        >
          <DeviceCatalog onOpen={openDevice} />
        </Box>

        {/* Viewer layer */}
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            minHeight: 0,
            opacity: viewMode === 'viewer' ? 1 : 0,
            visibility: viewMode === 'viewer' ? 'visible' : 'hidden',
            pointerEvents: viewMode === 'viewer' ? 'auto' : 'none',
            transition: 'opacity 120ms ease',
          }}
        >
          {!hasSessions ? (
            <Box sx={{ p: 2 }}>
              <Typography>No active device</Typography>
            </Box>
          ) : (
            liveSessions.map((session) => {
              const active = viewMode === 'viewer' && activeDeviceId === session.deviceId

              return (
                <Box
                  key={session.sessionId}
                  sx={{
                    position: 'absolute',
                    inset: 0,
                    minHeight: 0,
                    opacity: active ? 1 : 0,
                    visibility: active ? 'visible' : 'hidden',
                    pointerEvents: active ? 'auto' : 'none',
                    transition: 'opacity 120ms ease',
                  }}
                >
                  <ScreenIOS
                    deviceId={session.deviceId}
                    clientSessionId={session.sessionId}
                    isActive={active}
                    viewOnly={session.mode === 'watch'}
                    resumeOnly={session.resumeOnly}
                    onResumeAccepted={() => {
                      setSessions((prev) =>
                        prev.map((s) =>
                          s.deviceId === session.deviceId
                            ? { ...s, resumeOnly: false }
                            : s
                        )
                      )
                    }}
                    onReleased={(info) => {
                      closeSession(session.deviceId)
                      setViewMode('catalog')
                    }}
                  />
                </Box>
              )
            })
          )}
        </Box>
      </Box>
      {/* Manual close/release confirm */}
      <Dialog open={confirmReleaseModal.open} onClose={() => setConfirmReleaseModal({ open: false })}>
        <DialogTitle>Release this device?</DialogTitle>
        <DialogContent>
          <Typography sx={{ color: 'text.secondary' }}>
            {confirmReleaseModal.deviceName
              ? `Are you sure you want to release ${confirmReleaseModal.deviceName}?`
              : 'Are you sure you want to release this device?'}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmReleaseModal({ open: false })}>Cancel</Button>
          <Button
            variant="contained"
            color="error"
            onClick={() => {
              const deviceId = confirmReleaseModal.deviceId
              if (deviceId) {
                closeSession(deviceId)
                if (activeDeviceId === deviceId) setViewMode('catalog')
              }
              setConfirmReleaseModal({ open: false })
            }}
          >
            Release
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}