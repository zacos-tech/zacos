// client/src/App.jsx
import { useState, useEffect } from 'react'

function App() {
  const [position, setPosition] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    const fetchPosition = async () => {
      try {
        const res = await fetch('/api/gps')
        if (!res.ok) throw new Error('No GPS fix')
        const data = await res.json()
        setPosition(data)
      } catch (err) {
        setError(err.message)
      }
    }

    fetchPosition()
    const interval = setInterval(fetchPosition, 5000)
    return () => clearInterval(interval)
  }, [])

  if (error) return <div>Error: {error}</div>
  if (!position) return <div>Waiting for GPS...</div>

  return (
    <div>
      <h1>ZAC Position</h1>
      <p>Lat: {position.lat}</p>
      <p>Lon: {position.lon}</p>
      <p>Alt: {position.alt}m</p>
    </div>
  )
}

export default App