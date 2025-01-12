import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import archiver from 'archiver'; // Archiver csomag importálása

import { fileURLToPath } from 'url';
import { dirname } from 'path';



const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 5000;
const ROOT_DIR = path.join(__dirname, 'public'); // Public mappa elérési útja

app.use(
  cors({
    origin: 'http://localhost:5173', // Csak a React alkalmazás engedélyezett
  })
);

app.use((req, res, next) => {
  console.log(`Kérés érkezett: ${req.method} ${req.url}`);

  // Logoljuk a query paramétereket
  console.log('Kapott query paraméterek:', req.query);

  if (!req.url.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public/index.html'));
  } else {
    next();
  }
});


app.get('/favicon.ico', (req, res) => {
  res.status(204); // No Content
});



app.get('/api/files', (req, res) => {
  const decodedPath = decodeURIComponent(req.query.path || ''); // Path dekódolása
  const requestedPath = path.join(ROOT_DIR, decodedPath); // Teljes útvonal felépítése

  console.log('Kapott path:', req.query.path);
  console.log('Decoded path:', decodedPath);
  console.log('Requested path:', requestedPath);

  // Ellenőrzés: létezik-e az útvonal
  if (!fs.existsSync(requestedPath)) {
    console.error('Path not found:', requestedPath);
    return res.status(404).json({ error: 'Path not found' });
  }

  // Ellenőrzés: mappa-e az útvonal
  const isDirectory = fs.statSync(requestedPath).isDirectory();
  if (!isDirectory) {
    console.error('Path is not a directory:', requestedPath);
    return res.status(400).json({ error: 'Path is not a directory' });
  }

  // Fájlok és mappák listázása
  const files = fs.readdirSync(requestedPath).map((name) => {
    const filePath = path.join(requestedPath, name);
    return {
      name,
      isDirectory: fs.statSync(filePath).isDirectory(),
    };
  });

  res.json({ files });
});






app.get('/api/download', (req, res) => {
  const decodedPath = decodeURIComponent(req.query.path || ''); // Path dekódolása
  const requestedPath = path.join(ROOT_DIR, decodedPath); // Teljes útvonal felépítése

  console.log('Kapott path:', req.query.path);
  console.log('Decoded path:', decodedPath);
  console.log('Requested path:', requestedPath);

  if (!fs.existsSync(requestedPath)) {
    console.error('Path not found:', requestedPath);
    return res.status(404).json({ error: 'File or folder not found' });
  }

  const isDirectory = fs.statSync(requestedPath).isDirectory();

  if (isDirectory) {
    const zipName = `${path.basename(requestedPath)}.zip`;
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
    res.setHeader('Content-Type', 'application/zip');

    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('error', (err) => {
      console.error('Archiver error:', err);
      res.status(500).send('Error creating ZIP archive');
    });

    archive.pipe(res);
    archive.directory(requestedPath, false);
    archive.finalize();
  } else {
    console.log('Downloading file:', requestedPath);
    res.download(requestedPath);
  }
});





app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
