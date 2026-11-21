// Yeni Fikirhane sürümü var mı? Depodaki package.json sürümü kurulu olanla karşılaştırılır.
// Yalnızca sürüm numarası okunur; hiçbir kullanıcı bilgisi gönderilmez. Ağ engelliyse sessizce geçilir.
//   FIKIRHANE_UPDATE_URL   : farklı bir depo/ayna için package.json adresi
//   FIKIRHANE_UPDATE_CHECK=0 : denetimi kapatır
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_URL = 'https://raw.githubusercontent.com/mustafaergan/fikirhane/main/package.json';
const API_URL = 'https://api.github.com/repos/mustafaergan/fikirhane/contents/package.json?ref=main';
// Okunan sürüm yarım saat geçerlidir (arayüz yarım saatte bir sorar). Eskiden sonuç bir gün saklanıyordu: güncellemeden
// hemen sonra "depodaki = kurulu" sonucu ertesi sabaha kadar kalıyor, o arada çıkan sürümler hiç görünmüyordu.
const CACHE_MS = 30 * 60 * 1000;
// Depo okunamadıysa (açılışta ağ henüz hazır değil, bilgisayar uykudan yeni uyandı…) beş dakika sonra yeniden denenir
const RETRY_MS = 5 * 60 * 1000;
let cache = null; // { at, latest, failed }
let logged = '';

/** a > b ise pozitif (yalnızca sayısal parçalar karşılaştırılır: 0.10.0 > 0.9.2) */
export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

// Windows'ta fikirhane.ps1 hem git hem paket kurulumunu günceller (paket kurulumunda son sürümü zip olarak indirir)
const canApply = () => process.platform === 'win32' && fs.existsSync(path.join(ROOT, 'fikirhane.ps1'));

/**
 * Güncellemeyi başlatır: "fikirhane.ps1 guncelle" son sürümü çeker, paketleri kurar ve Fikirhane'yi yeniden başlatır.
 * Betik Fikirhane'yi durduracağı için bu sürecin alt süreci olmamalıdır; "start" ile bağımsız başlatılır.
 */
export function applyUpdate() {
  if (!canApply()) return { started: false };
  const script = path.join(ROOT, 'fikirhane.ps1');
  const child = spawn(process.env.ComSpec || 'cmd.exe',
    ['/d', '/s', '/c', `"start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}" guncelle"`],
    { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true, env: { ...process.env, FIKIRHANE_SORMA: '1', FIKIRHANE_GUNCELLEME_KAYDI: '1' } }); // çıktı: fikirhane-guncelle.log
  child.unref();
  return { started: true };
}

/** Adresteki package.json'un sürümü; okunamazsa '' */
async function versionAt(url, accept) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept, 'user-agent': 'fikirhane' } });
    if (!res.ok) return '';
    return versionIn(await res.text());
  } catch { return ''; }
}
const versionIn = (text) => { try { const v = String(JSON.parse(text).version || ''); return /^\d+\.\d+\.\d+/.test(v) ? v : ''; } catch { return ''; } };

/**
 * Aynı dosyayı Windows'un kendi ağ katmanıyla (PowerShell) okur. Node, Windows'ta tanımlı proxy'yi (kurum ağlarındaki
 * otomatik yapılandırma dahil) kullanmaz; PowerShell kullanır. Güncellemenin kendisi de PowerShell ile indirilir:
 * doğrudan okuma başarısız olduğunda sürüm de aynı yoldan sorulur ki "güncelleme yapılabiliyor ama görünmüyor" olmasın.
 * Adres komut satırına yazılmaz, ortam değişkeniyle verilir. Okunamazsa '' döner.
 */
export function systemText(url) {
  if (process.platform !== 'win32') return Promise.resolve('');
  const cmd = "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; "
    + '$r = Invoke-WebRequest -Uri $env:FIKIRHANE_DENETIM_ADRESI -UseBasicParsing -TimeoutSec 8; '
    + 'if ($r.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($r.Content) } else { [string]$r.Content }';
  return new Promise((resolve) => {
    try {
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
        { env: { ...process.env, FIKIRHANE_DENETIM_ADRESI: url }, timeout: 20_000, windowsHide: true, encoding: 'utf8' },
        (err, stdout) => resolve(err ? '' : String(stdout || '').trim()));
    } catch { resolve(''); }
  });
}
let systemGet = systemText;
/** Testler için: Windows ağ katmanıyla okuma yerine çağrılacak işlev */
export function setSystemGet(fn) { systemGet = fn || systemText; }
/** Testler için: saklanan sonucu siler */
export function resetUpdateCache() { cache = null; logged = ''; }

