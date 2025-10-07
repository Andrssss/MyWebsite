// src/User_pages.jsx  (or .tsx if you prefer)
import React from 'react';
import './App.css';
import './styles/others-ll.css';

const User_pages = () => {
    return (
        // ✅ Full-page white background + readable text color
        <div className="others-ll">


            {/* NOTE #0 */}
            <div className="others-ll__noteWrap" aria-live="polite">
                <section className="others-ll__note" aria-labelledby="quota-note-title-2">
                    <h3 id="quota-note-title-2">Előzetes információ</h3>
                    <hr />
                    <p>
                        Mindenki készíthet magának felhasználói oldalt a szerveren, ahol elhelyezheti az anyagait.
                        Ezek addig maradnak elérhetők, amíg aktív tanuló vagy. Emiatt sokan külső helyekre szervezik az anyagaikat.
                        A következő néhány kód segíthet, hogy könnyen meg lehessen találni és lementeni őket.
                    </p>


                    
                </section>
            </div>



            {/* NOTE #1 */}
            <div className="others-ll__noteWrap" aria-live="polite">

                <section className="others-ll__note" aria-labelledby="quota-note-title">
                    <h3 id="quota-note-title">User oldalak felfedezése</h3>
                    <hr />
                    <p>Előzetesen annyit a kódról, hogy nemcsak megnézi, melyik aktív, hanem le is szűri az üreseket és azokat, amelyeken nincs releváns tartalom. Ezeket a szűrőket te is tudod állítani. </p>

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
                        {String.raw`# --- Beállítások -------------------------------------------------------------
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
bokda2    fabal3    guima    hrehu    khosa       kuplo     misma    pakge2    retma    szama50  torad7
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

Write-Host "Kész."`}
                    </pre>

                    <p>Ezután az eredményeket ezzel a kóddal lehet megnyitni :</p>

                    <pre aria-label="PowerShell script">
                        {String.raw`# Fájl teljes elérési útja
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
}`}
                    </pre>
                </section>
            </div>

            {/* NOTE #2 */}
            <div className="others-ll__noteWrap" aria-live="polite">
                <section className="others-ll__note" aria-labelledby="quota-note-title-2">
                    <h3 id="quota-note-title-2">User oldalak tartalmának Letöltése</h3>
                    <hr />
                    <p>
                        Ha "LETÖLTÉS_1" nem működik, akkor a speckós "LETÖLTÉS_2"-vel lehet lehúzni az oldal tartalmát.
                        Csak ahhoz le kell tölteni a sütiket. Mindkettőben át kell állítani, hogy melyik weboldalról
                        (<code>$root</code>) mentse el a tartalmat.
                    </p>

                    <p>LETÖLTÉS_1.txt :</p>
                    <pre aria-label="PowerShell script">
                        {String.raw`# --- Beállítások ---
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
Write-Host "KÉSZ: $dest"`}
                    </pre>

                    <p>LETÖLTÉS_2.txt :</p>
                    <pre aria-label="PowerShell script">
                        {String.raw`wget.exe -r -np -nH --cut-dirs=2 -R "index.html*" --reject-regex "[?](C|O)=" -e robots=off -U "Mozilla/5.0" --load-cookies ^
"$env:USERPROFILE\Downloads\cookies.txt" -P "$env:USERPROFILE\Downloads\retge1_ai" "https://users.itk.ppke.hu/~retge1/6.felev.html/ai/"`}
                    </pre>
                </section>
            </div>

        </div>
    );
};

export default User_pages;
