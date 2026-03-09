import React, { useMemo, useState } from 'react'
import {
  Box,
  Typography,
  Button,
  IconButton,
  TextField,
  InputAdornment,
  FormControl,
  Select,
  MenuItem,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import DeviceCardTable from './DeviceCardTable'
import { catalogDevices } from './devicesCatalog'
import type { CatalogDevice } from './devicesCatalog'

type PlatformFilter = 'all' | 'android' | 'ios'
type AvailabilityFilter = 'all' | 'available' | 'in_use' | 'error'

export default function DeviceCatalog({ onOpen }: { onOpen: (deviceId: string, viewOnly?: boolean) => void }) {
  const [q, setQ] = useState('')
  const [platform, setPlatform] = useState<PlatformFilter>('all')
  const [availability, setAvailability] = useState<AvailabilityFilter>('all')
  const [collapsed, setCollapsed] = useState(false)


  //Computes the sidebar counts for each platform type
  const counts = useMemo(() => {
    return {
      all: catalogDevices.length,
      android: catalogDevices.filter(d => d.platform === 'android').length,
      ios: catalogDevices.filter(d => d.platform === 'ios').length,
    }
  }, [])

  //Returns an array that matches all three conditions
  //Runs only when the search query, platform filter, or availability changes 
  const filtered: CatalogDevice[] = useMemo(() => {
    const query = q.trim().toLowerCase()
    return catalogDevices.filter(d => {
      const matchQuery =
        !query ||
        d.name.toLowerCase().includes(query) ||
        d.osVersion.toLowerCase().includes(query)

      const matchPlatform = platform === 'all' ? true : d.platform === platform
      const matchAvailability = availability === 'all' ? true : d.status === availability

      return matchQuery && matchPlatform && matchAvailability
    })
  }, [q, platform, availability])

  return (
    <Box
      sx={{
        width: '100%',
        flex: 1,
        minHeight: 0,
        display: 'grid',
        gridTemplateColumns: collapsed ? '84px 1fr' : '260px 1fr',
        transition: 'grid-template-columns 0.25s ease',
        gap: 0,
        bgcolor: 'var(--bg)',
      }}
    >
      {/* LEFT: sidebar */}
      <Box
        sx={{
          height: '100%',
          minHeight: 0,
          bgcolor: 'var(--sidebarBg)',
          borderRight: '1px solid var(--border)',
          position: 'relative',
          pt: 1.25,
          fontFamily: '"Noto Sans", system-ui, sans-serif',
        }}
      >
        {/* collapse button (top-right) */}
        <IconButton
          onClick={() => setCollapsed(v => !v)}
          size="small"
          sx={{
            position: 'absolute',
            top: 10,
            right: 10,
            width: 34,
            height: 34,
            border: '1px solid var(--border)',
            borderRadius: 1,
            bgcolor: 'transparent',
            color: 'var(--text)',
            '&:hover': { bgcolor: 'var(--sidebarHover)' },
          }}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? <ChevronRightIcon fontSize="small" /> : <ChevronLeftIcon fontSize="small" />}
        </IconButton>

        <Box sx={{ px: 1.25, mt: 4 }}>
          <SideRow
            active={platform === 'all'}
            collapsed={collapsed}
            icon={<span style={{ fontSize: 18 }}>▢</span>}
            title="All mobile"
            subtitle={`${counts.all} devices`}
            onClick={() => setPlatform('all')}
          />
          <SideRow
            active={platform === 'android'}
            collapsed={collapsed}
            icon={<span style={{ fontSize: 18 }}>🤖</span>}
            title="Android"
            subtitle={`${counts.android} devices`}
            onClick={() => setPlatform('android')}
          />
          <SideRow
            active={platform === 'ios'}
            collapsed={collapsed}
            icon={<span style={{ fontSize: 18 }}></span>}
            title="iOS"
            subtitle={`${counts.ios} devices`}
            onClick={() => setPlatform('ios')}
          />
        </Box>
      </Box>

      {/* RIGHT: content column */}
      <Box
        sx={{
          height: '100%',
          minHeight: 0,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          bgcolor: 'var(--bg)',
        }}
      >
        {/* header/search (fixed) */}
        <Box
          sx={{
            px: 2,
            py: 1.25,
            borderBottom: '1px solid var(--border)',
            bgcolor: 'var(--bg)',
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
          }}
        >
          {/* Search */}
          <TextField
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search devices"
            size="small"
            sx={{
              width: 340,
              '& .MuiInputBase-root': {
                bgcolor: 'var(--panel)',
                borderRadius: 1,
                color: 'var(--text)',
              },
              '& fieldset': { borderColor: 'var(--border)' },
              '&:hover fieldset': { borderColor: 'var(--chip-border)' },
            }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ color: 'var(--muted)', fontSize: 18 }} />
                </InputAdornment>
              ),
            }}
          />

          {/* Availability dropdown */}
          <FormControl size="small" sx={{ minWidth: 200 }}>
            <Select
              value={availability}
              onChange={(e) => setAvailability(e.target.value as AvailabilityFilter)}
              displayEmpty
              sx={{
                bgcolor: 'var(--panel)',
                borderRadius: 1,
                color: 'var(--text)',
                '& .MuiSelect-icon': { color: 'var(--muted)' },
                '& fieldset': { borderColor: 'var(--border)' },
                '&:hover fieldset': { borderColor: 'var(--chip-border)' },
              }}
              renderValue={(v) => {
                if (v === 'all') return 'Availability: All'
                if (v === 'available') return 'Availability: Available'
                if (v === 'in_use') return 'Availability: In use'
                return 'Availability: Error'
              }}
            >
              <MenuItem value="all">All</MenuItem>
              <MenuItem value="available">Available</MenuItem>
              <MenuItem value="in_use">In use</MenuItem>
              <MenuItem value="error">Error</MenuItem>
            </Select>
          </FormControl>

          <Box sx={{ flex: 1 }} />

          {/* Optional count */}
          <Typography sx={{ color: 'var(--muted)', fontWeight: 500, fontSize: 13 }}>
            Showing <b style={{ color: 'var(--text)' }}>{filtered.length}</b> / {catalogDevices.length}
          </Typography>
        </Box>

        {/* SCROLL AREA (grid) */}
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            overflow: 'auto',
            px: 2,
            pb: 2,
            bgcolor: 'var(--bg)',
          }}
        >
          <DeviceCardTable title="All mobile" devices={filtered} onOpen={onOpen} />
        </Box>
      </Box>
    </Box>
  )
}

