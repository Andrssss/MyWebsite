import React, { useState } from 'react';
import './SemesterPreview.css';

const SemesterPreview = ({ title, subjects, videos, link }) => {
  const [videosOpen, setVideosOpen] = useState(false);

  return (
    <div className="folder-card">
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
        {subjects.map((subject, i) => (
          <a
            key={i}
            className="subject-item"
            href={subject.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {subject.name}
          </a>
        ))}
      </div>

      {videos && videos.length > 0 && (
        <>
          <div className="videos-divider" />
          <button
            className="videos-toggle"
            onClick={() => setVideosOpen(o => !o)}
          >
            {videosOpen ? '▲' : '▶'} Videók ({videos.length})
          </button>
          {videosOpen && (
            <div className="subjects-container videos-list">
              {videos.map((video, i) => (
                <a
                  key={i}
                  className="video-item"
                  href={video.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  ▶ {video.name}
                </a>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default SemesterPreview;
