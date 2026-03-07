import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import AppShell from './ui/AppShell'
import Lab from './ui/Lab'
import ScreenIOS from './ui/ScreenIOS'



export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Everything inside AppShell gets the global top menu bar */}
        <Route element={<AppShell />}>
          <Route path="/" element={<Navigate to="/lab" replace />} />
          <Route path="/lab" element={<Lab />} />

          {/* keep legacy deep link route */}
          <Route path="/screen/:deviceId" element={<ScreenIOS />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}