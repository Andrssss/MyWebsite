import React, { useState } from 'react';
import './SubjectInfo.css';



const subjects = [
  {
    name: 'Matematikai alapismeretek',
    difficulty: 1,
    general: 'Aki volt Emelt matekon annak ez egy vicc, aki nem volt, annak pedig egy figyelmeztetés, hogy innen minden csak egyre nehezedni fog.',
    semester: 1,
  },
  {
    name: 'Fizikai alapismeretek',
    difficulty: 1,
    general: 'Izgalmas, érdekes. De aki nem foglalkozott eddig fizikával, annak nehéz is lehet. De légy hálás mert a BME-n milliószor nehezebb ez a tárgy.',
    semester: 1,
  },
  {
    name: 'Matematikai analízis I.',
    difficulty: 10,
    general: 'Másnevén "Anál", a köznépi megnevezés jól tükrözi az érzést amit érezni fogsz a tárgy elvégzése közben. A nehézségek ott kezdődnek, hogy be kell járni előadásra és gyakorlatra. Ennek elhanyagolása legtöbb esetben bukáshoz vezet. A tárgy kulcsfontosságú, mivel majdnem minden tárgy erre a tudásra épít, az itt felszedet hiányosságok a későbbiekben is hátráltatni fognak.',
    duringSemester: 'Folyamatos figyelemre és gyakorlásra van szükség a tárgy elvégzéséhez. Nem lehet ZH-ra felkészűlni 1 nap alatt. Gyakorolni kell rá amennyit csak lehet.',
    exam: 'Ha átszenvedted magad a ZH-kon jön a következő pofon a Vizsga. Van akinek elég 3 nap felkészűlni, de az átlag embernek MINIMUM 1 hét, ha már ki vannak dolgozva a tételek. ',
    semester: 1,
  },
  {
    name: 'Lineáris algebra és diszkrét matematika I.',
    difficulty: 6,
    general: 'Ez a tárgy lényegesen kellemesebb, mint az Analízis, mivel lényegesen kisebb az anyag. A DM része könnyű, még az LA része némi otthoni utánajárást igényel. Minél több mindenről tudod, hogyan néz ki vizuálisan, annál könnyebb lesz ez a tárgy. Rengeteg jó anyag van vele kapcsolatban a neten, melegen javasolt, ha más nem a vizsga miatt',
    duringSemester: 'Némi gyakorlás, folyamatosan naprakésznek kell lenni belőle.',
    exam: 'Ha van megajánlott jegy, akkor az ajándék. Érdemes vele élni, ha nincs akkor pedig a vizsga 1 hetes kaland tud lenni.',
    semester: 1,
  },
  {
    name: 'Matematikai analízis II.',
    difficulty: 8,
    general: 'Olyan mint az első, csak mostmár tudod mire számítasz, ha ment az első, akkor ezzel se lesz bajod. És a témák meglepően érdekesek. Természetesen az itt megszerzett tudást is fogod később használni más tárgyakon.',
    exam: 'Olyan mint az első.',
    semester: 2,
  },
  {
    name: 'Lineáris algebra és diszkrét matematika II.',
    difficulty: 6,
    general: 'Olyan mint az első. Figyelni kell és amennyit csak lehet kérdezni a gyakorlatokon, hogy még közelebb kerűlj a megértéshez.',
    semester: 2,
  },
  {
    name: 'Valószínűségszámítás, matematikai statisztika',
    difficulty: 6,
    general: 'Ha középsuliban se volt a kedvenc tárgyad, akkor majd itt megszereted. Érdekesen adják elő, de a fogalmak nem maguktól értetődőek. Nem feltétlen nehéz tárgy, de könnyű rajta megcsúszni, ha nem veszed komolyan. ZH-k hasonlóak mint a felsőbb évesek.',
    duringSemester: 'Javasolt az órákra bejárni és figyelni. Mert le fogsz maradni.',
    exam: 'Ha van megajánlott jegy, akkor rá kell repűlni, mert a vizsga az nem annyira barátságos. Egyrészt tudni kell a tételeket, másrészt mély értést is feltételeznek és bele is kérdeznek, akár részletesen 1-1 fogalomba. Főleg azért fontos a megajánlott jegy, mert rettentően sok és nehéz vizsga van ebben a félévben.',
    semester:3 ,
  }, 
  {
    name: 'A digitális számítás elmélete',
    difficulty: 3,
    general: 'Teljesen barátságos tárgy. Egyszerű és könnyű anyag.',
    semester: 1,
  },
  {
    name: 'Sztochasztikus folyamatok',
    difficulty: 6,
    general: 'A híres Valszám 2. Abban különbözik, hogy itt extrán érdekes dolgokat fogtok tanulni, ha érdekes a statisztika és a jóslás. Az itt megszerzett tudás természetesen másik tárgyakon is kelleni fog. Hasonlóan nehéz, mint a Valszám.',
    exam: 'Itt is foggal-körömmel kell kaparni a megajánlott jegyért, ha van. De egyébként az elmélet nem olyan szuper nehéz, ha figyeltél és felkészűltél hétről-hétre.',
    semester: 4,
  },
  {
    name: 'A közgazdaságtan alapjai',
    difficulty: 2,
    general: 'Nekünk ez online volt, szóval nem igényelt sok munkát. De aki szereti, annak érdekes lehet, mert jó a tanár. De halottam, hogy később ez a tárgy nehézzé vált. Erről nem tudok nyilatkozni. ',
    semester: 1,
  },
  {
    name: 'Bevezetés a kereszténységbe',
    difficulty: 1,
    general: 'Ez is olyan, mint a Biblia világa. Ha az se érdekelt, akkor ez se fog. Csak legalább jól fel is bosszant, hogy minek tanultok ilyen butaságokat. Év végén volt egy ZH, ahol folyamatosan körbe járt a Tanár úr. Az volt a szerencsénk, hogy elfogadta a Tanár úr, hogy nem papoknak tanulunk és ezért gyakorlatilag mindegy mi volt a ZH-n, a kettest megadta.',
    semester: 3,
  },
  {
    name: 'A Biblia világa',
    difficulty: 1,
    general: 'Kötelező volt bejárni. Jó volt mindig hallgatni, ahogy 30-an beszélnek mögöttem. ZH abból állt, hogy be kellett küldeni egy pdf-et amiben ki lehetett választani a helyes választ. Szuper könnyen le lehetet csalni. Borzalmas tárgy. Semmi értelme. Nem vagyok bölcsész.',
    duringSemester: 'Heti előadások és beadandók.',
    exam: 'Írásbeli esszévizsga.',
    semester: 2,
  },
  {
    name: 'A Katolikus Egyház társadalmi tanítása',
    difficulty: 2,
    general: 'Három a Magyar igazság Matyikám. Egyébként ezzel a tárgyal még tudtam is rezonálni, mert ha rárakunk egy kereszténység szürőt, akkor egész jónak hangzik az ott elhangzottak. Zh és Vizsga is van, amikre azt mondták, hogy megcsinálható. Nekünk úgy alakult, hogy teljes fedésben volt 2 másik kötelező tárgyal így Tanár nő, csak azt kérte, hogy olvassuk el a könyvét és beszélgessünk vele róla. Tanár nő kedves és megértő. Amikor meséltem másoknak erről a tárgyról mindig kinevettek. Szóval ha más nem egy jó beszélgetés indító marad az élmény.',
    duringSemester: 'Kötelező bejárni...',
    semester: 5,
  },
  
  {
    name: 'Az agykutatás története',
    difficulty: 3,
    general: 'Az első órára nyilván mindenki bejár, de a végére talán maradtunk 6-an. Én érdekesnek és izgalmasnak tartottam az itt elhangzottakat. Megajánlott jegyet lehet szerezni az egyesnél jobban megírt zh-val. Ahol bármilyen segítséget lehet használni, közös megegyezés alapján. ',
    duringSemester: 'Nem fontos bejárni.',
    semester: 3,
  },
  {
    name: 'Multidiszciplináris kitekintés I.',
    difficulty: 1,
    general: 'Izgalmas volt. Ide se jártunk be sokan. De őszíntén bántam volna, ha néha nem megyek be. Nekünk úgy nézett ki, hogy minden héten előadókat hívott be teljesen másik területről (volt műholdakkal foglalkozó kutató, utána rögtön egy zongorista művész) és a tárgy végén egy esszét kellett írni a három legjobbról. Szuper fun.',
    duringSemester: 'Nem szükséges bejárni.',
    semester: 3,
  },
  {
    name: 'Bevezetés a programozásba I.',
    difficulty: 6,
    general: 'Na ezen a tárgyon sokan elhasalnak. Bár akinek van előélete a tárgyal kapcsolatban, annak írtó könnyű lesz, de aki tapasztalatlan, annak bele kell tenni apait-anyait. Ettől függetlenűl ez a szakma lelke. Ha ez nem tetszik, akkor rossz helyen vagy.',
    duringSemester: 'Be kell járni, foglalkozni kell vele sokat otthon.',
    exam: 'Itt találkozunk először, hogy milyen egy programozós vizsga. Lényegében az összes többi ugyan ilyen lesz. És lesz még dögivel.',
    semester: 1,
  },
  {
    name: 'Bevezetés a programozásba II.',
    difficulty: 8,
    general: 'Lényegesen nehezebb, mint az első. Mert sok olyan absztrakt fogalmat tanulunk, amiket ha nem értesz, akkor napokba kerűlhet debuggolni. CodeBlocks amúgyse segít sokat benne. Ha van lehetőség inkább javasolt a Clion használata, mert ő szól is ha nullpointer van vagy ha esetleg kihagytál egy pontos vesszőt. ',
    duringSemester: 'Csinálni kell.',
    exam: ' Egyébként, ha megcsinálod a házikat és jól, akkor a vizsga könnyű lesz, mert a háziba írt dolgokat használhatod és csak össze kell legózni belőlük.',
    semester: 2,
  },
  {
    name: 'Bevezetés a Matlab programozásba',
    difficulty: 8,
    general: 'Ez a tárgy ilyen kis aranyos távolról, de ha odamész hozzá akkor harap. Viccet félretéve, Matlab egy könnyű nyelv, az teszi nehézzé a tárgyat, hogy be kell magolni egy csomo függvényt. Gyakorolni kell sokat és nem lesz baj.',
    duringSemester: 'Erősen javasolt bejárni.',
    exam: 'Nálunk a társaság 80%-a megbukott az első vizsgán így biztosan változtattak a vizsgán. Nem tudok nyilatkozni. (Közös géptermi.)',
    semester: 2,
  },
  {
    name: 'Adatszerkezetek és algoritmusok',
    difficulty: 11,
    general: 'Ennek a tárgynak hatalma a bukási aránya, de nem véletlen. Ezzel a tudással, már eltudsz menni dolgozni, arról nem is beszélve, hogy az állásinterjún ezzel kapcsolatos kérdések nem ritkák. A legfontosabb építőkövei annak, hogy valaki jó Informatikus legyen. Elpusztít, hogy emelett a tárgy mellett szinte levegőt se kapsz. Fájni fog, nem lesz egyszerű, de megéri.',
    duringSemester: 'Ha van szabadidőd szorgalmi időszakban, akkor foglalkozz ezzel.',
    exam: 'Ha a 2 ZH-n átszenveded magad, akkor a vizsga egy pihepuha ágy, amibe csak belefekszel. Kedves a Tanár úr és könnyen átenged.',
    semester: 3,
  },
  {
    name: 'Java programozás',
    difficulty: 8,
    general: 'Ha Adatszerken túlvagy, akkor ez a tárgy már becsukott szemmel menni fog, ettől még ez nem egy egyszerű tárgy. Szó sincs róla, megvannnak a JAVA-nak is sajátosságai. Itt találkozunk a több szálon futással első kézben és "oh boy"... A nyelvnek megvannak a sajátos nehézségei, de így is lényegesen könyebb. Arra kell figyelni, hogy időben el kell kezdeni a projektet és akkor meglesz ez a tárgy is. ',
    exam: 'Géptermi. Nem egyszerű, de ha érted a többszálú futást, akkor nem lesz gond.',
    semester: 4,
  },
  {
    name: 'Adatbázis rendszerek',
    difficulty: 8,
    general: 'Nem mindenki szereti ezt a tárgyat egyenlő lelkesedéssel. Szerintem mind az oktató, mind a gyakvezem nagyon jó volt és így 10/10 ez a tárgy. De ne tévesszen meg az első pár alkalom, ez egy nehéz tárgy. A nehézség oka nem más, mint hogy sokat kell gyakorolni és sok fogalmat meg kell érteni. Egyik se triviális. De ez megint egy olyan tárgy amivel munkát lehet szerezni. Állásinterjú gyanús.',
    duringSemester: 'A beugrók nehezek voltak 2024-ban remélem azóta könnyítettek rajta. Amiatt sokan majdnem megbuktak.',
    exam: 'Szóbeli vizsga, hogy érted-e a fogalmakat. Szuper kedvesek és segítőkészek.',
    semester: 4,
  },
  {
    name: 'Digitális jelfeldolgozás',
    difficulty: 9,
    general: 'Ez se volt egy egyszerű tárgy. De nagyon hasznos. A nehézséget a fogalmak okozzák és hogy kevés anyag van hozzá. A számolós feladatok nem triviálisak, sok gyakorlást igényelnek. Az elmélet meg bár Előadás jó, mégsincs elég anyag a megértéshez. Emiatt vizsgán a leggyakoribb jegy a 2-es volt',
    duringSemester: 'Melegen javasolt bejárni, nem szabad félválról venni. Arról nem is beszélve, hogy a fogalmakra épűlnek tárgyak.',
    exam: 'Gyakorlati vizsga, jobb jegyért lehet előadóval beszélgetni.',
    semester: 4,
  },
  {
    name: 'Neural Networks',
    difficulty: 9,
    general: 'Szemet gyönyörködtető. Baromi jófejek a tanárok és jó is az anyag. De cserébe nehéz is. Az év elején ZH, utána egy python vizsga. Ha ezeken túlvagy, akkor amint meghírdetik a projektet, akkor el kell kezdeni foglalkozni vele. Sok hétbe kerűl mire megérted mi a fene is történik, hiába van mögöttem az elméleti tudás. Benne kell lenni a top-ban, hogy ne kelljen megírni az utolsó ZH-t és vizsgázni se kelljen. Ez nem kicsit teszi könyebbé az életed. Anélkűl nehéz ez a tárgy. Inkább a projekten dolgozz, minthogy a ZH-ra készűlj, mert ott majd nem lehet segítséget használni.',
    duringSemester: 'Fogalalkozni kell vele sokat. Projektet meg kell nyomni. Előadásra erősen javasolt bejárni.',
    exam: 'Nem mondják könnyűnek. Mi projektel benne voltunk hálisten a top3-ban.',
    semester: 5,
  },
  {
    name: 'Bevezetés a mérnökségbe',
    difficulty: 1,
    general: 'Nem volt nehéz. Egy előadáson voltam bent a másikat felvételről láttam, ennyi elég is volt.',
    duringSemester: 'Nem szükséges bejárni.',
    semester: 1,
  },
  {
    name: 'Információ visszakeresés elmélete és gyakorlata',
    difficulty: 3,
    general: 'Az anyag nem nehéz, de felvétel nem tartozik hozzá így ha nem jársz előadásra és nem figyelsz, akkor a HF nehéz lesz, meg a ZH is, mert a diákban direkt nincs szájbarágósan leírva és nem fogod érteni, hogy mi történik.',
    duringSemester: 'Nem szükséges bejárni, de egyrészt kötelező, másrészt nem fogsz vizsgán bután nézni a tanárnőre.',
    exam: 'Megajánlott jegyet lehet kapni bármire. Vizsgán lehet javítani. Kedves és segítőkész tanárnő.',
    semester: 5,
  },
  {
    name: 'Basics of Mobile Application Development',
    difficulty: 4,
    general: 'Szuper érdekes, szuper hasznos. Borzalmasan könnyen elvégezhető tárgy. Aki bejár órarára és KZH-kon, meg HF-ken elér sok pontot, annak a ZH szinte instant megvan, mert azok hozzáadódnak az össz pontszámhoz. De ZH se nehéz, lehet használni az előadás diáit.',
    duringSemester: 'Érdemes bejárni.',
    semester: 5,
  },
  {
    name: 'Digitális rendszerek és számítógép architektúrák',
    difficulty: 10,
    general: 'Tesség itt van 40 oldal architectúra magold be ZH-ra.. Oké minden évben kb. ugyanaz, mint az elöző évben. Oké be lehet magolni. De ezt a tárgyat senki se szereti és sokan meg is csúsznak miatta. Ettől függetlenűl könnyen tanulható, ha szeretsz magolni. Persze, ha érted, akkor az sokat segít. De nem lesz egyszerű. Komolyan kell venni és be kell magolni. Csalás eszedbe se jusson, mert nem is lesz rá lehetőséged. Megajánlott jegy lehet a 4 és 5 -ös ZH-kkal. Melegen javasolt.',
    duringSemester: 'Érdemes előre kidolgozni a ZH előtt sokkal az előfordúlható kérdéseket. Mert akkor már lehet hogy késő lesz amikor jön a ZH időszak.',
    exam: 'Nem adják ingyen. Minimális értést igényel.',
    semester: 4,
  },
  {
    name: 'Áramkörök elmélete és számítása',
    difficulty: 11,
    general: 'Ez a tárgy. Fu. A legnagyobb probléma vele, a segédanyagok hiánya. Komolyan kell venni. 2023-ban ennek a tárgynak nagyon el volt engedve a keze. 2023-ban A jegyek átlaga : 1.95  és medián :  2 Jegyek :      29db 1-es, 66db 2-es, 21db 3-a és 1db 4-es. Én nem vagyok egy okos gyerek, de itt jól láthatóan az okatás minőségével van a baj. Nem tudsz mit csinálni, gyakorolni kell sokat.  ',
    duringSemester: 'Be KELL járni, és amikor van kis időd gyakorolni kell, mert magas a bukás arány.',
    exam: 'Ha a ZH megvan, akkor a Vizsga szinte könnyű. Írásban van és olyan, mint a ZH.',
    semester: 3,
  },
  {
    name: 'Számítógépes hálózatok',
    difficulty: 6,
    general: 'Ez a tárgy fantasztikus. Sok fontos és érdekes fogalom. A gyakorlatokon vicces dolgokat fogsz megismerni. A tárgy könnyű, csak beugró van és vizsga.',
    duringSemester: 'Gyakorlatra meg kell tanulni a fogalmakat.',
    exam: 'Könnyű, csak egy laza beszélgetés, hogy az általad húzott tételben szereplő fogalmakat érted-e.',
    semester: 3,
  },
  {
    name: 'Bevezetés a méréstechnikába és jelfeldolgozásba',
    difficulty: 6,
    general: 'Fájdalom. A beugrók nehezek, mert nem tudod miből fogod írni. Jól bevált taktika, hogyha nem is tudod miről van szó, ha írsz pár mondatot a témával kapcsolatban és értelmesnek tűnik, kegyelem kettest megkaphatod rá. Nálunk a karakterszám még kötelező 10k volt, ezt sokszor úgy oldottuk meg, hogy csempésztünk a jegyzőkönyvbe oda nem illő dolgokat. Volt aki az első fejezetet bemásolta a jegyzőkönyv hasába. Volt recept és esetleg volt aki leírta bele a napját. Szerencsére rájöttek, hogy ez nem előnyös.',
    duringSemester: 'Jegyzőkönyvet meg kell csinálni minél előbb. Beugrókra felkészűlni felsőbbévesek jegyzőkönyveiből lehet.',
    semester: 2,
  },
  {
    name: 'Computer Controlled Systems',
    difficulty: 4,
    general: 'Meglepően könnyű tárgy. A rendszerek szabályozásáról, megfigyeléséről szól és stabilizálásáról. ZH 2 részből áll, elméleti és gyakorlati rész, azonos pontot érnek. Az elméleti rész-nél nem hivatalosan lehet használni segítséget. Gyakorlatoti rész korrekt. Órák jól felkészítenek. ',
    duringSemester: 'Erősen javasolt bejárni.',
    exam: 'Nálunk mindenki megajánlott jegyet kapott, aki megcsinálta a ZH-t. Hiába volt arról szó, hogy csak az 5-ös kap. Utána egy projektet kellett megcsinálni, ami max 1 nap. ',
    semester: 5,
  },
  {
    name: 'Előírt labor',
    difficulty: 6,
    general: 'Bev. a méréstec, csak már durvább matekosabb feladatok. Érdekes itt látni, hogy mire vagyunk képesek az eddig megszerzett tudásunkkal. (Ha van :D)',  
    semester: 5,
  },
  {
    name: 'Infocommunication Systems',
    difficulty: 3,
    general: 'Könnyű tárgy. Se beugró, se zh. Se nem kell bejárni. Inkább gyakorlatiasabb, elméleti anyag nagyon kicsi. ',
    duringSemester: 'Melegen javasolt. Mert különben sok idő felvenni a fonalat.',
    exam: 'Ha bejártál órákra akkor borzalmasan könnyű. Nekünk rajzolni kellett egy PN állapotterét. Majd egy PN deffinició és hogy mik a részei. Majd a végén egy SDL-t rajzolni. Ennyi. Egyszerű. ',
    semester: 5,
  },


  




  {
    name: 'Introduction to Artificial Intelligence ',

    semester: 5,
  },
  {
    name: 'Web programozás',

    semester: 6,
  },
  {
    name: 'A szoftvertechnológia alapjai',

    semester: 6,
  },
  {
    name: 'Információ- és kódelmélet',

    semester: 6,
  },
  
  {
    name: 'Programozási nyelvek és módszerek',

    semester: 6,
  },
  {
    name: 'Adatbiztonság és kriptográfia',

    semester: 6,
  },
  {
    name: 'Celluláris hullámszámítógépek',

    semester: 6,
  },
  {
    name: 'Önlab',

    semester: 6,
  },
  {
    name: 'Szoftvertechnológia és nyelvtechnológia ZV',
  
    semester: 7,
  },
  {
    name: 'Haladó C++ programozás',
 
    semester: 7,
  },
  {
    name: 'Jogi alapismeretek és szellemi tulajdon',
  
    semester: 7,
  },
  {
    name: 'Szoftvertechnológia és nyelvtechnológia ZV',
  
    semester: 7,
  },
];



