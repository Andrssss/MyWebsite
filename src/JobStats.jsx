import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./JobStats.css";

const CATEGORY_COLOR_MAP = {
  "Webfejlesztés": "#4f8cff",
  "Data / AI": "#6366f1",
  DevOps: "#10b981",
  "QA / Tesztelő": "#f59e0b",
  Helpdesk: "#ef4444",
  Elemző: "#8b5cf6",
  SAP: "#14b8a6",
  Security: "#ec4899",
  "Hálózat / Infra": "#64748b",
  Hardware: "#f97316",
  Mobil: "#06b6d4",
  Fejlesztő: "#a855f7",
  Egyéb: "#94a3b8",
};

const getCategoryColor = (category) => {
  if (CATEGORY_COLOR_MAP[category]) return CATEGORY_COLOR_MAP[category];

  let hash = 0;
  for (let index = 0; index < category.length; index += 1) {
    hash = category.charCodeAt(index) + ((hash << 5) - hash);
  }

  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 65% 55%)`;
};

const PieChart = ({ data, title }) => {
  const total = data.reduce((s, d) => s + d.count, 0);
  if (!total) return <div className="stats-pie-empty">Nincs adat</div>;

  const size = 200;
  const cx = size / 2;
  const cy = size / 2;
  const r = 80;

  let cumAngle = -Math.PI / 2;
  const slices = data.map((d, i) => {
    const angle = (d.count / total) * 2 * Math.PI;
    const startX = cx + r * Math.cos(cumAngle);
    const startY = cy + r * Math.sin(cumAngle);
    cumAngle += angle;
    const endX = cx + r * Math.cos(cumAngle);
    const endY = cy + r * Math.sin(cumAngle);
    const largeArc = angle > Math.PI ? 1 : 0;
    const path = `M${cx},${cy} L${startX},${startY} A${r},${r} 0 ${largeArc},1 ${endX},${endY} Z`;
    return { ...d, path, color: getCategoryColor(d.category), pct: ((d.count / total) * 100).toFixed(1) };
  });

  return (
    <div className="stats-pie-section">
      <h2>{title}</h2>
      <div className="stats-pie-row">
        <svg viewBox={`0 0 ${size} ${size}`} className="stats-pie-svg">
          {slices.map((s, i) => (
            <path key={i} d={s.path} fill={s.color} stroke="rgba(0,0,0,0.3)" strokeWidth="1" />
          ))}
        </svg>
        <div className="stats-pie-legend">
          {slices.map((s, i) => (
            <div key={i} className="stats-pie-legend-item">
              <span className="stats-pie-color" style={{ background: s.color }} />
              <span className="stats-pie-label">{s.category}</span>
              <span className="stats-pie-count">{s.count} ({s.pct}%)</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const API = "/.netlify/functions/job-stats";

const JobStats = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lineRange, setLineRange] = useState(30);
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

  const {
    month = [],
    last10 = [],
    allDays = [],
    monthlyTotals = [],
    monthCategories = [],
    weekCategories = [],
  } = data;

  /* ===== ÁTLAGOK (összes adatból) ===== */
  const allTotal = allDays.reduce((s, d) => s + d.total_jobs, 0);
  const allIntern = allDays.reduce((s, d) => s + d.intern_jobs, 0);
  const allDaysCount = allDays.length || 1;
  const avgTotal = (allTotal / allDaysCount).toFixed(1);
  const avgIntern = (allIntern / allDaysCount).toFixed(1);
  const avgRegular = ((allTotal - allIntern) / allDaysCount).toFixed(1);
  const sortedDailyTotals = allDays
    .map((d) => d.total_jobs)
    .sort((a, b) => a - b);
  const midIndex = Math.floor(sortedDailyTotals.length / 2);
  const dailyMedian = sortedDailyTotals.length
    ? (sortedDailyTotals.length % 2 === 0
        ? ((sortedDailyTotals[midIndex - 1] + sortedDailyTotals[midIndex]) / 2).toFixed(1)
        : sortedDailyTotals[midIndex])
    : 0;

  /* ===== BAR CHART – utolsó 10 nap ===== */
  const barMax = Math.max(...last10.map((d) => d.total_jobs), 1);
  const monthlyBarMax = Math.max(...monthlyTotals.map((d) => d.total_jobs), 1);

  /* ===== LINE CHART – időszak szűrés ===== */
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (lineRange - 1));
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const rangeData = allDays.filter((d) => d.date >= cutoffStr);

  const lineRangeLabel =
    lineRange === 30 ? "Elmúlt 30 nap" : lineRange === 90 ? "Elmúlt 3 hónap" : "Elmúlt 6 hónap";

  const lineMax = Math.max(...rangeData.map((d) => d.total_jobs), 1);
  const lineW = 600;
  const lineH = 200;
  const linePad = 30;

  const linePoints = rangeData.map((d, i) => {
    const x = linePad + (i / Math.max(rangeData.length - 1, 1)) * (lineW - 2 * linePad);
    const y = lineH - linePad - (d.total_jobs / lineMax) * (lineH - 2 * linePad);
    return { x, y, ...d };
  });

  const internLinePoints = rangeData.map((d, i) => {
    const x = linePad + (i / Math.max(rangeData.length - 1, 1)) * (lineW - 2 * linePad);
    const y = lineH - linePad - (d.intern_jobs / lineMax) * (lineH - 2 * linePad);
    return { x, y, ...d };
  });

  const toPath = (pts) =>
    pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");

  const fmtDate = (iso) => {
    const d = new Date(iso);
    return `${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
  };

  const fmtMonth = (monthKey) => {
    const [year, monthNumber] = monthKey.split("-").map(Number);
    const date = new Date(year, monthNumber - 1, 1);
    return new Intl.DateTimeFormat("hu-HU", {
      year: "numeric",
      month: "short",
    }).format(date);
  };

  return (
    <div className="stats-page">
      <div className="stats-header">
        <h1>Statisztikák</h1>
        <button className="stats-back-btn" onClick={() => navigate("/allasfigyelo")}>
          ← Vissza
        </button>
      </div>
      <div className="stats-header">
        <h4>Keep in mind, hogy azért vannak tüskék az adatokban, mert mostanában sok forrást adtam hozzá és sokat változtattam a filtereken is és azokon a napokon, amikor ezekkel foglalkoztam, akkor sok adat kerűlt a db-be !</h4>
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
                <span className="stats-bar-value intern">{d.intern_jobs}</span>
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
      <div className="stats-section">
        <h2>Összes adatból</h2>
      </div>
      <div className="stats-averages">
        <div className="stats-avg-card">
          <span className="stats-avg-number">{avgRegular}</span>
          <span className="stats-avg-label">Napi átlag (juni/medi)</span>
        </div>
        <div className="stats-avg-card">
          <span className="stats-avg-number">{avgIntern}</span>
          <span className="stats-avg-label">Napi átlag (diák/intern)</span>
        </div>
        <div className="stats-avg-card highlight">
          <span className="stats-avg-number">{avgTotal}</span>
          <span className="stats-avg-label">Átlag (összes)</span>
        </div>
        <div className="stats-avg-card">
          <span className="stats-avg-number">{dailyMedian}</span>
          <span className="stats-avg-label">Medián (összes)</span>
        </div>
      </div>

      {/* ===== LINE CHART ===== */}
      <div className="stats-section">
        <div className="stats-line-header">
          <h2>{lineRangeLabel} napi bontás</h2>
          <div className="stats-range-buttons">
            {[30, 90, 180].map((r) => (
              <button
                key={r}
                className={`stats-range-btn${lineRange === r ? " active" : ""}`}
                onClick={() => setLineRange(r)}
              >
                {r === 30 ? "30 nap" : r === 90 ? "3 hónap" : "6 hónap"}
              </button>
            ))}
          </div>
        </div>
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

      {/* ===== PIE CHARTS ===== */}
      <div className="stats-pies-row">
        <PieChart data={monthCategories} title="Elmúlt 30 nap kategória bontás" />
        <PieChart data={weekCategories} title="6 havi kategória bontás" />
      </div>

      <div className="stats-section stats-monthly-summary-section">
        <h2>Utolsó 6 hónap összesítése</h2>
        <div className="stats-bar-chart stats-monthly-bar-chart">
          {monthlyTotals.map((item) => {
            const totalPct = (item.total_jobs / monthlyBarMax) * 100;
            return (
              <div key={item.month} className="stats-bar-col stats-monthly-bar-col">
                <span className="stats-bar-value">{item.total_jobs}</span>
                <span className="stats-bar-value intern">{item.intern_jobs}</span>
                <div className="stats-bar-track stats-monthly-bar-track">
                  <div className="stats-bar-fill" style={{ height: `${totalPct}%` }}>
                    <div
                      className="stats-bar-intern"
                      style={{ height: `${item.total_jobs ? (item.intern_jobs / item.total_jobs) * 100 : 0}%` }}
                    />
                  </div>
                </div>
                <span className="stats-bar-label">{fmtMonth(item.month)}</span>
              </div>
            );
          })}
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
