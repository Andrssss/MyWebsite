import React, { useEffect, useMemo, useRef, useState } from "react";
import "./JobStats.css";

const CATEGORY_COLOR_MAP = {
  "Webfejlesztés": "#3b82f6",
  "Data / AI": "#6366f1",
  DevOps: "#10b981",
  "QA / Tesztelő": "#f59e0b",
  "Computer Support": "#ef4444",
  SAP: "#14b8a6",
  Security: "#ec4899",
  "Hálózat / Infra": "#64748b",
  Hardware: "#f97316",
  Mobil: "#06b6d4",
  Fejlesztő: "#a855f7",
  "C++": "#0ea5e9",
  "Menedzser / PM": "#f43f5e",
  "Business / System Analyst": "#8b5cf6",
  "Data Analytics": "#06b6d4",
  "BI (Business Intelligence)": "#0d9488",
  "Mérnöki / Gyártás": "#84cc16",
  Egyéb: "#94a3b8",

  // Backward compatibility for historical data
  Helpdesk: "#ef4444",
  Elemző: "#8b5cf6",
};

const CATEGORY_DISPLAY_NAMES = {
  "Fejlesztő": "Egyéb fejlesztő",
};

const getCategoryColor = (category) => {
  const normalizedCategory = category?.startsWith("intern:")
    ? category.slice("intern:".length)
    : category;

  if (CATEGORY_COLOR_MAP[normalizedCategory]) {
    return CATEGORY_COLOR_MAP[normalizedCategory];
  }

  let hash = 0;
  for (let index = 0; index < normalizedCategory.length; index += 1) {
    hash = normalizedCategory.charCodeAt(index) + ((hash << 5) - hash);
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
              <span className="stats-pie-label">{CATEGORY_DISPLAY_NAMES[s.category] ?? s.category}</span>
              <span className="stats-pie-count">{s.count} ({s.pct}%)</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const API = "/.netlify/functions/job-stats";

const lerp = (a, b, t) => a + (b - a) * t;

const sampleSeries = (rows, key, count) => {
  if (count <= 0) return [];
  if (!rows.length) return Array.from({ length: count }, () => 0);
  if (rows.length === 1) return Array.from({ length: count }, () => Number(rows[0][key] || 0));

  return Array.from({ length: count }, (_, i) => {
    const t = count === 1 ? 0 : i / (count - 1);
    const rawIndex = t * (rows.length - 1);
    const left = Math.floor(rawIndex);
    const right = Math.min(rows.length - 1, Math.ceil(rawIndex));
    const mix = rawIndex - left;
    const a = Number(rows[left][key] || 0);
    const b = Number(rows[right][key] || 0);
    return lerp(a, b, mix);
  });
};

const sampleDates = (rows, count) => {
  if (count <= 0) return [];
  if (!rows.length) return Array.from({ length: count }, () => "");
  if (rows.length === 1) return Array.from({ length: count }, () => rows[0].date || "");

  return Array.from({ length: count }, (_, i) => {
    const t = count === 1 ? 0 : i / (count - 1);
    const idx = Math.round(t * (rows.length - 1));
    return rows[idx]?.date || "";
  });
};

const JobStats = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lineRange, setLineRange] = useState(30);
  const [lineMorphT, setLineMorphT] = useState(1);
  const [lineMorphState, setLineMorphState] = useState({ from: [], to: [] });
  const previousRangeDataRef = useRef([]);
  const lineMorphRafRef = useRef(null);

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
    internCategories6m = [],
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

  /* ===== LINE CHART – időszak szűrés + morph animáció ===== */
  const rangeData = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (lineRange - 1));
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return allDays.filter((d) => d.date >= cutoffStr);
  }, [allDays, lineRange]);

  useEffect(() => {
    const from = previousRangeDataRef.current.length
      ? previousRangeDataRef.current
      : rangeData;
    const to = rangeData;

    if (lineMorphRafRef.current) {
      cancelAnimationFrame(lineMorphRafRef.current);
    }

    setLineMorphState({ from, to });
    setLineMorphT(0);

    const duration = 360;
    const start = performance.now();

    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      setLineMorphT(t);
      if (t < 1) {
        lineMorphRafRef.current = requestAnimationFrame(tick);
      } else {
        previousRangeDataRef.current = to;
        lineMorphRafRef.current = null;
      }
    };

    lineMorphRafRef.current = requestAnimationFrame(tick);
  }, [rangeData]);

  useEffect(() => () => {
    if (lineMorphRafRef.current) {
      cancelAnimationFrame(lineMorphRafRef.current);
    }
  }, []);

  const lineRangeLabel =
    lineRange === 30 ? "Elmúlt 30 nap" : lineRange === 90 ? "Elmúlt 3 hónap" : "Elmúlt 6 hónap";

  const lineW = 600;
  const lineH = 200;
  const linePad = 30;

  const { linePoints, internLinePoints, lineMax } = useMemo(() => {
    const from = lineMorphState.from;
    const to = lineMorphState.to;
    const pointCount = Math.max(from.length, to.length, 2);

    const fromTotals = sampleSeries(from, "total_jobs", pointCount);
    const toTotals = sampleSeries(to, "total_jobs", pointCount);
    const fromInterns = sampleSeries(from, "intern_jobs", pointCount);
    const toInterns = sampleSeries(to, "intern_jobs", pointCount);
    const dates = sampleDates(to.length ? to : from, pointCount);

    const maxFrom = Math.max(...fromTotals, 1);
    const maxTo = Math.max(...toTotals, 1);
    const maxValue = Math.max(1, lerp(maxFrom, maxTo, lineMorphT));

    const totalPoints = fromTotals.map((fromValue, i) => {
      const value = lerp(fromValue, toTotals[i], lineMorphT);
      const x = linePad + (i / Math.max(pointCount - 1, 1)) * (lineW - 2 * linePad);
      const y = lineH - linePad - (value / maxValue) * (lineH - 2 * linePad);
      return { x, y, value, date: dates[i] };
    });

    const internPoints = fromInterns.map((fromValue, i) => {
      const value = lerp(fromValue, toInterns[i], lineMorphT);
      const x = linePad + (i / Math.max(pointCount - 1, 1)) * (lineW - 2 * linePad);
      const y = lineH - linePad - (value / maxValue) * (lineH - 2 * linePad);
      return { x, y, value, date: dates[i] };
    });

    return {
      linePoints: totalPoints,
      internLinePoints: internPoints,
      lineMax: maxValue,
    };
  }, [lineMorphState, lineMorphT]);

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
        <button className="stats-back-btn" onClick={() => window.location.href = "/allasfigyelo"}>
          ← Vissza
        </button>
      </div>

      <div className="stats-note">
        Keep in mind, hogy azért vannak tüskék az adatokban, mert mostanában sok forrást adtam hozzá és
        sokat változtattam a filtereken is és ilyenkor sok adat került a DB-be.
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
            {[30, 90, 180].map((range) => (
              <button
                key={range}
                className={`stats-range-btn${lineRange === range ? " active" : ""}`}
                onClick={() => setLineRange(range)}
              >
                {range === 30 ? "30 nap" : range === 90 ? "3 hónap" : "6 hónap"}
              </button>
            ))}
          </div>
        </div>
        <div>
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

      {/* ===== PIE CHARTS ===== */}
      <div className="stats-pies-row">
        <PieChart data={monthCategories} title="Elmúlt 30 nap kategória bontás" />
        <PieChart data={weekCategories} title="6 havi kategória bontás" />
      </div>
      <div className="stats-pies-row">
        <PieChart data={internCategories6m} title="6 havi diák/intern kategória bontás" />
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
