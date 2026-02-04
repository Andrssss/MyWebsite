import React, { useEffect, useState, useCallback } from 'react';
import './styles/others-ll.css';

const OTHERS_LINKS = [
    { label: 'pauad1 📚', url: 'https://users.itk.ppke.hu/~pauad1/' },
    { label: 'hakkeltamas 🖤', url: 'https://itk.hakkeltamas.hu/' },
    { label: 'ekacs 🦔', url: 'https://users.itk.ppke.hu/~ekacs/anyagok/' },
    { label: 'radzi1 📚', url: 'https://users.itk.ppke.hu/~radzi1/' },
    { label: 'szege7 🧩', url: 'https://users.itk.ppke.hu/~szege7/' },
    { label: 'gyoad5 🕊️', url: 'https://users.itk.ppke.hu/~gyoad5/i_sem/index.html' },
    { label: 'retge1 🍞', url: 'https://users.itk.ppke.hu/~retge1/' },
    { label: 'szama36 📘', url: 'https://users.itk.ppke.hu/~szama36/Hasznos%20dolgok/index.html' },
    { label: 'balma14 📚', url: 'https://users.itk.ppke.hu/~balma14/' },
    { label: 'bolle 📚', url: 'https://users.itk.ppke.hu/~bolle/Minden%20-by%20Bal%c3%a1zs%20M%c3%a1ty%c3%a1s/' },
    { label: 'vagle 🌀', url: 'https://users.itk.ppke.hu/~vagle/main/segedletek' },
    { label: 'hudes ☁️', url: 'https://drive.google.com/drive/folders/1Mcsi-VZUb1PcdKfhHFXn3JHNiRei28BO' },
    { label: 'petma12 📂', url: 'https://users.itk.ppke.hu/~petma12/' },
    { label: 'csobo3 📚', url: 'https://users.itk.ppke.hu/~csobo3/' },
    { label: 'juhki1 📚', url: 'https://users.itk.ppke.hu/~juhki1/jegyzetek/' },
    { label: 'nagda9 🔵', url: 'https://users.itk.ppke.hu/~nagda9/home.php' },
    { label: 'szale8 📗', url: 'https://users.itk.ppke.hu/~szale8' },
    { label: 'heihe 🌲', url: 'https://users.itk.ppke.hu/~heihe/' },
    { label: 'morak 🛰️', url: 'https://users.itk.ppke.hu/~morak/' },
    { label: 'vecha ☁️', url: 'https://mega.nz/folder/kYEiST5A#tdOn3s5WDauUS1mkhUAgDQ' },
    { label: 'mozbo 🐈', url: 'https://users.itk.ppke.hu/~mozbo/' },
    { label: 'mozbo 🐹', url: 'https://users.itk.ppke.hu/~szivi10/' },

    { label: 'PPKE WIKI 🅦', url: 'https://users.itk.ppke.hu/~marri1/' },
];

const ADDITIONAL_LINKS = {
    'Kevesebb anyag - 2025.09': [
        { label: 'panis1 🍆', url: 'https://users.itk.ppke.hu/~panis1/' },
        { label: 'iller3', url: 'https://users.itk.ppke.hu/~iller3/' },
        { label: 'araba4', url: 'https://users.itk.ppke.hu/~araba4/' },
        { label: 'perpa4', url: 'https://users.itk.ppke.hu/~perpa4' },
        { label: 'szumi3', url: 'https://users.itk.ppke.hu/~szumi3/' },
        { label: 'nemda3', url: 'https://users.itk.ppke.hu/~nemda3/' },
        { label: 'erdar2', url: 'https://users.itk.ppke.hu/~erdar2' },
        { label: 'nemda2', url: 'https://users.itk.ppke.hu/~nemda2/' },
        { label: 'szaba30', url: 'https://users.itk.ppke.hu/~szaba30/' },
        { label: 'bocka2', url: 'https://users.itk.ppke.hu/~bocka2/' },
        { label: 'szama50', url: 'https://users.itk.ppke.hu/~szama50/' },
        { label: 'nadak', url: 'https://users.itk.ppke.hu/~nadak/#/f' },
        { label: 'fedad', url: 'https://users.itk.ppke.hu/~fedad/' },
        { label: 'kisbe32', url: 'https://users.itk.ppke.hu/~kisbe32/' },
        { label: 'misma', url: 'https://users.itk.ppke.hu/~misma/public_html_2/vsz_2020_vids.php' },
        { label: 'pocta', url: 'https://users.itk.ppke.hu/~pocta/' },
        { label: 'cseda6', url: 'https://users.itk.ppke.hu/~cseda6/public_html/files/' },
        { label: 'tarcs', url: 'https://users.itk.ppke.hu/~tarcs/' },
        { label: 'odobo', url: 'https://users.itk.ppke.hu/~odobo/' },
        { label: 'karbe8', url: 'https://users.itk.ppke.hu/~karbe8/' },
        { label: 'szama50', url: 'https://users.itk.ppke.hu/~szama50/' },
    ],
    'Folyamatban - 2025.09': [
        { label: 'varbe35', url: 'https://users.itk.ppke.hu/~varbe35/' },
        { label: 'vasbo2', url: 'https://users.itk.ppke.hu/~vasbo2' },
        { label: 'tabcs', url: 'https://users.itk.ppke.hu/~tabcs/' },
        { label: 'lazta3', url: 'https://users.itk.ppke.hu/~lazta3/' },
        { label: 'herpe3', url: 'https://users.itk.ppke.hu/~herpe3/' },
        { label: 'skulo', url: 'https://users.itk.ppke.hu/~skulo/web/index.html' },
        { label: 'kadso', url: 'https://users.itk.ppke.hu/~kadso/' },
        { label: 'orbsa2', url: 'https://users.itk.ppke.hu/~orbsa2/' },
    ],
    'GAME :': [
        { label: 'gelge1', url: 'https://users.itk.ppke.hu/~gelge1/' },
        { label: 'wagzi', url: 'https://users.itk.ppke.hu/~wagzi/G7V/' },
    ],
    'Random WTF :': [
        { label: 'juhki1', url: 'https://users.itk.ppke.hu/~juhki1/' },
        { label: 'juhga7', url: 'https://users.itk.ppke.hu/~juhga7/Jegyzetek/Honlap/galeria1.html' },
        { label: 'prabo', url: 'https://users.itk.ppke.hu/~prabo/' },
        { label: 'kovzo14', url: 'https://users.itk.ppke.hu/~kovzo14' },
        { label: 'juhbe8', url: 'https://users.itk.ppke.hu/~juhbe8/' },
        { label: 'szeem4', url: 'https://users.itk.ppke.hu/~szeem4' },
        { label: 'berbo5', url: 'https://users.itk.ppke.hu/~berbo5' },
        { label: 'kolcs', url: 'https://users.itk.ppke.hu/~kolcs' },
        { label: 'totbe31', url: 'https://users.itk.ppke.hu/~totbe31' },
        { label: 'tolma1', url: 'https://users.itk.ppke.hu/~tolma1/' },
        { label: 'fabal3', url: 'https://users.itk.ppke.hu/~fabal3/' },
        { label: 'hugal', url: 'https://users.itk.ppke.hu/~hugal/' },
        { label: 'mulkr', url: 'https://users.itk.ppke.hu/~mulkr/' },
        { label: 'sikbo', url: 'https://users.itk.ppke.hu/~sikbo/' },
        { label: 'kovri7', url: 'https://users.itk.ppke.hu/~kovri7/' },
    ],
};



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
