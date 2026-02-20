// web-client/src/ui/Home.tsx
import { Card, CardContent, Button, Typography, Stack } from '@mui/material'
import { devices } from '../devices'
import { Link as RouterLink } from 'react-router-dom'

export default function Home() {
  return (
    <Stack spacing={2}>
      <Typography variant="h5" fontWeight={800}>Choose an Emulator</Typography>
      {devices.map((d) => (
        <Card key={d.id}>
          <CardContent sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="h6">{d.name} !{d.id}!</Typography>
            <Button
              component={RouterLink}
              to={`/screen/${d.id}`}
              target="_blank"
              rel="noopener noreferrer"
              variant="contained"
            >
              Open
            </Button>
          </CardContent>
        </Card>
      ))}
    </Stack>
  )
}
