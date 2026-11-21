// Senaryolar: seçici denetimi, adım denetimi, betik üretimi ve sonuç bildirimi.
// Üretilen betikler sahte bir Playwright kütüphanesiyle gerçekten çalıştırılır: betik adımları sırayla yürütür,
// sonucu test sunucusuna bildirir; kaldığında ekranın karta göre değişip değişmediği anlaşılır. Tarayıcı gerekmez.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fikirhane-senaryo-test-'));
process.env.FIKIRHANE_HOME = tmp;
process.env.FIKIRHANE_UPDATE_CHECK = '0';
process.env.FIKIRHANE_ATOLYE_FILE = path.join(tmp, 'atolye-yerel-llm.json'); // gerçek ~/.atolye okunmaz
const senaryo = await import('../src/senaryo.js');
const gezgin = await import('../src/gezgin.js');
const lib = await import('../src/library.js');
const { createServer } = await import('../src/server.js');

const origin = 'https://uygulama.example.com';
const via = (s) => (!s ? '' : `"${s.name}" ${s.role === 'link' ? 'bağlantısı' : 'düğmesi'}`);
const mk = (no, from, step, raw) => ({ no, from, step, via: via(step), ...gezgin.makeCard({ origin, ...raw, url: origin + raw.url }, origin) });
const FORM = { url: '/uyeler/yeni', title: 'Yeni üye', headings: ['Yeni üye'],
  fields: [{ name: 'Ad', type: 'text', required: true, locator: "getByLabel('Ad')" }, { name: 'Giriş kodu', type: 'password', locator: "getByLabel('Giriş kodu')" }, { name: 'Tür', type: 'select', options: ['Bireysel', 'Kurumsal'], locator: "getByLabel('Tür')" }],
  buttons: [{ name: 'Kaydet', role: 'button', locator: "getByRole('button', { name: 'Kaydet' })" }] };
const cards = [
  mk(1, null, null, { url: '/', title: 'Ana sayfa', links: [{ name: 'Üyeler', href: `${origin}/uyeler`, locator: "getByRole('link', { name: 'Üyeler' })" }] }),
  mk(2, 1, { role: 'link', name: 'Üyeler', row: false }, { url: '/uyeler', title: 'Üyeler', buttons: [{ name: 'Yeni üye', role: 'button', locator: "getByRole('button', { name: 'Yeni üye' })" }] }),
  mk(3, 2, { role: 'button', name: 'Yeni üye', row: false }, FORM),
  mk(4, 2, { role: 'button', name: 'Süz', row: false }, { url: '/uyeler', title: 'Üyeler', dialog: 'Süzgeç' }),
];

test('seçiciler dar bir dilbilgisine göre ayrıştırılır; kod sokulamaz', () => {
  const same = ["getByRole('button', { name: 'Kaydet' })", "getByLabel('Ad', { exact: true }).first()", 'locator(\'a[href*="/urun/"]\').nth(2)', "getByTestId('kaydet')",
    "locator('#tablo').getByRole('row').filter({ hasText: 'Ali' }).getByRole('button', { name: 'Sil' })"];
  for (const s of same) assert.equal(senaryo.locatorText(senaryo.parseLocator(s)), s);
  assert.equal(senaryo.locatorText(senaryo.parseLocator('page.getByText("O\'nun adı")')), "getByText('O\\'nun adı')", 'page. öneki ve çift tırnak kabul edilir, tek biçime çevrilir');
  const bad = ["getByRole('button').click()", "getByRole('button'); process.exit(1)", 'getByRole(`a${1}`)', "locator('x', { hasText: require('fs') })", 'first()', 'getByText(ad)', "evaluate('1')",
    "getByRole('button', { name: { a: 1 } })", "getByRole('button', { __proto__: 'x' })", "getByRole('button', { onclick: 'x' })", "getByLabel('a') + 1", "getByRole('button'", '', "getByRole('BUTTON; x')",
    "getByLabel('a').getByLabel('b').getByLabel('c').getByLabel('d').getByLabel('e').getByLabel('f').getByLabel('g')", `getByText('${'x'.repeat(400)}')`];
  for (const s of bad) assert.throws(() => senaryo.parseLocator(s), { code: 'bad-locator' }, s);
});

