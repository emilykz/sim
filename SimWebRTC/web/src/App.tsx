import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Home from './ui/Home.tsx'
import ScreenIOS from './ui/ScreenIOS.tsx';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        {/* new iOS viewer route — Home already links to /screen/:deviceId */}
        <Route path="/screen/:deviceId" element={<ScreenIOS />} />
      </Routes>
    </BrowserRouter>
  )
}
