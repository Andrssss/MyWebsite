import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import './BugReport.css';

const BUG_REPORT_API = '/.netlify/functions/bug-report';
const BUG_REPORT_COOKIE = 'lastBugReport';
const BUG_REPORT_COOLDOWN_MS = 5 * 60 * 1000;

const readCookie = (name) => {
  for (const part of document.cookie.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v || '');
  }
  return '';
};

const writeCookie = (name, value, days) => {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
};

const BugReport = ({ buttonLabel = '🐛 Bug report', buttonClassName }) => {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState('');
  const [sending, setSending] = useState(false);

  const isCooldown = () => {
    const val = readCookie(BUG_REPORT_COOKIE);
    return val ? Date.now() - Number(val) < BUG_REPORT_COOLDOWN_MS : false;
  };

  const handleSubmit = async () => {
    const msg = message.trim();
    if (!msg) { setStatus('Írj valamit a küldés előtt.'); return; }
    if (isCooldown()) { setStatus('Már küldtél hibajelentést nemrég. Várj egy kicsit.'); return; }
    setSending(true);
    setStatus('');
    try {
      const res = await fetch(BUG_REPORT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
      writeCookie(BUG_REPORT_COOKIE, String(Date.now()), 1);
      setMessage('');
      setStatus('✔ Köszönjük a visszajelzést!');
    } catch (err) {
      setStatus(`✗ Hiba a küldés során.${err.message ? ` (${err.message})` : ''}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <button
        className={buttonClassName || 'bug-report-trigger-btn'}
        onClick={() => { setOpen(true); setStatus(''); }}
      >
        {buttonLabel}
      </button>

      {open && createPortal(
        <div className="bug-modal-overlay" onClick={e => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="bug-modal" role="dialog" aria-modal="true">
            <div className="bug-modal-header">
              <span className="bug-modal-title">Visszajelzés / hibabejelentés</span>
              <button className="bug-modal-close" onClick={() => setOpen(false)}>✕</button>
            </div>
            <p className="bug-modal-info">Teljesen anoním, csak az üzenetet és az időt menti el.</p>
            <textarea
              className="bug-modal-textarea"
              rows={5}
              maxLength={2000}
              placeholder="Írd le a hibát, hiányzó funkciót, vagy bármilyen visszajelzést…"
              value={message}
              onChange={e => setMessage(e.target.value)}
              disabled={sending}
              autoFocus
            />
            <div className="bug-modal-footer">
              <span className="bug-modal-chars">{message.length}/2000</span>
              {status && <span className="bug-modal-status">{status}</span>}
              <button className="bug-modal-submit-btn" onClick={handleSubmit} disabled={sending || !message.trim()}>
                {sending ? 'Küldés…' : 'Küldés'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};

export default BugReport;
