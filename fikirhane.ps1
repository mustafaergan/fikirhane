<#
.SYNOPSIS
  Fikirhane'yi Windows'ta kurar, başlatır, günceller ve Windows açılışında otomatik çalıştırır.

.DESCRIPTION
  Komutlar:
    kur             (varsayılan) Kurulum: Node/Git kontrolü, indirme, paketler, masaüstü kısayolu,
                    Windows açılışında otomatik başlatma, ardından başlatıp tarayıcıyı açar.
    baslat          Arka planda başlatır (zaten çalışıyorsa sadece tarayıcıyı açar).
    durdur          Çalışan Fikirhane'yi durdurur.
    guncelle        Son sürümü indirir (git ile ya da paketten kurulumda zip olarak), paketleri günceller
                    ve yeniden başlatır.
    durum           Kurulum ve çalışma durumunu gösterir.
    otomatik-ac     Windows açılışında otomatik başlatmayı açar.
    otomatik-kapat  Windows açılışında otomatik başlatmayı kapatır.
    kisayol-ac      Masaüstü kısayolunu ekler.            kisayol-kapat   Masaüstü kısayolunu kaldırır.
    masaustu-ac     Fikirhane'yi kendi penceresinde açan masaüstü uygulamasını hazırlar (görev çubuğuna sabitlenebilir).
    masaustu-kapat  Masaüstü uygulamasını kaldırır; Fikirhane tarayıcıda açılır.
    kaldir          Fikirhane'yi kaldırır: durdurur, kısayolları ve otomatik başlatmayı siler, paketle
                    kurulmuşsa kurulum klasörünü de siler (onay ister; -Evet ile sormaz). Git ile
                    indirilmiş klasörlere dokunmaz.

  Yönetici izni gerekmez; kısayollar kullanıcının kendi Masaüstü ve Başlangıç klasörlerine yazılır.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\fikirhane.ps1
.EXAMPLE
  .\fikirhane.ps1 guncelle
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('kur', 'baslat', 'durdur', 'guncelle', 'durum', 'otomatik-ac', 'otomatik-kapat', 'kisayol-ac', 'kisayol-kapat', 'masaustu-ac', 'masaustu-kapat', 'ayarlar', 'kosullar', 'kaldir')]
  [string]$Komut = 'kur',

  # Kurulum klasörü. Script zaten bir Fikirhane klasörünün içindeyse o klasör kullanılır.
  [string]$Klasor,

  # Başlatırken tarayıcıyı açma (Windows açılışında kullanılır)
  [switch]$TarayiciAcma,

  # kaldir: onay sormadan kaldır (kullanıcı verilerine dokunmaz)
  [switch]$Evet,

  # kaldir: kullanıcı verilerini de sil (~/.fikirhane: klasörsüz sohbet klasörü, öğretilen komutlar, yerel model listesi,
  # eklenen dosyalar, arayüz durumu). Verilmezse -Evet ile bile silinmez.
  [switch]$Veriler,

  # kur: kullanım koşullarını sormadan kabul et (otomatik/toplu kurulum; FIKIRHANE_KABUL=1 ile aynı)
  [switch]$Kabul,

  # Bitince "kapatmak için Enter" bekle (.bat dosyalarından çift tıklanarak çalıştırıldığında)
  [switch]$Bekle
)

$ErrorActionPreference = 'Stop'
# Fikirhane'nin Ayarlar penceresi çıktıyı UTF-8 okur
if ($env:FIKIRHANE_UTF8 -eq '1') { try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { } }
$RepoUrl = 'https://github.com/mustafaergan/fikirhane.git'
$AppName = 'Fikirhane'
$MinNode = [version]'18.18.0'

# ---------- Yardımcılar ----------
function Write-Step($text) { Write-Host "  > $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "  ✓ $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "  ! $text" -ForegroundColor Yellow }
function Stop-WithError($text) {
  # Kurulum sırasındaki güncelleme denemesinde hata kurulumu durdurmaz; çağıran yakalar ve devam eder
  if ($script:HataFirlat) { throw [System.InvalidOperationException]::new([string]$text) }
  Write-Host "  ✗ $text" -ForegroundColor Red
  exit 1
}

function Test-FikirhaneDir($dir) {
  if (-not $dir) { return $false }
  $pkg = Join-Path $dir 'package.json'
  if (-not (Test-Path $pkg)) { return $false }
  try { return ((Get-Content $pkg -Raw -Encoding UTF8 | ConvertFrom-Json).name -eq 'fikirhane') } catch { return $false }
}

function Read-PaketInfo($dir) {
  $f = Join-Path $dir '.paket'
  if (-not (Test-Path $f)) { return $null }
  try { return (Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

# Script bir dağıtım paketinin (zip) çıkarıldığı klasörden mi çalışıyor? (.paket var; git deposu
# ya da kurulmuş kopya değil — kurulum klasörüne .kurulu işareti konur)
$PaketInfo = Read-PaketInfo $PSScriptRoot
$FromPackage = ($null -ne $PaketInfo) -and -not (Test-Path (Join-Path $PSScriptRoot '.git')) -and -not (Test-Path (Join-Path $PSScriptRoot '.kurulu'))

function Resolve-InstallDir {
  if ($Klasor) { return [IO.Path]::GetFullPath($Klasor) }
  if ($env:FIKIRHANE_KLASOR) { return [IO.Path]::GetFullPath($env:FIKIRHANE_KLASOR) } # farklı bir kurulum klasörü (deneme / toplu kurulum)
  if ($FromPackage) { return (Join-Path $env:LOCALAPPDATA 'Fikirhane') }
  if (Test-FikirhaneDir $PSScriptRoot) { return $PSScriptRoot }
  return (Join-Path $env:LOCALAPPDATA 'Fikirhane')
}

$InstallDir = Resolve-InstallDir
$LogFile = Join-Path $InstallDir 'fikirhane.log'
$ScriptPath = Join-Path $InstallDir 'fikirhane.ps1'
# Testlerde gerçek Masaüstü/Başlangıç klasörlerine dokunmamak için değiştirilebilir
# Windows, klasör yoksa ya da grup ilkesiyle kapatılmışsa GetFolderPath için boş yol döndürür.
# Önce oluşturmayı dener, sonra bilinen varsayılan yola düşer; o da olmazsa $null döner ve
# ilgili adım (kısayol / otomatik başlatma) uyarıyla atlanır.
function Resolve-SpecialDir($override, $folder, $fallback) {
  if ($override) { return $override }
  $p = $null
  try { $p = [Environment]::GetFolderPath($folder, [Environment+SpecialFolderOption]::Create) } catch { }
  if (-not $p -and $fallback) {
    try {
      if (-not (Test-Path $fallback)) { New-Item -ItemType Directory -Force $fallback | Out-Null }
      $p = $fallback
    } catch { $p = $null }
  }
  if ($p) { return $p }
  return $null
}
# Join-Path, erişilemeyen sürücülerde (ör. yönlendirilmiş ağ klasörü) hata verir; bu yüzden düz birleştirme
$DesktopDir = Resolve-SpecialDir $env:FIKIRHANE_DESKTOP_DIR 'Desktop' $(if ($HOME) { [IO.Path]::Combine($HOME, 'Desktop') })
$StartupDir = Resolve-SpecialDir $env:FIKIRHANE_STARTUP_DIR 'Startup' $(if ($env:APPDATA) { [IO.Path]::Combine($env:APPDATA, 'Microsoft\Windows\Start Menu\Programs\Startup') })
$DesktopLink = if ($DesktopDir) { [IO.Path]::Combine($DesktopDir, "$AppName.lnk") } else { $null }
$StartupLink = if ($StartupDir) { [IO.Path]::Combine($StartupDir, "$AppName.lnk") } else { $null }
function Test-Link($p) { try { return [bool]($p -and (Test-Path $p)) } catch { return $false } }
# Masaüstü uygulaması (isteğe bağlı): Fikirhane'yi kendi penceresinde açan küçük program. Kaynağı src\masaustu içindedir,
# bu bilgisayarda derlenir ve kurulum klasöründeki masaustu-app altına konur (güncellemede değişen klasörlerin dışında).
$ProgramsDir = Resolve-SpecialDir $env:FIKIRHANE_PROGRAMS_DIR 'Programs' $null
$StartMenuLink = if ($ProgramsDir) { [IO.Path]::Combine($ProgramsDir, "$AppName.lnk") } else { $null }
$AppDir = Join-Path $InstallDir 'masaustu-app'
$AppExe = Join-Path $AppDir 'Fikirhane.exe'
function Test-DesktopApp { return (Test-Path $AppExe) }

function Get-Port {
  $envFile = Join-Path $InstallDir '.env'
  if (Test-Path $envFile) {
    $line = Get-Content $envFile -Encoding UTF8 | Where-Object { $_ -match '^\s*FIKIRHANE_PORT\s*=\s*(\d+)' } | Select-Object -First 1
    if ($line -and $line -match '(\d+)\s*$') { return [int]$Matches[1] }
  }
  return 3310
}

function Get-Url { return "http://127.0.0.1:$(Get-Port)" }

# Porttaki uygulama bir Fikirhane mi? (süreç bilgisi okunamadığında yedek kontrol)
function Test-FikirhaneHttp([int]$port) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$port/api/config"
    return ($r.Content -match '"app":"fikirhane"')
  } catch { return $false }
}

# Portu dinleyen süreç ve bu kurulumun Fikirhane'si olup olmadığı (yoksa $null)
function Get-PortOwner([int]$port) {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { return $null }
  $procId = [int]$c.OwningProcess
  $name = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
  $cmd = $null
  try { $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction Stop).CommandLine } catch { }
  if ($cmd) {
    $cli = Join-Path $InstallDir 'src\cli.js'
    $ours = ($name -eq 'node') -and ($cmd.IndexOf($cli, [StringComparison]::OrdinalIgnoreCase) -ge 0)
  } else {
    $ours = ($name -eq 'node') -and (Test-FikirhaneHttp $port)
  }
  return @{ pid = $procId; name = $name; ours = [bool]$ours }
}