const SubjectInfo = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedSemester, setSelectedSemester] = useState('all'); // Default to "all semesters"

  const handleSemesterChange = (e) => {
    setSelectedSemester(e.target.value);
  };

  const filteredSubjects = subjects.filter((subject) => {
    const matchesSearch = subject.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesSemester = selectedSemester === 'all' || subject.semester === parseInt(selectedSemester, 10);
    return matchesSearch && matchesSemester;
  });

  return (
    <div className="subject-info-container">
      <div className="search-filter-container">
        <input
          type="text"
          placeholder="Keresés tárgy neve alapján..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="search-bar"
        />
        <select
          value={selectedSemester}
          onChange={handleSemesterChange}
          className="semester-filter"
        >
          <option value="all">Összes félév</option>
          <option value="1">1. félév</option>
          <option value="2">2. félév</option>
          <option value="3">3. félév</option>
          <option value="4">4. félév</option>
          <option value="5">5. félév</option>
          <option value="6">6. félév</option>
          <option value="7">7. félév</option>
        </select>
      </div>
      {filteredSubjects.map((subject, index) => (
        <div key={index} className="subject-card">
          <div className="subject-header">
            <h3 className="subject-title">{subject.name}</h3>
            <span className="difficulty">Nehézség: {subject.difficulty}/10</span>
          </div>
          <div className="subject-semester">
            <p>Félév: {subject.semester}. félév</p>
          </div>
          <div className="subject-details">
            {subject.general && (
              <div className="section">
                <h4>Általános</h4>
                <p>{subject.general}</p>
              </div>
            )}
            {subject.duringSemester && (
              <div className="section">
                <h4>Évközben</h4>
                <p>{subject.duringSemester}</p>
              </div>
            )}
            {subject.exam && (
              <div className="section">
                <h4>Vizsga</h4>
                <p>{subject.exam}</p>
              </div>
            )}
          </div>
        </div>
      ))}
      {filteredSubjects.length === 0 && (
        <p className="no-results">Nincs találat a keresett kifejezésre.</p>
      )}
    </div>
  );
};

export default SubjectInfo;