function SideRow({
  active,
  collapsed,
  icon,
  title,
  subtitle,
  onClick,
}: {
  active: boolean
  collapsed: boolean
  icon: React.ReactNode
  title: string
  subtitle: string
  onClick: () => void
}) {
  return (
    <Button
      onClick={onClick}
      fullWidth
      sx={{
        width: '100%',
        boxSizing: 'border-box',
        justifyContent: collapsed ? 'center' : 'flex-start',
        textTransform: 'none',
        borderRadius: 0,

        px: collapsed ? 0 : 1.5,
        py: 1.6,
        minHeight: 58,
        mb: 0.25,
        gap: collapsed ? 0 : 1.5,

        bgcolor: active ? 'var(--sidebarActive)' : 'transparent',
        border: active ? '1px solid var(--border)' : '1px solid transparent',
        borderLeft: active ? '3px solid var(--accent)' : '3px solid transparent',

        '&:hover': { bgcolor: 'var(--sidebarHover)' },
      }}
    >
      <Box
        sx={{
          width: collapsed ? 36 : 28,
          height: 36,
          display: 'grid',
          placeItems: 'center',
          opacity: 0.85,
          color: 'var(--text)',
        }}
      >
        {icon}
      </Box>

      {!collapsed && (
        <Box sx={{ textAlign: 'left', lineHeight: 1.1, minWidth: 0, flex: 1 }}>
          <Typography
            noWrap
            sx={{
              fontWeight: 500,
              fontSize: 16,
              color: 'var(--text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {title}
          </Typography>

          <Typography
            noWrap
            sx={{
              fontSize: 12.5,
              fontWeight: 700,
              color: 'var(--muted)',
              mt: 0.35,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {subtitle}
          </Typography>
        </Box>
      )}
    </Button>
  )
}
