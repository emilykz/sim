import React from 'react'
import { Box, Button, Card, Typography } from '@mui/material'
import type { CatalogDevice } from './devicesCatalog'

function statusStyle(status: CatalogDevice['status']) {
    if (status === 'available') return { label: 'Available', color: '#2e7d32', top: '#2e7d32' }
    if (status === 'in_use') return { label: 'In use', color: '#b26a00', top: '#b26a00' }
    return { label: 'Error', color: '#c62828', top: '#c62828' }
}

export default function DeviceCard({
    d,
    onOpen,
}: {
    d: CatalogDevice
    onOpen: (deviceId: string) => void
}) {
    const s = statusStyle(d.status)
    const disabled = d.status !== 'available'

    return (
        <Card
            sx={{
                width: '100%',
                height: '100%',
                display: 'grid',
                gridTemplateColumns: '130px 1fr',
                bgcolor: 'var(--card)',
                border: '1px solid var(--border)',
                borderRadius: 2, 
                overflow: 'hidden',
                boxShadow: 'none',
            }}
        >
            {/* top accent bar */}
            <Box sx={{ gridColumn: '1 / -1', height: 5, bgcolor: s.top }} />

            {/* LEFT image panel */}
            <Box
                sx={{
                    bgcolor: 'var(--card2)',
                    borderRight: '1px solid var(--border)',
                    display: 'grid',
                    placeItems: 'center',
                    minHeight: 150,
                }}
            >
                <Box
                    sx={{
                        width: 76,
                        height: 110,
                        borderRadius: 1.5,
                        border: '1px solid var(--chip-border)',
                        bgcolor: 'var(--panel)',
                        display: 'grid',
                        placeItems: 'center',
                    }}
                >
                    <Typography sx={{ fontSize: 26, opacity: 0.9 }}>
                        {d.platform === 'ios' ? '' : '🤖'}
                    </Typography>
                </Box>
            </Box>

            {/* RIGHT details */}
            <Box
                sx={{
                    p: 1.25,
                    minWidth: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 0.6,
                }}
            >
                {/* Name row: horizontal scroll if long */}
                {/* Name (wrap to 2 lines) */}
                <Typography
                    sx={{
                        color: 'var(--text)',
                        fontWeight: 300,
                        fontSize: 18,
                        lineHeight: 1.2,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                        minHeight: '2.4em',
                        // ✅ allow wrapping in general
                        whiteSpace: 'normal',
                        wordBreak: 'break-word',
                    }}
                    title={d.name}
                >
                    {d.name}
                </Typography>


                {/* Platform + version line */}
                <Typography
                    sx={{
                        color: 'var(--muted)',
                        fontWeight: 400,
                        fontSize: 13.5,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 0.75,
                    }}
                >
                    <span style={{ opacity: 0.9 }}>{d.platform === 'ios' ? '' : '🤖'}</span>
                    <span>{d.osVersion}</span>
                </Typography>

                {/* Status on its own line */}
                <Typography sx={{ color: s.color, fontWeight: 300, fontSize: 14 }}>
                    {s.label}
                </Typography>

                <Box sx={{ flex: 1 }} />

                <Button
                    fullWidth
                    variant="contained"
                    disabled={disabled}
                    onClick={() => onOpen(d.id)}
                    sx={{
                        textTransform: 'none',
                        fontWeight: 500,
                        borderRadius: 1,
                        py: 0.9,

                        bgcolor: disabled ? 'var(--btnDisabledBg)' : 'var(--brandBtn)',
                        color: disabled ? 'var(--btnDisabledText)' : 'var(--brandBtnText)',
                        border: disabled ? '1px solid var(--btnDisabledBorder)' : '1px solid transparent',

                        '&:hover': {
                            bgcolor: disabled ? 'var(--btnDisabledBg)' : 'var(--brandBtnHover)',
                        },

                        // ✅ force MUI disabled styles to use ours
                        '&.Mui-disabled': {
                            bgcolor: 'var(--btnDisabledBg)',
                            color: 'var(--btnDisabledText)',
                            border: '1px solid var(--btnDisabledBorder)',
                        },
                    }}
                >
                    Open
                </Button>
            </Box>
        </Card>
    )
}