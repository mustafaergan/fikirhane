// Uçtan uca: sunucu + sahte yerel model. Belge yüklenir, anlamlandırılır, sorular yanıtlanır, not eklenir,
// onaylanır ve soru sorulur. Sahte model kendisine gelen istekleri kaydeder; neyin gönderildiği denetlenir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fikirhane-'));
process.env.FIKIRHANE_HOME = tmp;
process.env.FIKIRHANE_UPDATE_CHECK = '0';
const { createServer } = await import('../src/server.js');

const seen = [];
const gateway = [];
let llm; let app; let base; let llmUrl;
before(async () => {
  llm = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = body ? JSON.parse(body) : {};
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'sohbet-modeli' }, { id: 'vektor-modeli' }] }));
      // "kurum-modeli" temperature alanını reddeden bir gateway gibi davranır
      if (j.model === 'kurum-modeli' && 'temperature' in j) { res.statusCode = 400; return res.end('{"error":"temperature desteklenmiyor"}'); }
      if (j.model === 'kurum-modeli') gateway.push({ path: req.url, headers: req.headers, body: j });
      if (req.url.endsWith('/embeddings')) return res.end(JSON.stringify({ data: j.input.map((t, index) => ({ index, embedding: [/iade/i.test(t) ? 1 : 0, /kargo/i.test(t) ? 1 : 0, 0.1] })) }));
      const system = j.messages[0].content;
      const user = j.messages.at(-1).content;
      seen.push({ system, user });
      const text = /JSON dizisi/.test(system) ? '["İade süresi hangi tarihten başlar?", "Kargo ücreti kimde?"]'
        : /haritasını çıkar/.test(system) ? '# Belgenin konusu\nSipariş, iade ve kargo kuralları.'
          : /bölümünü okuyorsun/.test(system) ? '**Konu:** kurallar\n**Öz:**\n- İade süresi 14 gündür (s.1)'
            : /Fikirhane/.test(system) ? 'İade süresi 5 gündür [kurallar.txt s.1].' : 'Merhaba';
      res.end(JSON.stringify({ choices: [{ message: { content: `<think>düşünüyorum</think>${text}` } }] }));
    });
  });
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  llmUrl = `http://127.0.0.1:${llm.address().port}`;
  app = await createServer({ port: 0 });
  base = `http://127.0.0.1:${app.address().port}`;
});
after(() => { llm.close(); app.close(); });

const call = (p, body, method = body ? 'POST' : 'GET', headers = {}) => fetch(base + p, { method, headers: method === 'GET' ? headers : { 'content-type': 'application/json', 'x-fikirhane': '1', ...headers }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const upload = (name, text) => fetch(`${base}/api/docs`, { method: 'POST', headers: { 'x-fikirhane': '1', 'x-dosya-adi': encodeURIComponent(name) }, body: Buffer.from(text, 'utf8') }).then((r) => r.json());
async function waitJob(id) {
  for (let i = 0; i < 100; i++) { const d = await call(`/api/docs/${id}`); if (d.job?.state !== 'running') return d; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('iş bitmedi');
}

test('korumalar: başka alan adıyla ya da özel başlık olmadan gelen değiştirme isteği reddedilir', async () => {
  const noHeader = await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403);
  const res = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: app.address().port, path: '/api/config', headers: { host: 'kotu.example.com' } }, resolve));
  assert.equal(res.statusCode, 403);
  const escape = await fetch(`${base}/..%2Fpackage.json`);
  assert.equal(escape.status, 404, 'public dışındaki dosya verilmez');
});

test('yerel model ayarı: adres denetlenir, modeller listelenir, kaydedilir; anahtar arayüze dönmez', async () => {
  assert.equal((await call('/api/settings', { url: 'localhost' })).code, 'bad-url');
  const t = await call('/api/settings/test', { url: `${llmUrl}/v1`, chatModel: 'sohbet-modeli', embedModel: 'vektor-modeli' });
  assert.deepEqual([t.ok, t.models, t.chat, t.embed], [true, ['sohbet-modeli', 'vektor-modeli'], true, 3]);
  assert.equal((await call('/api/settings/test', { url: 'http://127.0.0.1:9' })).code, 'unreachable');
  const s = await call('/api/settings', { url: llmUrl, chatModel: 'sohbet-modeli', embedModel: 'vektor-modeli', key: 'gizli' });
  assert.deepEqual(s.settings, { url: llmUrl, chatModel: 'sohbet-modeli', embedModel: 'vektor-modeli', hasKey: true, ready: true });
  assert.ok(!JSON.stringify(await call('/api/config')).includes('gizli'));
});

