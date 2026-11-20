// Site gezintisi: adres kalıpları ve kart metni (tarayıcısız), sonra gerçek tarayıcıyla uçtan uca: küçük bir deneme
// sitesi gezilir, ekran kartları çıkarılır, belge olarak kaydedilir, aranır ve yerel modelle anlamlandırılır.
// Bu bilgisayarda Edge ya da Chrome yoksa tarayıcılı testler atlanır.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fikirhane-gezgin-test-'));
process.env.FIKIRHANE_HOME = tmp;
process.env.FIKIRHANE_UPDATE_CHECK = '0';
process.env.FIKIRHANE_GEZGIN_GIZLI = '1'; // pencere açılmaz
const gezgin = await import('../src/gezgin.js');
const { createServer } = await import('../src/server.js');
const noBrowser = gezgin.findBrowser() ? false : 'Edge ya da Chrome bulunamadı';

test('adres kalıbı: kimlik görünümlü bölümler ve sorgu değerleri ekranı değiştirmez', () => {
  assert.equal(gezgin.urlPattern('https://uygulama.example.com/urun/12'), '/urun/{id}');
  assert.equal(gezgin.urlPattern('https://uygulama.example.com/urun/57?sekme=fiyat&dil=tr'), '/urun/{id}?dil&sekme');
  assert.equal(gezgin.urlPattern('https://uygulama.example.com/kayit/3f2b8c1e-1a2b-4c3d-9e8f-001122334455/duzenle'), '/kayit/{id}/duzenle');
  assert.equal(gezgin.urlPattern('https://uygulama.example.com/#/siparis/8'), '/#/siparis/{id}');
  assert.equal(gezgin.urlPattern('https://uygulama.example.com/yardim#bolum-2'), '/yardim', 'sayfa içi çapa ekranı değiştirmez');
  assert.equal(gezgin.screenPath('https://uygulama.example.com/ara?q=gizli+arama&sayfa=2'), '/ara?q=…&sayfa=…', 'sorgu değerleri karta yazılmaz');
});

test('otomatik gezintide gidilmeyen bağlantılar: çıkış, silme, indirme ve dosyalar', () => {
  const d = (name, p) => gezgin.dangerous(name, `https://uygulama.example.com${p}`);
  assert.equal(d('Siparişler', '/siparisler'), false);
  assert.equal(d('Ürün ayrıntısı', '/urun/3'), false);
  assert.equal(d('Çıkış', '/oturum/kapat'), true);
  assert.equal(d('', '/logout'), true);
  assert.equal(d('Kaydı sil', '/kayit/3/islem'), true);
  assert.equal(d('Kaldır', '/kayit/3'), true);
  assert.equal(d('Rapor', '/rapor/sil?id=3'), true);
  assert.equal(d('Rapor', '/rapor/2026.pdf'), true);
  assert.equal(d('Dışa aktar', '/liste'), true);
  assert.equal(gezgin.dangerous('Bozuk', 'javascript:void(0)'), true);
});

