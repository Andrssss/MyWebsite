import React from 'react';
import './SemesterPreview.css';

const SemesterPreview = ({ title, subjects, link }) => (
  <a href={link} target="_blank" rel="noopener noreferrer" className="folder-preview">
  <div className="emoji-icon">🗄️</div>
  <span className="folder-title">{title}</span>
  <div className="preview-tooltip">
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

</a>

);

export default SemesterPreview;
