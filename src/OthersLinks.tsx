import React, { useEffect, useState, useCallback } from 'react';
import './styles/others-ll.css';

const OTHERS_LINKS = [
    { label: 'hakkeltamas 🖤', url: 'https://itk.hakkeltamas.hu/' },
    { label: 'hudes ☁️', url: 'https://drive.google.com/drive/folders/1Mcsi-VZUb1PcdKfhHFXn3JHNiRei28BO' },
    { label: 'vecha ☁️', url: 'https://mega.nz/folder/kYEiST5A#tdOn3s5WDauUS1mkhUAgDQ' },
    { label: 'PPKE WIKI 🅦', url: 'https://users.itk.ppke.hu/~marri1/' },
];



function getDomain(u) {
    try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; }
}

export default function OthersLinksStyled({ autoOpen = false, onNavigateAway = () => { } }: { autoOpen?: boolean; onNavigateAway?: () => void; }) {
    const [warn, setWarn] = useState < { open: boolean; links: { url: string }[] } > ({ open: false, links: [] });
    const [moreOpen, setMoreOpen] = useState(false); // fallback modal, ha a popup-ot blokkolja a böngésző

    const openAll = useCallback((links: { url: string }[]) => {
        links.forEach(({ url }) => window.open(url, '_blank', 'noopener,noreferrer'));
    }, []);

    const askAndOpenAll = useCallback((links: { url: string }[]) => setWarn({ open: true, links }), []);

    const confirmAndOpen = useCallback(() => {
        setWarn((prev) => {
            const l = prev.links;
            setTimeout(() => openAll(l), 50);
            return { open: false, links: [] };
        });
    }, [openAll]);

    useEffect(() => {
        if (autoOpen) setWarn({ open: true, links: [...OTHERS_LINKS] });
    }, [autoOpen]);

    // --- UI helpers ---
    const Section = ({ title, links, extra }: { title: string; links: { label: string; url: string }[]; extra?: React.ReactNode }) => (
        <section className="others-ll__section" aria-labelledby={`${title}-title`}>
            <header className="others-ll__head">
                <h2 id={`${title}-title`}>{title}</h2>
                <div className="others-ll__actions">
                    <button className="others-ll__btn btn-red" onClick={() => askAndOpenAll(links)}>
                        Összes megnyitása
                    </button>
                    {extra}
                </div>
            </header>

            <ul className="others-ll__grid">
                {links.map(({ label, url }) => (
                    <li key={url} className="others-ll__card">
                        <a href={url} target="_blank" rel="noopener noreferrer" className="others-ll__cardLink">
                            <div className="others-ll__title" title={label}>{label}</div>
                            <div className="others-ll__meta">
                                <span className="others-ll__dot" />
                                <span>{getDomain(url)}</span>
                                <span className="others-ll__ext" aria-hidden>↗</span>
                            </div>
                        </a>
                    </li>
                ))}
            </ul>
        </section>
    );

    const allAdditional = Object.values(ADDITIONAL_LINKS).flat();

    return (
        <div className="others-ll">
            {/* Szigorúan scope-olt stílusok, hogy a formázás ne "folyjon szét" */}
           

            <div className="others-ll__container">
                {/* Fő szekció, felül a További linkek gombbal */}
                <Section
                    title="Alap linkek"
                    links={OTHERS_LINKS}
                    extra={
                        <button
                            className="others-ll__btn others-ll__btn--ghost"
                            onClick={() => { onNavigateAway(); setMoreOpen(true); }}
                        >
                            További linkek
                        </button>
                    }
                />
            </div>

            {/* Fallback: További linkek MODAL (ha a popup blokkolva van) */}
            {moreOpen && (
                <div className="others-ll__overlay" role="dialog" aria-modal="true" aria-labelledby="more-title" onClick={() => setMoreOpen(false)}>
                    <div className="others-ll__modal" onClick={(e) => e.stopPropagation()}>
                        <div className="others-ll__modalHead">
                            <h3 id="more-title" style={{ margin: 0 }}>További linkek</h3>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                <button className="others-ll__btn others-ll__btn--ghost" onClick={() => setMoreOpen(false)} aria-label="Bezárás">&times;</button>
                            </div>
                        </div>

                        {Object.entries(ADDITIONAL_LINKS).map(([category, links]) => (
                            <section key={category} className="others-ll__section" aria-labelledby={`sec-${category}`}>
                                <header className="others-ll__head">
                                    <h2 id={`sec-${category}`}>{category}</h2>
                                    <div className="others-ll__actions">
                                        <button className="others-ll__btn btn-red" onClick={() => askAndOpenAll(links as any)}>Összes megnyitása</button>
                                    </div>
                                </header>
                                <ul className="others-ll__grid">
                                    {(links as { label: string; url: string }[]).map(({ label, url }) => (
                                        <li key={url} className="others-ll__card">
                                            <a className="others-ll__cardLink" href={url} target="_blank" rel="noopener noreferrer">
                                                <div className="others-ll__title" title={label}>{label}</div>
                                                <div className="others-ll__meta">
                                                    <span className="others-ll__dot" />
                                                    <span>{getDomain(url)}</span>
                                                    <span className="others-ll__ext" aria-hidden>↗</span>
                                                </div>
                                            </a>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        ))}
                    </div>
                </div>
            )}

            {/* Felugró blokkoló figyelmeztetés a tömeges nyitásnál */}
            {warn.open && (
                <div className="others-ll__pbOverlay" role="dialog" aria-modal="true" aria-labelledby="warn-title">
                    <div className="others-ll__modal others-ll__pbBox">
                        <h3 id="warn-title" style={{ marginTop: 0 }}>Felugró ablakok – tipp</h3>
                        <p>Több lap fog megnyílni. Ha a böngésződ tiltja a felugrókat, engedélyezd őket ehhez az oldalhoz, majd folytasd.</p>
                        <p className="others-ll__guide">
                            <strong>Chrome / Edge:</strong> címsor jobb oldalán a blokkolt ikon → „Felugró ablakok és átirányítások” → Engedélyezés az oldalnál.<br />
                            <strong>Firefox:</strong> sáv felül/alul → Engedélyezés.
                        </p>
                        <div className="others-ll__pbActions">
                            <button className="others-ll__btn btn-red" onClick={confirmAndOpen}>Folytatás</button>
                            <button className="others-ll__btn others-ll__btn--ghost" onClick={() => setWarn({ open: false, links: [] })}>Mégse</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
