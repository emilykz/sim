import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Tab, Tabs, Typography } from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import DeviceCatalog from './DeviceCatalog'
import ScreenIOS from './ScreenIOS'
import { devices } from '../devices'

//Session data type - every opened device is tracked as a "session"
type Session = {
  deviceId: string
  name: string
  platform: 'ios' | 'android'
  openedAt: number
  lastActivityAt: number
  pendingReleaseReason?: string | null
}

//Inactivity timer threshold 
const INACTIVITY_MS = 45 * 1000

//localStorage keys to persist state between reloads 
const LS_SESSIONS = 'lab.sessions.v1' //array of open sessions 
const LS_ACTIVE = 'lab.activeDeviceId.v1' //currently focused device tab ID 
const LS_VIEWMODE = 'lab.viewMode.v1' //whether the UI is showing home or device tab/page

export default function Lab() {

  //State for determining user mode -- whether on device catalog page or a device screen
  const [viewMode, setViewMode] = useState<'catalog' | 'viewer'>(() => {
    const v = localStorage.getItem(LS_VIEWMODE)
    return (v === 'viewer' || v === 'catalog') ? v : 'catalog'
  })

  //Updates the storage's viewing mode when the viewing mode changes in UI  
  useEffect(() => { 
    localStorage.setItem(LS_VIEWMODE, viewMode) 
  }, [viewMode])

  //The list of active device sessions 
  const [sessions, setSessions] = useState<Session[]>(() => {
    try {
      const raw = localStorage.getItem(LS_SESSIONS)
      const parsed = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed)
        ? parsed.map((s: any) => ({
            ...s,
            pendingReleaseReason: s?.pendingReleaseReason ?? null,
          }))
        : []
    } catch {
      return []
    }
  })

   //Updates session state when sessions changes and updates the storage value too 
  const sessionsRef = useRef<Session[]>([])
  useEffect(() => { 
    sessionsRef.current = sessions 
  }, [sessions])

  useEffect(() => { 
    localStorage.setItem(LS_SESSIONS, JSON.stringify(sessions)) 
  }, [sessions])


  //Holds the ID of whichever device tab is currently selected (or null if none)
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(() => {
    return localStorage.getItem(LS_ACTIVE) || null
  })

  //Updates activeID state when active device ID changes and updates the storage value too 
  useEffect(() => {
    if (activeDeviceId) { 
      localStorage.setItem(LS_ACTIVE, activeDeviceId) 
    }
    else  {  
      localStorage.removeItem(LS_ACTIVE)
     }
  }, [activeDeviceId])


  //Tracks the dialog/pop ups when a session gets released due to inactivity - open status and which device and reasoning
  const [releasedModal, setReleasedModal] = useState<{ open: boolean; deviceName?: string; reason?: string }>({ open: false })
  ///Tracks the dialog/pop ups when users want to release a device 
  const [confirmReleaseModal, setConfirmReleaseModal] = useState<{ open: boolean; deviceId?: string; deviceName?: string }>({
    open: false,
  })

  useEffect(() => {

    //If active device id exists but no session exists with that id -> go back to device catalog page 
    if (activeDeviceId && !sessions.some(s => s.deviceId === activeDeviceId)) {
      setActiveDeviceId(null)
      setViewMode('catalog')
    } else if (!activeDeviceId && sessions.length > 0) {
      setActiveDeviceId(sessions[0].deviceId)
    }
  }, [])


  /**
   * Handler when user clicks opens/launches a device
   */
  const openDevice = useCallback((deviceId: string) => {

    //Finds the device that matches the specified device id 
    const foundDevice = devices.find(device => device.id === deviceId)

    //if no device exists -> exit 
    if (!foundDevice) return

    //Updates sessions 
    setSessions(prev => {

      //Checks if a session exists for that device ID 
      const exists = prev.find(session => session.deviceId === deviceId)

      //If a session already exists, refresh lastActivityAt timestamp to now and clear any pending release reason & return
      if (exists) {
        return prev.map(session =>
          session.deviceId === deviceId ? { ...session, lastActivityAt: Date.now(), pendingReleaseReason: null } : session
        )
      }
      //No session exists for this device ID -> create a new Session
      const next: Session = {
        deviceId,
        name: foundDevice.name,
        platform: foundDevice.platform,
        openedAt: Date.now(),
        lastActivityAt: Date.now(),
        pendingReleaseReason: null,
      }
      return [next, ...prev]
    })

    //Mark this device as the active tab and switch UI mode into device viewer mode 
    setActiveDeviceId(deviceId)
    setViewMode('viewer')
  }, [])

  /**
   * Handler for closing a device session 
   */
  const closeSession = useCallback((deviceId: string) => {

    //Removes the corresponding session from our active sessions array 
    setSessions(prev => prev.filter(s => s.deviceId !== deviceId))

    //Updates the active tab if needed 
    setActiveDeviceId(prevActive => {
      if (prevActive !== deviceId) return prevActive
      const remaining = sessionsRef.current.filter(s => s.deviceId !== deviceId)
      return remaining.length ? remaining[0].deviceId : null
    })
  }, [])

  /**
   * Handler for marking controller interaction activity 
   * 
   * Updates the timestamp for lastAcitivtyAt and clears any pendingReleaseReasion
   */
  const markActivity = useCallback((deviceId: string) => {
    setSessions(prev =>
      prev.map(s =>
        s.deviceId === deviceId ? { ...s, lastActivityAt: Date.now(), pendingReleaseReason: null } : s
      )
    )
  }, [])


  /**
   * Every 10 seconds, it checks sessions for inactivity & updates accordingly 
   */
  useEffect(() => {

    const iv = window.setInterval(() => {
      const now = Date.now()

      setSessions(prev => {

        let changed = false

        //Maps over the current sessions 
        const next = prev.map((s) => {

          //If session already has pendingReleaseReason, leave it as is  
          if (s.pendingReleaseReason) return s

          //If it hasn't been idle longer than the threshold, leave it as is 
          if (now - s.lastActivityAt <= INACTIVITY_MS) return s

          //Exceeds threshold -> update pendingReleaseReason for this device session 
          changed = true
          return { ...s, pendingReleaseReason: 'Session released due to inactivity.' }
        })

        //Returns new array if one session has changed 
        return changed ? next : prev
      })
    }, 10_000)

    return () => window.clearInterval(iv)
  }, [])


  //Handlers for clicking a device sesion tab 
  const onSelectTab = useCallback((deviceId: string) => {
    setActiveDeviceId(deviceId)
    setViewMode('viewer')
  }, [])

  const hasSessions = sessions.length > 0

  return (
    <Box sx={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', bgcolor: 'var(--bg)', color: 'var(--text)' }}>
      {/* "My devices" bar */}
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
        {/* My devices "tab" */}
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

        {/* Session tabs */}
        <Box sx={{ flex: 1, overflowX: 'auto' }}>
          {sessions.length === 0 ? null : (
            <Tabs
              value={viewMode === 'viewer' ? (activeDeviceId || false) : false}
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
              {sessions.map(s => (
                <Tab
                  key={s.deviceId}
                  value={s.deviceId}
                  onClick={() => onSelectTab(s.deviceId)}
                  label={
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <span style={{ opacity: 0.85 }}>{s.platform === 'ios' ? '' : '🤖'}</span>
                      <span>{s.name}</span>
                      <span
                        onClick={(e) => {
                          e.stopPropagation()
                          setConfirmReleaseModal({ open: true, deviceId: s.deviceId, deviceName: s.name })
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

      {/* Main content (KEEP BOTH MOUNTED) */}
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
            sessions.map(s => {
              const active = viewMode === 'viewer' && activeDeviceId === s.deviceId
              return (
                <Box
                  key={s.deviceId}
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
                    deviceId={s.deviceId}
                    isActive={active}
                    pendingReleaseReason={s.pendingReleaseReason}
                    onActivity={() => markActivity(s.deviceId)}
                    onReleased={(info) => {
                      closeSession(s.deviceId)
                      if (!info?.silent) {
                        setReleasedModal({
                          open: true,
                          deviceName: s.name,
                          reason: info?.reason,
                        })
                      }
                      setViewMode('catalog')
                    }}
                  />
                </Box>
              )
            })
          )}
        </Box>
      </Box>

      {/* Release message modal */}
      <Dialog open={releasedModal.open} onClose={() => setReleasedModal({ open: false })}>
        <DialogTitle>We are sorry…</DialogTitle>
        <DialogContent>
          <Typography sx={{ mb: 1 }}>Your device is no longer available.</Typography>
          <Typography sx={{ color: 'text.secondary' }}>
            {releasedModal.reason
              ? releasedModal.reason
              : releasedModal.deviceName
              ? `We released ${releasedModal.deviceName}.`
              : 'This session has been released.'}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button variant="contained" onClick={() => setReleasedModal({ open: false })}>
            OK, take me to my devices page
          </Button>
        </DialogActions>
      </Dialog>

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
