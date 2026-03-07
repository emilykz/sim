import React, { useState, useEffect } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import { AppBar, Toolbar, Box, Typography, Avatar } from '@mui/material'
import { IconButton } from '@mui/material'
import DarkModeIcon from '@mui/icons-material/DarkMode'
import LightModeIcon from '@mui/icons-material/LightMode'
import './AppShell.css'

export default function AppShell() {

  const nav = useNavigate()
  const appName = 'SimCast'
  const displayName = 'Emily'
  const avatarLetter = (displayName?.[0] || 'U').toUpperCase()


  //THEME SETTING
  const LS_THEME = 'ui.theme.v1'
  const [mode, setMode] = useState<'dark' | 'light'>(() => {
    const v = localStorage.getItem(LS_THEME)
    return v === 'light' ? 'light' : 'dark'
  })

  useEffect(() => {
    localStorage.setItem(LS_THEME, mode)
    document.documentElement.setAttribute('data-theme', mode)
  }, [mode])

  return (
    <Box
      sx={{
        minHeight: '100vh',
        height: '100vh',          
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'var(--bg)',    
      }}
    >
      {/* Global top menu bar */}
      <AppBar
        position="sticky"
        elevation={0}
        sx={{
          bgcolor: 'var(--brandBtn)',
          borderBottom: '1px solid var(--border)',
          color: '#ffffff',
        }}
      >
        <Toolbar sx={{ minHeight: 52, px: 1.5 }}>
          <Typography
            sx={{
              fontWeight: 900,
              letterSpacing: 0.2,
              color: '#ffffff',
             // cursor: 'pointer',
            }}
           // onClick={() => nav('/lab')}
            //title="Go to device lab"
          >
            {appName}
          </Typography>

          <Box sx={{ flex: 1 }} />

          <Box
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 1,
              px: 1,
              py: 0.5,
              borderRadius: 2,
              color: '#ffffff',
              fontWeight: 800,
              background: 'transparent',
              mr: 1,
            }}
          >
            <Avatar
              sx={{
                width: 30,
                height: 30,
                bgcolor: 'rgba(255,255,255,0.15)',
                color: '#ffffff',
                border: '1px solid rgba(255,255,255,0.20)',
                fontSize: 16,
              }}
            >
              {avatarLetter}
            </Avatar>
            <Typography sx={{ fontWeight: 700 }}>{displayName}</Typography>
          </Box>

          <IconButton
            onClick={() => setMode(m => (m === 'dark' ? 'light' : 'dark'))}
            sx={{
              mr: 1,
              border: '1px solid rgba(255,255,255,0.25)',
              borderRadius: 2,
              color: '#ffffff',
              bgcolor: 'transparent',
              '&:hover': { bgcolor: 'rgba(255,255,255,0.10)' },
            }}
            title={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {mode === 'dark' ? <LightModeIcon /> : <DarkModeIcon />}
          </IconButton>
        </Toolbar>
      </AppBar>

      {/* Route content renders below the global header */}
      <Box sx={{ flex: 1, minHeight: 0, bgcolor: 'var(--bg)' }}>
        <Outlet />
      </Box>
    </Box>
  )
}