# Bu kurulumun Fikirhane'si çalışıyor mu? (portta başka bir program varsa hayır)
function Test-Running {
  $o = Get-PortOwner (Get-Port)
  return [bool]($o -and $o.ours)
}

# Port gerçekten kullanılabilir mi? Dinleyen yoksa bile Windows (Hyper-V/WSL) bazı
# port aralıklarını ayırmış olabilir; bu yüzden kısa bir süre açmayı deneriz.
function Test-PortFree([int]$port) {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { return $false }
  $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $port)
  try { $listener.Start(); return $true } catch { return $false } finally { try { $listener.Stop() } catch { } }
}

function Find-FreePort([int]$start) {
  for ($p = $start; $p -lt $start + 100 -and $p -le 65535; $p++) { if (Test-PortFree $p) { return $p } }
  return $null
}

# .env içindeki bir değeri ayarlar (yorum satırı halindeyse açar, yoksa ekler)
function Set-EnvValue($key, $value) {
  $envFile = Join-Path $InstallDir '.env'
  $lines = @()
  if (Test-Path $envFile) { $lines = @(Get-Content $envFile -Encoding UTF8) }
  $done = $false
  $out = foreach ($l in $lines) {
    if (-not $done -and $l -cmatch "^\s*#?\s*$key\s*=") { $done = $true; "$key=$value" } else { $l }
  }
  if (-not $done) { $out = @($out) + "$key=$value" }
  [IO.File]::WriteAllLines($envFile, [string[]]$out, (New-Object Text.UTF8Encoding $false))
}

# Port başka bir programdaysa yeni bir port sorar (-Auto: sormadan boş portu seçer) ve .env'ye yazar
function Resolve-PortConflict([switch]$Auto) {
  $port = Get-Port
  $owner = Get-PortOwner $port
  if ($owner -and $owner.ours) { return }
  if (-not $owner -and (Test-PortFree $port)) { return }

  $who = if ($owner) { "$($owner.name) (PID $($owner.pid))" } else { 'Windows tarafından ayrılmış' }
  Write-Warn "Port $port kullanılamıyor: $who"
  $new = Find-FreePort ($port + 1)
  if (-not $new) { Stop-WithError "$port sonrasında boş port bulunamadı. .env dosyasına FIKIRHANE_PORT=<port> yazıp tekrar deneyin." }

  if (-not $Auto -and $env:FIKIRHANE_SORMA -ne '1' -and [Environment]::UserInteractive) {
    for ($i = 0; $i -lt 5; $i++) {
      $a = ''
      try { $a = Read-Host "  Fikirhane için kullanılacak port [$new]" } catch { break }
      $a = "$a".Trim()
      if (-not $a) { break }
      if ($a -notmatch '^\d+$' -or [int]$a -lt 1024 -or [int]$a -gt 65535) { Write-Warn '1024 ile 65535 arasında bir sayı girin.'; continue }
      if (-not (Test-PortFree ([int]$a))) { Write-Warn "Port $a da kullanılamıyor, başka bir numara deneyin."; continue }
      $new = [int]$a
      break
    }
  }
  Set-EnvValue 'FIKIRHANE_PORT' $new
  Write-Ok "Fikirhane artık $new portunu kullanacak (.env dosyasına kaydedildi): http://127.0.0.1:$new"
  Write-Host '  Not: Tarayıcı proje listesini adrese göre saklar; yeni adreste klasörleri bir kez yeniden eklemeniz gerekebilir.' -ForegroundColor Gray
}

# Tam paket kendi Node.js'ini "runtime" klasöründe getirir (Node kurulamayan bilgisayarlar için). Kurulum
# gerektirmez: node.exe olduğu yerden çalışır. Varsa her zaman o kullanılır ve npm/npx de oradan bulunur.
function Get-BundledNodeDir {
  foreach ($dir in @((Join-Path $InstallDir 'runtime'), (Join-Path $PSScriptRoot 'runtime'))) {
    if ($dir -and (Test-Path (Join-Path $dir 'node.exe'))) { return $dir }
  }
  return $null
}

function Get-NodePath {
  $bundled = Get-BundledNodeDir
  if ($bundled) {
    if (($env:PATH -split ';') -notcontains $bundled) { $env:PATH = "$bundled;$env:PATH" } # npm, npx ve oraya kurulan araçlar
    return (Join-Path $bundled 'node.exe')
  }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  # Node.js az önce kurulduysa bu pencerenin PATH'i henüz güncel olmayabilir: bilinen yerlere bak
  foreach ($dir in @("$env:ProgramFiles\nodejs", "${env:ProgramFiles(x86)}\nodejs", "$env:LOCALAPPDATA\Programs\nodejs")) {
    $exe = Join-Path $dir 'node.exe'
    if ($dir -and (Test-Path $exe)) {
      $env:PATH = "$dir;$env:PATH" # npm de bulunsun
      return $exe
    }
  }
  return $null
}

