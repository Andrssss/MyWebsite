import React from "react";
import "./App.css";
import "./styles/others-ll.css";
import CopyCode from "./components/CopyCode";

/* --------- Bash code snippets (remember: \${...} must be escaped) --------- */
const CODE_CREATE_DISCOVER_SCRIPT = String.raw`cat > ~/discover_users.sh <<'EOF'
#!/usr/bin/env bash
# Simple scanner: only base URLs, no numbered suffixes
set -u
set -o pipefail

trap 'echo "Hiba a(z) \${BASH_SOURCE[0]} sor \${LINENO}-nél. Státusz: \$?" >&2' ERR

OUTPUT="\${HOME}/result.txt"
EXISTING="\${HOME}/existing_urls.txt"
UA="Mozilla/5.0 (Linux) Bash Script"

usernames=(
  bolle fabro1 gulbe5 hudes kilbogy kurba1 mitle palag4 ricfe szama60 torad8
  abrdo bolpe fakpe gyaki hudga kinbo kurbe3 mkiss pales6 ricja szape31 totbe31
  abrga borbo4 farbi gyelu hugal kirbe2 kvaju moami palvi6 rohfr szare40 totbo5
  adoan borfe2 fardo1 gyere4 hunni kisbe21 laccs modak panhe rosca szase totes
  adrli borfi fardo11 gyoad4 ibrha1 kisbe32 lakanjo mohma2 panis1 rotga1 szasz31 totge9
  agoan4 borge3 farga8 gyoad5 ibrya kisbe35 lakev1 molba5 papad rudta szata22 totke
  ajlzo borjo3 fedad gyoba4 iller3 kisdo14 laklaja molma15 papak salma2 szean46 totle5
  akoso budbe4 fejat gyobe9 imase kisdo26 langa1 molma17 papbe5 sanan3 szeba totma42
  alamo bujzs fejdo2 gyoda imrzs4 kisma21 lanle molna papdo13 sanan6 szederkenyi totro5
  bokda2 fabal3 guima hrehu khosa kuplo mesma pakge2 retma szama50 torad7
)

EXCLUDED_PATTERNS=(
  '</td><td><a href="gyak11/">gyak11/</a>'
  '</td><td><a href="irodalom/">irodalom/</a>'
  '</td><td><a href="kepek/">kepek/</a>'
  '</td><td><a href="PhD/">PhD/</a>'
  '</td><td><a href="vogon_vers.txt">vogon_vers.txt</a>'
  '</td><td><a href="Mona%20Lisa.txt">Mona Lisa.txt</a></td>'
  '</td><td><a href="emberek/">emberek/</a>'
  '</td><td><a href="allatok/">allatok/</a>'
  '</td><td><a href="JPN.zip">JPN.zip</a>'
  '</td><td><a href="lorem_ipsum.txt">lorem_ipsum.txt</a>'
)

command -v curl >/dev/null 2>&1 || { echo "HIBA: curl nincs telepítve." >&2; exit 1; }
touch "\${OUTPUT}" "\${EXISTING}"

declare -A SEEN=()
while IFS= read -r line; do
  [[ -n "\${line:-}" ]] && SEEN["\$line"]=1
done < "\${EXISTING}" || true

echo "Felhasználók száma: \${#usernames[@]}"
echo "Eddig látott URL-ek: \${#SEEN[@]}"
echo "Kimenet: \${OUTPUT}"
echo "-------------------------------------------"

is_relevant_html() {
  local content="\$1"
  for pat in "\${EXCLUDED_PATTERNS[@]}"; do
    if grep -Fq -- "\$pat" <<<"\$content"; then
      return 1
    fi
  done
  return 0
}

check_base_url() {
  local base="\$1"
  local tmp; tmp=\$(mktemp)
  local code
  code=\$(curl -sS -L -A "\$UA" -o "\$tmp" -w "%{http_code}" "\$base" || true)

  case "\$code" in
    200)
      if is_relevant_html "\$(cat "\$tmp")"; then
        if [[ -z "\${SEEN[\$base]+x}" ]]; then
          echo "\$base" >> "\${OUTPUT}"
          echo "\$base" >> "\${EXISTING}"
          SEEN["\$base"]=1
          rm -f "\$tmp"
          return 0
        fi
      fi
      ;;
    403) echo "  403: \$base";;
    404) echo "  404: \$base";;
    *)   echo "  HTTP \$code: \$base";;
  esac
  rm -f "\$tmp"
  return 1
}

for name in "\${usernames[@]}"; do
  base="https://users.itk.ppke.hu/~\${name}"
  if check_base_url "\$base"; then
    echo "  ✓ Érvényes és új: \$base"
  else
    echo "  × Nem releváns / már láttuk : \$base"
  fi
done

echo "KÉSZ. Összes URL a fájlban:"
wc -l < "\${OUTPUT}" | xargs echo "  darab"
EOF
chmod +x ~/discover_users.sh
~/discover_users.sh`;



