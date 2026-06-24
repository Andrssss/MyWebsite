import React, { useState } from 'react';
import './SemesterPreview.css';

const toMobileYT = (url) =>
  url.replace(/^https?:\/\/(www\.)?youtube\.com/, 'https://m.youtube.com');

function extractFolderId(url) {
  return url?.match(/\/folders\/([a-zA-Z0-9_-]+)/)?.[1] ?? null;
}

function fileIcon(mimeType) {
  if (!mimeType) return '📄';
  if (mimeType === 'application/pdf') return '📕';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return '📊';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return '📊';
  if (mimeType.includes('document') || mimeType.includes('word')) return '📝';
  if (mimeType.includes('image')) return '🖼';
  if (mimeType.includes('zip') || mimeType.includes('archive')) return '🗜';
  if (mimeType === 'application/vnd.google-apps.folder') return '📁';
  return '📄';
}

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
            <a
              key={i}
              className="video-item video-item-nested"
              href={toMobileYT(video.url)}
              target="_blank"
              rel="noopener noreferrer"
            >
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
          <a
            href={`https://drive.google.com/uc?export=download&id=${file.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="preview-modal-download"
          >
            ⬇ Letöltés
          </a>
          <button className="preview-modal-close" onClick={onClose}>✕</button>
        </div>
      </div>
      <iframe
        src={`https://drive.google.com/file/d/${file.id}/preview`}
        className="preview-iframe"
        title={file.name}
        allow="autoplay"
      />
    </div>
  </div>
);

const SemesterPreview = ({ title, subjects, videos, link }) => {
  const [videosOpen, setVideosOpen] = useState(false);
  const [openFolderId, setOpenFolderId] = useState(null);
  const [filesCache, setFilesCache] = useState({});
  const [loadingId, setLoadingId] = useState(null);
  const [previewFile, setPreviewFile] = useState(null);

  const videoCount = videos ? videos.length : 0;

  async function toggleFiles(folderId) {
    if (!folderId) return;
    if (openFolderId === folderId) {
      setOpenFolderId(null);
      return;
    }
    if (filesCache[folderId]) {
      setOpenFolderId(folderId);
      return;
    }
    setLoadingId(folderId);
    try {
      const res = await fetch(`/.netlify/functions/drive-files?folderId=${folderId}`);
      const data = await res.json();
      setFilesCache(c => ({ ...c, [folderId]: data.files || [] }));
      setOpenFolderId(folderId);
    } catch (e) {
      console.error('[drive-files]', e);
    } finally {
      setLoadingId(null);
    }
  }

  return (
    <>
      <div className={`folder-card${openFolderId ? ' folder-card--wide' : ''}`}>
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="folder-header"
        >
          <div className="emoji-icon">🗄️</div>
          <span className="folder-title">{title}</span>
        </a>

        <div className="subjects-container">
          {subjects.map((subject, i) => {
            const folderId = extractFolderId(subject.url);
            const isOpen = openFolderId === folderId;
            const isLoading = loadingId === folderId;
            const files = filesCache[folderId];

            return (
              <div key={i} className="subject-wrapper">
                <div className="subject-row">
                  <a
                    className="subject-item"
                    href={subject.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {subject.name}
                  </a>
                  {folderId && (
                    <button
                      className={`subject-files-btn${isOpen ? ' subject-files-btn--active' : ''}`}
                      onClick={() => toggleFiles(folderId)}
                      title="Fájlok"
                    >
                      {isLoading ? '⏳' : isOpen ? '▲' : '📂'}
                    </button>
                  )}
                </div>
                {isOpen && files && (
                  <div className="file-list">
                    {files.length === 0 ? (
                      <span className="file-empty">Üres mappa</span>
                    ) : (
                      files.map(file => (
                        <div key={file.id} className="file-row">
                          <span className="file-icon">{fileIcon(file.mimeType)}</span>
                          <span className="file-name">{file.name}</span>
                          <div className="file-actions">
                            <button
                              className="file-btn file-btn-preview"
                              onClick={() => setPreviewFile(file)}
                              title="Előnézet"
                            >
                              👁
                            </button>
                            <a
                              href={`https://drive.google.com/uc?export=download&id=${file.id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="file-btn file-btn-download"
                              title="Letöltés"
                            >
                              ⬇
                            </a>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {videos && videos.length > 0 && (
          <>
            <div className="videos-divider" />
            <button
              className="videos-toggle"
              onClick={() => setVideosOpen(o => !o)}
            >
              {videosOpen ? '▲' : '▶'} Videók ({videoCount})
            </button>
            {videosOpen && (
              <div className="subjects-container videos-list">
                {videos.map((video, i) =>
                  video.group ? (
                    <VideoGroup key={i} name={video.name} items={video.group} />
                  ) : (
                    <a
                      key={i}
                      className="video-item"
                      href={toMobileYT(video.url)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      ▶ {video.name}
                    </a>
                  )
                )}
              </div>
            )}
          </>
        )}
      </div>

      {previewFile && <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />}
    </>
  );
};

export default SemesterPreview;
