import React from 'react';
import './SemesterPreview.css';

const SemesterPreview = ({ title, subjects, link }) => {
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
    </div>
  );
};

export default SemesterPreview;
