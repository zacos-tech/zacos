const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// API routes
app.get('/api/hello', (req, res) => {
  res.json({ message: 'Hello from ZAC' });
});

// Production: serve Vite static files
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/dist')));
  
  app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/dist', 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`ZACOS running on port ${PORT}`);
});