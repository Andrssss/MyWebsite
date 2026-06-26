import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import JSZip from 'jszip';
import './SemesterPreview.css';

const toMobileYT = (url) =>
  url.replace(/^https?:\/\/(www\.)?youtube\.com/, 'https://m.youtube.com');

function extractFolderId(url) {
  return url?.match(/\/folders\/([a-zA-Z0-9_-]+)/)?.[1] ?? null;
}

function fileIcon(mimeType) {
  if (!mimeType) return '📄';
  if (mimeType === 'application/vnd.google-apps.folder') return '📁';
  if (mimeType === 'application/pdf') return '📕';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return '📊';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return '📊';
  if (mimeType.includes('document') || mimeType.includes('word')) return '📝';
  if (mimeType.includes('image')) return '🖼';
  if (mimeType.includes('zip') || mimeType.includes('archive')) return '🗜';
  return '📄';
}

const isFolder = (mimeType) => mimeType === 'application/vnd.google-apps.folder';

const displayName = (name) => name.replace(/^\d+_/, '');

const sortFiles = (files) => [...files].sort((a, b) => {
  const aIsFolder = isFolder(a.mimeType) ? 0 : 1;
  const bIsFolder = isFolder(b.mimeType) ? 0 : 1;
  if (aIsFolder !== bIsFolder) return aIsFolder - bIsFolder;
  const na = parseInt(a.name.match(/^(\d+)_/)?.[1] ?? '9999', 10);
  const nb = parseInt(b.name.match(/^(\d+)_/)?.[1] ?? '9999', 10);
  if (na !== nb) return na - nb;
  return a.name.localeCompare(b.name);
});

const VideoGroup = ({ name, items }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="video-group">
      <button className="video-group-toggle" onClick={() => setOpen(o => !o)}>
        {open ? '▲' : '▶'} {name} ({items.length})
      </button>
      {open && (
        <div className="video-group-list">
          {items.map((video, i) => (
            <a key={i} className="video-item video-item-nested"
              href={toMobileYT(video.url)} target="_blank" rel="noopener noreferrer">
              ▶ {video.name}
            </a>
          ))}
        </div>
      )}
    </div>
  );
};

const PreviewModal = ({ file, onClose }) => createPortal(
  <div className="preview-overlay" onClick={onClose}>
    <div className="preview-modal" onClick={e => e.stopPropagation()}>
      <div className="preview-modal-header">
        <span className="preview-modal-title">{file.name}</span>
        <div className="preview-modal-actions">
          <a href={`https://drive.google.com/uc?export=download&id=${file.id}`}
            target="_blank" rel="noopener noreferrer" className="preview-modal-download">
            ⬇ Letöltés
          </a>
          <button className="preview-modal-close" onClick={onClose}>✕</button>
        </div>
      </div>
      <iframe src={`https://drive.google.com/file/d/${file.id}/preview`}
        className="preview-iframe" title={file.name} allow="autoplay" />
    </div>
  </div>,
  document.body
);

async function downloadFolder(folderId, name, fallbackUrl, setStatus, signal) {
  const check = () => { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); };
  try {
    setStatus('Fájlok listázása...');
    const listRes = await fetch(`/.netlify/functions/list-files-recursive?folderId=${folderId}`, { signal });
    if (!listRes.ok) throw new Error(`Lista hiba: HTTP ${listRes.status}`);
    const { files, error } = await listRes.json();
    if (error) throw new Error(error);
    if (!files || files.length === 0) { alert('Nincs letölthető fájl.'); setStatus(null); return; }

    const zip = new JSZip();
    let done = 0;

    for (const file of files) {
      check();
      setStatus(`Letöltés... (${done}/${files.length})`);
      try {
        const res = await fetch(`/.netlify/functions/proxy-file?fileId=${file.id}`, { signal });
        if (res.ok) zip.file(file.path, await res.arrayBuffer());
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }
      done++;
    }

    check();
    setStatus('Zip készítése...');
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    check();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    setStatus(null);
  } catch (e) {
    if (e.name === 'AbortError') { setStatus(null); return; }
    alert(`Hiba: ${e.message}\n\nMegnyitjuk Drive-ban.`);
    window.open(fallbackUrl, '_blank', 'noopener');
    setStatus(null);
  }
}