# Etkileşimli pencerede E/H sorusu; gizli/etkileşimsiz çalışmada varsayılanı döndürür
# (FIKIRHANE_SORMA=1: hiç sorma, her soruya "hayır" — otomatik/toplu kurulum için)
function Confirm-Yes($question, [bool]$default = $true) {
  if ($env:FIKIRHANE_SORMA -eq '1') { return $false }
  if (-not [Environment]::UserInteractive -or $TarayiciAcma) { return $default }
  $hint = if ($default) { '(E/h)' } else { '(e/H)' }
  try { $a = Read-Host "  $question $hint" } catch { return $default }
  if (-not $a) { return $default }
  return ($a.Trim() -match '^(e|evet|y|yes)$')
}

function Write-Box($color, [string[]]$lines) {
  $width = ($lines | Measure-Object -Property Length -Maximum).Maximum + 2
  Write-Host ''
  Write-Host ('  +' + ('-' * $width) + '+') -ForegroundColor $color
  foreach ($l in $lines) { Write-Host ('  | ' + $l.PadRight($width - 1) + '|') -ForegroundColor $color }
  Write-Host ('  +' + ('-' * $width) + '+') -ForegroundColor $color
  Write-Host ''
}

function Stop-NodeMissing([string]$reason) {
  $lines = @(
    $reason,
    '',
    "Fikirhane'nin çalışması için Node.js $MinNode veya üstü gerekli.",
    '1) https://nodejs.org adresinden "LTS" sürümünü indirip kurun',
    '   (ya da PowerShell''de: winget install OpenJS.NodeJS.LTS)',
    '2) Kurulumdan sonra bu pencereyi kapatıp Kur.bat''ı yeniden çalıştırın.'
  )
  Write-Box Red $lines
  if (Confirm-Yes 'Node.js indirme sayfası şimdi açılsın mı?') { Start-Process 'https://nodejs.org/' }
  exit 1
}

# Kullanım koşulları: kurulum, kullanıcı bunları açıkça kabul etmeden devam etmez.
function Get-TermsLines {
  return @(
    'KULLANIM KOŞULLARI',
    '',
    'Fikirhane belgelerinizi bu bilgisayarda işler ve yalnızca Ayarlar''da yazdığınız',
    'yerel dil modeli sunucusuna gönderir. Kuruluma devam ederek şunları kabul edersiniz:',
    '',
    '1) Yüklediğiniz belgeleri işleme ve bir dil modeline verme yetkiniz vardır;',
    '   şirketinizin bilgi güvenliği kurallarına uygun davranırsınız.',
    '2) Dil modelinin çıkardığı notlar, haritalar ve yanıtlar hatalı ya da eksik olabilir.',
    '   Önemli kararlarda asıl belgeye bakmak sizin sorumluluğunuzdadır.',
    '3) Yerel model sunucusu olarak başka bir bilgisayardaki ya da ağdaki bir adres',
    '   yazarsanız belgeleriniz o adrese gider; bunun uygunluğuna siz karar verirsiniz.',
    '4) Fikirhane MIT lisansıyla, olduğu gibi ve hiçbir garanti verilmeden sunulur.',
    '   Kurulumdan ve kullanımdan doğacak tüm sorumluluk kurulumu yapan ve kullanan',
    '   kişiye aittir; yazılımı geliştirenler sorumlu tutulamaz.'
  )
}

function Confirm-Terms {
  # Koşullar değiştiğinde sürüm artırılır; eski sürümü kabul etmiş olanlara yeniden sorulur
  $termsVersion = '2'
  $marker = Join-Path (Join-Path $HOME '.fikirhane') 'kullanim-kosullari-kabul.txt'
  if ((Test-Path $marker) -and ((Get-Content $marker -Raw -Encoding UTF8) -match "Koşul sürümü: $termsVersion\b")) {
    Write-Ok "Kullanım koşulları daha önce kabul edilmiş ($((Get-Item $marker).LastWriteTime.ToString('yyyy-MM-dd')))"
    return
  }
  Write-Box Yellow (Get-TermsLines)
  $accepted = ($Kabul -or $env:FIKIRHANE_KABUL -eq '1')
  if (-not $accepted) {
    if (-not (Test-Interactive)) { Stop-WithError "Kullanım koşulları kabul edilmeden kurulum yapılamaz. Etkileşimsiz kurulumda -Kabul parametresini (ya da FIKIRHANE_KABUL=1) kullanın." }
    $a = ''
    try { $a = Read-Host '  Bu koşulları kabul ediyor musunuz? Devam etmek için "evet" yazın' } catch { }
    $accepted = ($a.Trim() -match '^(evet|e|yes|y)$')
  }
  if (-not $accepted) {
    Write-Host ''
    Write-Host '  Koşullar kabul edilmedi; kurulum yapılmadı.' -ForegroundColor Red
    Write-Host ''
    exit 1
  }
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path $marker) | Out-Null
    Set-Content -Path $marker -Encoding utf8 -Value "Kullanım koşulları $((Get-Date).ToString('yyyy-MM-dd HH:mm')) tarihinde $env:USERNAME tarafından kabul edildi. Koşul sürümü: $termsVersion"
  } catch { }
  Write-Ok 'Kullanım koşulları kabul edildi'
}

function Test-Requirements {
  $node = Get-NodePath
  if (-not $node) { Stop-NodeMissing 'Node.js bulunamadı.' }
  $ver = $null
  try { $ver = [version]((& $node --version).Trim().TrimStart('v')) } catch { }
  if (-not $ver) { Stop-NodeMissing "Node.js çalıştırılamadı: $node" }
  if ($ver -lt $MinNode) { Stop-NodeMissing "Node.js $ver çok eski." }
  Write-Ok "Node.js $ver$(if (Get-BundledNodeDir) { ' (paketle birlikte geldi; ayrıca kurulum gerekmez)' })"
  if ($FromPackage) { return } # paketten kurulumda Git gerekmez
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Stop-WithError "Git bulunamadı. https://git-scm.com adresinden kurup tekrar deneyin." }
  Write-Ok "Git $(((git --version) -replace 'git version ', ''))"
}

