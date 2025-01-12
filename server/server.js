import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


const app = express();
const PORT = 5000;
const ROOT_DIR = path.join(__dirname, '../public'); // Root directory for files

// API: List files and folders
app.get('/api/files', (req, res) => {
  const requestedPath = path.join(ROOT_DIR, req.query.path || 'PPKE'); // PPKE mappa tartalma
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

// API: Download a file or folder
app.get('/api/download', (req, res) => {
  const requestedPath = path.join(ROOT_DIR, req.query.path || '');
  if (!fs.existsSync(requestedPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.download(requestedPath);
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'frontend')));

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