test('belge: yüklenir, aranır, anlamlandırılır, soru-yanıt ve notla beslenir, onaylanır, sorulur, silinir', async () => {
  assert.equal((await upload('resim.png', 'x')).code, 'unsupported');
  const text = ['İade süresi 14 gündür. İade başvurusu sipariş numarasıyla yapılır.', 'Kargo süresi üç iş günüdür. Kargo ücreti alıcıya aittir.'].join('\n\n');
  const up = await upload('kurallar.txt', text);
  assert.equal(up.ok, true);
  const id = up.meta.id;
  assert.deepEqual([up.meta.state, up.meta.pages, up.meta.approved], ['dizinlendi', 1, false]);

  // Yapay zekâ olmadan arama
  const found = await call('/api/search', { q: 'kargo ücreti kimde' });
  assert.equal(found.results[0].name, 'kurallar.txt');
  assert.match(found.results[0].text, /Kargo/);

  // Anlamlandırma: bölüm notu → harita → sorular
  assert.equal((await call(`/api/docs/${id}/understand`, {})).ok, true);
  let d = await waitJob(id);
  assert.equal(d.job.state, 'done', d.job.error);
  assert.deepEqual([d.meta.state, d.meta.understood], ['anlamlandırıldı', 1]);
  assert.match(d.notes[0].note, /İade süresi 14 gündür/);
  assert.ok(!d.notes[0].note.includes('<think>'), 'modelin düşünme bölümü atılır');
  assert.match(d.map, /Sipariş, iade ve kargo/);
  assert.deepEqual(d.questions.map((q) => q.q), ['İade süresi hangi tarihten başlar?', 'Kargo ücreti kimde?']);
  assert.match(seen.find((x) => x.system.includes('okuyorsun')).user, /\[s\.1\]\nİade süresi 14 gündür/, 'modele sayfa işaretli metin gider');

  // Kullanıcının beslemesi
  await call(`/api/docs/${id}/answer`, { i: 0, answer: 'Teslim tarihinden başlar.' });
  await call(`/api/docs/${id}/comment`, { text: 'İade süresi artık 5 gün; belgedeki 14 gün eski.' });
  assert.equal((await call(`/api/docs/${id}/comment`, { text: ' ' })).code, 'empty');
  await call(`/api/docs/${id}/map`, { text: '# Düzeltilmiş harita\nİade ve kargo.' });
  assert.equal((await call(`/api/docs/${id}/approve`, { approved: true })).meta.approved, true);

  // Anlamsal dizin
  await call(`/api/docs/${id}/embed`, {});
  d = await waitJob(id);
  assert.equal(d.meta.embedDim, 3);

  // Soru: harita, kullanıcının notları ve kaynak parçalar modele gider
  const a = await call('/api/ask', { q: 'İade süresi kaç gün?', docs: [id] });
  assert.equal(a.answer, 'İade süresi 5 gündür [kurallar.txt s.1].');
  assert.equal(a.sources[0].page, 1);
  const sent = seen.at(-1).user;
  assert.match(sent, /# Belge haritaları\n## kurallar\.txt \(kullanıcı onayladı\)\n# Düzeltilmiş harita/);
  assert.match(sent, /Kullanıcının yanıtı: Teslim tarihinden başlar\./);
  assert.match(sent, /İade süresi artık 5 gün; belgedeki 14 gün eski\./);
  assert.match(sent, /\[kurallar\.txt s\.1\]\nİade süresi 14 gündür/);
  assert.match(sent, /# Soru\nİade süresi kaç gün\?$/);

  // Dosyalar diskte düz ve okunur durur
  const dir = path.join(tmp, 'belgeler', id);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['asil.txt', 'harita.md', 'meta.json', 'notlar.json', 'parcalar.json', 'sayfalar.json', 'sorular.json', 'vektorler.bin', 'yorumlar.json']);
  assert.equal((await call(`/api/docs/${id}/page/1`)).text.startsWith('İade süresi'), true);

  await call(`/api/docs/${id}`, null, 'DELETE');
  assert.deepEqual((await call('/api/docs')).docs, []);
  assert.equal(fs.existsSync(dir), false);
});

test('yerel model ayarı dışa ve içe aktarılır: API anahtarı şifrelidir; Atölye dosyası ve kurum gateway adresi de çalışır', async () => {
  const file = path.join(tmp, 'ayarlar.json');
  await call('/api/settings', { url: llmUrl, chatModel: 'sohbet-modeli', embedModel: 'vektor-modeli', key: 'gizli-anahtar' });
  const ex = await call('/api/settings/export', { pass: 'parolam' });
  assert.deepEqual([ex.file.app, ex.file.type, ex.file.models.length], ['atolye', 'yerel-llm', 1], 'dosya biçimi Atölye ile ortak');
  assert.deepEqual([ex.file.models[0].url, ex.file.models[0].model, ex.file.models[0].embedModel, ex.file.models[0].kind], [llmUrl, 'sohbet-modeli', 'vektor-modeli', 'openai']);
  assert.ok(!JSON.stringify(ex).includes('gizli-anahtar'), 'API anahtarı dosyaya açık yazılmaz');

  // İçe aktarma: anahtar sorulur; yanlış anahtarla ya da bozuk dosyayla hiçbir şey yazılmaz
  fs.rmSync(file);
  assert.equal((await call('/api/settings/export', {})).code, 'nothing-to-export');
  assert.equal((await call('/api/settings/import', { data: JSON.stringify(ex.file) })).code, 'need-pass');
  assert.equal((await call('/api/settings/import', { data: ex.file, pass: 'yanlış' })).code, 'bad-pass');
  assert.equal((await call('/api/settings/import', { data: '{"app":"baska"}', pass: 'parolam' })).code, 'bad-file');
  assert.equal((await call('/api/settings/import', { data: 'json değil', pass: 'parolam' })).code, 'bad-file');
  assert.equal(fs.existsSync(file), false);
  const im = await call('/api/settings/import', { data: JSON.stringify(ex.file), pass: 'parolam' });
  assert.deepEqual([im.settings, im.model], [{ url: llmUrl, chatModel: 'sohbet-modeli', embedModel: 'vektor-modeli', hasKey: true, ready: true }, 'sohbet-modeli']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).key, 'gizli-anahtar');
  assert.ok(!JSON.stringify(im).includes('gizli-anahtar'), 'çözülen anahtar arayüze dönmez');

  // Atölye'nin dışa aktardığı dosya: aynı şifreleme (scrypt + AES-256-GCM), birden çok model, tam uç nokta adresi
  const salt = crypto.randomBytes(16);
  const seal = (text) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', crypto.scryptSync('atolye', salt, 32), iv);
    const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
  };
  const atolye = { app: 'atolye', type: 'yerel-llm', version: 1, salt: salt.toString('base64'), models: [
    { name: 'Kurum', url: `${llmUrl}/gw/v2/chat/completions`, model: 'kurum-modeli', kind: 'openai', key: seal('kurum-anahtari') },
    { name: 'Ollama', url: llmUrl, model: 'sohbet-modeli', kind: 'anthropic' },
    { name: 'Bozuk', url: 'adres değil', model: 'x' }] };
  const ask = await call('/api/settings/import', { data: atolye, pass: 'atolye' });
  assert.deepEqual(ask.choose, [{ i: 0, name: 'Kurum', url: `${llmUrl}/gw/v2`, model: 'kurum-modeli', kind: 'openai' }, { i: 1, name: 'Ollama', url: llmUrl, model: 'sohbet-modeli', kind: 'anthropic' }]);
  assert.equal((await call('/api/config')).settings.chatModel, 'sohbet-modeli', 'seçim yapılmadan ayar değişmez');
  const other = await call('/api/settings/import', { data: atolye, pass: 'atolye', pick: 1 });
  assert.deepEqual([other.anthropic, other.settings.embedModel, other.settings.hasKey], [true, 'vektor-modeli', false], 'aynı sunucuda embedding modeli korunur; anahtarsız kayıt eski anahtarı taşımaz');
  const picked = await call('/api/settings/import', { data: atolye, pass: 'atolye', pick: 0 });
  assert.deepEqual([picked.settings, picked.anthropic], [{ url: `${llmUrl}/gw/v2`, chatModel: 'kurum-modeli', embedModel: '', hasKey: true, ready: true }, false]);

  // Gateway: sürüm yolu korunur, anahtar üç başlıkta gider, reddedilen alanlar olmadan yinelenir
  const t = await call('/api/settings/test', { chatModel: 'kurum-modeli' });
  assert.deepEqual([t.ok, t.chat], [true, true], t.error);
  const sent = gateway.at(-1);
  assert.equal(sent.path, '/gw/v2/chat/completions');
  assert.deepEqual([sent.headers.authorization, sent.headers['api-key'], sent.headers['x-api-key']], ['Bearer kurum-anahtari', 'kurum-anahtari', 'kurum-anahtari']);
  assert.deepEqual(Object.keys(sent.body).sort(), ['messages', 'model', 'stream']);

  // Anahtar boş bırakılınca aynı sunucuda korunur, başka bir sunucuya taşınmaz
  assert.equal((await call('/api/settings', { url: `${llmUrl}/gw/v2`, chatModel: 'kurum-modeli' })).settings.hasKey, true);
  assert.equal((await call('/api/settings', { url: 'http://127.0.0.1:9', chatModel: 'baska-model' })).settings.hasKey, false);
});

test('yerel model tanımlı değilken anlamlandırma ve soru anlaşılır hata verir; arama çalışmaya devam eder', async () => {
  fs.rmSync(path.join(tmp, 'ayarlar.json'), { force: true });
  const up = await upload('not.md', 'Toplantı kararı: sürüm 2.4 haftaya çıkacak.');
  assert.equal((await call(`/api/docs/${up.meta.id}/understand`, {})).code, 'no-llm');
  assert.equal((await call('/api/ask', { q: 'sürüm ne zaman' })).code, 'no-llm');
  assert.match((await call('/api/search', { q: 'sürüm 2.4' })).results[0].text, /sürüm 2\.4/);
});
