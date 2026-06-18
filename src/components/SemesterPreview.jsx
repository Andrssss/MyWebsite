import React, { useState } from 'react';
import './SemesterPreview.css';

const toMobileYT = (url) =>
  url.replace(/^https?:\/\/(www\.)?youtube\.com/, 'https://m.youtube.com');

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

const SemesterPreview = ({ title, subjects, videos, link }) => {
  const [videosOpen, setVideosOpen] = useState(false);

  const videoCount = videos
    ? videos.reduce((acc, v) => acc + (v.group ? 1 : 1), 0)
    : 0;

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
  );
};

export default SemesterPreview;
