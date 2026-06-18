import React, { useState, useRef, useCallback } from 'react';
import './FileUpload.css';

const MAX_MB = 4;
const MAX_BYTES = MAX_MB * 1024 * 1024;

const ALLOWED_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'application/zip',
  'image/jpeg',
  'image/png',
]);

const FileUpload = () => {
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState(null); // null | 'uploading' | 'success' | 'error'
  const [fileName, setFileName] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const inputRef = useRef(null);

  const reset = () => {
    setStatus(null);
    setFileName('');
    setErrorMsg('');
    if (inputRef.current) inputRef.current.value = '';
  };

  const uploadFile = useCallback(async (file) => {
    if (!ALLOWED_TYPES.has(file.type)) {
      setStatus('error');
      setErrorMsg('Nem támogatott fájltípus (pdf, doc, ppt, xls, txt, zip, jpg, png)');
      return;
    }
    if (file.size > MAX_BYTES) {
      setStatus('error');
      setErrorMsg(`Túl nagy a fájl (max ${MAX_MB}MB)`);
      return;
    }

    setFileName(file.name);
    setStatus('uploading');
    setErrorMsg('');

    try {
      const base64Data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const res = await fetch('/.netlify/functions/upload-to-drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, mimeType: file.type, base64Data }),
      });

      const data = await res.json();
      if (res.ok && data.ok) {
        setStatus('success');
      } else {
        setStatus('error');
        setErrorMsg(data.error || 'Feltöltés sikertelen');
      }
    } catch {
      setStatus('error');
      setErrorMsg('Hálózati hiba');
    }
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  }, [uploadFile]);

  return (
    <div className="upload-section">
      <h3 className="upload-title">📤 Anyag feltöltése</h3>

      {status === 'success' ? (
        <div className="upload-success">
          <span>✅ <strong>{fileName}</strong> sikeresen feltöltve!</span>
          <button className="upload-again-btn" onClick={reset}>Újabb feltöltés</button>
        </div>
      ) : (
        <div
          className={`upload-zone${dragging ? ' dragging' : ''}${status === 'uploading' ? ' uploading' : ''}`}
          onDrop={handleDrop}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onClick={() => status !== 'uploading' && inputRef.current?.click()}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.zip,.jpg,.jpeg,.png"
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files[0]; if (f) uploadFile(f); }}
          />
          {status === 'uploading' ? (
            <div className="upload-spinner-wrap">
              <div className="upload-spinner" />
              <span>{fileName}</span>
            </div>
          ) : (
            <>
              <span className="upload-icon">📁</span>
              <span className="upload-text">Húzd ide a fájlt, vagy kattints</span>
              <span className="upload-sub">PDF · DOC · PPT · XLS · TXT · ZIP · JPG · PNG — max {MAX_MB}MB</span>
            </>
          )}
        </div>
      )}

      {status === 'error' && (
        <div className="upload-error">
          ❌ {errorMsg}
          <button className="upload-retry-btn" onClick={reset}>Újra</button>
        </div>
      )}
    </div>
  );
};

export default FileUpload;