test('kart: ham sayfa verisi temizlenir; veri satırları özetlenir; iz yapıya bağlıdır, veriye değil', () => {
  const origin = 'https://uygulama.example.com';
  const raw = (extra = {}) => ({ url: `${origin}/urunler?q=kalem`, origin, title: 'Ürünler', h1: 'Ürünler', dialog: '', headings: ['Ürünler', 'x'.repeat(500)], columns: ['Ürün', 'Fiyat'], unnamed: 2,
    fields: [{ name: 'Ürün adı', type: 'text', required: true, options: [], locator: "getByLabel('Ürün adı')" }, { name: 'Adet', type: 'number', row: true }],
    buttons: [{ name: 'Ara', role: 'button', locator: "getByRole('button', { name: 'Ara' })" }, { name: 'Sil', role: 'button', row: true }, { name: 'Sil', role: 'button', row: true }, { name: 'Ekle', role: 'button' }, { name: 'Ekle', role: 'button' }],
    links: [{ name: 'Ana sayfa', href: `${origin}/` }, { name: 'Kırmızı Kalem', href: `${origin}/urun/1`, row: true }, { name: 'Mavi Defter', href: `${origin}/urun/2`, row: true },
      { name: 'Yardım', href: 'https://yardim.example.com/' }, { name: 'Posta', href: 'mailto:biri@example.com' }, { name: 'Bozuk', href: 'javascript:alert(1)' }], ...extra });
  const c = { no: 2, from: 1, via: '"Ürünler" bağlantısı', ...gezgin.makeCard(raw(), origin) };
  assert.equal(c.path, '/urunler?q=…');
  assert.ok(c.headings[1].length <= 80, 'uzun metinler kısaltılır');
  assert.deepEqual(c.fields.map((f) => f.name), ['Ürün adı'], 'tablo satırındaki alan veridir, karta girmez');
  assert.deepEqual(c.buttons.map((b) => [b.name, b.n]), [['Ara', 1], ['Ekle', 2]]);
  assert.deepEqual(c.rowActions, ['Sil']);
  assert.deepEqual(c.links.map((l) => l.name), ['Ana sayfa']);
  assert.deepEqual(c.rowLinks.map((r) => [r.pattern, r.n]), [['/urun/{id}', 2]]);
  assert.equal(c.external, 1);
  const text = gezgin.cardText(c, [{ no: 1, title: 'Hoş geldiniz', links: [] }, c]);
  assert.match(text, /^Ekran 2: Ürünler\nAdres: \/urunler\?q=…\nGeliş: Ekran 1 \(Hoş geldiniz\) → "Ürünler" bağlantısı/);
  assert.match(text, /Alanlar: Ürün adı \(metin, zorunlu\)/);
  assert.match(text, /Düğmeler: Ara; Ekle \(2 adet\)/);
  assert.match(text, /Adsız düğmeler: 2/);
  assert.match(text, /Satır işlemleri: Sil\nSatır bağlantıları: \/urun\/\{id\} \(2 adet\)/);
  assert.ok(!/Kırmızı Kalem|Mavi Defter|kalem/.test(text), 'satır verisi ve sorgu değeri metne girmez');
  // Başka veriyle aynı ekran aynı izi verir; yeni bir düğme izi değiştirir
  const other = gezgin.makeCard(raw({ url: `${origin}/urunler?q=defter`, links: [{ name: 'Ana sayfa', href: `${origin}/` }, { name: 'Sarı Silgi', href: `${origin}/urun/9`, row: true }] }), origin);
  assert.equal(other.iz, c.iz);
  assert.notEqual(gezgin.makeCard(raw({ buttons: [{ name: 'Ara', role: 'button' }, { name: 'Dışa aktar', role: 'button' }] }), origin).iz, c.iz);
});

test('ortak menü her kartta yinelenmez; arama parçaları ekran başlığını taşır', () => {
  const origin = 'https://uygulama.example.com';
  const menu = [{ name: 'Ana sayfa', href: `${origin}/` }, { name: 'Ürünler', href: `${origin}/urunler` }];
  const cards = ['/', '/urunler', '/hakkinda'].map((p, i) => ({ no: i + 1, from: null, via: '', ...gezgin.makeCard({ url: origin + p, origin, title: `Sayfa ${i + 1}`,
    links: [...menu, ...(i === 1 ? [{ name: 'Yeni ürün', href: `${origin}/urunler/yeni` }] : [])], fields: Array.from({ length: i === 2 ? 60 : 0 }, (_, k) => ({ name: `Uzun adlı alan ${k}`, type: 'text' })) }, origin) }));
  assert.match(gezgin.cardText(cards[0], cards), /Ortak menü \(ekranların çoğunda var\): Ana sayfa → \/; Ürünler → \/urunler/);
  assert.match(gezgin.cardText(cards[1], cards), /Bağlantılar: Yeni ürün → \/urunler\/yeni\nOrtak menü: var/);
  const chunks = gezgin.cardChunks(cards);
  const third = chunks.filter((c) => c.page === 3);
  assert.ok(third.length > 1, 'uzun kart birden çok parçaya bölünür');
  assert.ok(third.every((c) => c.text.startsWith('Ekran 3: Sayfa 3') && c.text.length <= 1000));
});

