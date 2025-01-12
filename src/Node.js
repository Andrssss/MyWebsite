const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 5000;
const ROOT_DIR = path.join(__dirname, 'files'); // Gyökér könyvtár

// API: Fájlok listázása
app.get('/api/files', (req, res) => {
  const requestedPath = path.join(ROOT_DIR, req.query.path || '');
  if (!fs.existsSync(requestedPath)) {
    return res.status(404).json({ error: 'Path not found' });
  }

  const files = fs.readdirSync(requestedPath).map((fileName) => {
    const fullPath = path.join(requestedPath, fileName);
    return {
      name: fileName,
      type: fs.statSync(fullPath).isDirectory() ? 'folder' : 'file',
    };
  });

  res.json({ files });
});

// API: Letöltés
app.get('/api/download', (req, res) => {
  const requestedPath = path.join(ROOT_DIR, req.query.path || '');
  if (!fs.existsSync(requestedPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.download(requestedPath);
});

// Statikus fájlok kiszolgálása (frontend)
app.use(express.static(path.join(__dirname, 'frontend')));

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
