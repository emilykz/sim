import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,        // <-- key: listen on 0.0.0.0 instead of localhost only
    port: 5173,
    strictPort: true,
  },
})
