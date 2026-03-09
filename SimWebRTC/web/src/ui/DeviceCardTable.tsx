import React from 'react'
import { Box, Typography } from '@mui/material'
import DeviceCard from './DeviceCard'
import type { CatalogDevice } from './devicesCatalog'

export default function DeviceCardTable({
  title,
  devices,
  onOpen,
}: {
  title: string
  devices: CatalogDevice[]
  onOpen: (deviceId: string, viewOnly?: boolean) => void
}) {


  const minCard = 320
  const maxGrid = 1180

  return (
    <Box sx={{ width: '100%' }}>
     

      {/* ✅ centers the table as ONE unit */}
      <Box sx={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
        <Box sx={{ width: '100%', maxWidth: maxGrid }}>
          <Box
            sx={{
              display: 'grid',
              gap: 2,
              gridTemplateColumns: `repeat(auto-fit, minmax(${minCard}px, 1fr))`,
              alignItems: 'stretch',
            }}
          >
            {devices.map((d) => (
              <Box key={d.id} sx={{ minWidth: 0 }}>
                <DeviceCard d={d} onOpen={onOpen} />
              </Box>
            ))}
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
