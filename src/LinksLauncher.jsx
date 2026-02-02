import  { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import CopyCode from "./components/CopyCode";

const JOB_PORTALS = [
  { label: 'Melódiák – gyakornoki', url: 'https://www.melodiak.hu/diakmunkak/?l=gyakornoki-szakmai-munkak&ca=informatikai-mernoki-muszaki' },
  { label: 'Minddiák ', url: 'https://minddiak.hu/position?page=2' },
  { label: 'Muisz – gyakornoki kategória', url: 'https://muisz.hu/hu/diakmunkaink?categories=3&locations=10' },
  { label: "CV Centrum – gyakornok IT", url: "https://cvcentrum.hu/allasok/?s=gyakornok&category%5B%5D=it&category%5B%5D=it-programozas&category%5B%5D=it-uzemeltetes&type=&location%5B%5D=budapest&_noo_job_field_year_experience=&post_type=noo_job" },
  { label: "CV Centrum – intern IT", url: "https://cvcentrum.hu/?s=intern&category%5B%5D=information-technology&category%5B%5D=it&category%5B%5D=it-programozas&category%5B%5D=it-uzemeltetes&category%5B%5D=networking&type=&_noo_job_field_year_experience=&post_type=noo_job" },
  { label: 'Zyntern – IT/fejlesztés', url: 'https://zyntern.com/jobs?fields=16' },
  { label: 'Profession – Intern', url: 'https://www.profession.hu/allasok/it-programozas-fejlesztes/1,10,0,intern' },
  { label: 'Profession – Gyakornok', url: 'https://www.profession.hu/allasok/it-uzemeltetes-telekommunikacio/1,25,0,gyakornok' },
  { label: 'Fürge Diák – gyakornok', url: 'https://gyakornok.furgediak.hu/allasok?statikusmunkakor=7' },
  { label: 'Schönherz – Budapest fejlesztő/tesztelő', url: 'https://schonherz.hu/diakmunkak/budapest/fejleszto---tesztelo' },
  { label: "Pannondiak", url: "https://pannondiak.hu/jobs/?category%5B%5D=250&category%5B%5D=1845&category%5B%5D=1848&regio%5B%5D=267#job_list" },
  { label: 'Frissdiplomás – állások', url: 'https://www.frissdiplomas.hu/allasok' },
  { label: "Prodiák – IT állások", url: "https://www.prodiak.hu/adverts/it-5980e4975de0fe1b308b460a/budapest/kulfold" },
  { label: 'Qdiák', url: 'https://cloud.qdiak.hu/munkak' },
  { label: 'LinkedIn – PAST 24H', url: 'https://www.linkedin.com/jobs/search/?currentJobId=4194029806&f_E=1%2C2&f_TPR=r86400&geoId=100288700&origin=JOB_SEARCH_PAGE_JOB_FILTER&refresh=true&sortBy=R' }
];


const COMPANIES = [
  { label: 'GOV.HU – állások', url: 'https://karrier.ih.gov.hu/index.php/nyitott-poziciok/' },
  { label: "NIX – junior", url: "https://nixstech.com/hu/allasok/?level=junior-hu" },
  { label: "NIX – trainee", url: "https://nixstech.com/hu/allasok/?level=trainee-hu" },  { label: 'OTP Karrier – GYAKORNOK', url: 'https://karrier.otpbank.hu/go/Minden-allasajanlat/1167001/?q=&q2=&alertId=&locationsearch=&title=GYAKORNOK&date=&location=&shifttype=' },
  { label: 'TCS Hungary – állások', url: 'https://hungarycareer.tcsapps.com/?s=' },
  { label: 'AVL – állások', url: 'https://jobs.avl.com/search/?createNewAlert=false&q=&locationsearch=hu' },
  { label: 'MOL – állások', url: 'https://molgroup.taleo.net/careersection/external/jobsearch.ftl?lang=hu' },
  { label: 'Taboola – állások', url: 'https://www.taboola.com/careers/jobs#team=&location=31734' },
  { label: 'Siemens – állások', url: 'https://jobs.siemens.com/careers/search?query=%2A&location=Budapest%2C%20Hungary&pid=563156121706158&level=student%20%28not%20yet%20graduated%29&level=early%20professional&level=recent%20college%20graduate&level=not%20defined&domain=siemens.com&sort_by=relevance&location_distance_km=25&triggerGoButton=false' },
  { label: 'Mediso – állások', url: 'https://mediso.com/global/hu/career?search=&location=&category=9' },
  { label: 'Thyssenkrupp – állások', url: 'https://jobs.thyssenkrupp.com/hu?filter=jobField%3AIT&location=Hungary%2C+Magyarorsz%C3%A1g&lat=47.1817585&lng=19.5060937&placeId=512e36525b8f8133405990a2cedc43974740f00101f9015753000000000000c0020b92030748756e67617279&radius=0' },
  { label: 'Continental – állások', url: 'https://jobs.continental.com/hu/#/?fieldOfWork_stringS=3a2330f4-2793-4895-b7c7-aee9c965ae22,b99ff13c-96c8-4a72-b427-dec7effd7338&location=%7B%22title%22:%22Magyarorsz%C3%A1g%22,%22type%22:%22country%22,%22countryCode%22:%22hu%22%7D&searchTerm=intern' },
  { label: 'K&H – állások', url: 'https://karrier.kh.hu/allasok/2' },
  { label: 'Piller – állások', url: 'https://piller.karrierportal.hu/allasok?q=Y2l0aWVzJTVCJTVEJTNEQnVkYXBlc3QlMjYuuzzuuzz#!'},
  { label: 'prohardver – állások', url: 'https://prohardver.hu/allasok/index.html' },

];

const TM_HIGHLIGHTER = String.raw`// ==UserScript==
// @name         Job Keyword Highlighter (yellow, HU+IT)
// @namespace    hu.job.highlight
// @version      1.1.0
// @description  Highlight keywords in yellow on selected job sites
// @author       you
// @run-at       document-end
// @grant        none
// @noframes     true

// @match https://*.melodiak.hu/*
// @match https://*.minddiak.hu/*
// @match https://*.muisz.hu/*
// @match https://*.cvcentrum.hu/*
// @match https://*.zyntern.com/*
// @match https://*.profession.hu/*
// @match https://*.furgediak.hu/*
// @match https://*.schonherz.hu/*
// @match https://*.pannondiak.hu/*
// @match https://*.frissdiplomas.hu/*
// @match https://*.prodiak.hu/*
// @match https://*.qdiak.hu/*
// @match https://*.linkedin.com/*  

// @match https://karrier.ih.gov.hu/*
// @match https://*.nixstech.com/*
// @match https://*.otpbank.hu/*
// @match https://hungarycareer.tcsapps.com/*
// @match https://jobs.avl.com/*
// @match https://*.molgroup.taleo.net/*
// @match https://*.taboola.com/*
// @match https://jobs.siemens.com/*
// @match https://*.mediso.com/*
// @match https://jobs.thyssenkrupp.com/*
// @match https://jobs.continental.com/*
// @match https://karrier.kh.hu/*
// @match https://piller.karrierportal.hu/*
// ==/UserScript==

(() => {
  'use strict';

  // Edit this list if you want more words
  const KEYWORDS = ["gyakornok", "intern", "IT"];

  // Build a case-insensitive regex for the words (no lookbehind: max compatibility)
  const esc = s => s.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
  const RE = new RegExp(KEYWORDS.map(esc).join("|"), "gi");

  // "Word" test that covers Latin + accents (Hungarian-friendly)
  const WORD_CHAR = /[A-Za-z0-9_\u00C0-\u024F\u1E00-\u1EFF]/; // Latin-1 + Extended + Accents
  const isWordChar = ch => !!ch && WORD_CHAR.test(ch);

  // Don’t touch inside these tags
  const SKIP = new Set(["SCRIPT","STYLE","NOSCRIPT","IFRAME","INPUT","TEXTAREA","CODE","PRE","SVG","MATH"]);

  function highlightIn(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (t) => {
        if (!t.nodeValue || !t.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = t.parentElement;
        if (!p || SKIP.has(p.tagName) || p.isContentEditable) return NodeFilter.FILTER_REJECT;
        // Avoid double-processing (if already wrapped)
        if (p.closest && p.closest('.tm-hi-span')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    for (const textNode of nodes) {
      const text = textNode.nodeValue;
      RE.lastIndex = 0;
      let m, last = 0, changed = false;
      const frag = document.createDocumentFragment();

      while ((m = RE.exec(text)) !== null) {
        const i = m.index;
        const j = i + m[0].length;

        // word-boundary check without lookbehind/lookahead
        const prev = text[i - 1];
        const next = text[j];
        if (isWordChar(prev) || isWordChar(next)) continue; // inside a bigger word, skip

        if (i > last) frag.appendChild(document.createTextNode(text.slice(last, i)));

        const span = document.createElement('span');
        span.className = 'tm-hi-span';
        span.style.background = 'yellow';
        span.textContent = text.slice(i, j);
        frag.appendChild(span);

        last = j;
        changed = true;
      }

      if (!changed) continue;
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      textNode.parentNode.replaceChild(frag, textNode);
    }
  }

  // Initial pass
  highlightIn(document.body);

  // Handle dynamically added content (SPAs, infinite scroll)
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    // throttle to once per animation frame
    requestAnimationFrame(() => {
      scheduled = false;
      highlightIn(document.body);
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Debug hint
  console.info('[Job Keyword Highlighter] active on', location.hostname);
})();`;


function getDomain(u) {
  try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; }
}

