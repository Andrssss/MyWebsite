import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./JobStats.css";

const API = "/.netlify/functions/job-stats";

const JobStats = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetch(API)
      .then((r) => r.json())
      .then((d) => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="stats-page"><p className="stats-loading">Betöltés…</p></div>;
  if (!data || (!data.month?.length && !data.last10?.length))
    return <div className="stats-page"><p className="stats-loading">Nincs még adat.</p></div>;

  const { month = [], last10 = [] } = data;

  /* ===== HAVI ÁTLAGOK ===== */
  const monthTotal = month.reduce((s, d) => s + d.total_jobs, 0);
  const monthIntern = month.reduce((s, d) => s + d.intern_jobs, 0);
  const daysCount = month.length || 1;
  const avgTotal = (monthTotal / daysCount).toFixed(1);
  const avgIntern = (monthIntern / daysCount).toFixed(1);
  const avgRegular = ((monthTotal - monthIntern) / daysCount).toFixed(1);

  /* ===== BAR CHART – utolsó 10 nap ===== */
  const barMax = Math.max(...last10.map((d) => d.total_jobs), 1);

  /* ===== LINE CHART – havi ===== */
  const lineMax = Math.max(...month.map((d) => d.total_jobs), 1);
  const lineW = 600;
  const lineH = 200;
  const linePad = 30;

  const linePoints = month.map((d, i) => {
    const x = linePad + (i / Math.max(month.length - 1, 1)) * (lineW - 2 * linePad);
    const y = lineH - linePad - (d.total_jobs / lineMax) * (lineH - 2 * linePad);
    return { x, y, ...d };
  });

  const internLinePoints = month.map((d, i) => {
    const x = linePad + (i / Math.max(month.length - 1, 1)) * (lineW - 2 * linePad);
    const y = lineH - linePad - (d.intern_jobs / lineMax) * (lineH - 2 * linePad);
    return { x, y, ...d };
  });

  const toPath = (pts) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");

  const fmtDate = (iso) => {
    const d = new Date(iso);
    return `${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
  };

  return (
    <div className="stats-page">
      <div className="stats-header">
        <h1>Statisztikák</h1>
        <button className="stats-back-btn" onClick={() => navigate("/allasfigyelo")}>
          ← Vissza
        </button>
      </div>

      {/* ===== BAR CHART ===== */}
      <div className="stats-section">
        <h2>Utolsó 10 nap</h2>
        <div className="stats-bar-chart">
          {last10.map((d) => {
            const totalPct = (d.total_jobs / barMax) * 100;
            const internPct = (d.intern_jobs / barMax) * 100;
            return (
              <div key={d.date} className="stats-bar-col">
                <span className="stats-bar-value">{d.total_jobs}</span>
                <div className="stats-bar-track">
                  <div className="stats-bar-fill" style={{ height: `${totalPct}%` }}>
                    <div className="stats-bar-intern" style={{ height: `${d.total_jobs ? (d.intern_jobs / d.total_jobs) * 100 : 0}%` }} />
                  </div>
                </div>
                <span className="stats-bar-label">{fmtDate(d.date)}</span>
              </div>
            );
          })}
        </div>
        <div className="stats-legend">
          <span className="stats-legend-item"><span className="stats-dot regular" /> Összes</span>
          <span className="stats-legend-item"><span className="stats-dot intern" /> Diák/Intern</span>
        </div>
      </div>

      {/* ===== KÖZÉPSŐ SZÁMOK ===== */}
      <div className="stats-averages">
        <div className="stats-avg-card">
          <span className="stats-avg-number">{avgRegular}</span>
          <span className="stats-avg-label">Napi átlag (sima)</span>
        </div>
        <div className="stats-avg-card">
          <span className="stats-avg-number">{avgIntern}</span>
          <span className="stats-avg-label">Napi átlag (diák/intern)</span>
        </div>
        <div className="stats-avg-card highlight">
          <span className="stats-avg-number">{avgTotal}</span>
          <span className="stats-avg-label">Napi átlag (összes)</span>
        </div>
        <div className="stats-avg-card">
          <span className="stats-avg-number">{monthTotal}</span>
          <span className="stats-avg-label">Havi összesen</span>
        </div>
      </div>

      {/* ===== LINE CHART ===== */}
      <div className="stats-section">
        <h2>E havi napi bontás</h2>
        <div className="stats-line-chart-wrapper">
          <svg viewBox={`0 0 ${lineW} ${lineH}`} className="stats-line-chart">
            {/* Grid lines */}
            {[0, 0.25, 0.5, 0.75, 1].map((f) => {
              const y = lineH - linePad - f * (lineH - 2 * linePad);
              return (
                <g key={f}>
                  <line x1={linePad} y1={y} x2={lineW - linePad} y2={y} className="stats-grid-line" />
                  <text x={linePad - 4} y={y + 4} className="stats-axis-label" textAnchor="end">
                    {Math.round(f * lineMax)}
                  </text>
                </g>
              );
            })}

            {/* Összes vonal */}
            {linePoints.length > 1 && (
              <path d={toPath(linePoints)} className="stats-line total-line" />
            )}
            {linePoints.map((p, i) => (
              <circle key={`t-${i}`} cx={p.x} cy={p.y} r={3.5} className="stats-point total-point" />
            ))}

            {/* Intern vonal */}
            {internLinePoints.length > 1 && (
              <path d={toPath(internLinePoints)} className="stats-line intern-line" />
            )}
            {internLinePoints.map((p, i) => (
              <circle key={`i-${i}`} cx={p.x} cy={p.y} r={3} className="stats-point intern-point" />
            ))}

            {/* X tengely labelek */}
            {linePoints.filter((_, i) => i % Math.max(1, Math.floor(linePoints.length / 8)) === 0 || i === linePoints.length - 1).map((p, i) => (
              <text key={`xl-${i}`} x={p.x} y={lineH - 6} className="stats-axis-label" textAnchor="middle">
                {fmtDate(p.date)}
              </text>
            ))}
          </svg>
        </div>
        <div className="stats-legend">
          <span className="stats-legend-item"><span className="stats-dot regular" /> Összes</span>
          <span className="stats-legend-item"><span className="stats-dot intern" /> Diák/Intern</span>
        </div>
      </div>
    </div>
  );
};

export default JobStats;