test('adımlar denetlenir: yalnızca bilinen işlemler, bu sitedeki adresler; parola alanına sabit değer yazılamaz', () => {
  const norm = (steps) => senaryo.normalizeSteps(steps, { origin, cards });
  const steps = norm([{ do: 'goto', screen: 2 }, { do: 'goto', url: '/uye/{{no}}?sekme=bilgi' }, { do: 'click', locator: 'page.getByRole("button", { name: "Yeni üye" })', note: '  formu   açar ' },
    { do: 'fill', locator: "getByLabel('Ad')", value: 'Ayşe' }, { do: 'fill', locator: "getByLabel('Giriş kodu')", value: '{{kod}}' }, { do: 'select', locator: "getByLabel('Tür')", value: 'Kurumsal' },
    { do: 'check', locator: "getByLabel('Bülten')" }, { do: 'press', key: 'Enter' }, { do: 'expect', text: '{{ad}} kaydedildi' }, { do: 'expectUrl', text: '/uyeler' }, { do: 'expectHidden', locator: "getByRole('dialog')" }]);
  assert.deepEqual(steps.slice(0, 3), [{ do: 'goto', url: `${origin}/uyeler` }, { do: 'goto', url: `${origin}/uye/{{no}}?sekme=bilgi` }, { do: 'click', locator: "getByRole('button', { name: 'Yeni üye' })", note: 'formu açar' }]);
  assert.deepEqual(senaryo.scenarioVars(steps), ['no', 'kod', 'ad']);
  assert.deepEqual(steps.map(senaryo.stepLabel), ['Git: /uyeler', `Git: ${origin}/uye/{{no}}?sekme=bilgi`, "Tıkla: getByRole('button', { name: 'Yeni üye' })", "Doldur: getByLabel('Ad') = Ayşe", "Doldur: getByLabel('Giriş kodu') = {{kod}}",
    "Seç: getByLabel('Tür') = Kurumsal", "İşaretle: getByLabel('Bülten')", 'Tuş: Enter', 'Bekle: "{{ad}} kaydedildi" görünsün', 'Bekle: adres "/uyeler" içersin', "Bekle: getByRole('dialog') kaybolsun"]);
  const fails = (step, code, detail) => assert.throws(() => norm([step]), (err) => err.code === code && (!detail || detail.test(err.detail)), JSON.stringify(step));
  fails({ do: 'evaluate', text: 'x' }, 'bad-step', /bilinmeyen işlem/);
  fails({ do: 'click', locator: "getByRole('button').click()" }, 'bad-step', /seçici anlaşılamadı/);
  fails({ do: 'goto', url: 'https://baska.example.com/' }, 'bad-step', /bu sitede olmalı/);
  fails({ do: 'goto', url: 'javascript:alert(1)' }, 'bad-step');
  fails({ do: 'goto', screen: 4 }, 'bad-step', /açık pencerenin adresi olmaz/);
  fails({ do: 'goto', screen: 99 }, 'bad-step', /Ekran 99 yok/);
  fails({ do: 'press', key: 'Enter"); process.exit(1); ("' }, 'bad-step', /tuş adı/);
  fails({ do: 'expect', text: ' ' }, 'bad-step');
  fails({ do: 'fill', locator: "getByLabel('Giriş kodu')", value: '1234' }, 'secret-literal', /1\. adım/); // kartta türü parola olan alan
  fails({ do: 'fill', locator: "getByPlaceholder('Şifreniz')", value: 'abc' }, 'secret-literal'); // adı parolaya benzeyen alan
  assert.throws(() => norm([]), { code: 'no-steps' });
  assert.throws(() => norm(Array.from({ length: 61 }, () => ({ do: 'press', key: 'Tab' }))), { code: 'too-many-steps' });
});

