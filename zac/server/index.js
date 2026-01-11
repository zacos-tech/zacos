// server/index.js

import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import { MeshDevice } from '@meshtastic/core'
import { TransportNodeSerial } from '@meshtastic/transport-node-serial'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3000

let currentPosition = null

// Connect to T-Beam
const transport = await TransportNodeSerial.create('/dev/ttyACM0')
const device = new MeshDevice(transport)

device.events.onPositionPacket.subscribe((packet) => {
  console.log('Received position packet:', packet.data);
  currentPosition = {
    lat: packet.data.latitudeI / 1e7,
    lon: packet.data.longitudeI / 1e7,
    alt: packet.data.altitude,
    time: Date.now()
  }
});

await device.configure();

// API route
app.get('/api/gps', (req, res) => {
  if (!currentPosition) {
    return res.status(503).json({ error: 'No GPS fix yet' })
  }
  res.json(currentPosition)
})

// Production: serve Vite static files
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/dist')))
  
  app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/dist', 'index.html'))
  })
}

app.listen(PORT, () => {
  console.log(`ZACOS running on port ${PORT}`)
})