/**
 * Depodaki sürümü okur. { current, latest, available, how, canApply, checked, failed }.
 * force: saklanan sonuca bakmadan yeniden okur (kullanıcı elle denetlediğinde ve zamanlı denetimde).
 * Okuma başarısız olursa daha önce görülmüş sürüm unutulmaz (failed: true ile birlikte döner).
 */
export async function checkUpdate({ force = false, now = Date.now() } = {}) {
  const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  // Git ile indirilmişse "fikirhane.ps1 guncelle", paketten kurulmuşsa yeni paket
  const how = fs.existsSync(path.join(ROOT, '.git')) ? 'git' : 'paket';
  const view = (c) => ({ current, latest: c?.latest || null, available: Boolean(c?.latest) && compareVersions(c.latest, current) > 0, how, canApply: canApply(),
    ...(c ? { checked: c.at, ...(c.failed ? { failed: true } : {}) } : {}) });
  if (process.env.FIKIRHANE_UPDATE_CHECK === '0') return view(null);
  const age = cache ? now - cache.at : Infinity;
  if (!force && cache && age >= 0 && age < (cache.failed ? RETRY_MS : CACHE_MS)) return view(cache);
  let latest = '';
  try {
    try {
      if (typeof tls.getCACertificates === 'function' && typeof tls.setDefaultCACertificates === 'function')
        tls.setDefaultCACertificates([...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])]);
    } catch { /* eski Node */ }
    // Olağan adres (raw.githubusercontent.com) dosyayı birkaç dakika önbellekte tutar. Kullanıcı elle denetlediğinde
    // önce önbelleksiz GitHub API'si sorulur ki yeni gönderilmiş sürüm hemen görülsün; o yanıt vermezse (saatlik
    // istek sınırı, ağ engeli) olağan adrese dönülür.
    const custom = process.env.FIKIRHANE_UPDATE_URL;
    const sources = custom ? [[custom, 'application/json']] : [...(force ? [[API_URL, 'application/vnd.github.raw+json']] : []), [DEFAULT_URL, 'application/json']];
    for (const [url, accept] of sources) {
      latest = await versionAt(url, accept);
      if (latest) break;
    }
    if (!latest) latest = versionIn(await systemGet(custom || DEFAULT_URL));
  } catch { /* ağ yok / engelli: bildirim gösterilmez */ }
  cache = latest ? { at: now, latest } : { at: now, latest: cache?.latest || '', failed: true };
  const line = `[güncelleme] kurulu ${current}, depodaki ${latest || 'okunamadı'}`;
  if (line !== logged) { logged = line; console.log(line); } // aynı sonuç her denetimde yeniden yazılmaz
  return view(cache);
}

/** Bir sonraki günlük denetim anı: yerel saatle "hour":00 (o an geçtiyse ertesi gün) */
export function nextDailyAt(now, hour = 9) {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * Güncellemeyi Fikirhane açılır açılmaz bir kez, sonra her sabah 9'da denetler. Bilgisayar o saatte kapalı ya da
 * uykudaysa denetim açıldığında yapılır (saat birkaç dakikada bir yoklanır). Depo okunamadıysa ertesi sabah beklenmez:
 * beş dakika sonra, sonra aralığı ikiye katlayarak (en çok saatte bir) yeniden denenir. Sayfa açıkken arayüz ayrıca
 * yarım saatte bir sorar. FIKIRHANE_UPDATE_HOUR ile saat, FIKIRHANE_UPDATE_CHECK=0 ile kapatma.
 */
export function startDailyCheck({ hour = Number(process.env.FIKIRHANE_UPDATE_HOUR) || 9, check = () => checkUpdate({ force: true }), now = () => Date.now(), tickMs = 5 * 60 * 1000, firstMs = 5000, retryMs = RETRY_MS } = {}) {
  if (process.env.FIKIRHANE_UPDATE_CHECK === '0') return () => {};
  let due = nextDailyAt(now(), hour);
  let wait = retryMs;
  const run = () => Promise.resolve().then(check).then((r) => {
    if (!r?.failed) { wait = retryMs; return; }
    due = Math.min(due, now() + wait);
    wait = Math.min(wait * 2, 60 * 60 * 1000);
  }).catch(() => {});
  const first = setTimeout(run, firstMs);
  const timer = setInterval(() => {
    if (now() < due) return;
    due = nextDailyAt(now(), hour);
    run();
  }, tickMs);
  first.unref?.();
  timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
