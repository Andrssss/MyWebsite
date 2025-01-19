import React, { useState } from 'react';
import './SubjectInfo.css';



const subjects = [
  {
    name: 'Matematikai alapismeretek',
    difficulty: 1,
    general: 'Aki volt Emelt matekon annak nem lesz nehéz. Akinek nem volt, annak pedig egy figyelmeztetés, hogy innen minden csak egyre nehezedni fog.',
    semester: 1,
  },
  {
    name: 'Fizikai alapismeretek',
    difficulty: 1,
    general: 'Izgalmas, érdekes. De aki nem foglalkozott eddig fizikával, annak nehéz is lehet.',
    semester: 1,
  },
  {
    name: 'Matematikai analízis I. - 2022',
    difficulty: 10,
    general: 'Másnevén "Anál", a köznépi megnevezés jól tükrözi az érzést amit érezni fogsz a tárgy elvégzése közben. A nehézségek ott kezdődnek, hogy be kell járni előadásra és gyakorlatra. Ennek elhanyagolása legtöbb esetben bukáshoz vezet. A tárgy kulcsfontosságú, mivel rengeteg tárgy erre a tudásra épít, az itt felszedet hiányosságok a későbbiekben is hátráltatni fognak.',
    duringSemester: 'Folyamatos figyelemre és gyakorlásra van szükség a tárgy elvégzéséhez. Nem lehet ZH-ra felkészűlni 1 nap alatt. Gyakorolni kell rá amennyit csak lehet.',
    exam: 'Szóbeli, tételeket tudni kell és arra is rákérdez, hogy érted-e. Van akinek elég 3 nap felkészűlni, de az átlag embernek MINIMUM 1 hét, ha már ki vannak dolgozva a tételek.  ',
    semester: 1,
  },
  {
    name: 'Lineáris algebra és diszkrét matematika I. -2022',
    difficulty: 6,
    general: 'Ez a tárgy lényegesen kellemesebb, mint az Analízis, mivel szignifikánsan kisebb az anyag. A DM része könnyű, még az LA része némi otthoni utánajárást igényel. Minél több mindenről tudod, hogyan néz ki vizuálisan, annál könnyebb lesz ez a tárgy. Rengeteg jó anyag van vele kapcsolatban a neten, melegen javasolt, ha más nem a vizsga miatt',
    duringSemester: 'Némi gyakorlást igényel. Érdemes bejárni órákra.',
    exam: 'Ha van megajánlott jegy, akkor az ajándék. Érdemes vele élni, ha nincs akkor pedig olyan, mint Analízis.',
    semester: 1,
  },
  {
    name: 'Matematikai analízis II. - 2023',
    difficulty: 8,
    general: 'Olyan mint az első, csak mostmár tudod mire számítasz. És a témák meglepően érdekesek. Természetesen az itt megszerzett tudást is fogod később használni más tárgyakon. ',
    duringSemester: 'Melegen javasolt bejárni.',
    exam: 'Olyan mint az első.',
    semester: 2,
  },
  {
    name: 'Lineáris algebra és diszkrét matematika II. - 2023',
    difficulty: 6,
    general: 'Olyan mint az első.',
    duringSemester: 'Melegen javasolt bejárni.',
    semester: 2,
  },
  {
    name: 'Valószínűségszámítás, matematikai statisztika - 2023',
    difficulty: 6,
    general: 'Ha középsuliban nem volt a kedvenc tárgyad, akkor majd itt megszereted, mert itt érdekesen adják elő. Neve jól leírja amire számíthatsz. De a fogalmak nem triviálisak. Nem feltétlen nehéz tárgy, de könnyű rajta megcsúszni, ha nem veszed komolyan. A tárgy olyasmi struktúrájában, mint LA. ',
    duringSemester: 'Javasolt az órákra bejárni és figyelni. Mert le fogsz maradni.',
    exam: 'Ha van megajánlott jegy, akkor rá kell repűlni, mert a vizsga az nem annyira barátságos. Egyrészt tudni kell a tételeket, másrészt mély értést is feltételeznek és bele is kérdeznek, akár részletesen 1-1 fogalomba. Főleg azért fontos a megajánlott jegy, mert rettentően sok és nehéz vizsga van ebben a félévben.',
    semester:3 ,
  }, 
  {
    name: 'A digitális számítás elmélete - 2023',
    difficulty: 3,
    general: 'Teljesen barátságos tárgy. Egyszerű és könnyű anyag. Itt-ott kicsit épűlnek rá tárgyak, de nem szuper fontosak az itt megtanult fogalmak. Év végén volt 1db ZH, ami nem volt nehéz.',
    duringSemester:   'Érdemes lehet bejárni, mert elég sok lesz a kérdőjel, mire eljön a zh időszak.' ,
    exam: 'Nálunk annó lehetett puskázni vizsgán. De én nem éltem a lehetőséggel és így se volt nehéz. Nagyon kedven a Tanár úr és kedvesen osztályoz.',
    semester: 4,
  },
  {
    name: 'Sztochasztikus folyamatok - 2023',
    difficulty: 6,
    general: 'A híres Valszám 2. Abban különbözik, hogy itt érdekesebb dolgokat fogtok tanulni, már ha érdekes a statisztika és a jóslás. Az itt megszerzett tudás természetesen másik tárgyakon is kelleni fog, széleskörben lehet használni. Hasonlóan nehéz, mint a Valszám. Bionikásoknak is hasznos lehet. ',
    duringSemester: 'Melegen javasolt bejárni.',
    exam: 'Itt is a megajánlott jegy nem kevés szenvedéstől tud megóvni, ha van. Vizsga olyan, mint valszámon, ha mégse lenne meg a megajánlott jegy.',
    semester: 4,
  },
  {
    name: 'A közgazdaságtan alapjai - 2022',
    difficulty: 2,
    general: 'Nekünk ez online volt, szóval nem igényelt sok munkát. Kidolgoztunk rá egy excel táblázatot az összes kérdéssel és válasszal. Aki szereti, annak érdekes lehet, mert jó a tanár. De halottam, hogy később ez a tárgy nehézzé vált. Erről nem tudok nyilatkozni. ',
    semester: 1,
  },
  {
    name: 'Bevezetés a kereszténységbe - 2023',
    difficulty: 1,
    general: 'Kötelező volt bejárni. Jó volt mindig hallgatni, ahogy 30-an beszélnek mögöttem. Olyan érdekes dolgokat tudhatsz meg, hogy a kutyák miért nem kerűlnek a mennybe vagy miért alsóbrendű aki nem keresztény. Szuper. ZH nekünk abból állt, hogy be kellett küldeni egy pdf-et amiben ki lehetett választani a helyes választ. Ez megegyezett az elöző évivel. ',
    semester: 1,
  },
  {
    name: 'A Biblia világa - 2023',
    difficulty: 1,
    general: 'Ez is olyan, mint a Biblia világa. Ha az se érdekelt, akkor ez se fog. Csak legalább jól fel is bosszant, hogy minek tanultok ilyenekről megint. Év végén volt egy ZH, ahol folyamatosan körbe járt a Tanár úr. Az volt a szerencsénk, hogy elfogadta, hogy nem papoknak tanulunk és ezért gyakorlatilag mindegy mi volt a ZH-n, a kettest megadta.',
    semester: 2,
  },
  {
    name: 'A Katolikus Egyház társadalmi tanítása - 2024',
    difficulty: 2,
    general: 'Egyébként ezzel a tárgyal még tudtam is rezonálni, mert ha rárakunk egy kereszténység szürőt, akkor egész jónak hangzik az ott elhangzottak. Röviden arról szól, hogy milyen lenne egy olyan gazdaság ahol mindenki jól jár. Zh és Vizsga is van, amikre azt mondták, hogy megcsinálható. Nekünk úgy alakult, hogy teljes fedésben volt 2 másik kötelező tárgyal így Tanár nő, csak azt kérte, hogy olvassuk el a könyvét és beszélgessünk vele róla. Tanár nő kedves és megértő. Amikor meséltem másoknak erről a tárgyról mindig kinevettek. Szóval ha más nem egy jó beszélgetés indító marad az élmény.',
    duringSemester: 'Kötelező bejárni...',
    exam: 'Azt mesélték, hogy "tip-mix"-el egy 2-est meglehet szerezni vizsgán.',
    semester: 5,
  },
  
  {
    name: 'Az agykutatás története - 2023',
    difficulty: 3,
    general: 'Én érdekesnek és izgalmasnak tartottam az itt elhangzottakat. A tárgy neve jól leírja miről szól ez a tárgy. Megajánlott jegyet lehet szerezni az egyesnél jobban megírt zh-val. Ahol bármilyen segítséget lehet használni, Tanár úr finoman utalt rá. ',
    duringSemester: 'Nem fontos bejárni.',
    semester: 3,
  },
  {
    name: 'Multidiszciplináris kitekintés I. - 2023',
    difficulty: 1,
    general: 'Izgalmas volt. Ide se jártunk be sokan. De őszíntén bántam volna, ha néha nem megyek be. Nekünk úgy nézett ki, hogy minden héten előadókat hívott be teljesen másik területről (volt műholdakkal foglalkozó kutató, utána rögtön egy zongorista művész) és a tárgy végén egy esszét kellett írni a három legjobbról. Érdekes dolgokat mondtak. 1 db beadandó volt és ennyi. Ingyen kredit.',
    duringSemester: 'Nem szükséges bejárni.',
    semester: 3,
  },
  {
    name: 'Bevezetés a programozásba I. - 2022',
    difficulty: 6,
    general: 'Na ezen a tárgyon sokan elhasalnak. Bár akinek van előélete a tárgyal kapcsolatban, annak írtó könnyű lesz, de aki tapasztalatlan, annak bele kell tenni apait-anyait. Nekünk, ha jól emlékszek volt 1 db PLANG ZH és  1 db C++ ZH. Tárgy végén géptermi vizsga. ',
    duringSemester: 'Be kell járni, foglalkozni kell vele sokat otthon.',
    exam: 'Itt találkozunk először, hogy milyen egy géptermi vizsga. Ez nem vészes, ha gyakoroltál év közben.',
    semester: 1,
  },
  {
    name: 'Bevezetés a programozásba II. - 2023',
    difficulty: 8,
    general: 'Lényegesen nehezebb, mint az első. Mert sok olyan absztrakt fogalmat tanulunk, amiket ha nem értesz, akkor napokba kerűlhet debuggolni. CodeBlocks amúgyse segít sokat benne. Ha van lehetőség inkább javasolt a Clion használata. Nálunk volt egy nagy projekt, játék tervezés és minden héten házi.  ',
    duringSemester: 'Be kell járni.',
    exam: ' Egyébként, ha megcsinálod a házikat és jól, akkor a vizsga könnyű lesz, mert a háziba írt dolgokat használhatod és csak össze kell legózni belőlük.',
    semester: 2,
  },
  {
    name: 'Bevezetés a Matlab programozásba - 2023',
    difficulty: 8,
    general: 'Ez a tárgy ilyen kis aranyos távolról, de ha odamész hozzá akkor harap. Matlab egy könnyű nyelv, az teszi nehézzé a tárgyat, hogy be kell magolni egy csomo függvényt. Gyakorolni kell sokat és nem lesz baj.',
    duringSemester: 'Erősen javasolt bejárni.',
    exam: 'Nálunk a társaság 80%-a megbukott az első vizsgán így biztosan változtattak rajta. Nem tudok nyilatkozni. (Közös géptermi.)',
    semester: 2,
  },
  {
    name: 'Adatszerkezetek és algoritmusok - 2023',
    difficulty: 11,
    general: 'Ennek a tárgynak hatalma a bukási aránya, de nem véletlen. Ezzel a tudással, már eltudsz menni dolgozni, arról nem is beszélve, hogy az állásinterjún ezzel kapcsolatos kérdések nem ritkák. A legfontosabb építőkövei annak, hogy valaki jó Informatikus legyen. Fájni fog, nem lesz egyszerű, de megéri. Nekünk 2 db ZH volt és és végén egy szóbeli vizsga. ',
    duringSemester: 'Ha van szabadidőd szorgalmi időszakban, akkor foglalkozz ezzel.',
    exam: 'Ha a 2 ZH-n átszenveded magad, akkor a szóbeli vizsga már barátságos. Kedves a Tanár úr és könnyen átenged.',
    semester: 3,
  },
  {
    name: 'Java programozás - 2024',
    difficulty: 8,
    general: 'Ha Adatszerken túlvagy, akkor ez a tárgy már csukott szemmel menni fog, ettől még ez nem egy egyszerű tárgy. Szó sincs róla, megvannnak a JAVA-nak is sajátosságai. Itt találkozunk a több szálon futással első kézben és "oh boy"... Arra kell figyelni, hogy időben el kell kezdeni a projektet és akkor meglesz ez a tárgy is. ZH-nál nálunk úgy nézett ki, hogy a többszálú futás köré épült. Azt évközben nagyon jól meg kell érteni. Ami kárpótolhat, hogy csak 1db ZH volt és vizsga nem. (meg projekt feladaat.)',
    semester: 4,
  },
  {
    name: 'Adatbázis rendszerek - 2024',
    difficulty: 8,
    general: 'Nem mindenki szereti ezt a tárgyat egyenlő lelkesedéssel. Szerintem mind az oktató, mind a gyakvezem nagyon jó volt és így 10/10 ez a tárgy. De ne tévesszen meg az első pár alkalom, ez egy nehéz tárgy. A nehézség oka nem más, mint hogy sokat kell gyakorolni és sok fogalmat meg kell érteni. De ez megint egy olyan tárgy amivel munkát lehet szerezni. A röpZH-k nekünk nehezek voltak remélem azóta könnyítettek rajta. Amiatt sokan majdnem megbuktak. A Szuper-RZH meg egyenesen halál. (3 rzh egyben ?!). De így cserébe nem volt ZH.',
    duringSemester: 'A beugrókra kell figyelni. Csinálni kell heti rendszerességgel a házikat. ',
    exam: 'Szóbeli vizsga, hogy érted-e a fogalmakat. Szuper kedvesek és segítőkészek.',
    semester: 4,
  },
  {
    name: 'Digitális jelfeldolgozás - 2024',
    difficulty: 9,
    general: 'Ez se volt egy egyszerű tárgy. De nagyon hasznos. A nehézséget a fogalmak okozzák, hogy kevés anyag van hozzá. A számolós feladatok nem egyszerűek, sok gyakorlást igényelnek. Az elmélet meg bár az Előadás jó, mégsincs elég anyag a megértéshez. Emiatt vizsgán a leggyakoribb jegy a 2-es volt. Nekünk 4db KZH volt és 1 ZH. Útóbbin olyan 70% bukott meg elsőre. De Pótzh-n átment az emberek nagyrésze. Ezt csak mint egy figyelmeztetést írom ide, hogy nem kell kétségbe esni, de komolyan kell venni. Majd utána egy írásbeli vizsga.',
    duringSemester: 'Melegen javasolt bejárni, nem szabad félválról venni. Arról nem is beszélve, hogy a fogalmakra épűlnek másik tárgyak.',
    exam: 'Gyakorlati vizsga, jobb jegyért lehet előadóval beszélgetni. Olyan nehézségű, mint egy sima ZH.',
    semester: 4,
  },
  {
    name: 'Neural Networks - 2024',
    difficulty: 9,
    general: 'Szemet gyönyörködtető. Baromi jófejek a tanárok és jó is az anyag. De cserébe nehéz is. Nekünk három ZH volt évközben : Python, Papiros, Géptermi. Ebből az első 2 könnyű volt. Viszont a harmadikról nem hallottam szépeket, mert ugye ott nem lehet használni segítséget és egy neurális hálót kell építeni a 0-ról. Ezt az utolsót és a vizsgát lehet "skip"-pelni a projektel, ha benne vagy a top valamennyi százalékban. Amivel melegen javasolt elkezdeni foglalkozni, mert akkor simán kaphatsz megajánlott jegyek (nem kell megírni az utolsó zh-t se) Sok hétbe kerűl mire megérted mi a fene is történik, hiába van mögöttem az elméleti tudás. De lényegesen könyebb lesz az életed. A projektet egy erős gépen érdemes futtatni, aminek jó a videókártyája, mert különben a többiekhez képest hátrányba fogsz kerülni.',
    duringSemester: 'Fogalalkozni kell vele sokat. Projektet meg kell nyomni. Előadásra erősen javasolt bejárni.',
    exam: 'Nem mondják könnyűnek. Mi projektel benne voltunk hálisten a top3-ban.',
    semester: 5,
  },
  {
    name: 'Bevezetés a mérnökségbe- 2021',
    difficulty: 1,
    general: 'Nem volt nehéz. Egy előadáson voltam bent a másikat felvételről láttam, ennyi elég is volt.',
    duringSemester: 'Nem szükséges bejárni.',
    semester: 1,
  },
  {
    name: 'Információ visszakeresés elmélete és gyakorlata - 2024',
    difficulty: 3,
    general: 'Az anyag nem nehéz, de felvétel nem tartozik hozzá így ha nem jársz előadásra és nem figyelsz, akkor a HF nehéz tud lenni, meg a ZH is, mert a diákban direkt nincs szájbarágósan leírva és nem fogod érteni, hogy mi történik. Alapvetően ez egy barátságos tárgy. Mármint HF, az könnyű, ZH nekünk online volt. Szóval gyakorlatilag ingyen kredit.',
    duringSemester: 'Nem szükséges bejárni, de egyrészt kötelező, másrészt nem fogsz vizsgán bután nézni a tanárnőre, vagy a házi bemutatás során.',
    exam: 'Megajánlott jegyet lehet kapni bármire. Vizsgán lehet javítani. Kedves és segítőkész tanárnő.',
    semester: 4,
  },
  {
    name: 'Basics of Mobile Application Development - 2024',
    difficulty: 4,
    general: 'Szuper érdekes, szuper hasznos. Borzalmasan könnyen elvégezhető tárgy. Aki bejár órarára és KZH-kon, meg HF-ken elér sok pontot, annak a ZH szinte instant megvan, mert azok hozzáadódnak az össz pontszámhoz. De ZH se nehéz, lehet használni az előadás diáit. És ha figyeltél órán, akkor még könnyű is lesz.',
    duringSemester: 'Érdemes bejárni.',
    semester: 5,
  },
  {
    name: 'Digitális rendszerek és számítógép architektúrák - 2024',
    difficulty: 10,
    general: 'Tesség itt van 40 oldal architectúra magold be ZH-ra.. Oké minden évben kb. ugyanaz, mint az elöző évben. Oké be lehet magolni. De nem egyetemhez méltó ez az oktatási szint. Nem lesz egyszerű ez a tárgy elvégzése. Csalás eszedbe se jusson, mert nem is lesz rá lehetőséged. Megajánlott jegy lehet a 4 és 5 -ös ZH-kkal. Melegen javasolt. Ez a tárgy förtelmesen rossz . Méltó a tanfolyamokon átívelő nevére "Digszar".',
    duringSemester: 'Érdemes előre kidolgozni a ZH előtt sokkal az előfordúlható kérdéseket. Mert akkor már lehet hogy késő lesz amikor jön a ZH időszak.',
    exam: 'Nem adják ingyen. Függ attól is, hogy ki vizsgáztat, de elvileg nem értékelik, ha semmit sem tudsz mondani.',
    semester: 4,
  },
  {
    name: 'Áramkörök elmélete és számítása - 2023',
    difficulty: 11,
    general: 'Ez a tárgy. Fu. A legnagyobb probléma vele, a segédanyagok hiánya. 2023-ban ennek a tárgynak nagyon el volt engedve a keze. Ebben az évben az év végi jegyek átlaga : 1.95  és medián :  2 ..... Jegyek :      29db 1-es, 66db 2-es, 21db 3-a és 1db 4-es. Én nem vagyok egy okos gyerek, de itt jól láthatóan az okatás minőségével van a baj. Nem tudsz mit csinálni, gyakorolni kell sokat. 2024-ben hallottam, hogy visszahoztak a  "létrát", az elvileg még egy mód, hogy megbuktassanak. Kitartást gyerekek.',
    duringSemester: 'Be KELL járni, és amikor van kis időd gyakorolni kell, mert magas a bukás arány.',
    exam: 'Ha a ZH megvan, akkor a Vizsga szinte könnyű, hasonló a ZH-hoz. ',
    semester: 3,
  },
  {
    name: 'Számítógépes hálózatok - 2023',
    difficulty: 4,
    general: 'Ez a tárgy fantasztikus. Sok fontos és érdekes fogalom. Neve jól leírja az itt tanultakat. A gyakorlatokon vicces dolgokat fogsz megismerni. A tárgy könnyű, csak beugró van és vizsga.',
    exam: 'Könnyű, csak egy laza beszélgetés, hogy az általad húzott tételben szereplő fogalmakat érted-e. De nálunk volt megajánlott jegy, arra javasolt rárepülni.',
    semester: 3,
  },
  {
    name: 'Bevezetés a méréstechnikába és jelfeldolgozásba - 2023',
    difficulty: 6,
    general: 'Fájdalom. A beugrók nehezek, mert nem tudod miből fogod írni. Jól bevált taktika, hogy ha nem is tudod miről van szó, akkor ha írsz pár mondatot a témával kapcsolatban és értelmesnek tűnik, akkor a kegyelem kettest megkaphatod rá. Felsőbb évesek beugróiból lehet jól felkészűlni és jegyzőkönyveikből. Nálunk a karakterszám még kötelező 10k volt, ezt sokszor úgy oldottuk meg, hogy csempésztünk a jegyzőkönyvbe oda nem illő dolgokat. Volt aki az első fejezetet bemásolta a jegyzőkönyv hasába. Volt recept és esetleg volt aki leírta bele a napját. Szerencsére rájöttek, hogy ez nem előnyös.',
    duringSemester: 'Jegyzőkönyvet meg kell csinálni minél előbb. ',
    semester: 2,
  },
  {
    name: 'Computer Controlled Systems - 2024',
    difficulty: 6,
    general: 'Meglepően könnyű tárgy. A rendszerek szabályozásáról, megfigyeléséről szól és stabilizálásáról. Mindkettő ZH 2 részből áll, elméleti és gyakorlati rész, azonos pontot érnek. Az elméleti rész-nél nem hivatalosan lehet használni segítséget. Gyakorlatoti rész korrekt. Órák jól felkészítenek. Házik, projekt eddig 3 éve változatlan. ZH-kon minimálisakat válzotatnak.',
    duringSemester: 'Erősen javasolt bejárni.',
    exam: 'Nálunk mindenki megajánlott jegyet kapott, aki megcsinálta a ZH-t. (kivéve akinek mennie kellett PÓTZH-ra.) Hiába volt arról szó, hogy csak az 5-ös kap. Utána egy projektet kellett megcsinálni, ami max 1 nap, az egész éves tudás alapján. ',
    semester: 5,
  },
  {
    name: 'Előírt labor - 2024',
    difficulty: 6,
    general: 'Bev. méréstec, csak már durvább matekosabb feladatok. Érdekes itt látni, hogy mire vagyunk képesek az eddig megszerzett tudásunkkal. (Ha van :D) Nálunk volt egy házi is, ami arról szólt, hogy be kellett mutatni, hogy a chat-GPT miért nem jó nagyobb szövegek írására. A beugróknál ugyanúgy elvoltunk veszbe, mint bev. méréstech.-nél.',  
    semester: 5,
  },
  {
    name: 'Infocommunication Systems - 2024',
    difficulty: 3,
    general: 'Könnyű tárgy. Se beugró, se zh. Se nem kell bejárni. Inkább gyakorlatiasabb, elméleti anyag nagyon kicsi. Olyasmi, mint a Dig. szám. az anyag, csak továbbgondolva. ',
    duringSemester: 'Javasolt bejárni. Mert különben sok idő felvenni a fonalat.',
    exam: 'Ha bejártál órákra akkor borzalmasan könnyű. Nekünk rajzolni kellett egy PN állapotterét. Majd egy PN deffinició és hogy mik a részei. Majd a végén egy SDL-t rajzolni. Ennyi. Egyszerű. ',
    semester: 5,
  },
  {
    name: 'Játékelmélet és hálózati alkalmazásai - 2024',
    difficulty: 4,
    general: '1. órán megy a beetetés, hogy wow ez tök érdekes tárgy lesz. Egy csomó izgalmas dolgot fogunk tanulni, majd amikor már nem lehet leadni ezt a tárgyat, akkor derűl ki, hogy 30% érdekez dolog, 70% butaságok számolása amiknek semmi köze az elképzelésedhez. Jó azért vannak egész érdekes dolgok, de akkor sem erről volt szó. Ez a tárgy összességében relatív könnyű, mert év végén van egy ZH ami abból áll, hogy ezekből a számolós feladatokból van pár, meg néhány elméleti kérdés és ennyi. Ha figyeltél órán, akkor kis idő alatt begyakorolhatóak, minden évben hasonlóak a feladatok. Fent van youtube-on videó velük kapcsolatban.  ',
    duringSemester: 'Érdemes bejárni, mert év végén nem nagyon lesz idő átnézni ezt a sok butaságot. De van aki nem járt be és megcsinálta egész jóra a ZH-T. Személy függő. Szerintem ez egy butaság tárgy, lehetne muilliószor jobb. ',
    exam: '2-esnél jobb ZH megajánlott jegyet kap. ',
    semester: 4,
  },
  {
    name: 'A nyelvtechnológia alapjai - 2024',
    difficulty: 7,
    general: 'Ez megint egy olyan tárgy, hogy miért is tanulunk ilyeneket. Az elmélet még úgy elmegy. Kis nyelvtan, kis mondat elemzés, kis digitális szótárak. De a gyakorlat, az kemény. Olyan randomnak érződik a tananyag, kicsit mintha nem lenne struktúra. ZH-n az még rosszabb, mint a gyakorlat. Fájdalmas. 2db ZH van, ezek évről-évre picit változhatnak. Alapvetőleg elméleti részből áll az első része, a többi a gyaorlaton elhangzottakból lehet bármi. Nem igazán lehet itt okosat mondani, ez a tárgy idén borzalmas volt.',
    duringSemester: 'Én azt mondanám, hogy érdemes bejárni, főleg gyakorlatra és figyelni. Mert akkor sokkal könnyebb dolgod lesz a ZH-n. ',
    exam: 'A vizsgán a gyakorlati jegyedről indulsz. Választasz egy tételt és ha az előadó úgy ítéli meg, hogy érted, akkor javíthatsz a jegyeden. Ha nem akkor meg kirugdos. :D  (persze megadva azt a jegyet, mint amit kaptál gyakorlatra.)',
    semester: 3,
  },


  {
    name: 'Introduction to Artificial Intelligence',
    difficulty: 10,
    general: 'Azt monják nehéz. A követelmény rendszer meg káosz. Mármint a pontszámítás katyvasz és van amit meg se osztanak vizsgáig. Meg nem is az AI-ról szól.',
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
    general: 'Digjel 2. Alig várom.',
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

  // Ékezetek eltávolítása a szövegből
  const removeAccents = (str) =>
    str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  const handleSemesterChange = (e) => {
    setSelectedSemester(e.target.value);
    setSearchTerm(''); // Töröljük a keresési mezőt
  };

  const filteredSubjects = subjects.filter((subject) => {
    // Ékezetmentesítjük mind a keresett szöveget, mind a tárgy nevét
    const normalizedSearchTerm = removeAccents(searchTerm.toLowerCase());
    const normalizedSubjectName = removeAccents(subject.name.toLowerCase());

    const matchesSearch = normalizedSubjectName.includes(normalizedSearchTerm);
    const matchesSemester =
      selectedSemester === 'all' || subject.semester === parseInt(selectedSemester, 10);

    // Ha van keresési kifejezés, csak a keresési találatok jelenjenek meg.
    if (searchTerm) {
      return matchesSearch;
    }

    // Ha nincs keresési kifejezés, alkalmazzuk a félév szűrőt.
    return matchesSemester;
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
            <p>Félév: {subject.semester}. </p>
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