const FileBrowser = ({ rootId, rootName, subjectVideos, onRootError, onBack }) => {
  const [stack, setStack] = useState([{ id: rootId, name: rootName }]);
  const [cache, setCache] = useState({});
  const [loadingId, setLoadingId] = useState(null);
  const [previewFile, setPreviewFile] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const abortRef = React.useRef(null);

  const currentFolder = stack[stack.length - 1];
  const isRoot = stack.length === 1;
  const files = cache[currentFolder.id];

  React.useEffect(() => {
    if (cache[currentFolder.id] !== undefined) return;
    let cancelled = false;
    setLoadingId(currentFolder.id);
    fetch(`/.netlify/functions/drive-files?folderId=${currentFolder.id}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => { if (!cancelled) setCache(c => ({ ...c, [currentFolder.id]: sortFiles(data.files || []) })); })
      .catch(e => {
        console.error('[drive-files]', e);
        if (!cancelled && isRoot) onRootError?.();
      })
      .finally(() => { if (!cancelled) setLoadingId(null); });
    return () => { cancelled = true; };
  }, [currentFolder.id]);

  const ytLinks = isRoot && subjectVideos
    ? subjectVideos.flatMap(v =>
        v.group
          ? v.group.map(g => ({ label: g.name, url: g.url }))
          : [{ label: v.name, url: v.url }]
      )
    : [];

  return (
    <>
      {/* Navigáció */}
      <div className="file-nav">
        <button className="file-back-btn" onClick={isRoot ? onBack : () => setStack(s => s.slice(0, -1))}>
          ← {isRoot ? 'Vissza' : stack[stack.length - 2].name}
        </button>
        {!isRoot && (
          <span className="file-breadcrumb-current">{currentFolder.name}</span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '3px' }}>
          {downloading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              <span style={{ fontSize: '0.68rem', color: '#aaa', textAlign: 'right' }}>{downloading}</span>
              <button className="folder-download-btn" style={{ background: '#5a2a2a', borderColor: '#a04040' }}
                onClick={() => abortRef.current?.abort()}>
                ✕ Mégse
              </button>
            </div>
          ) : (
            <button
              className="folder-download-btn"
              onClick={() => {
                const ctrl = new AbortController();
                abortRef.current = ctrl;
                downloadFolder(
                  currentFolder.id,
                  displayName(currentFolder.name),
                  `https://drive.google.com/drive/folders/${currentFolder.id}`,
                  setDownloading,
                  ctrl.signal
                );
              }}
            >
              ⬇ Letöltés
            </button>
          )}
          {ytLinks.length === 1 && (
            <a className="yt-toggle-btn yt-single"
              href={toMobileYT(ytLinks[0].url)} target="_blank" rel="noopener noreferrer">
              ▶ Youtube
            </a>
          )}
        </div>
      </div>

      {ytLinks.length > 1 && (() => {
        const cols = ytLinks.length <= 3 ? ytLinks.length : Math.ceil(ytLinks.length / 2);
        return (
          <div className="yt-btn-group" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
            {ytLinks.map((item, i) => (
              <a key={i} className="yt-toggle-btn"
                href={toMobileYT(item.url)} target="_blank" rel="noopener noreferrer">
                ▶ {item.label}
              </a>
            ))}
          </div>
        );
      })()}

      <div className="file-list">
        {loadingId === currentFolder.id ? (
          <span className="file-empty">⏳ Betöltés...</span>
        ) : !files || files.length === 0 ? (
          <span className="file-empty">Üres mappa</span>
        ) : (
          files.map(file => (
            <div key={file.id} className={`file-row${isFolder(file.mimeType) ? ' file-row--folder' : ''}`}>
              <span className="file-icon">{fileIcon(file.mimeType)}</span>
              {isFolder(file.mimeType) ? (
                <button className="file-name file-folder-btn"
                  onClick={() => setStack(s => [...s, { id: file.id, name: file.name }])}>
                  {isRoot ? displayName(file.name) : file.name}
                </button>
              ) : (
                <span className="file-name">{file.name}</span>
              )}
              {!isFolder(file.mimeType) && (
                <div className="file-actions">
                  <button className="file-btn file-btn-preview"
                    onClick={() => setPreviewFile(file)} title="Előnézet">👁</button>
                  <a href={`https://drive.google.com/uc?export=download&id=${file.id}`}
                    target="_blank" rel="noopener noreferrer"
                    className="file-btn file-btn-download" title="Letöltés">⬇</a>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {previewFile && <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />}
    </>
  );
};

const SemesterPreview = ({ title, subjects, videos, link, hidden, onSubjectOpen, onBackToAll }) => {
  const [videosOpen, setVideosOpen] = useState(false);
  const [openSubject, setOpenSubject] = useState(null);
  const [semDownloading, setSemDownloading] = useState(false);

  const videoCount = videos ? videos.length : 0;

  function enterSubject(subject) {
    const matchingVideos = (videos || []).filter(
      v => v.name.toLowerCase() === subject.name.toLowerCase()
    );
    setOpenSubject({ ...subject, matchingVideos });
    onSubjectOpen?.();
  }

  function goBack() {
    setOpenSubject(null);
    onBackToAll?.();
  }

  return (
    <div className={`folder-card${openSubject ? ' folder-card--open' : ''}${hidden ? ' folder-card--hidden' : ''}`}>
      {openSubject ? (
        <div className="card-slide animate-forward" key={openSubject.folderId}>
          <a className="folder-header" href={openSubject.url} target="_blank" rel="noopener noreferrer">
            <div className="emoji-icon">📂</div>
            <span className="folder-title">{openSubject.name}</span>
          </a>
          <FileBrowser
            rootId={openSubject.folderId}
            rootName={openSubject.name}
            subjectVideos={openSubject.matchingVideos}
            onBack={goBack}
            onRootError={() => {
              const url = openSubject.url;
              setOpenSubject(null);
              onBackToAll?.();
              window.open(url, '_blank', 'noopener,noreferrer');
            }}
          />
        </div>
      ) : (
        <div className="card-slide" key="subjects">
          <a href={link} target="_blank" rel="noopener noreferrer" className="folder-header">
            <div className="emoji-icon">🗄️</div>
            <span className="folder-title">{title}</span>
          </a>

          <div className="subjects-container">
            {subjects.map((subject, i) => {
              const folderId = extractFolderId(subject.url);
              return (
                <div key={i} className="subject-row">
                  {folderId ? (
                    <button className="subject-item"
                      onClick={() => enterSubject({ folderId, name: subject.name, url: subject.url })}>
                      {subject.name}
                    </button>
                  ) : (
                    <a className="subject-item" href={subject.url} target="_blank" rel="noopener noreferrer">
                      {subject.name}
                    </a>
                  )}
                </div>
              );
            })}
          </div>

          {videos && videos.length > 0 && (
            <>
              <div className="videos-divider" />
              <button className="videos-toggle" onClick={() => setVideosOpen(o => !o)}>
                {videosOpen ? '▲' : '▶'} Videók ({videoCount})
              </button>
              {videosOpen && (
                <div className="subjects-container videos-list">
                  {videos.map((video, i) =>
                    video.group ? (
                      <VideoGroup key={i} name={video.name} items={video.group} />
                    ) : (
                      <a key={i} className="video-item" href={toMobileYT(video.url)}
                        target="_blank" rel="noopener noreferrer">
                        ▶ {video.name}
                      </a>
                    )
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default SemesterPreview;