function New-Shortcut($path, $arguments, $description, [switch]$App) {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($path)
  if ($App) {
    # Masaüstü uygulaması: kısayol doğrudan programa gider (görev çubuğuna sabitlenebilir)
    $lnk.TargetPath = $AppExe
    $lnk.Arguments = ''
    $lnk.WindowStyle = 1
  } else {
    $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`" $arguments"
    $lnk.WindowStyle = 7 # simge durumunda
  }
  $lnk.WorkingDirectory = $InstallDir
  $lnk.Description = $description
  $icon = Join-Path $InstallDir 'public\fikirhane.ico'
  $lnk.IconLocation = if (Test-Path $icon) { "$icon,0" } else { "$env:SystemRoot\System32\shell32.dll,13" }
  $lnk.Save()
}

# ---------- Komutlar ----------
function Install-FromPackage {
  $samePlace = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') -ieq [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
  if ($samePlace) { Write-Ok "Kurulum klasörü: $InstallDir"; return }
  if (Test-Path (Join-Path $InstallDir '.git')) {
    Stop-WithError "$InstallDir git ile kurulmuş. Onu '$InstallDir\fikirhane.ps1 guncelle' ile güncelleyin ya da -Klasor ile başka bir yer seçin."
  }
  if ((Test-Path $InstallDir) -and -not (Test-FikirhaneDir $InstallDir) -and (Get-ChildItem $InstallDir -Force | Select-Object -First 1)) {
    Stop-WithError "$InstallDir boş değil ve bir Fikirhane klasörü değil. -Klasor ile başka bir yer seçin."
  }
  $old = Read-PaketInfo $InstallDir
  if ($old) { Write-Step "Güncelleniyor: $($old.version) → $($PaketInfo.version)" } else { Write-Step "Kuruluyor: $($PaketInfo.version) → $InstallDir" }
  if (Test-Running) { Stop-Fikirhane; Start-Sleep -Seconds 1 }

  New-Item -ItemType Directory -Force $InstallDir | Out-Null
  # Eski sürümden kalan dosyalar karışmasın diye uygulama klasörlerini yenile; .env ve node_modules korunur
  foreach ($d in @('src', 'public', 'scripts')) {
    $p = Join-Path $InstallDir $d
    if (Test-Path $p) { Remove-Item $p -Recurse -Force }
  }
  $skip = @('.env')
  if (-not $PaketInfo.tam) { $skip += 'node_modules' }
  Get-ChildItem $PSScriptRoot -Force | Where-Object { $skip -notcontains $_.Name } | ForEach-Object {
    Copy-Item $_.FullName -Destination $InstallDir -Recurse -Force
  }
  Set-Content (Join-Path $InstallDir '.kurulu') (Get-Date -Format s) -Encoding ASCII
  # İnternetten indirilen zip'ten çıkan dosyalardaki "engellendi" işaretini kaldır
  Get-ChildItem $InstallDir -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue
  Write-Ok "Dosyalar kopyalandı: $InstallDir"
}

function Install-Files {
  if ($FromPackage) { Install-FromPackage; return }
  if (Test-FikirhaneDir $InstallDir) {
    Write-Ok "Kurulum klasörü: $InstallDir"
  } else {
    if ((Test-Path $InstallDir) -and (Get-ChildItem $InstallDir -Force | Select-Object -First 1)) {
      Stop-WithError "$InstallDir boş değil ve bir Fikirhane klasörü değil. -Klasor ile başka bir yer seçin."
    }
    Write-Step "İndiriliyor: $RepoUrl → $InstallDir"
    git clone --quiet $RepoUrl $InstallDir
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'git clone başarısız oldu.' }
    Write-Ok 'İndirildi'
  }
}

function Install-Packages {
  $info = Read-PaketInfo $InstallDir
  if ($info -and $info.tam -and (Test-Path (Join-Path $InstallDir 'node_modules\pdfjs-dist'))) {
    Write-Ok 'Paketler pakette hazır geldi (npm erişimi gerekmedi)'
    return
  }
  Write-Step 'Paketler kuruluyor (ilk seferde birkaç dakika sürebilir)…'
  Push-Location $InstallDir
  try {
    npm install --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'npm install başarısız oldu. Şirket ağı npm erişimini engelliyor olabilir.' }
  } finally { Pop-Location }
  Write-Ok 'Paketler hazır'
}

function Install-EnvFile {
  $envFile = Join-Path $InstallDir '.env'
  if (Test-Path $envFile) { return }
  Set-Content $envFile "# Fikirhane ayarlari (istege bagli)`r`n# FIKIRHANE_PORT=3310" -Encoding ASCII
  Write-Ok '.env oluşturuldu'
}

function Test-Interactive { return ([Environment]::UserInteractive -and -not $TarayiciAcma -and $env:FIKIRHANE_SORMA -ne '1') }

function Start-Fikirhane {
  Repair-Install
  if (Test-Running) {
    Write-Ok "Zaten çalışıyor: $(Get-Url)"
  } else {
    # Port başka bir programdaysa: elle başlatmada sor, Windows açılışında (gizli) boş portu kendisi seçsin
    Resolve-PortConflict -Auto:$TarayiciAcma
    $node = Get-NodePath
    if (-not $node) { Stop-WithError 'Node.js bulunamadı.' }
    Write-Step 'Başlatılıyor…'
    # Sunucu, terminalden bağımsız gizli bir pencerede ve kullanıcının ana klasöründe çalışır
    # (terminal kapansa da sürer); çıktısı fikirhane.log dosyasına yazılır.
    $cli = Join-Path $InstallDir 'src\cli.js'
    $shell = New-Object -ComObject WScript.Shell
    $shell.CurrentDirectory = $HOME
    [void]$shell.Run("cmd /d /s /c `"`"$node`" `"$cli`" --no-open > `"$LogFile`" 2>&1`"", 0, $false)
    $ok = $false
    for ($i = 0; $i -lt 40; $i++) {
      Start-Sleep -Milliseconds 500
      if (Test-Running) { $ok = $true; break }
    }
    if (-not $ok) {
      Write-Warn 'Fikirhane başlatılamadı. Son kayıtlar:'
      if (Test-Path $LogFile) { Get-Content $LogFile -Tail 15 | ForEach-Object { Write-Host "    $_" } }
      if ($script:HataFirlat) { throw "Fikirhane başlatılamadı" }
      exit 1
    }
    Write-Ok "Çalışıyor: $(Get-Url)"
  }
  if (-not $TarayiciAcma) { if (Test-DesktopApp) { Start-Process $AppExe } else { Start-Process (Get-Url) } }
}

function Stop-Fikirhane {
  $port = Get-Port
  $owner = Get-PortOwner $port
  $stopped = $false
  # Sadece bu kurulumun Fikirhane'sini durdur; portu başka bir program (başka bir Node uygulaması
  # ya da başka bir Fikirhane kurulumu) kullanıyorsa dokunma
  if ($owner -and $owner.ours) {
    # /T: alt süreçlerle birlikte kapat
    taskkill /PID $owner.pid /T /F 2>&1 | Out-Null
    Write-Ok "Durduruldu (süreç $($owner.pid))"
    $stopped = $true
  } elseif ($owner) {
    Write-Warn "Port $port başka bir program tarafından kullanılıyor ($($owner.name)); dokunulmadı."
  }
  # Önceki sürümlerin durdururken geride bıraktığı, bu kurulumdan çalışan süreçler
  $prefix = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\') + '\'
  $orphans = Get-Process -Name node -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) }
  foreach ($p in $orphans) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  if ($orphans) { Write-Ok "Arkada kalmış $(@($orphans).Count) süreç kapatıldı" }
  if (-not $stopped -and -not $orphans) { Write-Ok 'Zaten çalışmıyor' }
}

