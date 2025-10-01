import React, { useState } from 'react';
import './SubjectInfo.css';



const subjects = [
  {
    name: 'Általános információ',
    difficulty: 0,
    general: 'Sajnos a backend elpusztult és vele együtt a vélemények is. Így csak a saját véleményemel tudok szolgálni...',
    semester: 0,
  },
  {
    name: 'Matematikai alapismeretek',
    difficulty: 6,
    usefulness: 1,
    general: 'Nem feltétlen könnyű...',
    semester: 1,
  },
  {
    name: 'Fizikai alapismeretek',
    difficulty: 1,
    usefulness: 0,
    general: 'Izgalmas, érdekes. De aki nem foglalkozott eddig fizikával, annak nehéz is lehet.',
    semester: 1,
  },
  {
    name: 'Matematikai analízis I. - 2022',
      difficulty: 10,
      usefulness: 1,
    general: 'Másnevén "Anál", a köznépi megnevezés jól tükrözi az érzést amit érezni fogsz a tárgy elvégzése közben. A nehézségek ott kezdődnek, hogy be kell járni előadásra és gyakorlatra. Ennek elhanyagolása legtöbb esetben bukáshoz vezet. A tárgy kulcsfontosságú, mivel rengeteg tárgy erre a tudásra épít, az itt felszedet hiányosságok a későbbiekben is hátráltatni fognak.',
    duringSemester: 'Folyamatos figyelemre és gyakorlásra van szükség a tárgy elvégzéséhez. Nem lehet ZH-ra felkészűlni 1 nap alatt. Gyakorolni kell rá amennyit csak lehet.',
    exam: 'Szóbeli, tételeket tudni kell és arra is rákérdez, hogy érted-e. Van akinek elég 3 nap felkészűlni, de az átlag embernek MINIMUM 1 hét, ha már ki vannak dolgozva a tételek.  ',
    semester: 1,
  },
  {
    name: 'Lineáris algebra és diszkrét matematika I. -2022',
      difficulty: 6,
      usefulness: 1,
    general: 'Ez a tárgy lényegesen kellemesebb, mint az Analízis, mivel szignifikánsan kisebb az anyag. A DM része könnyű, még az LA része némi otthoni utánajárást igényel. Minél több mindenről tudod, hogyan néz ki vizuálisan, annál könnyebb lesz ez a tárgy. Rengeteg jó anyag van vele kapcsolatban a neten, melegen javasolt, ha más nem a vizsga miatt',
    duringSemester: 'Némi gyakorlást igényel. Érdemes bejárni órákra.',
    exam: 'Ha van megajánlott jegy, akkor az ajándék. Érdemes vele élni, ha nincs akkor pedig olyan, mint Analízis.',
    semester: 1,
  },
  {
    name: 'Matematikai analízis II. - 2023',
      difficulty: 8,
      usefulness: 1,
    general: 'Olyan mint az első, csak mostmár tudod mire számítasz. És a témák meglepően érdekesek. Természetesen az itt megszerzett tudást is fogod később használni más tárgyakon. ',
    duringSemester: 'Melegen javasolt bejárni.',
    semester: 2,
  },
  {
    name: 'Lineáris algebra és diszkrét matematika II. - 2023',
      difficulty: 6,
      usefulness: 1,
    general: 'Olyan mint az első.',
    duringSemester: 'Melegen javasolt bejárni.',
    semester: 2,
  },
  {
    name: 'Valószínűségszámítás, matematikai statisztika - 2023',
      difficulty: 6,
      usefulness: 2,
    general: 'Ha középsuliban nem volt a kedvenc tárgyad, akkor majd itt megszereted. Mert itt érdekesen adják elő. Neve jól leírja amire számíthatsz. De a fogalmak nem triviálisak. Nem feltétlen nehéz tárgy, de könnyű rajta megcsúszni, ha nem veszed komolyan. A tárgy olyasmi struktúrájában, mint LA. ',
    duringSemester: 'Javasolt az órákra bejárni és figyelni. Mert le fogsz maradni.',
    exam: 'Ha van megajánlott jegy, akkor rá kell repűlni, mert a vizsga az nem annyira barátságos. Egyrészt tudni kell a tételeket, másrészt mély értést is feltételeznek és bele is kérdeznek, akár részletesen 1-1 fogalomba. Főleg azért fontos a megajánlott jegy, mert rettentően sok és nehéz vizsga van ebben a félévben.',
    semester:3 ,
  }, 
  {
    name: 'A digitális számítás elmélete - 2024',
      difficulty: 3,
      usefulness: 0,
    general: 'Teljesen barátságos tárgy. Egyszerű és könnyű anyag. Itt-ott kicsit épűlnek rá tárgyak, de nem szuper fontosak az itt megtanult fogalmak. Év végén volt 1db ZH, ami nem volt nehéz.',
    duringSemester:   'Érdemes lehet bejárni, mert elég sok lesz a kérdőjel, mire eljön a zh időszak.' ,
    exam: 'Nálunk annó lehetett puskázni vizsgán. De én nem éltem a lehetőséggel és így se volt nehéz. Nagyon kedven a Tanár úr és kedvesen osztályoz.',
    semester: 4,
  },
  {
    name: 'Sztochasztikus folyamatok - 2023',
      difficulty: 6,
      usefulness: 6,
    general: 'A híres Valszám 2. Abban különbözik, hogy itt komplexebb dolgokat fogtok tanulni. Olyasmiket, mint a statisztika és a jóslás. Az itt megszerzett tudás természetesen másik tárgyakon is kelleni fog. Hasonlóan nehéz, mint a Valszám. Bionikásoknak is hasznos lehet. ',
    duringSemester: 'Melegen javasolt bejárni.',
    exam: 'Itt is a megajánlott jegy nem kevés szenvedéstől tud megóvni, ha van. Vizsga olyan, mint valszámon, ha mégse lenne meg a megajánlott jegy.',
    semester: 4,
  },
  {
    name: 'A közgazdaságtan alapjai - 2021',
      difficulty: 2,
      usefulness: 0,
    general: 'Nekünk ez online volt, szóval nem igényelt sok munkát. Kidolgoztunk rá egy excel táblázatot az összes kérdéssel és válasszal és úgy a ZH ajándék volt. Aki szereti, annak érdekes lehet, mert jó a tanár. De halottam, hogy később ez a tárgy nehézzé vált. Erről nem tudok nyilatkozni. ',
    semester: 1,
  },
  {
    name: 'Bevezetés a kereszténységbe - 2021',
      difficulty: 1,
      usefulness: 0,
    general: 'Kötelező volt bejárni. Jó volt mindig hallgatni, ahogy 30-an beszélnek mögöttem. Olyan izgalmas dolgokat tudhatsz meg, hogy a kutyák miért nem kerülnek a mennybe vagy miért alsóbrendű aki nem keresztény. Szuper. ZH nekünk abból állt, hogy be kellett küldeni egy pdf-et amiben ki lehetett választani a helyes választ. Ez megegyezett az elöző évivel. ',
    semester: 1,
  },
  {
    name: 'A Biblia világa - 2022',
      difficulty: 1,
      usefulness: 0,
    general: 'Ez is olyan, mint a Bev. Ker. Év végén volt egy ZH, ahol folyamatosan körbe járt a Tanár úr. Az volt a szerencsénk, hogy elfogadta, hogy nem papoknak tanulunk és ezért gyakorlatilag mindegy mi volt a ZH-n, a kettest megadta.',
    semester: 2,
  },
  {
    name: 'A Katolikus Egyház társadalmi tanítása - 2024',
      difficulty: 2,
      usefulness: 0,
    general: 'Egyébként ezzel a tárgyal még tudtam is rezonálni, mert ha rárakunk egy kereszténység szürőt, akkor egész jónak hangzik az ott elhangzottak. Röviden arról szól, hogy milyen lenne egy olyan gazdaság ahol mindenki jól jár. Zh és Vizsga is van, amikre azt mondták, hogy megcsinálható. Nekünk úgy alakult, hogy teljes fedésben volt 2 másik kötelező tárgyal így Tanár nő, csak azt kérte, hogy olvassuk el a könyvét és beszélgessünk vele róla. Amikor meséltem másoknak erről a tárgyról, akkor mindig nevettünk egy jót. Szóval ha más nem egy jó beszélgetés indító marad az élmény.',
    duringSemester: 'Kötelező bejárni...',
    exam: 'Azt mesélték, hogy "tip-mix"-el egy 2-est meglehet szerezni vizsgán.',
    semester: 5,
  },
  
  {
    name: 'Az agykutatás története - 2023',
      difficulty: 3,
      usefulness: 0,
    general: 'Én érdekesnek és izgalmasnak tartottam az itt elhangzottakat. A tárgy neve jól leírja miről szól. Megajánlott jegyet lehet szerezni az egyesnél jobban megírt zh-val. Ahol bármilyen segítséget lehet használni, Tanár úr finoman utalt rá. ',
    duringSemester: 'Nem fontos bejárni.',
    semester: 3,
  },
  {
    name: 'Multidiszciplináris kitekintés I. - 2023',
      difficulty: 1,
      usefulness: 0,
    general: 'Ingyé kredit. Minden héten másik előadó. A kedvencem az volt, amikor egy előadó nem ért rá vagy aznapra nem tudott leszervezni Tanárnő senkit és ezért megnéztünk egy TV-s interjút kivetítve, hogy miért szar film a "Barbie". Az felért egy kínzással. De cserébe meg lehetnek olyan előadók akiknél tátva marad a száj.  ',
    duringSemester: 'Nem szükséges bejárni.',
    semester: 3,
  },
  {
    name: 'Bevezetés a programozásba I. - 2021',
      difficulty: 6,
      usefulness: 10,
    general: 'Na ezen a tárgyon sokan elhasalnak. Bár akinek van előélete a tárgyal kapcsolatban, annak írtó könnyű lesz, de aki tapasztalatlan, annak bele kell tenni apait-anyait. Nekünk, ha jól emlékszek volt 1 db PLANG ZH és  1 db C++ ZH. Tárgy végén géptermi vizsga. ',
    duringSemester: 'Be kell járni, foglalkozni kell vele sokat otthon.',
    exam: 'Itt találkozunk először, hogy milyen egy géptermi vizsga. Ez nem vészes, ha gyakoroltál év közben.',
    semester: 1,
  },
  {
    name: 'Bevezetés a programozásba II. - 2023',
      difficulty: 8,
      usefulness: 10,
    general: 'Lényegesen nehezebb, mint az első. Mert sok olyan absztrakt fogalmat tanulunk, amiket ha nem értesz, akkor napokba kerülhet debuggolni. CodeBlocks amúgyse segít sokat benne. Ha van lehetőség inkább javasolt a Clion használata. Nálunk volt egy nagy projekt. Játékékot kellett csinálni, azt érdemes időben elkezdeni.  ',
    duringSemester: 'Be kell járni.',
    exam: ' Egyébként, ha megcsinálod a házikat és jól, akkor a vizsga könnyű lesz, mert a háziba írt dolgokat használhatod és csak össze kell legózni belőlük.',
    semester: 2,
  },
  {
    name: 'Bevezetés a Matlab programozásba - 2023',
      difficulty: 8,
      usefulness: 1,
    general: 'Ez a tárgy ilyen kis aranyos távolról, de ha odamész hozzá akkor harap. Matlab egy könnyű nyelv, az teszi nehézzé a tárgyat, hogy be kell magolni egy csomo függvényt. Gyakorolni kell sokat és nem lesz baj.',
    duringSemester: 'Erősen javasolt bejárni.',
    exam: 'Nálunk a társaság 80%-a megbukott az első vizsgán így biztosan változtattak rajta. Nem tudok nyilatkozni. (Közös géptermi.)',
    semester: 2,
  },
  {
    name: 'Adatszerkezetek és algoritmusok - 2023',
      difficulty: 11,
      usefulness: 10,
    general: 'Ennek a tárgynak hatalmas a bukási aránya, de nem véletlen. Viszont ezzel a tudással, már eltudsz menni dolgozni, arról nem is beszélve, hogy az állásinterjún ezzel kapcsolatos kérdések nem ritkák. A legfontosabb építőkövei annak, hogy valaki jó Informatikus legyen. Fájni fog, nem lesz egyszerű, de megéri. Nekünk 2 db ZH volt és és végén egy szóbeli vizsga. ',
    duringSemester: 'Ha van szabadidőd szorgalmi időszakban, akkor foglalkozz ezzel.',
    exam: 'Ha a 2 ZH-n átszenveded magad, akkor a szóbeli vizsga már barátságos. Kedves a Tanár úr és könnyen átenged.',
    semester: 3,
  },
  {
    name: 'Java programozás - 2024',
      difficulty: 8,
      usefulness: 10,
    general: 'Ha Adatszerken túlvagy, akkor ez a tárgy már csukott szemmel menni fog. Ettől még ez nem egy egyszerű tárgy. Szó sincs róla, megvannak a JAVA-nak is sajátosságai. Arra kell figyelni, hogy időben el kell kezdeni a projektet és akkor meglesz ez a tárgy is. ZH-nál nálunk úgy nézett ki, hogy a többszálú futás köré épült. Azt évközben nagyon jól meg kell érteni. Ami kárpótolhat, hogy csak 1db ZH volt és vizsga nem. (meg projektfeladaat.)',
    semester: 4,
  },
  {
    name: 'Adatbázis rendszerek - 2024',
      difficulty: 8,
      usefulness: 10,
    general: 'Nem mindenki szereti ezt a tárgyat egyenlő lelkesedéssel. Szerintem mind az oktató, mind a gyakvezem nagyon jó volt és így 10/10 ez a tárgy. De ne tévesszen meg az első pár alkalom, ez egy nehéz tárgy. A nehézség oka nem más, mint hogy sokat kell gyakorolni és sok fogalmat meg kell érteni. De ez megint egy olyan tárgy amivel munkát lehet szerezni. A röpZH-k nekünk nehezek voltak remélem azóta könnyítettek rajta. Amiatt sokan majdnem megbuktak. A Szuper-RZH, mert az egyenesen halál. (3 rzh egyben ?!). De így cserébe nem volt ZH.',
    duringSemester: 'A beugrókra kell figyelni. Csinálni kell heti rendszerességgel a házikat. ',
    exam: 'Szóbeli vizsga, hogy érted-e a fogalmakat. Szuper kedvesek és segítőkészek.',
    semester: 4,
  },
  {
    name: 'Digitális jelfeldolgozás - 2024',
      difficulty: 9,
      usefulness: 1,
    general: 'Ez se volt egy egyszerű tárgy. De nagyon hasznos. A számolós feladatok nem egyszerűek, sok gyakorlást igényelnek. Az elmélet meg bár az Előadás jó, mégsincs elég anyag a megértéshez. Emiatt vizsgán a leggyakoribb jegy a 2-es volt. Nekünk 4db KZH volt és 1 ZH. ZH-n olyan 70% bukott meg elsőre. De Pótzh-n átment az emberek nagyrésze. Ezt csak mint egy figyelmeztetést írom ide, hogy nem kell kétségbe esni, de komolyan kell venni.',
    duringSemester: 'Melegen javasolt bejárni, nem szabad félválról venni. Arról nem is beszélve, hogy a fogalmakra épűlnek másik tárgyak.',
    exam: 'Gyakorlati vizsga, jobb jegyért lehet előadóval beszélgetni. Olyan nehézségű, mint egy sima ZH.',
    semester: 4,
  },
  {
    name: 'Neural Networks - 2024',
      difficulty: 9,
      usefulness: 5,
    general: 'Szemet gyönyörködtető. Baromi jófejek a tanárok és jó is az anyag. De cserébe nehéz is. Nekünk három ZH volt évközben : Python, Papiros, Géptermi. Ebből az első 2 könnyű volt. Viszont a harmadikról nem hallottam szépeket, mert ugye ott nem lehet használni segítséget és egy neurális hálót kell építeni a 0-ról. Ezt az utolsót és a vizsgát lehet "skip"-pelni a projekttel, ha benne vagy a top valamennyi százalékban. Ezért melegen javasolt elkezdeni foglalkozni, mert akkor simán kaphatsz megajánlott jegyet. Sok hétbe telik mire megérted mi a fene is történik, hiába van mögöttem az elméleti tudás. A projektet egy erős gépen érdemes futtatni, aminek jó a videókártyája, mert különben a többiekhez képest hátrányba fogsz kerülni.',
    duringSemester: 'Fogalalkozni kell vele sokat. Projektet meg kell nyomni. Előadásra erősen javasolt bejárni.',
    exam: 'Nem mondják könnyűnek. Mi projekttel benne voltunk hálisten a top 3-ban.',
    semester: 5,
  },
  {
    name: 'Bevezetés a mérnökségbe- 2021',
      difficulty: 1,
      usefulness: 0,
    general: 'Ingyen kredit.',
    duringSemester: 'Nem szükséges bejárni.',
    semester: 1,
  },
  {
    name: 'Információ visszakeresés elmélete és gyakorlata - 2024',
      difficulty: 3,
      usefulness: 0,
    general: 'Alapvetően ez egy barátságos tárgy, de felvétel nem tartozik hozzá. Ezért érdmes figyelni órákon. Volt egy HF és ZH. Utóbbi nekünk online volt. Szóval gyakorlatilag ingyen kredit.',
    duringSemester: 'Nem szükséges bejárni, de egyrészt kötelező, másrészt nem fogsz vizsgán bután nézni a tanárnőre, vagy a házi bemutatás során.',
    exam: 'Megajánlott jegyet lehet kapni bármire. Vizsgán lehet javítani. Kedves és segítőkész tanárnő.',
    semester: 4,
  },
  {
    name: 'Basics of Mobile Application Development - 2024',
      difficulty: 4,
      usefulness: 7,
    general: 'Borzalmasan könnyen elvégezhető tárgy. Aki bejár órarára és KZH-kon, meg HF-ken elér sok pontot, annak a ZH szinte instant megvan. Mivel azok hozzáadódnak az össz pontszámhoz. De ZH se nehéz, lehet használni az előadás diáit. És ha figyeltél órán, akkor még könnyűek is lesznek a kifejtős feladatok.',
    duringSemester: 'Érdemes bejárni.',
    semester: 5,
  },
  {
    "name": "Digitális rendszerek és számítógép-architektúrák - 2025",
      "difficulty": 69,
      usefulness: -1,
    "general": "Be kell vallanom, nekem kétszer kellett megcsinálnom ezt a tárgyat. Ami nem meglepő az 50%-os bukási aránynál. A nehézség a heti szintű rendszeres készülés, és hogy eddig semmi értelmes anyag nem volt a neten. De ne aggódj, mi kb. 50 kérdést tettünk fel tanár úrnak, és így megszületett a 3 db csodás Whiteboard (anyagaim között). Feltöltöttem statisztikákat is az előző évekről. Izgi.",
    "duringSemester": "Érdemes előre kidolgozni a ZH előtt jóval az előforduló kérdéseket, mert akkor már lehet, hogy késő lesz, amikor jön a ZH-időszak. A másik, hogy tényleg figyelj órán, és akkor barátságos lesz.",
    "exam": "Nem adják ingyen. Függ attól is, hogy ki vizsgáztat, de elvileg nem értékelik, ha semmit sem tudsz mondani.",
    "semester": 4
  },
  {
    name: 'Áramkörök elmélete és számítása - 2023',
      difficulty: 11,
      usefulness: 0,
    general: 'Ez a tárgy. Fu. A legnagyobb probléma vele, a segédanyagok hiánya. 2023-ban ennek a tárgynak nagyon el volt engedve a keze. Ebben az évben az év végi jegyek átlaga : 1.95  és medián :  2 ..... Eredmények táblázata a file-ok között van ennél a tárgynál. Jegyek :      29db 1-es, 66db 2-es, 21db 3-a és 1db 4-es. Én nem vagyok egy okos gyerek, de itt jól láthatóan az okatás minőségével van a baj. Nem tudsz mit csinálni, gyakorolni kell sokat. 2024-ben hallottam, hogy visszahoztak a  "létrát", az elvileg még egy mód, hogy megbuktassanak. Kitartást gyerekek.',
    duringSemester: 'Be KELL járni, és amikor van kis időd gyakorolni kell, mert magas a bukás arány.',
    exam: 'Ha a ZH megvan, akkor a Vizsga szinte könnyű, hasonló a ZH-hoz.',
    semester: 3,
  },
  {
    name: 'Számítógépes hálózatok - 2023',
      difficulty: 4,
      usefulness: 8,
    general: 'Ez a tárgy fantasztikus. Sok fontos és érdekes fogalom. Neve jól leírja az itt tanultakat. A gyakorlatokon vicces dolgokat fogsz megismerni. A tárgy könnyű, csak beugró van és vizsga.',
    exam: 'Ez se nehéz, csak egy laza beszélgetés, hogy az általad húzott tételben szereplő fogalmakat érted-e. De nálunk volt megajánlott jegy, arra javasolt rárepülni.',
    semester: 3,
  },
  {
    name: 'Bevezetés a méréstechnikába és jelfeldolgozásba - 2023',
      difficulty: 6,
      usefulness: 0,
    general: 'Fájdalom. A beugrók nehezek, mert nem tudod miből fogod írni. Jól bevált taktika, hogy ha nem is tudod miről van szó, akkor ha írsz pár mondatot a témával kapcsolatban és értelmesnek tűnik, akkor a kegyelem kettest megkaphatod rá. Felsőbb évesek beugróiból lehet jól felkészűlni és jegyzőkönyveikből. Nálunk a karakterszám még kötelező 10k volt, ezt sokszor úgy oldottuk meg, hogy belecsempésztünk a jegyzőkönyvbe oda nem illő dolgokat. Volt aki az első fejezetet bemásolta a jegyzőkönyv hasába. Volt recept és esetleg volt aki leírta bele a napját. Szerencsére rájöttek, hogy ez nem előnyös.',
    duringSemester: 'Jegyzőkönyvet meg kell csinálni minél előbb. ',
    semester: 2,
  },
  {
    name: 'Computer Controlled Systems - 2024',
      difficulty: 6,
      usefulness: 0,
    general: 'Meglepően könnyű tárgy. A rendszerek szabályozásáról, megfigyeléséről szól és stabilizálásáról. 2 ZH 2 részből áll, elméleti és gyakorlati rész, azonos pontot érnek. Az elméleti rész-nél nem hivatalosan lehetett használni segítséget. Gyakorlatoti rész korrekt. Órák jól felkészítenek. Házik, projekt eddig 3 éve változatlan. ZH-kon minimálisakat válzotatnak.',
    duringSemester: 'Erősen javasolt bejárni.',
    exam: 'Nálunk mindenki megajánlott jegyet kapott, aki megcsinálta a ZH-t. (kivéve akinek mennie kellett PÓTZH-ra.) Utána egy projektet kellett megcsinálni.',
    semester: 5,
  },
  {
    name: 'Előírt labor - 2024',
      difficulty: 6,
      usefulness: 0,
    general: 'Itt fogod utoljára látni a Tihanyit, és minden órával közelebb leszel ahhoz, hogy örülj ennek az állításomnak. De a tárgy lényegében egy Bev. Méréstech. A beugróknál ugyanúgy elvoltunk veszbe, mint bev. méréstech.-nél.',  
    semester: 5,
  },
  {
    name: 'Infocommunication Systems - 2024',
      difficulty: 3,
      usefulness: 0,
    general: 'Könnyű tárgy. Se beugró, se zh. Se nem kell bejárni. Inkább gyakorlatiasabb, az elméleti rész minimális. Olyasmi, mint a Dig. szám. az anyag, csak továbbgondolva. ',
    duringSemester: 'Javasolt bejárni, mert különben sok idő felvenni a fonalat.',
    exam: 'Ha bejártál órákra akkor borzalmasan könnyű. Nekünk rajzolni kellett egy PN állapotterét. Majd egy PN deffinició és hogy mik a részei. Majd a végén egy SDL-t rajzolni. ',
    semester: 5,
  },
  {
    name: 'Játékelmélet és hálózati alkalmazásai - 2024',
      difficulty: 4,
      usefulness: 0,
    general: '1. órán megy a beetetés, hogy wow ez tök érdekes tárgy lesz. Egy csomó izgalmas dolgot fogunk tanulni, majd amikor már nem lehet leadni ezt a tárgyat, akkor derűl ki, hogy 30% érdekez dolog, 70% butaságok számolása amiknek semmi köze az elképzelésedhez. Jó azért vannak finomságok, de akkor sem erről volt szó. Ez a tárgy összességében relatív könnyű, mert év végén van egy ZH ami abból áll, hogy ezekből a számolós feladatokból van pár, meg néhány elméleti kérdés és ennyi. Ha figyeltél órán, akkor kis idő alatt begyakorolhatóak, minden évben hasonlóak a feladatok. Fent van youtube-on videó velük kapcsolatban.  ',
    duringSemester: 'Érdemes bejárni, mert év végén nem nagyon lesz idő átnézni ezt a sok butaságot. De van aki nem járt be és megcsinálta egész jóra a ZH-T. Személy függő. ',
    exam: '2-esnél jobb ZH megajánlott jegyet kap. ',
    semester: 4,
  },
  {
    name: 'A nyelvtechnológia alapjai - 2024',
      difficulty: 7,
      usefulness: 0,
    general: 'Ez megint egy olyan tárgy, hogy miért is tanulunk ilyeneket. Az elmélet még úgy elmegy. Kis nyelvtan, kis mondat elemzés, kis digitális szótárak. De a gyakorlat, az kemény. Tanár úrnak csapongó a gondolatmenete, nehéz rá sokáig figyelni. A ZH az még rosszabb, mint a gyakorlat. Fájdalmas. 2db ZH van, ezek évről-évre picit változhatnak. Irreális elvárásokkal van teli. Alapvetőleg elméleti részből áll az első része, a többi a gyakorlaton elhangzottakból lehet bármi. Nem igazán lehet itt okosat mondani, csak hogy kitartást.',
    duringSemester: 'Én azt mondanám, hogy érdemes bejárni, főleg gyakorlatra és figyelni. Mert akkor sokkal könnyebb dolgod lesz a ZH-n. ',
    exam: 'A vizsgán a gyakorlati jegyedről indulsz. Választasz egy tételt és ha az előadó úgy ítéli meg, hogy érted, akkor javíthatsz a jegyeden. Ha nem akkor meg kirugdos. :D  (persze megadva azt a jegyet, mint amit kaptál gyakorlatra.)',
    semester: 3,
  },
  {
    name: 'Introduction to Artificial Intelligence',
      difficulty: 10,
      usefulness: 3,
    general: 'Azt monják nehéz. A követelmény rendszer meg káosz. Mármint a pontszámítás katyvasz és van amit meg se osztanak vizsgáig. Meg nem is az AI-ról szól.',
    semester: 5,
  },



  {
    name: 'Web programozás',
    general: 'Azt mondják könnyű és szuper érdekes. 2025-ben nincs.',
      semester: 6,
      usefulness: 8,
  },
{
  "name": "A szoftvertechnológia alapjai - 2025",
  "general": "Igazából ilyen töltelék tárgy. Találj ki egy csapattal egy weblapötletet, és annak a menedzselésén fogtok végigmenni. Év végén egy nyíltlapos ZH. Ha az nem sikerül, akkor pedig egy barátságos vizsga, ahol nekünk 2-es csapatokban kellett valamit kiokoskodni. Ami jó volt benne, hogy nem kellett magolni, csak érteni a dolgokat és átolvasni. Ingyen 5-ös.",
  "duringSemester": "Kedvencem az volt, amikor ZH-időszakban több tanár volt bent órán, mint diák (3–2). Ezt meglepő módon nem értékelték, utána kötelezővé tették a bejárást.",
  "difficulty": 2,
    "semester": 6,
  usefulness: 0
},
{
  "name": "Információ- és kódelmélet - 2025",
  "general": "Digjel 2. Fasza volt. Kicsit azért már könnyebb, és több anyag van hozzá.",
  "exam": "Vizsga is 1-1 ugyanolyan. Szeret szóban a megértésre rákérdezni. Mivel ez nekem nem volt meg, ezért a 3-as egy 2-esre sikerült lerontani.",
    "difficulty": 8,
    usefulness: 1,
  "semester": 6
},
{
  "name": "Programozási nyelvek és módszerek - 2025",
  "general": "Ez kemény volt. Évközben érdemes figyelgetni, és igazából csak vizsga van a végén.",
  "exam": "Nekem azért volt fájdalmas, mert 1 hét magolást igényelt. A lényeg, hogy olyan volt, mint az Adatszerk vizsga. Kis írásbeli rész, aztán szünet. Ahol utána lehet nézni a kérdéseknek, és lehet javítani az írásbelin, majd jön rá egy szóbeli rész. A probléma, hogy lehet, hogy 10 percet leszel kint, lehet, hogy 1,5 órát. Ami azt jelenti, hogy szerencsén múlik az, mennyit kell rá készülnöd előzetesen. Minél később adod be, annál valószínűbb, hogy sok időt leszel kint.",
    "difficulty": 10,
    usefulness: 10,
  "semester": 6
},
{
  "name": "Adatbiztonság és kriptográfia - 2025",
  "general": "Baromi érdekes, baromi könnyű. Nyilván figyelni kell. A gyakorlatokra be kell járni, és érdemes ott megérteni mindent jól. Mert vizsgán azt kérdi.",
    "difficulty": 7,
    usefulness: 2,
  "exam": "A vizsga számomra barátságos volt, mert igazából csak a megértést kéri számon, és kb. olyan volt, mint előző évben. Kis írásbeli rész, majd szóbeli. Ha látja, hogy jó vagy, akkor mehetsz.",
  "duringSemester": "Ami nálunk nagy szenvedés volt, az a kis ZH, mert elég szigorú annak az osztályozása. Alig lett meg az évfolyam nagy részének. A legtöbbeket a pápa halála mentett meg, mivel a gyász miatt aznap nem írtuk meg a beugrót, hisz bizonyára nem tudtunk rá tanulni a gyász miatt.",
  "semester": 6
},
{
  "name": "Celluláris hullámszámítógépek - 2025",
  "general": "Egyik legkönnyebb tárgy.",
  "duringSemester": "Első 3 órára jártam be, aztán úgy alakult, hogy nincs rá időm. Amúgy az előadások szörnyen érdekesek, csak a legtöbb ember annyira leterhelt, hogy nem jut rá idő. A gyakorlat segíthet a megértésben, ZH-hoz, de többnyire haszontalan a programozós rész.",
    "difficulty": 3,
    usefulness: 0,
  "exam": "Volt 1 ZH év közben, kb. olyan volt, mint előző évben. Pár nap tanulás elég. Vizsga nem javasolt, viszont a projektmunka szörnyen könnyű, és 4–5-öst lehet vele szerezni.",
  "semester": 6
},
{
  "name": "A nyelvtechnológia eszközei - 2025",
  "general": "Év közben mindig más előadó. A gyakorlat viszont fájdalom volt. Igazából ugyanaz, mint az első.",
  "exam": "Év végén volt vizsga, ahol elő kellett adni egy általad elolvasott cikket: hogy miről szólt és mik voltak benne.",
    "difficulty": 2,
    usefulness: 0,
  "semester": 6
},
{
  "name": "Önlab - 2025",
  "general": "Igazából a lényege, hogy kiválasztasz az itk.space-en egy szimpatikus témát, és arról kell dolgozni. Ami lényeges, hogy nagy valószínűséggel a témát viszed majd tovább, és lesz belőle szakdolgozat. Ha olyan tanárt választasz, aki nagyon elfoglalt, akkor esélyes, hogy nem fog segíteni eleget, és neked nagyon fájdalmas lesz.",
  "duringSemester": "Érdemes heti szinten haladni vele, hogy ne maradj le. Anyagokat, linkeket kezdj el gyűjteni egy mappába, mert minden forrást meg kell jelölni az írásban.",
    "difficulty": 6,
    usefulness: 6,
  "exam": "Év végére kell írni egy szakdolgozatszerű írást, és vizsgaidőszakban be kell mutatni közönség előtt, hogy mit csináltál egész félévben. Olyan kb. 20 ember előtt, abból csak 3 a bizottság, a többi a szaktársak.",
  "semester": 6
},



  {
    name: 'Haladó C++ programozás',
    usefulness: 5,
    semester: 7,
  },
  {
      name: 'Jogi alapismeretek és szellemi tulajdon',
      usefulness: 0,
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
                  <div className="subject-stats">
                      <span className="difficulty">Nehézség: {subject.difficulty}/10</span>
                      <span className="usefulness">Interjúra hasznosság: {subject.usefulness}/10</span>
                  </div>
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