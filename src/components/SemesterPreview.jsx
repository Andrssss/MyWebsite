import React, { useState } from 'react';
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

const PreviewModal = ({ file, onClose }) => (
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
  </div>
);

const FileBrowser = ({ rootId, rootName, subjectVideos, onRootError, onBack }) => {
  const [stack, setStack] = useState([{ id: rootId, name: rootName }]);
  const [cache, setCache] = useState({});
  const [loadingId, setLoadingId] = useState(null);
  const [previewFile, setPreviewFile] = useState(null);

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
      .then(data => { if (!cancelled) setCache(c => ({ ...c, [currentFolder.id]: data.files || [] })); })
      .catch(e => {
        console.error('[drive-files]', e);
        if (!cancelled && isRoot) onRootError?.();
      })
      .finally(() => { if (!cancelled) setLoadingId(null); });
    return () => { cancelled = true; };
  }, [currentFolder.id]);

  const [videosOpen, setVideosOpen] = useState(false);

  return (
    <>
      {/* Navigáció: vissza gomb + breadcrumb */}
      <div className="file-nav">
        <button className="file-back-btn" onClick={isRoot ? onBack : () => setStack(s => s.slice(0, -1))}>
          ← {isRoot ? 'Vissza' : stack[stack.length - 2].name}
        </button>
        {!isRoot && (
          <span className="file-breadcrumb-current">{currentFolder.name}</span>
        )}
      </div>

      {isRoot && subjectVideos && subjectVideos.length > 0 && (
        <div className="subject-videos">
          <button className="videos-toggle" onClick={() => setVideosOpen(o => !o)}>
            {videosOpen ? '▲' : '▶'} Videók ({subjectVideos.length})
          </button>
          {videosOpen && (
            <div className="subject-videos-list">
              {subjectVideos.map((video, i) =>
                video.group ? (
                  <VideoGroup key={i} name={video.name} items={video.group} />
                ) : (
                  <a key={i} className="video-item"
                    href={toMobileYT(video.url)} target="_blank" rel="noopener noreferrer">
                    ▶ {video.name}
                  </a>
                )
              )}
            </div>
          )}
        </div>
      )}

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
                  {file.name}
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
  const [direction, setDirection] = useState('forward');

  const videoCount = videos ? videos.length : 0;

  function enterSubject(subject) {
    const matchingVideos = (videos || []).filter(
      v => v.name.toLowerCase() === subject.name.toLowerCase()
    );
    setDirection('forward');
    setOpenSubject({ ...subject, matchingVideos });
    onSubjectOpen?.();
  }

  function goBack() {
    setDirection('back');
    setOpenSubject(null);
    onBackToAll?.();
  }

  return (
    <div className={`folder-card${openSubject ? ' folder-card--open' : ''}${hidden ? ' folder-card--hidden' : ''}`}>
      {openSubject ? (
        <div className="card-slide animate-forward" key={openSubject.folderId}>
          <div className="folder-header">
            <div className="emoji-icon">🗄️</div>
            <span className="folder-title">{title}</span>
          </div>
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
        <div className={`card-slide ${direction === 'back' ? 'animate-back' : ''}`} key="subjects">
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