# Klasörü sil; virüs tarayıcısı gibi geçici kilitler için birkaç kez dene
function Remove-DirWithRetry($dir) {
  for ($i = 0; $i -lt 10; $i++) {
    cmd /d /c "rmdir /s /q `"$dir`"" 2>$null
    if (-not (Test-Path $dir)) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Enable-Autostart {
  if (-not $StartupLink) { Write-Warn 'Windows Başlangıç klasörü bulunamadı; otomatik başlatma atlandı (Fikirhane kısayoldan açılabilir).'; return }
  try {
    New-Shortcut $StartupLink '-Komut baslat -TarayiciAcma' "$AppName (Windows açılışında arka planda başlar)"
    Write-Ok 'Windows açılışında otomatik başlatma açık'
  } catch {
    Write-Warn "Otomatik başlatma ayarlanamadı: $($_.Exception.Message)"
  }
}

function Disable-Autostart {
  if (Test-Link $StartupLink) { Remove-Item $StartupLink -Force }
  Write-Ok 'Windows açılışında otomatik başlatma kapalı'
}

function Install-DesktopShortcut {
  if (-not $DesktopLink) { Write-Warn "Masaüstü klasörü bulunamadı; kısayol atlandı. Fikirhane'yi '$ScriptPath baslat' ile açabilirsiniz."; return $false }
  try {
    if (Test-DesktopApp) { New-Shortcut $DesktopLink '' "$AppName'yi aç" -App } else { New-Shortcut $DesktopLink '-Komut baslat' "$AppName'yi aç" }
    Write-Ok "Masaüstü kısayolu: $DesktopLink"
    return $true
  } catch {
    Write-Warn "Masaüstü kısayolu oluşturulamadı: $($_.Exception.Message)"
    return $false
  }
}

function Remove-DesktopShortcut {
  if (Test-Link $DesktopLink) { Remove-Item $DesktopLink -Force }
  Write-Ok 'Masaüstü kısayolu kapalı'
}

# Masaüstü uygulamasını bu bilgisayarda derler. Windows'la gelen .NET Framework derleyicisi kullanılır; ek bir şey
# indirilmez. Kaynak değişmediyse yeniden derlenmez. Başarısız olursa $false döner (Fikirhane tarayıcıda açılmaya devam eder).
function Build-DesktopApp {
  $src = Join-Path $InstallDir 'src\masaustu'
  $code = Join-Path $src 'Fikirhane.cs'
  $libs = Join-Path $src 'webview2'
  if (-not (Test-Path $code) -or -not (Test-Path (Join-Path $libs 'WebView2Loader.dll'))) { Write-Warn 'Masaüstü uygulamasının dosyaları bu kurulumda yok (src\masaustu).'; return $false }
  $csc = @("$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe", "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $csc) { Write-Warn 'Masaüstü uygulaması hazırlanamadı: .NET Framework derleyicisi (csc.exe) bu bilgisayarda bulunamadı.'; return $false }
  $hash = (Get-FileHash $code -Algorithm SHA256).Hash
  $mark = Join-Path $AppDir '.kaynak'
  if ((Test-Path $AppExe) -and (Test-Path $mark) -and ((Get-Content $mark -Raw).Trim() -eq $hash)) { return $true }
  $tmp = Join-Path $InstallDir '.masaustu-derleme'
  try {
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    New-Item -ItemType Directory -Force $tmp | Out-Null
    Copy-Item (Join-Path $libs '*') -Destination $tmp -Force
    $icon = Join-Path $InstallDir 'public\fikirhane.ico'
    $cscArgs = @('-nologo', '-target:winexe', '-platform:x64', '-optimize+', '-codepage:65001', '-nowarn:1701,1702',
      "-win32manifest:$(Join-Path $src 'Fikirhane.manifest')",
      "-r:$(Join-Path $libs 'Microsoft.Web.WebView2.Core.dll')", "-r:$(Join-Path $libs 'Microsoft.Web.WebView2.WinForms.dll')",
      '-r:System.Windows.Forms.dll', '-r:System.Drawing.dll', "-out:$(Join-Path $tmp 'Fikirhane.exe')")
    if (Test-Path $icon) { $cscArgs += "-win32icon:$icon" }
    $out = (& $csc @cscArgs $code | Out-String)
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $tmp 'Fikirhane.exe'))) { throw "derleme başarısız: $($out.Trim())" }
    Set-Content (Join-Path $tmp '.kaynak') $hash -Encoding ASCII
    if (Test-Path $AppDir) {
      try { Remove-Item $AppDir -Recurse -Force -ErrorAction Stop } catch {
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path $AppExe) { Write-Warn 'Fikirhane penceresi açık olduğu için masaüstü uygulaması yenilenemedi; pencere kapalıyken yeniden denenecek.'; return $true }
        throw
      }
    }
    Rename-Item -LiteralPath $tmp -NewName 'masaustu-app'
    return $true
  } catch {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Write-Warn "Masaüstü uygulaması hazırlanamadı: $($_.Exception.Message)"
    return $false
  }
}

function Enable-DesktopApp {
  if (-not (Build-DesktopApp)) { Write-Warn 'Fikirhane tarayıcıda açılmaya devam edecek.'; return $false }
  if ($StartMenuLink) { try { New-Shortcut $StartMenuLink '' $AppName -App } catch { } }
  if (Test-Link $DesktopLink) { [void](Install-DesktopShortcut) }
  Write-Ok 'Masaüstü uygulaması hazır: Fikirhane kendi penceresinde açılır'
  Write-Host '    Görev çubuğuna sabitlemek için: Fikirhane penceresi açıkken görev çubuğundaki simgesine sağ tıklayıp "Görev çubuğuna sabitle"yi seçin.' -ForegroundColor Gray
  return $true
}

function Stop-DesktopApp {
  $open = @(Get-Process -Name Fikirhane -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -ieq $AppExe })
  foreach ($p in $open) { try { [void]$p.CloseMainWindow() } catch { } }
  if ($open) { Start-Sleep -Seconds 2 }
  foreach ($p in $open) { try { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force } } catch { } }
  return [bool]$open
}

function Disable-DesktopApp {
  $wasOpen = Stop-DesktopApp
  if (Test-Link $StartMenuLink) { Remove-Item $StartMenuLink -Force }
  if (Test-Path $AppDir) { [void](Remove-DirWithRetry $AppDir) }
  if (Test-Link $DesktopLink) { [void](Install-DesktopShortcut) }
  Write-Ok 'Masaüstü uygulaması kapalı: Fikirhane tarayıcıda açılır'
  if ($wasOpen -and (Test-Running)) { Start-Process (Get-Url) }
}

# Fikirhane'nin Ayarlar penceresi bu çıktıyı okur
function Show-Settings {
  $csc = @("$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe", "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  $state = [ordered]@{
    desktopApp          = [bool](Test-DesktopApp)
    desktopAppAvailable = [bool]($csc -and (Test-Path (Join-Path $InstallDir 'src\masaustu\Fikirhane.cs')))
    desktopShortcut     = [bool](Test-Link $DesktopLink)
    autostart           = [bool](Test-Link $StartupLink)
  }
  Write-Output ($state | ConvertTo-Json -Compress)
}

function Install-Fikirhane {
  Write-Host ''
  Write-Host "  $AppName kurulumu" -ForegroundColor White
  Write-Host ''
  Confirm-Terms
  Test-Requirements
  Install-Files
  Install-Packages
  Update-DuringInstall
  Install-EnvFile
  Write-Host ''
  Resolve-PortConflict
  # Seçenekler: sihirbaz ortam değişkeniyle bildirir (FIKIRHANE_MASAUSTU / FIKIRHANE_KISAYOL / FIKIRHANE_OTOMATIK = 1 ya da 0);
  # konsoldan kurulumda masaüstü uygulaması sorulur, kısayol ve otomatik başlatma eklenir.
  $wantApp = if ($env:FIKIRHANE_MASAUSTU) { $env:FIKIRHANE_MASAUSTU -eq '1' } elseif (Test-DesktopApp) { $true }
    else { (Test-Interactive) -and (Confirm-Yes 'Fikirhane kendi penceresinde (masaüstü uygulaması; görev çubuğuna sabitlenebilir) açılsın mı? Hayır derseniz tarayıcıda açılır.' $true) }
  if ($wantApp) {
    Write-Step 'Masaüstü uygulaması hazırlanıyor…'
    [void](Enable-DesktopApp)
  } elseif (Test-DesktopApp) { Disable-DesktopApp }
  $hasDesktop = $false
  if ($env:FIKIRHANE_KISAYOL -eq '0') { if (Test-Link $DesktopLink) { Remove-DesktopShortcut } } else { $hasDesktop = Install-DesktopShortcut }
  if ($env:FIKIRHANE_OTOMATIK -eq '0') { if (Test-Link $StartupLink) { Disable-Autostart } } else { Enable-Autostart }
  Start-Fikirhane
  Write-Host ''
  if ($hasDesktop) {
  } elseif ($hasDesktop) {
    Write-Host "  Kurulum tamam. Fikirhane'yi masaüstündeki '$AppName' kısayoluyla açabilirsiniz." -ForegroundColor Green
  } else {
    Write-Host "  Kurulum tamam. Fikirhane'yi tarayıcıda $(Get-Url) adresinden ya da '$ScriptPath baslat' ile açabilirsiniz." -ForegroundColor Green
  }
  Write-Host "  Yerel dil modelini (Ollama, LM Studio vb.) Fikirhane içindeki Ayarlar'dan tanımlayın." -ForegroundColor Gray
  if ($FromPackage) {
    Write-Host "  Güncellemek için yeni paketi indirip Kur.bat'ı çalıştırın. Bu çıkarılan klasörü artık silebilirsiniz." -ForegroundColor Gray
  } else {
    Write-Host "  Güncellemek için: $ScriptPath guncelle" -ForegroundColor Gray
  }
  Write-Host ''
}

# Paketten (zip) yapılmış kurulumu GitHub'daki son sürümle günceller: zip'i indirir, gerekiyorsa paketleri
# ayrı bir klasörde hazırlar, ancak her şey hazır olunca Fikirhane'yi durdurup dosyaları değiştirir. İndirme ya da
# paket kurulumu başarısız olursa çalışan kurulum olduğu gibi kalır.
#   FIKIRHANE_UPDATE_ZIP: farklı bir depo/ayna için zip adresi
# Klasörü hedefe aynalar: önce yeni/değişen dosyalar kopyalanır, hedefteki fazlalıklar sonra silinir.
# Kilitli dosyalarda birkaç kez yeniden dener; başarısız olursa hata fırlatır (robocopy: 8 ve üstü hata).
function Copy-Mirror($from, $to) {
  cmd /d /c "robocopy `"$from`" `"$to`" /MIR /NFL /NDL /NJH /NJS /NP /R:5 /W:1 >nul"
  if ($LASTEXITCODE -ge 8) { throw "Dosyalar kopyalanamadı: $to (robocopy kodu $LASTEXITCODE)" }
}

# Kilitli dosya/klasörlerde (az önce kapanan süreç tutamağı bırakana kadar) birkaç kez yeniden dener
function Rename-WithRetry($path, $newName) {
  for ($i = 1; ; $i++) {
    try { Rename-Item -LiteralPath $path -NewName $newName -ErrorAction Stop; return } catch { if ($i -ge 6) { throw }; Start-Sleep -Seconds 1 }
  }
}
function Move-WithRetry($from, $to) {
  for ($i = 1; ; $i++) {
    try { Move-Item -LiteralPath $from -Destination $to -ErrorAction Stop; return } catch { if ($i -ge 6) { throw }; Start-Sleep -Seconds 1 }
  }
}

# Güncelleme tam değişim anında kesildiyse (elektrik, zorla kapatma) bir klasör "<ad>.eski" olarak kalmış olabilir.
# Asıl klasör yoksa eskisi geri adlandırılır; böylece Fikirhane her durumda açılır.
function Repair-Install {
  foreach ($d in @('src', 'public', 'scripts', 'node_modules')) {
    $cur = Join-Path $InstallDir $d
    if (-not (Test-Path $cur) -and (Test-Path "$cur.eski")) {
      try { Rename-Item -LiteralPath "$cur.eski" -NewName $d -ErrorAction Stop; Write-Warn "Yarım kalmış bir güncelleme onarıldı: $d geri yüklendi." } catch { }
    }
  }
}

function Update-PackageInstall {
  $info = Read-PaketInfo $InstallDir
  $current = (Get-Content (Join-Path $InstallDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json)
  $zipUrl = if ($env:FIKIRHANE_UPDATE_ZIP) { $env:FIKIRHANE_UPDATE_ZIP } else { ($RepoUrl -replace '\.git$', '') + '/archive/refs/heads/main.zip' }
  $tmp = Join-Path $env:TEMP ('fikirhane-guncelle-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force $tmp | Out-Null
  try {
    Write-Step 'Son sürüm indiriliyor…'
    $zip = Join-Path $tmp 'fikirhane.zip'
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
      $oldProgress = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
      Invoke-WebRequest -Uri $zipUrl -OutFile $zip -UseBasicParsing -TimeoutSec 120
      $ProgressPreference = $oldProgress
    } catch {
      Stop-WithError "Son sürüm indirilemedi ($zipUrl): $($_.Exception.Message). Ağ bu adrese izin vermiyor olabilir; yeni paketi elle indirip Kur.bat ile kurabilirsiniz."
    }
    Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp 'x') -Force
    $src = Get-ChildItem (Join-Path $tmp 'x') -Directory | Select-Object -First 1
    if (-not $src -or -not (Test-FikirhaneDir $src.FullName)) { Stop-WithError 'İndirilen dosya bir Fikirhane sürümü değil; güncelleme yapılmadı.' }
    $src = $src.FullName
    $new = (Get-Content (Join-Path $src 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json)
    if ([version]$new.version -le [version]$current.version) { Write-Ok "Zaten güncel ($($current.version))"; return }
    Write-Step "Güncelleniyor: $($current.version) → $($new.version)"

    # Kütüphaneler değiştiyse: mevcut node_modules'un kopyası üzerinde, çalışan kuruluma dokunmadan hazırla
    $depsChanged = (($new.dependencies | ConvertTo-Json -Compress) -ne ($current.dependencies | ConvertTo-Json -Compress))
    $modules = Join-Path $InstallDir 'node_modules'
    if ($depsChanged) {
      Write-Step 'Kütüphaneler güncelleniyor (birkaç dakika sürebilir)…'
      if (Test-Path $modules) { cmd /d /c "robocopy `"$modules`" `"$(Join-Path $src 'node_modules')`" /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 >nul" }
      Push-Location $src
      try {
        cmd /d /c 'npm install --omit=dev --no-audit --no-fund --loglevel=error'
        if ($LASTEXITCODE -ne 0) { Stop-WithError 'Kütüphaneler indirilemedi (şirket ağı npm erişimini engelliyor olabilir). Güncelleme yapılmadı; çalışan sürüm olduğu gibi duruyor. Tam paketi (node_modules dahil) Kur.bat ile kurabilirsiniz.' }
      } finally { Pop-Location }
    }

    # 1) Hazırlık — Fikirhane çalışmaya devam ederken: yeni sürüm kurulum klasöründeki ".guncelleme" altına kopyalanır.
    #    Bu adımda bir şey ters giderse çalışan sürüme hiç dokunulmamış olur.
    $stage = Join-Path $InstallDir '.guncelleme'
    $rootFiles = @('package.json', 'package-lock.json', 'fikirhane.ps1', 'README.md', 'LICENSE', '.env.example')
    $dirs = @(@('src', 'public', 'scripts') | Where-Object { Test-Path (Join-Path $src $_) })
    if ($depsChanged) { $dirs += 'node_modules' }
    Write-Step 'Yeni sürüm hazırlanıyor (Fikirhane çalışmaya devam ediyor)…'
    try {
      if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
      New-Item -ItemType Directory -Force $stage | Out-Null
      foreach ($d in $dirs) { Copy-Mirror (Join-Path $src $d) (Join-Path $stage $d) }
    } catch {
      Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
      Stop-WithError "Yeni sürüm hazırlanamadı: $($_.Exception.Message). Çalışan sürüme dokunulmadı."
    }

    # 2) Değişim — Fikirhane yalnızca bu kısa adımda durur. Klasörler kopyalanmaz, yeniden adlandırılır:
    #    eskisi "<ad>.eski" olur, yenisi yerine geçer. Herhangi bir adım başarısız olursa adlar geri alınır.
    $wasRunning = Test-Running
    $swapped = @()
    $rootBackup = Join-Path $stage 'eski-dosyalar'
    try {
      if ($wasRunning) { Stop-Fikirhane; Start-Sleep -Seconds 1 }
      New-Item -ItemType Directory -Force $rootBackup | Out-Null
      foreach ($f in $rootFiles) {
        if (Test-Path (Join-Path $InstallDir $f)) { Copy-Item (Join-Path $InstallDir $f) -Destination $rootBackup -Force }
      }
      foreach ($d in $dirs) {
        $cur = Join-Path $InstallDir $d
        if (Test-Path "$cur.eski") { Remove-Item "$cur.eski" -Recurse -Force }
        if (Test-Path $cur) { Rename-WithRetry $cur "$d.eski" }
        $swapped += $d
        Move-WithRetry (Join-Path $stage $d) $cur
      }
      foreach ($f in $rootFiles) {
        if (Test-Path (Join-Path $src $f)) { Copy-Item (Join-Path $src $f) -Destination $InstallDir -Force }
      }
      $tam = [bool]($info -and $info.tam)
      Set-Content (Join-Path $InstallDir '.paket') (@{ version = $new.version; commit = ''; tam = $tam; tarih = (Get-Date -Format s) } | ConvertTo-Json) -Encoding UTF8
      Set-Content (Join-Path $InstallDir '.kurulu') (Get-Date -Format s) -Encoding ASCII
    } catch {
      $problem = $_.Exception.Message
      Write-Warn "Güncelleme sırasında hata oluştu: $problem"
      Write-Step 'Eski sürüm geri yükleniyor…'
      try {
        foreach ($d in $swapped) {
          $cur = Join-Path $InstallDir $d
          if (Test-Path "$cur.eski") {
            if (Test-Path $cur) { Remove-Item $cur -Recurse -Force }
            Rename-WithRetry "$cur.eski" $d
          }
        }
        foreach ($f in $rootFiles) {
          if (Test-Path (Join-Path $rootBackup $f)) { Copy-Item (Join-Path $rootBackup $f) -Destination $InstallDir -Force }
        }
        Write-Ok 'Eski sürüm geri yüklendi'
      } catch { Write-Warn "Eski sürüm geri yüklenemedi: $($_.Exception.Message). Fikirhane bir sonraki başlatılışta kendini onarmayı deneyecek." }
      Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
      if ($wasRunning) { try { $script:TarayiciAcma = $true; Start-Fikirhane } catch { } }
      Stop-WithError "Güncelleme tamamlanamadı; önceki sürüm ($($current.version)) kullanılmaya devam ediyor. Sebep: $problem"
    }
    # 3) Temizlik: eski klasörler ancak yenisi yerine geçtikten sonra silinir (silinemezse zararsızdır)
    foreach ($d in $dirs) { Remove-Item (Join-Path $InstallDir "$d.eski") -Recurse -Force -ErrorAction SilentlyContinue }
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem $InstallDir -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notlike '*\node_modules\*' } | Unblock-File -ErrorAction SilentlyContinue
    Write-Ok "Güncellendi: $($current.version) → $($new.version)"
    Install-EnvFile
    if (Test-DesktopApp) { [void](Build-DesktopApp) }
    if ($wasRunning) {
      $script:TarayiciAcma = $true
      Start-Fikirhane
      Write-Host '  Tarayıcıda sayfayı yenileyin.' -ForegroundColor Gray
    }
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Update-Fikirhane {
  # Arayüzden başlatılan güncelleme gizli pencerede çalışır; ne olduğu sonradan görülebilsin diye kaydedilir
  if ($env:FIKIRHANE_GUNCELLEME_KAYDI -eq '1') {
    try { Start-Transcript -Path (Join-Path $InstallDir 'fikirhane-guncelle.log') -Force | Out-Null } catch { }
  }
  if (-not (Test-FikirhaneDir $InstallDir)) { Stop-WithError "Kurulum bulunamadı: $InstallDir. Önce 'kur' komutunu çalıştırın." }
  Repair-Install
  if (-not (Test-Path (Join-Path $InstallDir '.git'))) {
    Update-PackageInstall
    return
  }
  # Önce yalnızca indirilir (git fetch): bu adım başarısız olursa çalışan sürüme hiç dokunulmamış olur.
  Push-Location $InstallDir
  try {
    $before = (git rev-parse HEAD)
    Write-Step 'Son sürüm indiriliyor…'
    git fetch --quiet
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'Son sürüm indirilemedi (git fetch). Çalışan sürüme dokunulmadı.' }
    $target = (git rev-parse '@{u}')
    if ($LASTEXITCODE -ne 0 -or -not $target) { Stop-WithError 'Bu klasör bir uzak dalı izlemiyor; güncelleme yapılamadı.' }
    if ($before -eq $target) {
      Write-Ok "Zaten güncel ($($before.Substring(0, 7)))"
      return
    }
    # İndirilen sürüm yerine konur (yerel, hızlı bir işlem). Fikirhane bu sırada eski sürümle çalışmaya devam eder.
    git merge --ff-only --quiet '@{u}'
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'Yeni sürüm uygulanamadı. Klasörde elle yapılmış değişiklikler olabilir (git status ile bakın). Çalışan sürüme dokunulmadı.' }
    Write-Step "Güncelleniyor: $($before.Substring(0, 7)) → $($target.Substring(0, 7))"
    # Kütüphaneler kurulamazsa dosyalar önceki sürüme geri alınır; yarım bir sürüm bırakılmaz
    cmd /d /c 'npm install --no-audit --no-fund --loglevel=error'
    if ($LASTEXITCODE -ne 0) {
      git reset --keep --quiet $before
      cmd /d /c 'npm install --no-audit --no-fund --loglevel=error >nul 2>&1'
      Stop-WithError "Kütüphaneler kurulamadı (şirket ağı npm erişimini engelliyor olabilir). Önceki sürüme ($($before.Substring(0, 7))) geri dönüldü; Fikirhane çalışmaya devam ediyor."
    }
  } finally { Pop-Location }
  Write-Ok "Güncellendi: $($before.Substring(0, 7)) → $($target.Substring(0, 7))"
  Install-EnvFile
  if (Test-DesktopApp) { [void](Build-DesktopApp) }
  # Fikirhane yalnızca en sonda, her şey hazır olduktan sonra yeniden başlatılır
  $wasRunning = Test-Running
  if ($wasRunning) {
    Stop-Fikirhane
    Start-Sleep -Seconds 1
    $script:TarayiciAcma = $true
    Start-Fikirhane
    Write-Host '  Tarayıcıda sayfayı yenileyin.' -ForegroundColor Gray
  }
}

# Kurulum sırasında: depoda daha yeni bir sürüm varsa Fikirhane başlatılmadan önce güncellenir. Bu adım kurulumu
# asla durdurmaz: sürüm okunamaz, indirilemez ya da kütüphaneler kurulamazsa kurulan sürümle devam edilir.
#   FIKIRHANE_UPDATE_CHECK=0 : bu adımı atlar      FIKIRHANE_UPDATE_URL : farklı bir depo/ayna için package.json adresi
function Update-DuringInstall {
  if ($env:FIKIRHANE_UPDATE_CHECK -eq '0' -or $env:FIKIRHANE_KURULUMDA_GUNCELLE -eq '0') { return }
  $current = $null
  try {
    $current = [string](Get-Content (Join-Path $InstallDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    $url = if ($env:FIKIRHANE_UPDATE_URL) { $env:FIKIRHANE_UPDATE_URL } else { 'https://raw.githubusercontent.com/mustafaergan/fikirhane/main/package.json' }
    Write-Step 'Güncelleme denetleniyor…'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $oldProgress = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
    try { $res = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 8 } finally { $ProgressPreference = $oldProgress }
    $body = if ($res.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($res.Content) } else { [string]$res.Content }
    $latest = [string]($body | ConvertFrom-Json).version
    if ([version]$latest -le [version]$current) { Write-Ok "Sürüm güncel ($current)"; return }
  } catch {
    Write-Warn "Güncelleme denetlenemedi (ağ bu adrese izin vermiyor olabilir); kurulan sürümle devam ediliyor$(if ($current) { " ($current)" })."
    return
  }
  Write-Step "Daha yeni bir sürüm var: $current → $latest. Güncelleniyor…"
  $script:HataFirlat = $true
  try {
    Update-Fikirhane
  } catch {
    Write-Warn "Güncelleme yapılamadı: $($_.Exception.Message)"
    Write-Warn "Kurulum, kurulan sürümle ($current) devam ediyor. Fikirhane açıldıktan sonra sağ üstteki 'Güncelleme var' düğmesiyle yeniden deneyebilirsiniz."
  } finally {
    $script:HataFirlat = $false
  }
}

function Show-Status {
  Write-Host ''
  $installed = Test-FikirhaneDir $InstallDir
  $yes = 'evet'; $no = 'hayır'
  Write-Host "  Kurulum klasörü : $InstallDir $(if ($installed) { '' } else { '(kurulu değil)' })"
  if ($installed) {
    $info = Read-PaketInfo $InstallDir
    if (Test-Path (Join-Path $InstallDir '.git')) {
      Push-Location $InstallDir
      try { Write-Host "  Sürüm           : $(git log -1 --format='%h %cd' --date=short) (git)" } finally { Pop-Location }
    } elseif ($info) {
      Write-Host "  Sürüm           : $($info.version) $($info.commit) (paket$(if ($info.tam) { ', tam' }))"
    }
  }
  Write-Host "  Çalışıyor       : $(if (Test-Running) { "$yes ($(Get-Url))" } else { $no })"
  $owner = Get-PortOwner (Get-Port)
  if ($owner -and -not $owner.ours) {
    Write-Host "  Port            : $(Get-Port) başka bir program tarafından kullanılıyor ($($owner.name)); 'baslat' yeni port soracak" -ForegroundColor Yellow
  } else {
    Write-Host "  Port            : $(Get-Port)"
  }
  Write-Host "  Masaüstü kısayolu: $(if (Test-Link $DesktopLink) { $yes } else { $no })"
  Write-Host "  Otomatik başlatma: $(if (Test-Link $StartupLink) { $yes } else { $no })"
  Write-Host "  Kayıt dosyası   : $LogFile"
  Write-Host ''
}

function Uninstall-Fikirhane {
  Write-Host ''
  Write-Host "  $AppName kaldırma" -ForegroundColor White
  Write-Host ''
  $installed = Test-FikirhaneDir $InstallDir
  $isRepo = Test-Path (Join-Path $InstallDir '.git')
  # Sadece paketle kurulmuş klasörler silinir (geliştiricinin git deposuna asla dokunulmaz)
  $markers = (Test-Path (Join-Path $InstallDir '.kurulu')) -or (Test-Path (Join-Path $InstallDir '.paket'))
  $full = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
  $unsafe = @($HOME, $env:LOCALAPPDATA, $env:APPDATA, $env:USERPROFILE, [IO.Path]::GetPathRoot($full)) |
    Where-Object { $_ } | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') }
  $canDelete = $installed -and -not $isRepo -and $markers -and ($unsafe -notcontains $full)
  $generalDir = Join-Path $HOME '.fikirhane'
  $hasShortcuts = (Test-Link $DesktopLink) -or (Test-Link $StartupLink) -or (Test-Link $StartMenuLink)

  if (-not $installed -and -not $hasShortcuts) {
    Write-Ok "Kaldırılacak bir Fikirhane kurulumu bulunamadı ($InstallDir)"
    return
  }

  Write-Host '  Yapılacaklar:'
  Write-Host '    - Çalışıyorsa Fikirhane durdurulacak'
  if ($hasShortcuts) { Write-Host '    - Masaüstü kısayolu ve Windows açılışında başlatma kaldırılacak' }
  if ($canDelete) { Write-Host "    - Kurulum klasörü silinecek (.env ayarları dahil): $InstallDir" }
  elseif ($isRepo) { Write-Host "    - Git ile indirilmiş klasöre dokunulmayacak: $InstallDir" -ForegroundColor Gray }
  if (-not $Veriler) { Write-Host "    - Kişisel verileriniz ($generalDir) korunacak" -ForegroundColor Gray }
  Write-Host ''
  if (-not $Evet -and -not (Confirm-Yes "$AppName kaldırılsın mı?" $false)) {
    Write-Host '  Vazgeçildi, hiçbir şey değiştirilmedi.' -ForegroundColor Gray
    return
  }

  [void](Stop-DesktopApp)
  Stop-Fikirhane
  if (Test-Link $DesktopLink) { Remove-Item $DesktopLink -Force; Write-Ok 'Masaüstü kısayolu kaldırıldı' }
  if (Test-Link $StartMenuLink) { Remove-Item $StartMenuLink -Force }
  Disable-Autostart

  if ($canDelete) {
    Write-Step 'Kurulum klasörü siliniyor…'
    # rmdir, uzun node_modules yollarında Remove-Item'dan daha güvenilir
    if (Remove-DirWithRetry $full) { Write-Ok "Kurulum klasörü silindi: $full" }
    else { Write-Warn "Klasör tamamen silinemedi (açık bir dosya olabilir): $full — elle silebilirsiniz." }
  }

  # Kullanıcı verileri: yalnızca açıkça istenirse silinir (-Veriler ya da soruya "evet"). -Evet tek başına silmez;
  # yeniden kurulumda komutlar, yerel modeller ve klasörsüz sohbet dosyaları yerinde olur.
  if (Test-Path $generalDir) {
    $wipe = $Veriler -or (-not $Evet -and (Confirm-Yes "Kişisel verileriniz de silinsin mi? (${generalDir}: yüklediğiniz belgeler, notlar, sorular ve ayarlar)" $false))
    if ($wipe) { if (Remove-DirWithRetry $generalDir) { Write-Ok "Silindi: $generalDir" } }
    else { Write-Host "  Kişisel verileriniz korundu: $generalDir (silmek için: kaldir -Veriler)" -ForegroundColor Gray }
  }

  Write-Host ''
  Write-Host "  $AppName kaldırıldı." -ForegroundColor Green
  if (-not $canDelete -and $installed) { Write-Host "  Dosyalar yerinde duruyor: $InstallDir" -ForegroundColor Gray }
  Write-Host ''
}

try {
  switch ($Komut) {
    'kur' { Install-Fikirhane }
    'baslat' { Start-Fikirhane }
    'durdur' { Stop-Fikirhane }
    'guncelle' { Update-Fikirhane }
    'durum' { Show-Status }
    'otomatik-ac' { Enable-Autostart }
    'otomatik-kapat' { Disable-Autostart }
    'kisayol-ac' { [void](Install-DesktopShortcut) }
    'kisayol-kapat' { Remove-DesktopShortcut }
    'masaustu-ac' { if (-not (Enable-DesktopApp)) { exit 1 } }
    'masaustu-kapat' { Disable-DesktopApp }
    'ayarlar' { Show-Settings }
    'kosullar' { Get-TermsLines | ForEach-Object { Write-Output $_ } }
    'kaldir' { Uninstall-Fikirhane }
  }
} finally {
  # Kaldir.bat kendi klasörünü silebildiği için bekleme .bat'ta değil burada yapılır
  if ($Bekle -and $env:FIKIRHANE_SORMA -ne '1') {
    try { [void](Read-Host "  Kapatmak için Enter'a basın") } catch { }
  }
}
