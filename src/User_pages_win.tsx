import React from "react";
import "./App.css";
import "./styles/others-ll.css";
import CopyCode from "./components/CopyCode";

// --- Code snippets (PowerShell) ---------------------------------------------
const PS_DISCOVER = String.raw`
# --- Beállítások ---
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# A LEGFELSŐ mappa (VÉGÉN perjel!)
$root = 'https://users.itk.ppke.hu/~cseda6/public_html/files/'
if (-not $root.EndsWith('/')) { $root += '/' }

# Helyi cél
$dest = "$env:USERPROFILE\Downloads\cseda"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$rootUri   = [Uri]$root
$destFull  = [IO.Path]::GetFullPath($dest)
$visited   = New-Object 'System.Collections.Generic.HashSet[string]'

function Get-Hrefs($html) {
  return [regex]::Matches($html, '<a\s+[^>]*href\s*=\s*"(.*?)"', 'IgnoreCase') |
         ForEach-Object { $_.Groups[1].Value }
}

function Normalize-RelPath([string]$relUrl) {
  $illegal = '[<>:"\|?*]'   # Windows tiltott karakterek

  $segs = $relUrl.Split('/') | Where-Object { $_ -ne '' } | ForEach-Object {
    $s = [System.Net.WebUtility]::UrlDecode($_)

    # Csak a valóban tiltott karaktereket cseréljük
    $s = $s -replace $illegal, '_'

    # Végéről pont és szóköz le
    $s = $s.Trim().TrimEnd('.')

    $s
  }

  if ($segs.Count -eq 0) { return $null }

  return ($segs -join [IO.Path]::DirectorySeparatorChar)
}


function Ensure-Under-Dest([string]$relPath) {
  $candidate = [IO.Path]::GetFullPath((Join-Path $dest $relPath))
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
    if ($href -eq '../') { continue }
    if ($href.StartsWith('?') -or $href.StartsWith('#')) { continue }
    if ($href -match '^/?icons/') { continue }

    $target = [Uri]::new($resp.BaseResponse.ResponseUri, $href)

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
Write-Host "KÉSZ: $dest"`;

const PS_OPEN_RESULTS = String.raw`# Fájl teljes elérési útja
$filePath = "C:\Users\Public\result.txt"

if (Test-Path -Path $filePath) {
    $links = Get-Content -Path $filePath
    foreach ($link in $links) {
        if ($link -match '^https?://') {
            Start-Process $link
        } else {
            Write-Host "Érvénytelen link kihagyva: $link"
        }
    }
} else {
    Write-Host "A megadott fájl nem található: $filePath"
}`;

const PS_DOWNLOAD_1 = String.raw`# --- Beállítások ---
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
  const $illegal = '[<>:"/\\|?*]';
  $segs = $relUrl.Split('/') | Where-Object { $_ -ne '' } | ForEach-Object {
    $s = [System.Net.WebUtility]::UrlDecode($_)
    $s = $s -replace $illegal, '_'     # Windows-illegális karakterek
    $s.Trim().TrimEnd('.')             # végéről pont/space le
  }
  if ($segs.Count -eq 0) { return $null }
  return ($segs -join [IO.Path]::DirectorySeparatorChar)
}

function Ensure-Under-Dest([string]$relPath) {
  $candidate = [IO.Path]::GetFullPath((Join-Path $dest $relPath))
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
    if ($href -eq '../') { continue }
    if ($href.StartsWith('?') -or $href.StartsWith('#')) { continue }
    if ($href -match '^/?icons/') { continue }

    $target = [Uri]::new($resp.BaseResponse.ResponseUri, $href)

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
Write-Host "KÉSZ: $dest"`;

const PS_DOWNLOAD_2 = String.raw`wget.exe -r -np -nH --cut-dirs=2 -R "index.html*" --reject-regex "[?](C|O)=" -e robots=off -U "Mozilla/5.0" --load-cookies ^
"$env:USERPROFILE\Downloads\cookies.txt" -P "$env:USERPROFILE\Downloads\retge1_ai" "https://users.itk.ppke.hu/~retge1/6.felev.html/ai/"`;

const User_pages_win: React.FC = () => {
  return (
    <div className="others-ll">
      {/* NOTE #0 */}
      <div className="others-ll__noteWrap" aria-live="polite">
        <section className="others-ll__note" aria-labelledby="quota-note-title-2">
          <h3 id="quota-note-title-2">Előzetes információ</h3>
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
        <section className="others-ll__note" aria-labelledby="quota-note-title">
          <h3 id="quota-note-title">User oldalak felfedezése (POWERSHELL)</h3>
          <hr />
          <p>
            Ez a kód nemcsak megnézi, melyik aktív, hanem le is szűri az üreseket és azokat, amelyeken nincs releváns tartalom.
            Ezeket a szűrőket te is tudod állítani a <code>$excludedPatterns</code> változóban.
          </p>

          <h4 style={{ margin: "6px 0" }}>SSH a szerverre</h4>
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
            – Ha később is szeretnél keresni oldalakat, akkor töröld ki a <code>result.txt</code> tartalmát…<br />
            – És akkor <code>C:\Users\Public\existing_urls.txt</code> -ban fogod tárolni a már megtalált oldalakat. (szünetekben szoktak megjelenni új oldalak.)
          </p>

          <CopyCode
            code={PS_DISCOVER}
            label="User oldalak felfedezése (PowerShell)"
            language=""
          />

          <p>Ezután az összes eredményt ezzel a kóddal tudod megnyitni :</p>

          <CopyCode
            code={PS_OPEN_RESULTS}
            label="Eredmények megnyitása (PowerShell)"
            language=""
          />
        </section>
      </div>

      {/* NOTE #2 */}
      <div className="others-ll__noteWrap" aria-live="polite">
        <section className="others-ll__note" aria-labelledby="quota-note-title-3">
          <h3 id="quota-note-title-3">User oldalak tartalmának Letöltése (POWERSHELL)</h3>
          <hr />
          <p>Ha "LETÖLTÉS_1" nem működik, akkor a speckós "LETÖLTÉS_2"-vel lehet lehúzni az oldal tartalmát… Ha valahova be kell jelentkezni, a tartalom megnézéséhez, akkor gyanús, hogy csak a speckóssal lehet lehúzni. Mivel ilyenkor szükség van a sütire, amit az oldal adott. Ezeket a sütiket előzetesen le kell töltened valami tool-lal.</p>

          <p>LETÖLTÉS_1.txt :</p>
          <CopyCode
            code={PS_DOWNLOAD_1}
            label="LETÖLTÉS_1.ps1 (PowerShell)"
            language=""
          />

          <p>LETÖLTÉS_2.txt :</p>
          <CopyCode
            code={PS_DOWNLOAD_2}
            label="LETÖLTÉS_2 (PowerShell sütikkel)"
            language=""
          />
        </section>
      </div>
    </div>
  );
};

export default User_pages_win;
