#!/usr/bin/env node
// Dağıtım paketi (zip) hazırlar: zip'i çıkarıp Kur.bat ile kurmak için. Git gerekmez.
//   npm run paket            → hafif paket (kurulumda kütüphaneler npm'den indirilir)
//   npm run paket -- --tam   → tam paket (kütüphaneler ve Node.js dahil; npm ve Node kurulumu gerekmez)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const full = process.argv.includes('--tam');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
let commit = '';
try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { /* git yoksa */ }

const name = `Fikirhane-${pkg.version}${full ? '-tam' : ''}`;
const dist = path.join(ROOT, 'dist');
const stage = path.join(dist, 'stage', 'Fikirhane');
const zip = path.join(dist, `${name}.zip`);
fs.rmSync(path.join(dist, 'stage'), { recursive: true, force: true });
fs.rmSync(zip, { force: true });
fs.mkdirSync(stage, { recursive: true });

for (const f of ['src', 'public', 'fikirhane.ps1', 'package.json', 'package-lock.json', 'README.md', 'LICENSE']) fs.cpSync(path.join(ROOT, f), path.join(stage, f), { recursive: true });

if (full) {
  console.log('Kütüphaneler kopyalanıyor…');
  // Yalnızca çalışma için gereken kütüphane girer: pdfjs'in isteğe bağlı görüntü çizme eklentisi (yerel ikili dosya,
  // metin çıkarmada kullanılmaz) pakete alınmaz.
  fs.cpSync(path.join(ROOT, 'node_modules', 'pdfjs-dist'), path.join(stage, 'node_modules', 'pdfjs-dist'), { recursive: true, filter: (p) => !/\.map$/.test(p) });
  if (process.platform === 'win32') {
    const runtime = path.join(stage, 'runtime');
    fs.mkdirSync(runtime, { recursive: true });
    console.log(`Node.js ${process.version} pakete ekleniyor…`);
    for (const f of ['node.exe', 'LICENSE']) if (fs.existsSync(path.join(path.dirname(process.execPath), f))) fs.copyFileSync(path.join(path.dirname(process.execPath), f), path.join(runtime, f));
  } else console.warn('Uyarı: Node.js yalnızca Windows\'ta hazırlanan tam pakete eklenir.');
}

fs.writeFileSync(path.join(stage, '.paket'), JSON.stringify({ version: pkg.version, commit, tam: full, tarih: new Date().toISOString() }, null, 2));

const konsol = ['chcp 65001 >nul', 'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fikirhane.ps1" kur', 'echo.', 'pause'];
fs.writeFileSync(path.join(stage, 'Kur.bat'), ['@echo off', 'if not exist "%~dp0src\\masaustu\\sihirbaz.ps1" goto konsol',
  'start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0src\\masaustu\\sihirbaz.ps1"', 'exit /b', ':konsol', ...konsol, ''].join('\r\n'));
fs.writeFileSync(path.join(stage, 'Kur-konsol.bat'), ['@echo off', ...konsol, ''].join('\r\n'));
fs.writeFileSync(path.join(stage, 'Kaldir.bat'), ['@echo off', 'chcp 65001 >nul',
  'cd /d "%TEMP%" & powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fikirhane.ps1" kaldir -Bekle & exit /b', ''].join('\r\n'));

fs.writeFileSync(path.join(stage, 'KURULUM.txt'), '\uFEFF' + [
  `Fikirhane ${pkg.version}${commit ? ` (${commit})` : ''}${full ? ' — tam paket' : ''}`,
  '',
  'Kurulum',
  full ? '  1. Node.js kurmanız gerekmez: bu paket kendi Node.js\'ini içinde getirir.' : '  1. Node.js kurulu değilse https://nodejs.org adresinden LTS sürümünü kurun (ya da tam paketi kullanın).',
  '  2. Bu zip dosyasını herhangi bir klasöre çıkarın.',
  '  3. Kur.bat dosyasına çift tıklayın; kurulum sihirbazı açılır (İleri > İleri > Kur).',
  '     Komut penceresinden kurmak isterseniz Kur-konsol.bat kullanın.',
  '',
  'Fikirhane %LOCALAPPDATA%\\Fikirhane klasörüne kurulur. Sihirbazda masaüstü uygulaması olarak mı',
  '(kendi penceresi, görev çubuğuna sabitlenebilir) yoksa tarayıcıda mı açılacağını seçersiniz.',
  'Depoda daha yeni bir sürüm varsa kurulum sırasında güncellenir; yapılamazsa paketteki sürüm kurulur.',
  '',
  'Yerel dil modeli',
  '  Fikirhane bu bilgisayarda ya da yerel ağınızda çalışan bir model sunucusunu kullanır (Ollama, LM Studio vb.).',
  '  Kurulumdan sonra Fikirhane içindeki Ayarlar\'dan sunucu adresini ve modeli girin.',
  '  Model tanımlı değilken de belge yükleyip içinde arama yapabilirsiniz.',
  '',
  'Kaldırma',
  '  Kaldir.bat dosyasına çift tıklayın. Belgeleriniz ve notlarınız (%USERPROFILE%\\.fikirhane) siz istemedikçe silinmez.',
  '',
  'Komutlar (kurulum klasöründe)',
  '  fikirhane.ps1 baslat | durdur | durum | guncelle | masaustu-ac | masaustu-kapat | kaldir',
  '',
].join('\r\n'));

console.log('Sıkıştırılıyor…');
const cwd = path.join(dist, 'stage');
if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-cf', zip, 'Fikirhane'], { cwd, stdio: 'inherit' });
else execFileSync('zip', ['-qr', zip, 'Fikirhane'], { cwd, stdio: 'inherit' });
fs.rmSync(path.join(dist, 'stage'), { recursive: true, force: true });
console.log(`\nHazır: ${path.relative(ROOT, zip)} (${(fs.statSync(zip).size / 1024 / 1024).toFixed(1)} MB)`);