export default function LinksLauncher({ autoOpen = false }) {
  const [warnModal, setWarnModal] = useState(false);

  const openAll = useCallback((links) => {
    links.forEach(({ url }) => {
      window.open(url, '_blank', 'noopener,noreferrer');
    });
  }, []);

  const handleOpenAllClick = useCallback((links) => {
    setWarnModal({ open: true, links }); // tároljuk, melyik listát nyitjuk
  }, []);

  const confirmAndOpen = useCallback(() => {
    setWarnModal({ open: false, links: [] });
    setTimeout(() => openAll(warnModal.links), 50);
  }, [openAll, warnModal]);

  useEffect(() => {
    if (autoOpen) {
      setWarnModal({ open: true, links: [...JOB_PORTALS, ...COMPANIES] });
    }
  }, [autoOpen]);

  const renderLinks = (title, links) => (
    <section className="links-launcher" aria-labelledby={`${title}-title`}>
      <header className="ll-head">
        <div>
          <h2 id={`${title}-title`}>{title}</h2>
        </div>
        <div className="ll-actions">
          <button
            className="btn-white x"
            onClick={() => handleOpenAllClick(links)}
          >
            Összes megnyitása
          </button>
        </div>
      </header>

      <ul className="link-grid">
        {links.map(({ label, url }) => (
          <li key={url} className="link-card">
            <a href={url} target="_blank" rel="noopener noreferrer" className="card-link">
              <div className="card-title">{label}</div>
              <div className="card-meta">
                <span className="dot" />
                <span>{getDomain(url)}</span>
              </div>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );

  return (
    <>
      <style>{`
        .links-launcher .link-card .card-meta .dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          display: inline-block;
          background-color: #22c55e !important;
          opacity: 1;
          filter: none;
        }
        .ll-tip {
          margin: 16px 0 24px;
          padding: 14px 16px;
          border-radius: 14px;
          background: #f8fafc;
          border: 1px solid #e5e7eb;
          font-size: 0.95rem;
          line-height: 1.5;
          color: #000;
        }

      `}</style>

      <div className="ll-tip">
        <strong>💡 Pro tipp:</strong> Tampermonkey (vagy más userscript) segítségével
        automatikusan <strong>kiemelheted</strong> a kulcsszavakat az álláshirdetésekben.
        Így gyorsabban átfutod az oldalakat. Erre alul van egy mintakód, amit anno én használtam. Ezt bemásolod a Tampermonkey-ban és kész is.
      </div>
     
      

      {renderLinks('Munka portálok', JOB_PORTALS)}
      {renderLinks('Cégek', COMPANIES)}

      <CopyCode
        code={TM_HIGHLIGHTER}
        label="Tampermonkey – Kulcsszó kiemelő script (másold be)"
      />

      {warnModal.open && (
        
        <div className="popup-blocker-overlay" role="dialog" aria-modal="true" aria-labelledby="warn-title">
          <div className="popup-blocker-box">
            <h3 id="warn-title">Felugró ablakok – tipp</h3>
            <p>
              Több lap fog megnyílni. Ha a böngésződ tiltja a felugrókat,
              engedélyezd őket ehhez az oldalhoz, majd folytasd.
            </p>
            <p className="popup-guide">
              <strong>Chrome / Edge:</strong> címsor jobb oldalán a blokkolt ikon → „Felugró ablakok és átirányítások” → Engedélyezés az oldalnál.<br />
              <strong>Firefox:</strong> sáv felül/alul → Engedélyezés.
            </p>
            <div className="popup-actions">
              <button className="btn btn-primary btn-red" onClick={confirmAndOpen}>Folytatás</button>
              <button className="btn btn-ghost" onClick={() => setWarnModal({ open: false, links: [] })}>Mégse</button>
            </div>
          </div>
     

        </div>
        
      )}
    </>
  );
}