const CODE_OPEN_LINKS = String.raw`#!/usr/bin/env bash
FILE="\${HOME}/result.txt"
if [[ -f "$FILE" ]]; then
  while IFS= read -r link; do
    [[ "$link" =~ ^https?:// ]] || { echo "Érvénytelen link kihagyva: $link"; continue; }
    xdg-open "$link" >/dev/null 2>&1 || echo "Nem sikerült megnyitni: $link"
    sleep 0.05
  done < "$FILE"
else
  echo "A megadott fájl nem található: $FILE"
fi
`;

const CODE_WGET1 = String.raw`#!/usr/bin/env bash
set -euo pipefail

# A LEGFELSŐ mappa (VÉGÉN perjel!)
ROOT='https://users.itk.ppke.hu/~cseda6/public_html/files/7.felev/oprendszerek/'
DEST="\${HOME}/Downloads/csedaOP"

mkdir -p "$DEST"

wget -r -np -nH --no-clobber \
  --cut-dirs=2 \
  -R "index.html*" \
  -e robots=off \
  -U "Mozilla/5.0" \
  -P "$DEST" \
  "$ROOT"

echo "KÉSZ: $DEST"
`;

const CODE_WGET2 = String.raw`// TODO 

`;

const User_pages_linux: React.FC = () => {
  return (
    <div className="others-ll">
      {/* NOTE #0 */}
      <div className="others-ll__noteWrap" aria-live="polite">
        <section className="others-ll__note" aria-labelledby="quota-note-title-L0">
          <h3 id="quota-note-title-L0">Előzetes információ</h3>
          <hr />
          <p>
            Mindenki készíthet magának user oldalt a szerveren, ahol elhelyezheti az anyagait.
            Ezek addig maradnak elérhetők, amíg aktív tanuló vagy. Emiatt sokan külső helyekre szervezik az anyagaikat.
            A következő néhány kód segíthet, hogy könnyen meg lehessen találni és lementeni őket.
          </p>
        </section>
      </div>

      {/* NOTE #1 */}
      <div className="others-ll__noteWrap" aria-live="polite">
        <section className="others-ll__note" aria-labelledby="quota-note-title-L1">
          <h3 id="quota-note-title-L1">User oldalak felfedezése (BASH)</h3>
          <hr />
          <p>
            Ez a kód nemcsak megnézi, melyik aktív, hanem le is szűri az üreseket és azokat, amelyeken nincs releváns tartalom.
            Ezeket a szűrőket te is tudod állítani a <code>$excludedPatterns</code> változóban.
          </p>

          <h4 style={{ margin: "6px 0" }}>SSH a szerverre</h4>
          <ol className="steps">
            <li>Konzolt megnyitod (cntrl + alt + t)</li>
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
            – A felfedezett usereket másold be a <code>usernames</code> változóba.<br /> 
            – Majd másold be ezt az egészet a konzolba és üss egy entert<br />
            – Az eredmény itt lesz: <code>Home\result.txt</code><br />
            – Ha később is szeretnél keresni oldalakat, akkor töröld ki a <code>result.txt</code> tartalmát…<br />
            – És akkor <code>Home\existing_urls.txt</code> -ban fogod tárolni a már megtalált oldalakat. (szünetekben szoktak megjelenni új oldalak.)
          </p>

          <CopyCode
            code={CODE_CREATE_DISCOVER_SCRIPT}
            label="User oldalak felfedezése (Bash)"
            language=""
            runnableFor="bash"
          />

          <p>Talált linkek megnyitása (Bash):</p>
          <CopyCode
            code={CODE_OPEN_LINKS}
            label="Talált linkek megnyitása (Bash)"
            language=""
            runnableFor="bash"
          />
        </section>
      </div>

      {/* NOTE #2 */}
      <div className="others-ll__noteWrap" aria-live="polite">
        <section className="others-ll__note" aria-labelledby="quota-note-title-L2">
          <h3 id="quota-note-title-L2">User oldalak tartalmának Letöltése (BASH)</h3>
          <hr />
          // Todo
        </section>
      </div>
    </div>
  );
};

export default User_pages_linux;