// ---------- Sunucu + sahte Playwright ----------
let app; let base; let site;
const pw = path.join(tmp, 'sahte-playwright');
const kayit = path.join(tmp, 'cagrilar.jsonl');
before(async () => {
  site = lib.addSite({ origin, start: `${origin}/`, cards }).id;
  app = await createServer({ port: 0 });
  base = `http://127.0.0.1:${app.address().port}`;
  // Sahte Playwright: her çağrıyı dosyaya yazar; SAHTE_KIR içeren ilk işlemde zaman aşımı hatası verir
  fs.mkdirSync(pw, { recursive: true });
  fs.writeFileSync(path.join(pw, 'package.json'), '{"name":"playwright","main":"index.js"}');
  fs.writeFileSync(path.join(pw, 'index.js'), `const fs = require('fs');
const log = (x) => fs.appendFileSync(process.env.SAHTE_KAYIT, JSON.stringify(x) + '\\n');
const ACT = ['click', 'fill', 'selectOption', 'check', 'uncheck', 'waitFor'];
const chain = (parts) => new Proxy({}, { get: (_t, fn) => (fn === 'then' ? undefined : (...args) => {
  const next = [...parts, [fn, ...args]];
  if (!ACT.includes(fn)) return chain(next);
  log(next);
  return process.env.SAHTE_KIR && JSON.stringify(next).includes(process.env.SAHTE_KIR) ? Promise.reject(new Error('Timeout 8000ms exceeded.\\nCall log: uzun ayrıntı')) : Promise.resolve();
}) });
const own = { goto: async (u) => log([['goto', u]]), setDefaultTimeout: (ms) => log([['timeout', ms]]), url: () => '${origin}/uyeler/yeni', keyboard: { press: async (k) => log([['press', k]]) },
  waitForURL: async (fn) => log([['waitForURL', fn(new URL('${origin}/uyeler?x=1'))]]), evaluate: async () => JSON.parse(process.env.SAHTE_EKRAN || 'null') };
const page = new Proxy(own, { get: (t, fn) => (fn in t ? t[fn] : fn === 'then' ? undefined : (...args) => chain([[fn, ...args]])) });
const context = { pages: () => [], newPage: async () => page, close: async () => {}, on: () => {} };
exports.chromium = { launch: async (o) => { log([['launch', o.channel, o.headless, Object.keys(o.env).some((k) => k.toUpperCase() === '__COMPAT_LAYER')]]); return { newContext: async () => context, close: async () => {} }; },
  launchPersistentContext: async (dir, o) => { log([['profil', dir, o.headless]]); return context; } };
`);
});
after(() => { app.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const call = (p, body, method = body ? 'POST' : 'GET') => fetch(base + p, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-fikirhane': '1' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
/** Senaryonun betiğini alır, sözdizimini denetler ve sahte Playwright ile çalıştırır */
async function run(sid, env = {}, args = []) {
  const r = await call(`/api/sites/${site}/scenarios/${sid}/script`);
  const file = path.join(tmp, r.file);
  fs.writeFileSync(file, r.script);
  assert.equal(spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }).stderr, '', 'üretilen betik geçerli JavaScript olmalı');
  fs.rmSync(kayit, { force: true });
  // Betik sonucu bu süreçteki sunucuya bildirir: süreç beklenirken olay döngüsü açık kalmalı (spawnSync olmaz)
  const p = await new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], { env: { ...process.env, __COMPAT_LAYER: 'DetectorsAppHealth', FIKIRHANE_PLAYWRIGHT: pw, SAHTE_KAYIT: kayit, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const calls = fs.existsSync(kayit) ? fs.readFileSync(kayit, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { code: p.status, out: p.stdout.trim(), err: p.stderr, calls, script: r.script, info: r };
}
const STEPS = [{ do: 'goto', screen: 2 }, { do: 'click', locator: "getByRole('button', { name: 'Yeni üye' })" }, { do: 'fill', locator: "getByLabel('Ad')", value: '{{ad}}' },
  { do: 'fill', locator: "getByLabel('Giriş kodu')", value: '{{kod}}' }, { do: 'select', locator: "getByLabel('Tür')", value: 'Kurumsal' }, { do: 'click', locator: "getByRole('button', { name: 'Kaydet' })" },
  { do: 'expect', text: '{{ad}} kaydedildi' }, { do: 'expectUrl', text: '/uyeler' }];

test('senaryo kaydedilir, güncellenir, listelenir; site özetinde görünür', async () => {
  assert.equal((await call(`/api/sites/${site}/scenarios`)).text, 'Bu site için kayıtlı senaryo yok.');
  assert.equal((await call(`/api/sites/${site}/scenarios`, { name: 'Yeni üye ekle', steps: [] })).code, 'no-steps');
  assert.equal((await call(`/api/sites/${site}/scenarios`, { name: ' ', steps: STEPS })).code, 'no-name');
  const secret = await call(`/api/sites/${site}/scenarios`, { name: 'Yeni üye ekle', steps: [{ do: 'fill', locator: "getByLabel('Giriş kodu')", value: '1234' }] });
  assert.equal(secret.code, 'secret-literal');
  assert.match(secret.error, /\{\{parola\}\}.*1\. adım/);
  assert.equal((await call('/api/sites/yok/scenarios', { name: 'x', steps: STEPS })).code, 'not-found');
  assert.equal((await fetch(`${base}/api/sites/${site}/scenarios`, { method: 'POST', body: '{}' })).status, 403, 'özel başlık olmadan senaryo yazılamaz');

  const saved = await call(`/api/sites/${site}/scenarios`, { name: 'Yeni üye ekle', description: 'Üyeler ekranından yeni üye kaydı', steps: STEPS.slice(0, 6) });
  assert.equal(saved.ok, true, saved.error);
  const sid = saved.scenario.id;
  assert.match(sid, /^s[0-9a-f]{6}$/);
  assert.equal(saved.text, ['Kaydedildi.', `Senaryo [${sid}]: Yeni üye ekle — henüz çalıştırılmadı`, 'Üyeler ekranından yeni üye kaydı', '1. Git: /uyeler', "2. Tıkla: getByRole('button', { name: 'Yeni üye' })",
    "3. Doldur: getByLabel('Ad') = {{ad}}", "4. Doldur: getByLabel('Giriş kodu') = {{kod}}", "5. Seç: getByLabel('Tür') = Kurumsal", "6. Tıkla: getByRole('button', { name: 'Kaydet' })",
    'Değişkenler: {{ad}}, {{kod}} (çalıştırırken FIKIRHANE_VAR_AD=… biçiminde verilir)'].join('\n'));
  // Aynı adla yeniden kayıt günceller; kartlarda olmayan seçici söylenir
  const again = await call(`/api/sites/${site}/scenarios`, { name: 'yeni üye EKLE', steps: [...STEPS, { do: 'click', locator: "getByRole('button', { name: 'Kapat' })" }] });
  assert.deepEqual([again.scenario.id, again.scenario.steps.length], [sid, 9]);
  assert.match(again.text, /Not: 1 adımın seçicisi ekran kartlarında yok; çalıştırılarak doğrulanmalı\.$/);
  await call(`/api/sites/${site}/scenarios`, { id: sid, name: 'Yeni üye ekle', steps: STEPS });
  assert.equal((await call(`/api/sites/${site}/scenarios`, { id: 'syok', name: 'x', steps: STEPS })).code, 'not-found');

  const list = await call(`/api/sites/${site}/scenarios`);
  assert.deepEqual(list.scenarios.map((s) => [s.id, s.name, s.steps, s.status, s.vars]), [[sid, 'Yeni üye ekle', 8, 'denenmedi', ['ad', 'kod']]]);
  assert.equal(list.text, `- [${sid}] Yeni üye ekle (8 adım) — henüz çalıştırılmadı`);
  assert.ok((await call(`/api/sites/${site}`)).text.endsWith(`## Senaryolar (kayıtlı, yeniden çalıştırılabilir)\n- [${sid}] Yeni üye ekle (8 adım) — henüz çalıştırılmadı`));
  assert.equal((await call(`/api/docs/${site}`)).scenarios[0].text.split('\n')[1], '1. Git: /uyeler');
  assert.deepEqual(fs.readdirSync(path.join(tmp, 'belgeler', site)).sort(), ['ekranlar.json', 'meta.json', 'parcalar.json', 'sayfalar.json', 'senaryolar.json']);
});

test('betik çalışır: adımlar sırayla yürür, sonuç Fikirhane\'ye bildirilir; kaldığında ekranın değişip değişmediği anlaşılır', async () => {
  const sid = (await call(`/api/sites/${site}/scenarios`)).scenarios[0].id;
  // Değişken verilmeden ve Playwright olmadan çalıştırılamaz (çıkış kodu 2)
  let r = await run(sid);
  assert.deepEqual([r.code, r.out, r.calls], [2, 'ÇALIŞTIRILAMADI: şu değişkenler verilmeli: FIKIRHANE_VAR_AD, FIKIRHANE_VAR_KOD', []]);
  r = await run(sid, { FIKIRHANE_VAR_AD: 'Ayşe', FIKIRHANE_VAR_KOD: '4711', FIKIRHANE_PLAYWRIGHT: path.join(tmp, 'yok') });
  assert.deepEqual([r.code, r.out], [2, 'ÇALIŞTIRILAMADI: Playwright bulunamadı. FIKIRHANE_PLAYWRIGHT ile kütüphanenin klasörünü verin.']);
  assert.match(r.info.text, /Gerekli değişkenler: FIKIRHANE_VAR_AD, FIKIRHANE_VAR_KOD$/);
  assert.ok(!r.script.includes('4711') && !r.script.includes('Ayşe'), 'değişken değerleri betiğe yazılmaz');

  // Geçen çalıştırma
  r = await run(sid, { FIKIRHANE_VAR_AD: 'Ayşe', FIKIRHANE_VAR_KOD: '4711' });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /^GEÇTİ: "Yeni üye ekle" \(8 adım, \d+\.\d sn\)\. Sonuç Fikirhane'ye kaydedildi\.$/);
  assert.deepEqual(r.calls, [[['launch', 'msedge', true, false]], [['timeout', 8000]], [['goto', `${origin}/uyeler`]], [['getByRole', 'button', { name: 'Yeni üye' }], ['click']],
    [['getByLabel', 'Ad'], ['fill', 'Ayşe']], [['getByLabel', 'Giriş kodu'], ['fill', '4711']], [['getByLabel', 'Tür'], ['selectOption', 'Kurumsal']], [['getByRole', 'button', { name: 'Kaydet' }], ['click']],
    [['getByText', 'Ayşe kaydedildi'], ['first'], ['waitFor', { state: 'visible' }]], [['waitForURL', true]]]);
  let s = (await call(`/api/sites/${site}/scenarios/${sid}`)).scenario;
  assert.deepEqual([s.status, s.runs.length, s.runs[0].ok], ['geçti', 1, true]);

  // Kalan çalıştırma, arayüz değişmiş: "Kaydet" düğmesi "Gönder" olmuş
  const changed = { ...FORM, origin, url: `${origin}/uyeler/yeni?kaynak=liste`, buttons: [{ name: 'Gönder', role: 'button', locator: "getByRole('button', { name: 'Gönder' })" }] };
  r = await run(sid, { FIKIRHANE_VAR_AD: 'Ayşe', FIKIRHANE_VAR_KOD: '4711', SAHTE_KIR: 'Kaydet', SAHTE_EKRAN: JSON.stringify(changed), FIKIRHANE_PROFIL: path.join(tmp, 'profil'), FIKIRHANE_GORUNUR: '1', FIKIRHANE_SURE: '3000' });
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(r.out, ['KALDI: "Yeni üye ekle" 6. adımda (6/8): Tıkla: getByRole(\'button\', { name: \'Kaydet\' })', 'Hata: Timeout 8000ms exceeded.', 'Kaldığı ekran: Yeni üye — /uyeler/yeni?kaynak=…',
    'Ekran 3 kayıtlı hâlinden farklı: arayüz değişmiş görünüyor.', 'Yeni öğeler:', "- düğme Gönder: getByRole('button', { name: 'Gönder' })", 'Artık olmayan öğeler:', "- düğme Kaydet: getByRole('button', { name: 'Kaydet' })"].join('\n'));
  assert.deepEqual([r.calls[0], r.calls[1], r.calls.length], [[['profil', path.join(tmp, 'profil'), false]], [['timeout', 3000]], 8], 'kalıcı profil ve görünür pencere; kalan adımdan (6.) sonrası yürütülmez');
  s = (await call(`/api/sites/${site}/scenarios/${sid}`)).scenario;
  assert.deepEqual([s.status, s.runs.length, s.runs[0].step, s.runs[0].error], ['kaldı', 2, 6, 'Timeout 8000ms exceeded.']);
  assert.match((await call(`/api/sites/${site}/scenarios/${sid}`)).text, /— son çalıştırma kaldı \(\d{4}-\d\d-\d\d, 6\. adım\)/);
  // Kart "değişmiş" olarak işaretlenir ve soran araca söylenir; kartın kendisi değişmez
  const screen = await call(`/api/sites/${site}/screens/3`);
  assert.match(screen.text, /\nUyarı: bu ekran \d{4}-\d\d-\d\d tarihli bir çalıştırmada karttan farklı çıktı \(arayüz değişmiş olabilir\)\. Yeni: düğme Gönder\. Artık yok: düğme Kaydet\.$/);
  assert.deepEqual(screen.screen.buttons.map((b) => b.name), ['Kaydet']);
  assert.match((await call(`/api/sites/${site}`)).text, /\n3\. Yeni üye — \/uyeler\/yeni \(değişmiş görünüyor\)\n/);
  assert.equal((await call(`/api/docs/${site}`)).screens[2].changed, true);

  // Kalan çalıştırma, ekran aynı: sorun arayüzde değil
  r = await run(sid, { FIKIRHANE_VAR_AD: 'Ayşe', FIKIRHANE_VAR_KOD: '4711', SAHTE_KIR: 'Tür', SAHTE_EKRAN: JSON.stringify({ ...FORM, origin, url: `${origin}/uyeler/yeni` }) });
  assert.match(r.out, /^KALDI: "Yeni üye ekle" 5\. adımda \(5\/8\): Seç: getByLabel\('Tür'\) = Kurumsal\nHata: .*\nKaldığı ekran: Yeni üye — \/uyeler\/yeni\nEkran kayıtlı hâliyle aynı \(Ekran 3\): arayüz değişmemiş\. Sorun seçicide, beklemede ya da veride olabilir\.\nŞu an görünen öğeler:\n- alan Ad: getByLabel\('Ad'\)/);
  // Bilinmeyen ekran ve özetlenemeyen sayfa
  r = await run(sid, { FIKIRHANE_VAR_AD: 'A', FIKIRHANE_VAR_KOD: '1', SAHTE_KIR: 'Yeni üye', SAHTE_EKRAN: JSON.stringify({ origin, url: `${origin}/giris`, title: 'Oturum aç' }) });
  assert.match(r.out, /Kaldığı ekran: Oturum aç — \/giris\nBu ekran Fikirhane'de kayıtlı değil/);
  r = await run(sid, { FIKIRHANE_VAR_AD: 'A', FIKIRHANE_VAR_KOD: '1', SAHTE_KIR: 'Yeni üye', SAHTE_EKRAN: JSON.stringify({ origin: 'https://giris.example.com', url: 'https://giris.example.com/sso' }) });
  assert.match(r.out, /Kaldığı ekranın özeti alınamadı/);

  // Fikirhane'ye bildirilmezse (ya da ulaşılamazsa) sonuç yalnızca ekrana yazılır
  r = await run(sid, { FIKIRHANE_VAR_AD: 'A', FIKIRHANE_VAR_KOD: '1', FIKIRHANE_BILDIRME: '1' });
  assert.match(r.out, /^GEÇTİ: Yeni üye ekle \(8 adım, \d+\.\d sn\)$/);
  r = await run(sid, { FIKIRHANE_VAR_AD: 'A', FIKIRHANE_VAR_KOD: '1', FIKIRHANE_BILDIRME: '1', SAHTE_KIR: 'Kaydet', SAHTE_EKRAN: JSON.stringify(changed) });
  assert.equal(r.out, ['KALDI: Yeni üye ekle 6. adımda (6/8): Tıkla: getByRole(\'button\', { name: \'Kaydet\' })', 'Hata: Timeout 8000ms exceeded.', `Kaldığı adres: ${origin}/uyeler/yeni`, 'Görünen düğmeler: Gönder', 'Görünen alanlar: Ad; Giriş kodu; Tür'].join('\n'));
  assert.equal((await call(`/api/sites/${site}/scenarios/${sid}`)).scenario.runs.length, 5, 'bildirilmeyen iki çalıştırma kaydedilmez');
  // Giriş kipi kalıcı profil ister
  r = await run(sid, {}, ['--giris']);
  assert.deepEqual([r.code, r.out], [2, 'ÇALIŞTIRILAMADI: --giris için FIKIRHANE_PROFIL (oturumun saklanacağı klasör) verilmeli.']);
});

test('senaryodaki hiçbir metin betikte koda dönüşmez; bildirilen sonuç güvenilmez veri olarak işlenir', async () => {
  const evil = '"); process.exit(7); ("\n`${process.exit(7)}`\\';
  const saved = await call(`/api/sites/${site}/scenarios`, { name: `Kötü \n process.exit(7) // */ ${evil}`, description: evil,
    steps: [{ do: 'goto', url: `/ara?q=${encodeURIComponent(evil)}` }, { do: 'fill', locator: `getByLabel('${evil.replace(/[\\']/g, '\\$&').replace(/\n/g, '\\n')}')`, value: evil, note: evil },
      { do: 'expect', text: evil }, { do: 'expectUrl', text: evil }, { do: 'fill', locator: "getByLabel('Ad')", value: '{{ad}}' }] });
  assert.equal(saved.ok, true, saved.error);
  const r = await run(saved.scenario.id, { FIKIRHANE_VAR_AD: evil });
  assert.equal(r.code, 0, `betik kendi adımları dışında bir şey çalıştırdı: ${r.out}${r.err}`);
  assert.deepEqual(r.calls[3], [['getByLabel', evil], ['fill', evil]], 'değer olduğu gibi, metin olarak gider');
  assert.deepEqual(r.calls.at(-1), [['getByLabel', 'Ad'], ['fill', evil]]);
  // Saklanan dosya elle bozulsa da betik üretilmez
  const file = path.join(tmp, 'belgeler', site, 'senaryolar.json');
  const all = JSON.parse(fs.readFileSync(file, 'utf8'));
  all.at(-1).steps[1].locator = "getByLabel('x'); process.exit(7); page.getByLabel('y')";
  fs.writeFileSync(file, JSON.stringify(all));
  assert.equal((await call(`/api/sites/${site}/scenarios/${saved.scenario.id}/script`)).code, 'bad-locator');
  // Uydurma sonuç: sınırlar içinde kaydedilir, sunucu düşmez
  const junk = await call(`/api/sites/${site}/scenarios/${saved.scenario.id}/result`, { ok: 'evet', step: 9999, ms: -5, error: 'x'.repeat(5000), screen: { origin, url: 'adres değil', buttons: 'dizi değil' } });
  assert.deepEqual([junk.ok, junk.status, junk.changed], [true, 'kaldı', null]);
  const run1 = (await call(`/api/sites/${site}/scenarios/${saved.scenario.id}`)).scenario.runs[0];
  assert.deepEqual([run1.step, run1.ms, run1.error.length], [5, 0, 300]);
  assert.equal((await call(`/api/sites/${site}/scenarios/${saved.scenario.id}`, null, 'DELETE')).ok, true);
  assert.equal((await call(`/api/sites/${site}/scenarios/${saved.scenario.id}`)).code, 'not-found');
});

test('bir ekrana gidiş, gezintide kaydedilen yoldan senaryo olarak üretilir', async () => {
  const r = await call(`/api/sites/${site}/scenarios/from-screen`, { no: 3 });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual([r.scenario.name, r.scenario.steps], ['Yeni üye ekranına git', [{ do: 'goto', url: `${origin}/` }, { do: 'click', locator: "getByRole('link', { name: 'Üyeler' })", note: 'Ekran 2: Üyeler' },
    { do: 'click', locator: "getByRole('button', { name: 'Yeni üye' })", note: 'Ekran 3: Yeni üye' }, { do: 'expect', text: 'Yeni üye' }]]);
  assert.equal((await call(`/api/sites/${site}/scenarios/from-screen`, { no: 3 })).scenario.id, r.scenario.id, 'yeniden üretmek aynı senaryoyu günceller');
  assert.equal((await call(`/api/sites/${site}/scenarios/from-screen`, { no: 4 })).code, 'no-route', 'tıklamasının seçicisi bilinmeyen yol senaryo olmaz');
  assert.equal((await call(`/api/sites/${site}/scenarios/from-screen`, { no: 99 })).code, 'not-found');
  const out = await run(r.scenario.id);
  assert.equal(out.code, 0, out.out + out.err);
  assert.equal(out.calls.length, 6);
});

test('site yeniden gezilince kayıt güncellenir: ekran numaraları, kullanıcının bilgisi ve senaryolar korunur', async () => {
  const id = lib.addSite({ origin, start: `${origin}/`, cards }).id;
  const dir = path.join(tmp, 'belgeler', id);
  const metaFile = path.join(dir, 'meta.json');
  // Önceki gezintiden biriken bilgi: bölüm notu, elle düzeltilmiş harita, kullanıcının notu, onay, iki senaryo
  const note = [{ i: 0, from: 1, to: 4, note: '**Ekranlar:** Üyeler (s.2)' }];
  fs.writeFileSync(path.join(dir, 'notlar.json'), JSON.stringify(note));
  fs.writeFileSync(metaFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(metaFile, 'utf8')), understood: 1, state: 'anlamlandırıldı' }));
  lib.saveMap(id, '# Elle düzeltilmiş harita');
  lib.addComment(id, 'Testte silme işlemi yapılmaz.');
  lib.setApproved(id, true);
  const viaButton = lib.saveScenario(id, { name: 'Formu aç', steps: [{ do: 'goto', screen: 2 }, { do: 'click', locator: "getByRole('button', { name: 'Yeni üye' })" }] }).scenario.id;
  const direct = lib.saveScenario(id, { name: 'Adı doldur', steps: [{ do: 'goto', screen: 3 }, { do: 'fill', locator: "getByLabel('Ad')", value: 'Ayşe' }] }).scenario.id;
  lib.recordRun(id, direct, { ok: true, ms: 400 });

  // Yeni gezinti: yalnızca üç ekran gezildi, numaraları farklı; "Yeni üye" düğmesi "Üye ekle" olmuş, Raporlar eklenmiş
  const fresh = [
    mk(1, null, null, { url: '/uyeler?q=ali', title: 'Üyeler', buttons: [{ name: 'Üye ekle', role: 'button', locator: "getByRole('button', { name: 'Üye ekle' })" }] }),
    mk(2, 1, { role: 'button', name: 'Üye ekle', row: false }, FORM),
    mk(3, 1, { role: 'link', name: 'Raporlar', row: false }, { url: '/raporlar', title: 'Raporlar' }),
  ];
  assert.throws(() => lib.updateSite(id, { origin: 'https://baska.example.com', cards: fresh }), { code: 'other-site' });
  assert.throws(() => lib.updateSite(id, { origin, cards: [] }), { code: 'no-screens' });
  const r = lib.updateSite(id, { origin, cards: fresh });
  assert.deepEqual([r.added, r.revised, r.same, r.unseen, r.warned, r.droppedNotes], [1, 1, 1, 2, 1, 1]);
  assert.equal(r.text, 'Güncellendi: 1 yeni ekran, 1 ekran değişti, 1 ekran aynı, 2 ekran bu gezintide görülmedi (silinmedi). 1 bölümün notu eskidi; "Anlamlandırmaya devam et" ile yenilenir. '
    + '1 senaryonun seçicileri eskimiş görünüyor (Senaryolar sekmesinde işaretli). Ekranlar değiştiği için onay geri alındı.');
  // Eşleşen ekranlar eski numarasını korur, yenisi sona eklenir; yollar kayıttaki numaralara çevrilir
  assert.deepEqual(lib.screens(id).screens.map((c) => [c.no, c.title, c.mark, c.from, c.via]), [[1, 'Ana sayfa', 'görülmedi', null, ''], [2, 'Üyeler', 'değişti', 1, '"Üyeler" bağlantısı'],
    [3, 'Yeni üye', '', 2, '"Üye ekle" düğmesi'], [4, 'Üyeler › Süzgeç', 'görülmedi', 2, '"Süz" düğmesi'], [5, 'Raporlar', 'yeni', 2, '"Raporlar" bağlantısı']]);
  let doc = lib.getDocument(id);
  assert.deepEqual([doc.meta.approved, doc.meta.revision, doc.meta.pages, doc.meta.understood, doc.meta.state], [false, 2, 5, 0, 'dizinlendi']);
  assert.deepEqual([doc.map, doc.comments.map((c) => c.text), doc.notes], ['# Elle düzeltilmiş harita', ['Testte silme işlemi yapılmaz.'], []], 'harita ve kullanıcının notu korunur; eskiyen bölüm notu düşer');
  assert.match(lib.pageText(id, 1).text, /\nNot: bu ekran son gezintide görülmedi; kaldırılmış ya da o gezintide açılmamış olabilir\.$/);
  assert.match(lib.pageText(id, 2).text, /Düğmeler: Üye ekle/);
  assert.equal((await lib.search('raporlar', [id]))[0].page, 5, 'yeni ekran aranabilir');
  assert.match(lib.siteOverview(id).text, /\n1\. Ana sayfa — \/ \(son gezintide görülmedi\)\n2\. Üyeler — \/uyeler\?q=…\n/);
  // Senaryolar: düğmesi kaybolan uyarılır ve "çalıştırılmadı" olur; diğeri sonucuyla birlikte durur
  const [a, b] = [lib.getScenario(id, viaButton), lib.getScenario(id, direct)];
  assert.deepEqual([a.scenario.status, a.scenario.warn], ['denenmedi', 'Son gezintide 2. adımın seçicisi hiçbir ekranda bulunamadı; senaryo güncellenmeli.']);
  assert.match(a.text, /\nUyarı: Son gezintide 2\. adımın seçicisi/);
  assert.deepEqual([b.scenario.status, b.scenario.warn, b.scenario.runs.length], ['geçti', undefined, 1]);
  assert.match(lib.listScenarios(id).text, /Formu aç \(2 adım\) — henüz çalıştırılmadı \(uyarı: seçicileri eskimiş olabilir\)/);
  // Senaryo düzeltilince uyarı kalkar
  lib.saveScenario(id, { id: viaButton, name: 'Formu aç', steps: [{ do: 'goto', screen: 2 }, { do: 'click', locator: "getByRole('button', { name: 'Üye ekle' })" }] });
  assert.equal(lib.getScenario(id, viaButton).scenario.warn, undefined);

  // Aynı ekranlarla yeniden gezinti: hiçbir şey değişmez; yenilenen not ve onay yerinde kalır
  fs.writeFileSync(path.join(dir, 'notlar.json'), JSON.stringify(note));
  lib.setApproved(id, true);
  const again = lib.updateSite(id, { origin, cards: fresh });
  assert.deepEqual([again.added, again.revised, again.same, again.unseen, again.droppedNotes, again.warned], [0, 0, 3, 2, 0, 0]);
  doc = lib.getDocument(id);
  assert.deepEqual([doc.meta.approved, doc.meta.understood, doc.meta.state, doc.notes.length, doc.screens.map((s) => s.mark)], [true, 1, 'anlamlandırıldı', 1, ['görülmedi', '', '', 'görülmedi', '']]);

  // Yerel model haritayı yeniden yazarken elle düzeltilmiş harita yedeklenir
  lib.saveMap(id, '# Modelin yeni haritası', false);
  assert.deepEqual([lib.getDocument(id).map, fs.readFileSync(path.join(dir, 'harita-onceki.md'), 'utf8')], ['# Modelin yeni haritası', '# Elle düzeltilmiş harita']);

  // Görülmeyen ekranlar silinir: numaralar yeniden verilmez, silinen ekrana bağlı yol temizlenir
  const pruned = await call(`/api/docs/${id}/screens/prune`, {});
  assert.deepEqual([pruned.removed, pruned.meta.pages], [2, 3]);
  assert.deepEqual(lib.screens(id).screens.map((c) => [c.no, c.from, c.via]), [[2, null, ''], [3, 2, '"Üye ekle" düğmesi'], [5, 2, '"Raporlar" bağlantısı']]);
  assert.equal((await call(`/api/docs/${id}/screens/prune`, {})).removed, 0);
  assert.equal(lib.getScenario(id, direct).scenario.steps.length, 2, 'senaryolar silinmez');
});

test('kapı: açılışta kapi.json yazılır; soru başlığı gelen yanıt imzalanır, anahtar hiçbir yanıtta yer almaz', async () => {
  const door = JSON.parse(fs.readFileSync(path.join(tmp, 'kapi.json'), 'utf8'));
  assert.equal(door.app, 'fikirhane');
  assert.equal(door.port, app.address().port);
  assert.match(door.anahtar, /^[0-9a-f]{64}$/);
  const ask = async (p, soru) => {
    const r = await fetch(base + p, { headers: soru ? { 'x-fikirhane-soru': soru } : {} });
    return { imza: r.headers.get('x-fikirhane-imza'), body: await r.text() };
  };
  const sign = (soru, p, body) => crypto.createHmac('sha256', door.anahtar).update([soru, `GET ${p}`, body].join('\n')).digest('hex');
  const soru = crypto.randomBytes(16).toString('hex');
  const a = await ask('/api/sites', soru);
  assert.equal(a.imza, sign(soru, '/api/sites', a.body), 'imza soru + istek + gövde üzerinden');
  assert.notEqual(a.imza, sign(soru, '/api/config', a.body), 'imza isteğin adresine bağlıdır');
  // Hata yanıtları da imzalanır (ör. bulunamayan site)
  const e = await ask('/api/sites/yok-boyle-site', soru);
  assert.equal(JSON.parse(e.body).ok, false);
  assert.equal(e.imza, sign(soru, '/api/sites/yok-boyle-site', e.body));
  // Soru yoksa ya da biçimi bozuksa imza da yok
  assert.equal((await ask('/api/sites')).imza, null);
  assert.equal((await ask('/api/sites', 'kisa')).imza, null);
  for (const p of ['/api/config', '/api/sites', `/api/sites/${site}`]) assert.ok(!(await ask(p, soru)).body.includes(door.anahtar), `${p} anahtarı sızdırmamalı`);
});
