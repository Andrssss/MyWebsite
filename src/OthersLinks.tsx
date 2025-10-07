import React, { useEffect, useState, useCallback } from 'react';

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
            <style>{`
        .others-ll, .others-ll * { box-sizing: border-box; }
        .others-ll { position: relative; isolation: isolate;
          --ll-bg: rgba(20,20,20,0.65);
          --ll-card: rgba(255,255,255,0.06);
          --ll-card-hover: rgba(255,255,255,0.12);
          --ll-border: rgba(255,255,255,0.12);
          --ll-text: #f4f4f5;
          --ll-muted: #c9c9ce;
          --ll-shadow: 0 10px 30px rgba(0,0,0,.35);
          --ll-radius: 16px;
          --ll-blur: saturate(140%) blur(6px);

          --note-bg: #ffffff;
          --note-text: #111827;
          --note-muted: #6b7280;
          --note-border: #e5e7eb;
        }
        .others-ll__container { max-width: 1240px; margin: 0 auto; padding: 12px 16px 24px; padding-left: 120px; }
        .others-ll__section { margin: 18px 0 26px; color: var(--ll-text); background: var(--ll-bg); backdrop-filter: var(--ll-blur); border: 1px solid var(--ll-border); border-radius: var(--ll-radius); padding: 18px 18px 22px; box-shadow: var(--ll-shadow); }
        .others-ll__head{ display:flex; align-items:flex-end; justify-content:space-between; gap:12px; margin-bottom:14px; border-bottom:1px solid var(--ll-border); padding-bottom:12px; }
        .others-ll__head h2{ margin:0; font-size: clamp(20px, 2.4vw, 28px); letter-spacing:.2px; }
        .others-ll__actions{ display:flex; gap:10px; flex-wrap:wrap; }
        .others-ll__btn{ border-radius:12px; padding:10px 14px; border:1px solid var(--ll-border); background: var(--ll-card); color: var(--ll-text); cursor: pointer; display:inline-flex; align-items:center; gap:8px; }
        .others-ll__btn:hover{ background: var(--ll-card-hover); }
        .others-ll__btn:active{ background: var(--ll-card-hover); }
        .others-ll__btn--ghost{ background: transparent; }
        .btn-red{ background-color:#e53935 !important; border-color:#e53935 !important; color:#fff !important; }
        .btn-red:hover{ background-color:#c62828 !important; border-color:#c62828 !important; }
        .others-ll__grid{ list-style:none; margin:12px 0 0; padding:0; display:grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; align-items: stretch; }
        .others-ll__card{ border-radius: var(--ll-radius); overflow: clip; border: 1px solid var(--ll-border); background: linear-gradient(180deg, var(--ll-card), rgba(255,255,255,0.03)); box-shadow: var(--ll-shadow); }
        .others-ll__card:hover{ border-color: rgba(170, 59, 59, 0.71); }
        .others-ll__cardLink{ display:block; padding:14px 14px 12px; text-decoration:none; color:inherit; min-height: 96px; }
        .others-ll__title{ font-weight:600; line-height:1.2; margin-bottom:8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .others-ll__meta{ display:flex; align-items:center; gap:8px; font-size:.9rem; color: var(--ll-muted); }
        .others-ll__dot{ width:6px; height:6px; border-radius:999px; background: var(--ll-muted); opacity:.6; }
        .others-ll__ext{ margin-left:auto; opacity:.7; }

        /* NOTE (white background) */
        .others-ll__noteWrap { max-width: 1240px; margin: 0 auto 28px; padding: 0 16px; padding-left: 120px; }
        .others-ll__note {
          background: var(--note-bg);
          color: var(--note-text);
          border: 1px solid var(--note-border);
          border-radius: 14px;
          padding: 16px 18px;
          box-shadow: 0 6px 18px rgba(0,0,0,.08);
        }
        .others-ll__note h3 { margin: 0 0 8px; font-size: clamp(18px, 2vw, 22px); }
        .others-ll__note p { margin: 6px 0 10px; color: var(--note-text); line-height: 1.5; }
        .others-ll__note small { color: var(--note-muted); }
        .others-ll__note hr { border: 0; border-top: 1px solid var(--note-border); margin: 14px 0; }
        .others-ll__note .steps { margin: 0; padding-left: 18px; }
        .others-ll__note pre {
          background: #0b1020;
          color: #e5e7eb;
          border-radius: 10px;
          padding: 12px;
          overflow: auto;
          line-height: 1.4;
          border: 1px solid #111827;
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.03);
        }
        .others-ll__note code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 13px; }

        /* Fullscreen overlay that centers the modal */
        .others-ll__overlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,.45);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          z-index: 1000;
        }
        /* The modal itself */
        .others-ll__modal {
          width: min(1240px, 100%);
          max-width: 1240px;
          height: 100%;
          max-height: calc(100vh - 48px);
          overflow: auto;
          background: var(--ll-bg);
          border-radius: var(--ll-radius);
          padding: 20px;
          box-shadow: var(--ll-shadow);
        }

        /* Popup-blocker tip */
        .others-ll__pbOverlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); display:flex; align-items:center; justify-content:center; z-index: 1100; }
        .others-ll__pbBox { max-width: 680px; width: calc(100% - 32px); }
        .others-ll__pbActions { display:flex; gap:8px; margin-top:12px; }
        .others-ll__guide { color: var(--ll-text); opacity:.9; }

        @media (max-width: 520px){ .others-ll__section{ padding:5px; border-radius:14px; } }
        @media (max-width: 844px){ .others-ll__container, .others-ll__noteWrap{ padding-left:0 !important; } }
        @media (max-width: 768px) {
          .others-ll__container { padding: 8px 10px 18px; }
          .others-ll__head { flex-direction: column; align-items: stretch; gap:10px; }
          .others-ll__actions { justify-content: flex-start; }
          .others-ll__btn { width: 100%; }
          .others-ll__grid { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
          .others-ll__cardLink { min-height: 92px; }
        }
      `}</style>

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

            {/* --- ÚJ: Fehér hátterű jegyzet a komponens alatt --- */}
            <div className="others-ll__noteWrap" aria-live="polite">
                <section className="others-ll__note" aria-labelledby="quota-note-title">
                    <h3 id="quota-note-title">User oldalak felfedezése</h3>

                    <hr />

                    <h4 style={{ margin: '6px 0' }}>SSH a szerverre</h4>
                    <ol className="steps">
                        <li>CMD-t megnyitod vagy a neki megfelelő macOS alkalmazást</li>
                        <li><code>ssh bakan7@users.itk.ppke.hu</code></li>
                        <li>jelszó</li>
                        <li>yes</li>
                    </ol>
                    <p>Így már be vagy lépve a szerverre.</p>

                    <ol className="steps" start={5}>
                        <li><code>cd ..</code></li>
                        <li><code>ls</code></li>
                    </ol>
                    <p>
                        – Bárám bimm – bara bumm. Ez az összes aktív user oldal.<br />
                        – Ezeket bemásolod a következő PowerShell kódba, a <code>$rawList</code> változóba.<br />
                        – Ezután bemásolod PowerShell-be és futtatod.<br />
                        – Az eredmény itt lesz: <code>C:\Users\Public\result.txt</code><br />
                        – Ha később is szeretnél keresni oldalakat, akkor töröld ki a <code>result.txt</code> tartalmát, és akkor ide már csak azokat fogja menteni, amiket eddig még nem láttál.<br />
                        – Erre szolgál a <code>existing_urls.txt</code> — itt tárolod azokat az oldalakat, amiket már láttál, és a <code>result.txt</code> az újakat.
                    </p>

                    <pre aria-label="PowerShell script">
                        <code>{String.raw`# --- Beállítások -------------------------------------------------------------
$outputFile   = "C:\Users\Public\result.txt"
$existingFile = "C:\Users\Public\existing_urls.txt"

# A felhasználónevek listája – whitespace szerint lesz szétszedve
$rawList = @"
bolle     fabro1   gulbe5   hudes       kilbogy   kurba1   mitle     palag4   ricfe    szama60      torad8
abrdo     bolpe     fakpe    gyaki    hudga       kinbo     kurbe3   mkiss     pales6   ricja    szape31      totbe31
abrga     borbo4    farbi    gyelu    hugal       kirbe2    kvaju    moami     palvi6   rohfr    szare40      totbo5
adoan     borfe2    fardo1   gyere4   hunni       kisbe21   laccs    modak     panhe    rosca    szase        totes
adrli     borfi     fardo11  gyoad4   ibrha1      kisbe32   lakanjo  mohma2    panis1   rotga1   szasz31      totge9
agoan4    borge3    farga8   gyoad5   ibrya       kisbe35   lakev1   molba5    papad    rudta    szata22      totke
ajlzo     borjo3    fedad    gyoba4   iller3      kisdo14   laklaja  molma15   papak    salma2   szean46      totle5
akoso     budbe4    fejat    gyobe9   imase       kisdo26   langa1   molma17   papbe5   sanan3   szeba        totma42
alamo     bujzs     fejdo2   gyoda    imrzs4      kisma21   lanle    molna     papdo13  sanan6   szederkenyi  totro5
almjo     buran5    fejma1   gyuma1   incde       kisre8    lanpe6   molzs11   papdo8   sanes2   szeel        totro6
alna      chasu     fekad    haire    inczs1      kisro4    lanzs2   mondo1    papkr7   sardo4   szeem4       totta21
alpdo     cosda     fekis1   hajan8   indba       kissa5    lasba4   morak     paple    sasdo1   szees11      totve7
andko     csado7    felno    hajcs9   ivan        kista8    laskr1   morba     pappe5   sass     szega12      tulda1
andma3    csagy1    fenan    hajda2   jakma3      kisvi22   lazlo    mozbo     pasba2   schan20  szege7       turka
apaad     csama20   ferbo    hajki1   jamer1      klazs     lazta3   mozga     pasbo1   schka7   szeis5       tuzcs
araba4    csazs23   ferkr    hajli5   jarda1      klema1    ledba    mpasztor  pasda2   schla3   szeis6       ujhda2
arkab     csebo4    ferma10  hajta2   jasad       kocba     leecs    mulba     pasja    schle2   szeka9       ujvat
arkbo     cseda6    flugi    hakta    jenma1      kocba3    lehcs    nadak     patka5   sedda    szezo10      uveba1
bakan7    csekr9    fodag3   halle1   jog_torol   kocdo8    lenab    nadpe1    pauad1   semla    szido5       vagle
balda20   cserey    fodba    halma2   jog_vissza  kocdo8    lenba8   nagad2    paube1   shosu    szikl1       vagmi
bales13   csiel     fodpe1   halpe1   juhbe8      kolcs     lenba8   nagat12   pavba    sikba    szivi10      vago
balga9    csivi10   forba1   halzo    juhga7      kolka11   lesbo    nagbe24   perbo    sikba3   szivi4       vajle
balhu     csobo3    forna    hamja    juhge4      kolmi     levke    nagbo17   peri     sikbo    szivi9       vajmo
balma14   csoza1    freen    hamjo    juhja       kolumban  linma2   nagda9    perpa4   simal2   szizs24      valle1
balma26   csuba     frema1   hamko    juhju2      komja     lorma2   nagdo32   pesbe1   siman8   szkma        varbe35
balzs32   czesz     fulan3   harni1   juhka1      konan8    lovbu    nagga17   pesta    simba8   szmze        varhe3
banor2    cziar     fulma1   harzi    juhki1      konbo2    ls-lah   nagge18   petma12  skulo    szoda2       varle10
barad6    cziat1    furja1   hasfe    jusma       konso1    luddo1   nagha1    petsz5   solpe3   szodo3       varro2
barad7    daulo     fuzzs1   hatja    kadanfe     korta6    lukan10  nagli16   pinat    solpe4   szoka3       varso
baran25   davag     gacbo    hatlo1   kadso       kovak1    madak1   nagni16   pinha    somda1   szoma6       vasbo2
barbe29   debdo     galdo5   hazba2   kalba5      kovan61   majno2   nagyi     pocta    sonak1   szues4       vasma6
barbe30   demdo2    galge8   hazve    kalgr       kovan65   makak2   nasma1    pokla    sooan1   szuhaj       vegak
barre12   demtar    garbo1   hegad3   kalzs5      kovar3    maran33  naszy     pokma    soono    szukr7       verba5
barsz3    dobko     garlu2   hegfe2   kali        kovba18   marba    navbe1    polak    stali    szumi3       vilan
bartfai   dolja     gaszo    heihe    kalma7      kovbo13   marri1   navke     polal3   stema2   szure2       vilzs2
basbe     draba     gecbe    helri    kalre1      kovdo23   marva    nemaf     polpe    stuat    tabcs        virkr1
belbo1    drada1    gedga    herkr1   kalzs5      kovdo28   marzs8   nembe14   ponle    stuhe    tahkr        vitan1
benbe5    dreim     gelge1   herpe3   kami        kovem6    matli3   nemda2    posma1   sulan    takacsgy     vokge
benbo6    droba     gelkr    herri1   kanes       kovlo     matma15  nemda3    pozla1   sumvi    takacsgy_    wagzi
benle1    dudda     geran14  hodka1   kapzs2      kovma26   matma17  nemfl4    prabo    surev    takbo2       webar
benpa1    duddo1    gerba2   hor      karacs      kovmi9    maule    nemke     priba1   susma    takev2       wedkr
benzo     durma1    gerbe1   horad17  karve4      kovpe22   megdo    nemse     prida2   szaag1   takma9       wirda
beral1    dzses     gerdo    horan    karvi8      kovri7    menma1   nerdo     racno1   szaaj    takno9       yanzigy
berbo5    educatio  gerdo12  horan3   karvi8      kovta9    mesdo    nicak     racvi7   szaba30  tarcs        zahan2
berces    egecs     gerhu    horba13  kasmi       kovzo14   mesge3   novat     radzi1   szabi5   tegan        zamsz
berda7    ekacs     germa9   horba15  kasse       kozda1    mesma15  obeja     rakle    szabo15  thogl        zatti
berjo2    eleat     godga    horbe    kasza       kozla2    mesma17  odobo     rec      szacs18  thorday      zencs
besti     endta1    godma    horda23  katpe       kozma1    metma1   olaba     recfe    szada20  tihanyia     zenzo
bires3    engan     gogpe1   hordo20  kecga1      kozma1    mezan3   olage4    regan2   szaeo    TMP          zsagi
b_novak   erdar2    gombo1   horge15  kekkr       kraba3    mezan3   orbbu     regiszo  szage11  tocbo        zseta
bocka2    erdja1    gralaba  horhu    keobe       kriba1    mikba1   orbma1    renma1   szale8   tolma1       zsuol
bodba6    erdro2    grivi    horka23  kerma7      krida1    mikma2   orbsa2    repat    szale8   tolma1       zsuol
bodba8    erodo     groen    horre18  kerma8      kulda1    mikmi    ottla     retge1   szama36  tomla2
bokda2    fabal3    guima    hrehu    khosa       kuplo     mesma    pakge2    retma    szama50  torad7
"@


# --- Inicializálás -----------------------------------------------------------
$usernames = ($rawList -split '\s+') |
  Where-Object { $_ -and $_.Trim() -ne '' } |
  ForEach-Object { $_.Trim() } |
  Sort-Object -Unique

if (-not (Test-Path $outputFile))  { New-Item -ItemType File -Path $outputFile -Force | Out-Null }
if (-not (Test-Path $existingFile)) { New-Item -ItemType File -Path $existingFile -Force | Out-Null }

[string[]]$existingUrls = if (Test-Path $existingFile) { Get-Content $existingFile } else { @() }
$existingSet = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$null = $existingUrls | ForEach-Object { $existingSet.Add($_) | Out-Null }

$notFoundContent = @"
<html><head><title>404 Not Found</title></head><body><h1>Not Found</h1><p>The requested URL was not found on this server.</p><hr><address>Apache/2.4.56 (Debian) Server at users.itk.ppke.hu Port 443</address></body></html>
"@
$forbiddenContent = @"
<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">
<html><head><title>403 Forbidden</title></head><body><h1>Forbidden</h1><p>You don't have permission to access this resource.</p><hr><address>Apache/2.4.56 (Debian) Server at users.itk.ppke.hu Port 443</address></body></html>
"@

$excludedPatterns = @(
  '</td><td><a href="gyak11/">gyak11/</a>',
  '</td><td><a href="irodalom/">irodalom/</a>',
  '</td><td><a href="kepek/">kepek/</a>',
  '</td><td><a href="PhD/">PhD/</a>',
  '</td><td><a href="vogon_vers.txt">vogon_vers.txt</a>',
  '</td><td><a href="Mona%20Lisa.txt">Mona Lisa.txt</a></td>',
  '</td><td><a href="emberek/">emberek/</a>',
  '</td><td><a href="allatok/">allatok/</a>',
  '</td><td><a href="JPN.zip">JPN.zip</a>',
  '</td><td><a href="lorem_ipsum.txt">lorem_ipsum.txt</a>'
)

$headers = @{ 'User-Agent' = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PowerShell Script' }

# --- Feldolgozás -------------------------------------------------------------
$maxNumberSuffix   = 40
$maxConsecutive404 = 4

Write-Host "Keresés a listán..."

foreach ($name in $usernames) {
  $baseUrl = "https://users.itk.ppke.hu/~$name"
  $shouldTestNumberedUrls = $false

  try {
    $response = Invoke-WebRequest -Uri $baseUrl -UseBasicParsing -Headers $headers -ErrorAction Stop
    $content  = $response.Content

    if ($content -ne $notFoundContent -and $content -ne $forbiddenContent) {
      $exclude = $false
      foreach ($pattern in $excludedPatterns) { if ($content -match $pattern) { $exclude = $true; break } }

      if (-not $exclude -and -not $existingSet.Contains($baseUrl)) {
        Add-Content $outputFile $baseUrl
        Add-Content $existingFile $baseUrl
        $existingSet.Add($baseUrl) | Out-Null
        Write-Host "Érvényes URL: $baseUrl"
        $shouldTestNumberedUrls = $true
      } else {
        Write-Host "Fake vagy már megvolt: $baseUrl"
      }
    }
  } catch {
    $status = $null
    if ($_.Exception.PSObject.Properties.Name -contains 'Response' -and $_.Exception.Response) {
      $status = $_.Exception.Response.StatusCode.value__
    }
    if ($status -eq 403) { $shouldTestNumberedUrls = $true }
  }

  if ($shouldTestNumberedUrls) {
    $egymasUtan404 = 0
    for ($i = 1; $i -le $maxNumberSuffix; $i++) {
      $numberedUrl = "$baseUrl$i"
      try {
        $resp = Invoke-WebRequest -Uri $numberedUrl -UseBasicParsing -Headers $headers -ErrorAction Stop
        $cnt  = $resp.Content

        if ($cnt -ne $notFoundContent -and $cnt -ne $forbiddenContent) {
          $exclude = $false
          foreach ($pattern in $excludedPatterns) { if ($cnt -match $pattern) { $exclude = $true; break } }

          if (-not $exclude -and -not $existingSet.Contains($numberedUrl)) {
            Add-Content $outputFile $numberedUrl
            Add-Content $existingFile $numberedUrl
            $existingSet.Add($numberedUrl) | Out-Null
            Write-Host "Érvényes URL: $numberedUrl"
          } else {
            Write-Host "Fake vagy már megvolt: $numberedUrl"
          }
          $egymasUtan404 = 0
        }
      } catch {
        $status = $null
        if ($_.Exception.PSObject.Properties.Name -contains 'Response' -and $_.Exception.Response) {
          $status = $_.Exception.Response.StatusCode.value__
        }
        if ($status -eq 404 -or $_.Exception.Message -like '*404*') { $egymasUtan404++ }
        elseif ($status -eq 403 -or $_.Exception.Message -like '*403*') { $egymasUtan404 = 0 }
      }

      if ($egymasUtan404 -ge $maxConsecutive404) { break }
      Start-Sleep -Seconds (0 + (Get-Random -Minimum 0 -Maximum 0.1))
    }
  }

  Start-Sleep -Seconds (0 + (Get-Random -Minimum 0 -Maximum 0.1))
}

Write-Host "Kész."`}</code>
                    </pre>

                    <p>
                        Ezután az eredményeket ezzel a kóddal lehet megnyitni :
                    </p>

                    <pre aria-label="PowerShell script">

                        <code>{String.raw`
# Fájl teljes elérési útja
$filePath = "C:\Users\Public\result.txt"

# Ellenőrizzük, hogy létezik-e a fájl
if (Test-Path -Path $filePath) {
    # Olvassuk be a fájl tartalmát
    $links = Get-Content -Path $filePath

    # Minden linket megnyitunk az alapértelmezett böngészőben
    foreach ($link in $links) {
        if ($link -match '^https?://') {
            Start-Process $link
        } else {
            Write-Host "Érvénytelen link kihagyva: $link"
        }
    }
} else {
    Write-Host "A megadott fájl nem található: $filePath"
}

                        `}</code>
                    </pre>



                </section>
            </div>



            <div className="others-ll__noteWrap" aria-live="polite">
                <section className="others-ll__note" aria-labelledby="quota-note-title">
                    <h3 id="quota-note-title">User oldalak felfedezése</h3>

                    <hr />

                  
                    <p>
                        Ha "LETÖLTÉS_1" nem működik, akkor a speckós "LETÖLTÉS_2"-vel lehet lehúzni az oldal tartalmát.
                        Csak ahoz le kell tölteni a sütiket.

                        Mindkettőben át kell állítani, h melyik weboldalról ($root) mentse el a tartalmat.
                    </p>
                    <p>LETÖLTÉS_1.txt :  </p>

                    <pre aria-label="PowerShell script">
                        <code>{String.raw`
# --- Beállítások ---
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# A LEGFELSŐ mappa (VÉGÉN perjel!)
$root = 'https://users.itk.ppke.hu/~cseda6/public_html/files/7.felev/oprendszerek/'
if (-not $root.EndsWith('/')) { $root += '/' }

# Helyi cél
$dest = "$env:USERPROFILE\Downloads\csedaOP"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$rootUri   = [Uri]$root
$destFull  = [IO.Path]::GetFullPath($dest)
$visited   = New-Object 'System.Collections.Generic.HashSet[string]'

function Get-Hrefs($html) {
  return [regex]::Matches($html, '<a\s+[^>]*href\s*=\s*"(.*?)"', 'IgnoreCase') |
         ForEach-Object { $_.Groups[1].Value }
}

function Normalize-RelPath([string]$relUrl) {
  # URL-dekód + tiltott karakterek cseréje szegmensenként
  $segs = $relUrl.Split('/') | Where-Object { $_ -ne '' } | ForEach-Object {
    $s = [System.Net.WebUtility]::UrlDecode($_)
    $s = $s -replace '[<>:"/\\|?*]', '_'     # Windows-illegális karakterek
    $s.Trim().TrimEnd('.')                   # végéről pont/space le
  }
  if ($segs.Count -eq 0) { return $null }
  return ($segs -join [IO.Path]::DirectorySeparatorChar)
}

function Ensure-Under-Dest([string]$relPath) {
  $candidate = [IO.Path]::GetFullPath((Join-Path $dest $relPath))
  # Biztonsági ellenőrzés: ne lépjen ki a célból
  if ($candidate.ToLower().StartsWith($destFull.ToLower())) { return $candidate }
  return $null
}

function Mirror-Web([Uri]$url) {
  if (-not $visited.Add($url.AbsoluteUri)) { return }

  try {
    $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -Headers @{ 'User-Agent'='Mozilla/5.0' }
  } catch {
    Write-Warning "Nem olvasható: $($url.AbsoluteUri) -> $($_.Exception.Message)"
    return
  }

  $hrefs = Get-Hrefs $resp.Content
  foreach ($href in $hrefs) {
    if (-not $href) { continue }
    if ($href -eq '../') { continue }                                   # parent
    if ($href.StartsWith('?') -or $href.StartsWith('#')) { continue }    # rendező/anchor
    if ($href -match '^/?icons/') { continue }                           # Apache ikonok

    $target = [Uri]::new($resp.BaseResponse.ResponseUri, $href)

    # Csak a ROOT alatti URL-ek jöhetnek szóba
    if (-not $rootUri.IsBaseOf($target)) { continue }
    if ($target.Query) { continue }

    $isDir = ($href.EndsWith('/') -or $target.AbsolutePath.EndsWith('/'))

    $relUrl  = $rootUri.MakeRelativeUri($target).OriginalString
    $relPath = Normalize-RelPath $relUrl
    if (-not $relPath) { continue }

    if ($isDir) {
      $localDir = Ensure-Under-Dest $relPath
      if ($localDir) { if (!(Test-Path $localDir)) { New-Item -ItemType Directory -Force -Path $localDir | Out-Null } }
      Mirror-Web $target
      continue
    }

    $outFile = Ensure-Under-Dest $relPath
    if (-not $outFile) { continue }
    $outDir = Split-Path $outFile -Parent
    if (!(Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

    try {
      Invoke-WebRequest -Uri $target.AbsoluteUri -UseBasicParsing -OutFile $outFile -ErrorAction Stop
      Write-Host "Letöltve: $relPath"
    } catch {
      Write-Warning "HIBA: $relPath -> $($_.Exception.Message)"
    }
  }
}

Mirror-Web $rootUri
Write-Host "KÉSZ: $dest"
                        `}</code>
                    </pre>



                    <p>
                         LETÖLTÉS_2.txt :
                    </p>

                    <pre aria-label="PowerShell script">
                        <code>{String.raw`
wget.exe -r -np -nH --cut-dirs=2 -R "index.html*" --reject-regex "[?](C|O)=" -e robots=off -U "Mozilla/5.0" --load-cookies 
"$env:USERPROFILE\Downloads\cookies.txt" -P "$env:USERPROFILE\Downloads\retge1_ai" "https://users.itk.ppke.hu/~retge1/6.felev.html/ai/"
                        `}</code>
                    </pre>

                </section>
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