// ---------- Gerçek tarayıcıyla ----------
const hits = [];
const seen = [];
let site; let llm; let app; let base; let siteUrl;
const page = (title, body) => `<!doctype html><html lang="tr"><head><meta charset="utf-8"><title>${title}</title></head><body>
  <nav><a href="/">Ana sayfa</a> <a href="/urunler">Ürünler</a> <a href="/uyeler">Üyeler</a> <a href="/cikis">Çıkış</a> <a href="/rapor.pdf">Rapor</a> <a href="https://yardim.example.com/">Yardım</a></nav>${body}</body></html>`;
const PAGES = {
  '/': page('Deneme Mağazası', '<h1>Hoş geldiniz</h1><p>Bugünkü ciro: 48.250 TL</p><button onclick="document.getElementById(\'d\').showModal()">Yeni üye</button>'
    + '<dialog id="d" aria-label="Yeni üye kaydı"><h2>Yeni üye kaydı</h2><label>E-posta <input type="email" required></label><button>Kaydet</button></dialog>'),
  '/urunler': page('Ürünler', '<h1>Ürünler</h1><form method="post" action="/urunler"><label>Ürün adı <input name="ad" value="gizli-deger"></label>'
    + '<label for="k">Kategori</label><select id="k"><option>Hepsi</option><option>Kırtasiye</option></select><input placeholder="Barkod"><input type="password" name="p" value="cok-gizli"><button>Ara</button></form>'
    + '<table><thead><tr><th>Ürün</th><th>Fiyat</th><th></th></tr></thead><tbody>'
    + '<tr><td><a href="/urun/1">Kırmızı Kalem</a></td><td>12</td><td><button>Düzenle</button><a href="/sil?id=1">Sil</a></td></tr>'
    + '<tr><td><a href="/urun/2">Mavi Defter</a></td><td>30</td><td><button>Düzenle</button><a href="/sil?id=2">Sil</a></td></tr></tbody></table>'),
  '/urun': page('Ürün', '<h1>Ürün ayrıntısı</h1><table><tr><td><label for="f">Fiyat</label></td><td><input id="f" type="number" required></td></tr></table>'
    + '<button data-testid="kaydet">Kaydet</button><button aria-label="Kapat">×</button><button><svg width="8" height="8"></svg></button>'),
  '/uyeler': page('Üyeler', '<h1>Üyeler</h1><a href="/uyeler/yeni">Yeni üye ekle</a>'),
  '/uyeler/yeni': page('Yeni üye', '<h1>Yeni üye</h1><label>Ad <input></label>'),
};
before(async () => {
  site = http.createServer((req, res) => {
    if (!req.url.includes('favicon')) hits.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGES[/^\/urun\/\d+$/.test(req.url) ? '/urun' : req.url] || page('Yok', '<h1>Bulunamadı</h1>'));
  });
  llm = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body);
      const system = j.messages[0].content;
      seen.push({ system, user: j.messages.at(-1).content });
      const text = /JSON dizisi/.test(system) ? '["Testte hangi kullanıcı kullanılmalı?"]' : /haritasını çıkar/.test(system) ? '# Uygulamanın amacı\nÜrün ve üye yönetimi.' : '**Ekranlar:** Ürünler (s.2)';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
    });
  });
  await Promise.all([site, llm].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
  app = await createServer({ port: 0 });
  base = `http://127.0.0.1:${app.address().port}`;
});
after(async () => { await gezgin.cancelTour(); site.close(); llm.close(); app.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const call = (p, body, method = body ? 'POST' : 'GET') => fetch(base + p, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-fikirhane': '1' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
async function until(fn, what) {
  for (let i = 0; i < 300; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`beklenen olmadı: ${what}`);
}
const tour = async () => (await call('/api/tour')).tour;

test('gezinti olmadan ve geçersiz adresle anlaşılır hata', async () => {
  assert.equal((await call('/api/tour')).tour, null);
  assert.equal((await call('/api/tour', { url: 'ftp://uygulama.example.com' })).code, 'bad-site');
  assert.equal((await call('/api/tour', { url: '' })).code, 'bad-site');
  assert.equal((await call('/api/tour/capture', {})).code, 'no-tour');
  assert.equal((await call('/api/tour/finish', {})).code, 'no-tour');
  assert.equal((await fetch(`${base}/api/tour`, { method: 'POST', body: '{}' })).status, 403, 'özel başlık olmadan tarayıcı açılamaz');
});

test('site gezilir: ekranlar kart olur, tıklama "geliş" olarak yazılır, otomatik gezinti güvenli kalır, belge olarak kaydedilir', { skip: noBrowser }, async () => {
  assert.equal((await call('/api/tour', { url: `${siteUrl}/` })).ok, true);
  assert.equal((await call('/api/tour', { url: `${siteUrl}/` })).code, 'tour-busy');
  await until(async () => (await tour()).count === 1, 'ilk ekran');

  // Kullanıcının gezmesi: açılan pencere (adres değişmez) ve tıklanan bağlantı ayrı ekranlar olarak kaydedilir
  await gezgin._deneme.evaluate('document.querySelector("button").click()');
  let t = await until(async () => { const x = await tour(); return x.count === 2 && x; }, 'açılan pencere');
  assert.deepEqual([t.cards[1].title, t.cards[1].path, t.cards[1].via], ['Hoş geldiniz › Yeni üye kaydı', '/', '"Yeni üye" düğmesi']);
  await gezgin._deneme.evaluate('document.getElementById("d").close(); [...document.querySelectorAll("a")].find((a) => a.textContent === "Ürünler").click()');
  t = await until(async () => { const x = await tour(); return x.count === 3 && x; }, 'tıklanan bağlantı');
  assert.deepEqual([t.cards[2].title, t.cards[2].path, t.cards[2].via], ['Ürünler', '/urunler', '"Ürünler" bağlantısı']);
  const again = await call('/api/tour/capture', {});
  assert.deepEqual([again.added, again.no], [false, 3], 'aynı ekran ikinci kez kaydedilmez');

  // Otomatik gezinti: yalnızca bağlantıların adresine gider
  assert.equal((await call('/api/tour/crawl', { limit: 20 })).ok, true);
  t = await until(async () => { const x = await tour(); return x.crawl && !x.crawl.running && x; }, 'otomatik gezinti');
  assert.deepEqual(t.cards.map((c) => c.path).sort(), ['/', '/', '/urun/1', '/urunler', '/uyeler', '/uyeler/yeni']);
  assert.ok(t.crawl.skipped >= 3, 'çıkış, silme ve dosya bağlantıları atlanır');
  assert.deepEqual(hits.filter((h) => !h.startsWith('GET ')), [], 'hiçbir form gönderilmez');
  assert.ok(!hits.some((h) => /cikis|sil|rapor|urun\/2/.test(h)), `gidilmemesi gereken adrese gidildi: ${hits.join(', ')}`);

  // Belge olarak kaydedilir; yapılı kartlarda seçiciler durur
  const fin = await call('/api/tour/finish', {});
  assert.equal(fin.ok, true, fin.error);
  assert.deepEqual([fin.meta.kind, fin.meta.pages, fin.meta.state, fin.meta.name], ['site', 6, 'dizinlendi', new URL(siteUrl).host]);
  assert.equal((await call('/api/tour')).tour, null);
  const id = fin.meta.id;
  const { screens } = await call(`/api/docs/${id}/screens`);
  const products = screens.find((s) => s.path === '/urunler');
  assert.deepEqual(products.fields.map((f) => [f.name, f.type, f.locator]), [['Ürün adı', 'text', "getByLabel('Ürün adı')"], ['Kategori', 'select', "getByLabel('Kategori')"], ['Barkod', 'text', "getByPlaceholder('Barkod')"], ['p', 'password', 'locator(\'[name="p"]\')']]);
  assert.deepEqual(products.fields[1].options, ['Hepsi', 'Kırtasiye']);
  assert.deepEqual([products.columns, products.rowActions, products.rowLinks.map((r) => r.pattern)], [['Ürün', 'Fiyat'], ['Düzenle'], ['/urun/{id}', '/sil?id']]);
  const detail = screens.find((s) => s.path === '/urun/1');
  assert.deepEqual([detail.from, detail.via], [3, 'tablo satırındaki bağlantı']);
  assert.deepEqual(detail.fields.map((f) => [f.name, f.required, f.locator]), [['Fiyat', true, "getByLabel('Fiyat')"]], 'yerleşim tablosundaki alan veri sayılmaz');
  assert.deepEqual(detail.buttons.map((b) => b.locator), ["getByTestId('kaydet')", "getByRole('button', { name: 'Kapat' })"]);
  assert.equal(detail.unnamed, 1);
  const dialog = screens.find((s) => s.dialog);
  assert.deepEqual(dialog.fields.map((f) => f.name), ['E-posta'], 'açık pencerede yalnızca pencerenin içi kaydedilir');
  assert.deepEqual(dialog.links, []);

  // Diskte: değerler ve veriler yok
  const dir = path.join(tmp, 'belgeler', id);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['ekranlar.json', 'meta.json', 'parcalar.json', 'sayfalar.json']);
  const disk = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.ok(!/gizli-deger|cok-gizli|Kırmızı Kalem|Mavi Defter|48\.250/.test(disk), 'alan değerleri, satır verileri ve sayfa metni kaydedilmez');

  // Arama ve belge ayrıntısı belgelerle aynı yoldan çalışır
  const found = await call('/api/search', { q: 'barkod kategori' });
  assert.equal(found.results[0].page, products.no);
  assert.match((await call(`/api/docs/${id}/page/1`)).text, /^Ekran 1: Hoş geldiniz\nAdres: \/\n.*Düğmeler: Yeni üye\nOrtak menü \(ekranların çoğunda var\): Ana sayfa → \/; Ürünler → \/urunler; Üyeler → \/uyeler; Çıkış → \/cikis; Rapor → \/rapor\.pdf\nDış bağlantılar: 1$/s);
  const doc = await call(`/api/docs/${id}`);
  assert.equal(doc.screens.length, 6);

  // Anlamlandırma: siteye özel yönergeler, ekran kartları modele gider
  await call('/api/settings', { url: `http://127.0.0.1:${llm.address().port}`, chatModel: 'sohbet-modeli' });
  assert.equal((await call(`/api/docs/${id}/understand`, {})).ok, true);
  const d = await until(async () => { const x = await call(`/api/docs/${id}`); return x.job?.state !== 'running' && x; }, 'anlamlandırma');
  assert.equal(d.job.state, 'done', d.job.error);
  assert.match(d.map, /Ürün ve üye yönetimi/);
  assert.deepEqual(d.questions.map((q) => q.q), ['Testte hangi kullanıcı kullanılmalı?']);
  assert.match(seen[0].system, /ekran kartlarını okuyorsun/);
  assert.match(seen[0].user, /^Uygulama: 127\.0\.0\.1:\d+\nEkranlar: 1–6\n\n\[s\.1\]\nEkran 1: Hoş geldiniz/);
  assert.match(seen[1].system, /web uygulamasının ekran notları/);
});

test('tarayıcı penceresi kapanırsa kaydedilen ekranlar kaybolmaz; vazgeçince geçici profil silinir', { skip: noBrowser }, async () => {
  const profiles = () => { try { return fs.readdirSync(path.join(tmp, 'gezgin')); } catch { return []; } };
  assert.deepEqual(profiles(), [], 'önceki gezintinin profili silinmiş');
  await call('/api/tour', { url: `${siteUrl}/uyeler` });
  await until(async () => (await tour()).count === 1, 'ilk ekran');
  assert.equal(profiles().length, 1);
  gezgin._deneme.kill(); // kullanıcının pencereyi kapatması
  const t = await until(async () => { const x = await tour(); return x.state === 'kapandı' && x; }, 'pencerenin kapanması');
  assert.equal(t.count, 1);
  assert.match(t.error, /kapatıldı/);
  assert.equal((await call('/api/tour/capture', {})).code, 'tour-closed');
  assert.equal((await call('/api/tour', { url: siteUrl })).code, 'tour-busy', 'kaydedilen ekranlar yeni gezintiyle ezilmez');
  assert.equal((await call('/api/tour/cancel', {})).ok, true);
  assert.equal((await call('/api/tour')).tour, null);
  assert.deepEqual(profiles(), [], 'vazgeçince profil (çerezler, oturum) kalmaz');
});
