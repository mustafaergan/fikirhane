// Kitaplık: belgelerin diskteki hâli ve üzerlerindeki işler.
// Her belge ~/.fikirhane/belgeler/<kimlik>/ altında düz dosyalar olarak durur (elle okunup düzeltilebilir):
//   meta.json      ad, sayfa sayısı, durum
//   sayfalar.json  çıkarılan metin (sayfa sayfa)
//   parcalar.json  arama parçaları
//   vektorler.bin  (varsa) parçaların embedding vektörleri
//   notlar.json    bölüm notları (yerel modelin çıkardığı)
//   harita.md      belgenin bir sayfalık haritası
//   sorular.json   modelin kullanıcıya sorduğu sorular ve yanıtları
//   yorumlar.json  kullanıcının kendi notları (belgeden çıkan bilgiden ayrı tutulur)
// Gezilen bir web uygulaması da bir belgedir (kind: "site"): her ekran bir sayfadır; ayrıca
//   ekranlar.json  ekran kartları (alanlar, düğmeler, bağlantılar ve test seçicileri) durur.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractPages, makeChunks, makeSections, extOf, SUPPORTED } from './text.js';
import { buildIndex, bm25, cosineTop, fuse, tokens, fold } from './search.js';
import { normalizeSteps, scenarioText, scenarioScript, scenarioVars, statusText, judgeRun, fileName, MAX_SCENARIOS } from './senaryo.js';
import { cardText, cardChunks, commonLinks, screenGuide, routeTo } from './gezgin.js';
import * as llm from './llm.js';

export const home = () => process.env.FIKIRHANE_HOME || path.join(os.homedir(), '.fikirhane');
const docsDir = () => path.join(home(), 'belgeler');
const dirOf = (id) => path.join(docsDir(), String(id).replace(/[^\w-]/g, ''));
const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 1)); };
const safeName = (name) => String(name || 'belge').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 150) || 'belge';

// ---------- Ayarlar (yerel model sunucusu) ----------
// İki kaynak vardır: elle girilen sunucu (ayarlar.json içinde durur) ya da Atölye'de tanımlı bir yerel model
// (source: "atolye"). Atölye modeli seçiliyken adres, model ve API anahtarı her kullanımda Atölye'nin kaydından
// (~/.atolye/yerel-llm.json) okunur, buraya kopyalanmaz: Atölye'de yapılan değişiklik kendiliğinden geçerli olur.
const settingsFile = () => path.join(home(), 'ayarlar.json');
const atolyeFile = () => process.env.FIKIRHANE_ATOLYE_FILE || process.env.ATOLYE_LOCAL_FILE
  || path.join(process.env.ATOLYE_STATE_FILE ? path.dirname(process.env.ATOLYE_STATE_FILE) : path.join(os.homedir(), '.atolye'), 'yerel-llm.json');
const line = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
const kindOf = (m) => (/\/chat\/completions\/?$/i.test(String(m.url).trim()) || m.kind === 'openai' ? 'openai' : 'anthropic'); // Atölye'deki kuralla aynı
function atolyeModels() {
  const d = readJson(atolyeFile(), null);
  return (Array.isArray(d?.models) ? d.models : []).filter((m) => m && m.id && llm.validUrl(m.url) && line(m.model, 120)).slice(0, 50)
    .map((m) => ({ id: String(m.id), name: line(m.name, 40) || line(m.model, 120), url: llm.base(m.url), model: line(m.model, 120), kind: kindOf(m), key: String(m.key || '') }));
}
/** Atölye'de tanımlı yerel modeller (API anahtarları hariç); Atölye yoksa ya da model tanımlı değilse boş */
export const atolyeList = () => atolyeModels().map((m) => ({ id: m.id, name: m.name, url: m.url, model: m.model, kind: m.kind, hasKey: Boolean(m.key) }));

const stored = () => {
  const s = readJson(settingsFile(), {});
  return { url: s.url || '', chatModel: s.chatModel || '', embedModel: s.embedModel || '', key: s.key || '', kind: s.kind === 'anthropic' ? 'anthropic' : 'openai',
    source: s.source === 'atolye' ? 'atolye' : '', atolye: String(s.atolye || '') };
};
/** Geçerli ayar. kind: "openai" ya da "anthropic" (uç nokta biçimi). Atölye modeli silinmişse missing: true. */
export function settings() {
  const s = stored();
  if (s.source !== 'atolye') return { url: s.url, chatModel: s.chatModel, embedModel: s.embedModel, key: s.key, kind: s.kind, source: '' };
  const m = atolyeModels().find((x) => x.id === s.atolye);
  return m ? { url: m.url, chatModel: m.model, embedModel: s.embedModel, key: m.key, kind: m.kind, source: 'atolye', atolye: m.id, name: m.name }
    : { url: '', chatModel: '', embedModel: s.embedModel, key: '', kind: 'openai', source: 'atolye', atolye: s.atolye, name: '', missing: true };
}
const noModel = (cfg) => fail(cfg.missing ? 'no-atolye-model' : 'no-llm');
export const publicSettings = () => {
  const s = settings();
  const own = stored();
  return { url: s.url, chatModel: s.chatModel, embedModel: s.embedModel, hasKey: Boolean(s.key), ready: Boolean(s.url && s.chatModel), ...(s.kind === 'anthropic' ? { kind: 'anthropic' } : {}),
    ...(s.source ? { source: s.source, atolye: s.atolye, name: s.name, missing: Boolean(s.missing), manual: { url: own.url, chatModel: own.chatModel, hasKey: Boolean(own.key) } } : {}) };
};
export function saveSettings({ url, chatModel, embedModel, key, source, atolye } = {}) {
  const old = stored();
  if (source === 'atolye') { // elle girilmiş sunucu bilgisi silinmez; kaynağa geri dönülebilir
    if (!atolyeModels().some((m) => m.id === String(atolye))) throw fail('no-atolye-model');
    writeJson(settingsFile(), { ...old, embedModel: line(embedModel, 120), source: 'atolye', atolye: String(atolye) });
    return publicSettings();
  }
  const u = llm.base(url);
  if (!llm.validUrl(u)) throw fail('bad-url');
  writeJson(settingsFile(), { url: u, chatModel: String(chatModel || '').trim(), embedModel: String(embedModel || '').trim(),
    key: String(key || '').trim() || (old.url === u ? old.key : ''), // anahtar boşsa eskisi kalır; ama başka bir sunucuya taşınmaz
    kind: old.url === u ? old.kind : 'openai', source: '', atolye: '' });
  return publicSettings();
}
/** "Bağlantıyı dene" için: henüz kaydedilmemiş ayarın (ya da seçilen Atölye modelinin) bağlantı bilgisi */
export function draftSettings({ url, key, chatModel, embedModel, source, atolye } = {}) {
  if (source === 'atolye') {
    const m = atolyeModels().find((x) => x.id === String(atolye));
    if (!m) throw fail('no-atolye-model');
    return { url: m.url, key: m.key, kind: m.kind, chatModel: m.model, embedModel: line(embedModel, 120) };
  }
  const old = stored();
  const u = llm.base(url || old.url);
  if (!llm.validUrl(u)) throw fail('bad-url');
  const same = u === old.url;
  return { url: u, key: String(key || '').trim() || (same ? old.key : ''), kind: same ? old.kind : 'openai', chatModel: line(chatModel, 120), embedModel: line(embedModel, 120) };
}

// Dışa / içe aktarma: yerel model ayarı tek bir JSON dosyasına yazılır. Dosya biçimi Atölye'ninkiyle aynıdır
// (app: "atolye", type: "yerel-llm"), böylece iki uygulama birbirinin dosyasını içe aktarabilir. API anahtarı dosyada
// açık durmaz: verilen şifreleme anahtarıyla (boş bırakılırsa "fikirhane") AES-256-GCM ile şifrelenir, içe aktarırken
// aynı anahtar istenir. Varsayılan anahtar herkesçe bilindiği için gizlilik sağlamaz; kendi anahtarınızı yazın.
export const EXPORT_PASS = 'fikirhane';
const passKey = (pass, salt) => crypto.scryptSync(String(pass), salt, 32);

export function exportSettings({ pass } = {}) {
  const s = settings();
  if (!s.url || !s.chatModel) throw fail('nothing-to-export');
  const salt = crypto.randomBytes(16);
  const seal = (text) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', passKey(String(pass || '') || EXPORT_PASS, salt), iv);
    const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
  };
  return { app: 'atolye', type: 'yerel-llm', version: 1, from: 'fikirhane', salt: salt.toString('base64'),
    models: [{ name: s.chatModel, url: s.url, model: s.chatModel, kind: s.kind, ...(s.embedModel ? { embedModel: s.embedModel } : {}), ...(s.key ? { key: seal(s.key) } : {}) }] };
}

/**
 * Dışa aktarılmış dosyadan (Fikirhane ya da Atölye) yerel model ayarını alır. Fikirhane tek bir model kullanır:
 * dosyada birden çok model varsa ve "pick" verilmediyse seçenekler döner ({ choose }), hiçbir şey yazılmaz.
 * Şifreleme anahtarı yanlışsa da hiçbir şey yazılmaz.
 */
export function importSettings({ data, pass, pick } = {}) {
  let d = data;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch { throw fail('bad-file'); } }
  if (!d || d.app !== 'atolye' || d.type !== 'yerel-llm' || !Array.isArray(d.models)) throw fail('bad-file');
  const models = d.models.slice(0, 50).filter((m) => m && llm.validUrl(m.url) && String(m.model || '').trim());
  if (!models.length) throw fail('bad-file');
  if (models.some((m) => m.key) && !String(pass || '')) throw fail('need-pass');
  let key = null;
  const open = (k) => {
    try {
      key ||= passKey(pass, Buffer.from(String(d.salt || ''), 'base64'));
      const dc = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(k.iv), 'base64'));
      dc.setAuthTag(Buffer.from(String(k.tag), 'base64'));
      return Buffer.concat([dc.update(Buffer.from(String(k.data), 'base64')), dc.final()]).toString('utf8');
    } catch { throw fail('bad-pass'); }
  };
  const keys = models.map((m) => (m.key ? open(m.key) : '')); // bütün anahtarlar çözülür: yanlış anahtar seçimden önce anlaşılır
  const text = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);
  if (models.length > 1 && (pick === undefined || pick === null || pick === '')) {
    return { choose: models.map((m, i) => ({ i, name: text(m.name, 40) || text(m.model, 120), url: llm.base(m.url), model: text(m.model, 120), kind: kindOf(m) })) };
  }
  const i = models.length > 1 ? Number(pick) : 0;
  const m = models[i];
  if (!m) throw fail('not-found');
  const old = stored();
  const url = llm.base(m.url);
  // Embedding modeli dosyada yoksa (Atölye dosyası) ve sunucu aynıysa var olan korunur
  writeJson(settingsFile(), { url, chatModel: text(m.model, 120), embedModel: text(m.embedModel, 120) || (old.url === url ? old.embedModel : ''), key: keys[i],
    kind: kindOf(m), source: '', atolye: '' });
  // Atölye'de Anthropic uyumlu diye kayıtlı sunucu OpenAI uç noktasını da sunuyor olabilir (Ollama gibi) ya da olmayabilir
  return { settings: publicSettings(), model: text(m.model, 120), anthropic: kindOf(m) === 'anthropic' };
}

// ---------- Belgeler ----------
const metaOf = (id) => readJson(path.join(dirOf(id), 'meta.json'), null);
const saveMeta = (meta) => writeJson(path.join(dirOf(meta.id), 'meta.json'), meta);
const part = (id, name, fallback) => readJson(path.join(dirOf(id), name), fallback);

export function listDocs() {
  let ids = [];
  try { ids = fs.readdirSync(docsDir()); } catch { return []; }
  return ids.map(metaOf).filter(Boolean).sort((a, b) => String(b.added).localeCompare(String(a.added)));
}

const indexCache = new Map(); // belge kimliği → { index, chunks, vectors, dim }
function loaded(id) {
  if (indexCache.has(id)) return indexCache.get(id);
  const chunks = part(id, 'parcalar.json', []);
  const entry = { chunks, index: buildIndex(chunks), vectors: null, dim: 0 };
  const meta = metaOf(id);
  if (meta?.embedDim) {
    try {
      const buf = fs.readFileSync(path.join(dirOf(id), 'vektorler.bin'));
      entry.vectors = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
      entry.dim = meta.embedDim;
    } catch { /* vektör yoksa yalnızca kelime araması */ }
  }
  indexCache.set(id, entry);
  return entry;
}

/** Belge ekler: metin çıkarılır, parçalanır ve kelime dizini hazır olur (yapay zekâ kullanılmaz) */
export async function addDocument(buf, name) {
  const e = extOf(name);
  if (!SUPPORTED.includes(e)) throw fail('unsupported', { ext: e });
  const { pages, paged, chars } = await extractPages(buf, name);
  const id = crypto.randomBytes(5).toString('hex');
  const chunks = makeChunks(pages);
  const meta = { id, name: safeName(name), ext: e, added: new Date().toISOString(), pages: pages.length, paged, chars, chunks: chunks.length, sections: makeSections(pages).length, state: 'dizinlendi', understood: 0, approved: false, embedDim: 0 };
  writeJson(path.join(dirOf(id), 'sayfalar.json'), pages);
  writeJson(path.join(dirOf(id), 'parcalar.json'), chunks);
  fs.writeFileSync(path.join(dirOf(id), `asil.${e}`), buf);
  saveMeta(meta);
  return meta;
}

/**
 * Gezilen siteyi belge olarak ekler: her ekran kartı bir "sayfa" olur, böylece arama, anlamlandırma, onay ve soru
 * yanıtlama belgelerle aynı yoldan çalışır. Kartların yapılı hâli (seçicilerle) ekranlar.json'da durur.
 */
export function addSite({ origin, start, cards }) {
  if (!cards?.length) throw fail('no-screens');
  const common = commonLinks(cards);
  const pages = cards.map((c) => ({ page: c.no, text: cardText(c, cards, common) }));
  const chunks = cardChunks(cards);
  const id = crypto.randomBytes(5).toString('hex');
  const host = new URL(origin).host;
  const same = listDocs().filter((d) => d.kind === 'site' && d.origin === origin).length;
  const meta = { id, name: same ? `${host} (${same + 1})` : host, ext: 'site', kind: 'site', origin, start, added: new Date().toISOString(), pages: pages.length, paged: true,
    chars: pages.reduce((n, p) => n + p.text.length, 0), chunks: chunks.length, sections: makeSections(pages).length, state: 'dizinlendi', understood: 0, approved: false, embedDim: 0 };
  writeJson(path.join(dirOf(id), 'ekranlar.json'), cards);
  writeJson(path.join(dirOf(id), 'sayfalar.json'), pages);
  writeJson(path.join(dirOf(id), 'parcalar.json'), chunks);
  saveMeta(meta);
  return meta;
}
/** Sitenin ekran kartları (yapılı): alanlar, düğmeler, bağlantılar ve Playwright biçiminde seçiciler */
export function screens(id) {
  const meta = metaOf(id);
  if (!meta || meta.kind !== 'site') throw fail('not-found');
  return { origin: meta.origin, approved: meta.approved, screens: part(id, 'ekranlar.json', []) };
}

export function removeDocument(id) {
  if (!metaOf(id)) throw fail('not-found');
  cancelJob(id);
  indexCache.delete(id);
  fs.rmSync(dirOf(id), { recursive: true, force: true });
}

/** Belgenin ayrıntısı: harita, bölüm notları, sorular, kullanıcının yorumları ve süren iş */
export function getDocument(id) {
  const meta = metaOf(id);
  if (!meta) throw fail('not-found');
  let map = '';
  try { map = fs.readFileSync(path.join(dirOf(id), 'harita.md'), 'utf8'); } catch { /* henüz yok */ }
  const list = meta.kind === 'site' ? part(id, 'ekranlar.json', []).map((c) => ({ no: c.no, title: c.title, path: c.path, from: c.from, via: c.via, fields: c.fields.length, buttons: c.buttons.length, links: c.links.length, changed: Boolean(c.changed) })) : undefined;
  return { meta, map, notes: part(id, 'notlar.json', []), questions: part(id, 'sorular.json', []), comments: part(id, 'yorumlar.json', []), screens: list,
    scenarios: meta.kind === 'site' ? scenarios(id).map((x) => ({ ...scenInfo(x), text: scenarioText(x) })) : undefined, job: jobs.get(id) || null };
}

export function pageText(id, page) {
  const p = part(id, 'sayfalar.json', []).find((x) => x.page === Number(page));
  if (!p) throw fail('not-found');
  return p;
}

// ---------- Kullanıcının katkıları ----------
export function answerQuestion(id, i, answer) {
  const qs = part(id, 'sorular.json', []);
  if (!qs[i]) throw fail('not-found');
  qs[i].answer = String(answer || '').trim().slice(0, 4000);
  writeJson(path.join(dirOf(id), 'sorular.json'), qs);
  return qs;
}
export function addComment(id, text) {
  if (!metaOf(id)) throw fail('not-found');
  const t = String(text || '').trim().slice(0, 4000);
  if (!t) throw fail('empty');
  const list = part(id, 'yorumlar.json', []);
  list.push({ id: crypto.randomBytes(4).toString('hex'), text: t, added: new Date().toISOString() });
  writeJson(path.join(dirOf(id), 'yorumlar.json'), list);
  return list;
}
export function removeComment(id, commentId) {
  const list = part(id, 'yorumlar.json', []).filter((c) => c.id !== commentId);
  writeJson(path.join(dirOf(id), 'yorumlar.json'), list);
  return list;
}
export function saveMap(id, text) {
  if (!metaOf(id)) throw fail('not-found');
  fs.writeFileSync(path.join(dirOf(id), 'harita.md'), String(text || '').slice(0, 60_000));
}
export function setApproved(id, approved) {
  const meta = metaOf(id);
  if (!meta) throw fail('not-found');
  meta.approved = Boolean(approved);
  saveMeta(meta);
  return meta;
}

// ---------- Arka plan işleri (anlamlandırma, embedding) ----------
const jobs = new Map(); // belge kimliği → { kind, done, total, state, error, controller }
export const jobOf = (id) => { const j = jobs.get(id); return j ? { kind: j.kind, done: j.done, total: j.total, state: j.state, error: j.error || '' } : null; };
export function cancelJob(id) {
  const j = jobs.get(id);
  if (j?.state === 'running') { j.state = 'cancelled'; j.controller.abort(); }
}
function startJob(id, kind, total, run) {
  if (jobs.get(id)?.state === 'running') throw fail('busy');
  const job = { kind, done: 0, total, state: 'running', error: '', controller: new AbortController() };
  jobs.set(id, job);
  job.promise = run(job).then(() => { if (job.state === 'running') job.state = 'done'; }, (err) => {
    if (job.state !== 'cancelled') { job.state = 'error'; job.error = err.detail || err.message; console.warn(`[iş] ${kind} ${id}: ${job.error}`); }
  });
  return job;
}

const PROMPT = {
  note: 'Bir belgenin bir bölümünü okuyorsun. Görevin bu bölümü, sonradan sorulara kaynak olacak şekilde nota çevirmek.\n'
    + 'Kurallar: Yalnızca metinde yazanı kullan, tahmin ekleme. Her maddenin sonuna geçtiği sayfayı (s.N) yaz. Türkçe yaz.\n'
    + 'Biçim:\n**Konu:** tek cümle\n**Öz:** 3–6 madde\n**Kurallar ve kararlar:** varsa maddeler (yoksa "yok")\n**Terimler:** varsa "terim: anlamı" (yoksa "yok")',
  group: 'Aşağıda bir belgenin ardışık bölümlerinin notları var. Bunları, ayrıntıyı kaybetmeden tek bir özet nota indir. Sayfa numaralarını (s.N) koru. Türkçe yaz.',
  map: 'Aşağıda bir belgenin bölüm notları var. Bu belgenin bir sayfalık haritasını çıkar. Yalnızca notlarda yazanı kullan. Türkçe yaz.\n'
    + 'Biçim:\n# Belgenin konusu ve amacı (2–3 cümle)\n# Ana başlıklar (her biri bir satır, sayfa aralığıyla)\n# En önemli kurallar ve kararlar (sayfa numarasıyla)\n# Temel terimler\n# Belirsiz ya da çelişkili görünen noktalar',
  questions: 'Aşağıda bir belgenin haritası var. Bu belgeyi doğru yorumlayabilmek için belgenin sahibine sorulması gereken en fazla 6 soru yaz: '
    + 'belirsiz kalan noktalar, çelişkili görünen yerler, hangi bölümün güncel/geçerli olduğu, kullanıcı için neyin önemli olduğu. '
    + 'Yalnızca bir JSON dizisi döndür: ["soru 1", "soru 2"]. Başka hiçbir şey yazma.',
  // Gezilen web uygulamaları için: kaynak ekran kartlarıdır, (s.N) ekran numarasıdır
  siteNote: 'Bir web uygulamasının ekran kartlarını okuyorsun: her kart bir ekranın adresini, başlıklarını, alanlarını, düğmelerini ve bağlantılarını listeler. '
    + 'Görevin bu ekranları, sonradan "şu iş hangi ekranda, nasıl yapılır" sorularına ve tarayıcı testlerine kaynak olacak şekilde nota çevirmek.\n'
    + 'Kurallar: Yalnızca kartta yazanı kullan, tahmin ekleme. Alan ve düğme adlarını kartta yazdığı gibi, tırnak içinde yaz. Her maddenin sonuna ekran numarasını (s.N) yaz. Türkçe yaz.\n'
    + 'Biçim:\n**Ekranlar:** her ekran için tek satır: adı, adresi, ne işe yaradığı\n**Yapılabilen işler:** maddeler: hangi ekranda hangi alanlar doldurulur, hangi düğmeye basılır\n**Geçişler:** hangi ekrandan hangisine nasıl gidilir',
  siteMap: 'Aşağıda bir web uygulamasının ekran notları var. Bu uygulamanın bir sayfalık haritasını çıkar. Yalnızca notlarda yazanı kullan. Ekran numaralarını (s.N) koru. Türkçe yaz.\n'
    + 'Biçim:\n# Uygulamanın amacı (2–3 cümle)\n# Ekranlar (her biri bir satır: adı, adresi, ne işe yaradığı, ekran numarası)\n# Temel akışlar (adım adım: hangi ekran, hangi alan, hangi düğme)\n# Giriş ve gezinme (giriş ekranı, ortak menü)\n# Belirsiz kalan noktalar',
  siteQuestions: 'Aşağıda bir web uygulamasının haritası var. Bu uygulamayı doğru test edebilmek için uygulamayı bilen kişiye sorulması gereken en fazla 6 soru yaz: '
    + 'en önemli akışlar hangileri, hangi alan hangi değerleri kabul eder, hangi işlemler geri alınamaz ve testte yapılmamalıdır, testte hangi kullanıcı ve veri kullanılmalıdır. '
    + 'Yalnızca bir JSON dizisi döndür: ["soru 1", "soru 2"]. Başka hiçbir şey yazma.',
  answer: 'Sen Fikirhane\'sin: kullanıcının belgelerine dayanarak soru yanıtlarsın.\n'
    + 'Kurallar: Yalnızca aşağıda verilen kaynakları kullan. Her bilginin yanına kaynağını [belge adı s.N] biçiminde yaz. '
    + '"Kullanıcının notları" bölümü belgeden değil kullanıcıdan gelir; belgeyle çelişirse kullanıcının notunu esas al ve bunu belirt. '
    + 'Kaynaklarda yanıt yoksa "Belgelerde bu bilgi yok" de, tahmin yürütme. Kısa ve açık yaz, Türkçe yanıtla.',
};

function parseQuestions(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try { const a = JSON.parse(text.slice(start, end + 1)); if (Array.isArray(a)) return a.filter((q) => typeof q === 'string' && q.trim()).slice(0, 6); } catch { /* aşağıdaki yedek */ }
  }
  return text.split('\n').map((l) => l.replace(/^[\s\-*\d.)"]+|["',]+$/g, '').trim()).filter((l) => l.endsWith('?')).slice(0, 6);
}

/** Yerel modelle anlamlandırma: bölüm notları → harita → kullanıcıya sorular. Kaldığı yerden devam eder. */
export function understand(id) {
  const meta = metaOf(id);
  if (!meta) throw fail('not-found');
  const cfg = settings();
  if (!cfg.url || !cfg.chatModel) throw noModel(cfg);
  const sections = makeSections(part(id, 'sayfalar.json', []));
  const ask = (system, user, signal, maxTokens) => llm.chat({ url: cfg.url, key: cfg.key, kind: cfg.kind, model: cfg.chatModel, signal, maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
  const site = meta.kind === 'site';
  const P = site ? { note: PROMPT.siteNote, map: PROMPT.siteMap, questions: PROMPT.siteQuestions } : PROMPT;
  return startJob(id, 'anlamlandırma', sections.length + 2, async (job) => {
    const notes = part(id, 'notlar.json', []);
    for (const s of sections) {
      if (job.state !== 'running') return;
      if (!notes.some((n) => n.i === s.i)) {
        const note = await ask(P.note, `${site ? 'Uygulama' : 'Belge'}: ${meta.name}\n${site ? 'Ekranlar' : 'Sayfalar'}: ${s.from}–${s.to}\n\n${s.text}`, job.controller.signal, 900);
        notes.push({ i: s.i, from: s.from, to: s.to, note });
        notes.sort((a, b) => a.i - b.i);
        writeJson(path.join(dirOf(id), 'notlar.json'), notes);
        const m = metaOf(id); m.understood = notes.length; m.state = 'anlamlandırılıyor'; saveMeta(m);
      }
      job.done++;
    }
    // Harita: notlar modelin bağlamına sığmayacak kadar uzunsa önce gruplar hâlinde özetlenir
    let pieces = notes.map((n) => `[s.${n.from}–${n.to}]\n${n.note}`);
    while (pieces.join('\n\n').length > 14_000 && pieces.length > 1) {
      const groups = [];
      let cur = '';
      for (const p of pieces) { if (cur && cur.length + p.length > 9000) { groups.push(cur); cur = ''; } cur += (cur ? '\n\n' : '') + p; }
      if (cur) groups.push(cur);
      if (groups.length === pieces.length) break;
      pieces = [];
      for (const g of groups) { if (job.state !== 'running') return; pieces.push(await ask(PROMPT.group, g, job.controller.signal, 1000)); }
    }
    const map = await ask(P.map, `${site ? 'Uygulama' : 'Belge'}: ${meta.name} (${meta.pages} ${site ? 'ekran' : 'sayfa'})\n\n${pieces.join('\n\n').slice(0, 16_000)}`, job.controller.signal, 1400);
    saveMap(id, map);
    job.done++;
    const old = part(id, 'sorular.json', []);
    if (!old.length) {
      const qs = parseQuestions(await ask(P.questions, map, job.controller.signal, 600));
      writeJson(path.join(dirOf(id), 'sorular.json'), qs.map((q) => ({ q, answer: '' })));
    }
    job.done++;
    const m = metaOf(id); m.state = 'anlamlandırıldı'; m.understood = notes.length; saveMeta(m);
  });
}

/** Anlamsal dizin: parçaların embedding vektörleri yerel modelden alınır (isteğe bağlı) */
export function embedDocument(id) {
  const meta = metaOf(id);
  if (!meta) throw fail('not-found');
  const cfg = settings();
  if (!cfg.url || !cfg.embedModel) throw fail('no-embed');
  const chunks = part(id, 'parcalar.json', []);
  return startJob(id, 'anlamsal dizin', chunks.length, async (job) => {
    const rows = [];
    for (let i = 0; i < chunks.length; i += 16) {
      if (job.state !== 'running') return;
      const batch = chunks.slice(i, i + 16);
      rows.push(...await llm.embed({ url: cfg.url, key: cfg.key, model: cfg.embedModel, input: batch.map((c) => c.text), signal: job.controller.signal }));
      job.done = Math.min(chunks.length, i + batch.length);
    }
    const dim = rows[0].length;
    const all = new Float32Array(rows.length * dim);
    rows.forEach((r, i) => all.set(r, i * dim));
    fs.writeFileSync(path.join(dirOf(id), 'vektorler.bin'), Buffer.from(all.buffer));
    const m = metaOf(id); m.embedDim = dim; m.embedModel = cfg.embedModel; saveMeta(m);
    indexCache.delete(id);
  });
}

// ---------- Arama ve soru yanıtlama ----------
/** Seçili belgelerde (boşsa hepsinde) arar: kelime araması + varsa anlamsal arama. [{ doc, name, page, text }] */
export async function search(q, docIds = [], limit = 8) {
  const docs = listDocs().filter((d) => !docIds.length || docIds.includes(d.id));
  const cfg = settings();
  let qvec = null;
  const lists = [[], []];
  for (const d of docs) {
    const e = loaded(d.id);
    for (const r of bm25(e.index, q, 20)) lists[0].push({ doc: d.id, name: d.name, page: e.chunks[r.i].page, text: e.chunks[r.i].text, i: r.i, score: r.score });
    if (e.vectors && cfg.url && cfg.embedModel && d.embedModel === cfg.embedModel) {
      try {
        if (!qvec) qvec = (await llm.embed({ url: cfg.url, key: cfg.key, model: cfg.embedModel, input: [q], timeoutMs: 30_000 }))[0];
        if (qvec.length === e.dim) for (const r of cosineTop(e.vectors, e.dim, qvec, 20)) lists[1].push({ doc: d.id, name: d.name, page: e.chunks[r.i].page, text: e.chunks[r.i].text, i: r.i, score: r.score });
      } catch { /* anlamsal arama yapılamazsa kelime aramasıyla devam edilir */ }
    }
  }
  lists.forEach((l) => l.sort((a, b) => b.score - a.score));
  return fuse(lists.filter((l) => l.length), (x) => `${x.doc}:${x.i}`, limit).map(({ doc, name, page, text }) => ({ doc, name, page, text }));
}

/** Soruyu belgelere dayanarak yanıtlar: harita + kullanıcının notları + en ilgili parçalar yerel modele verilir */
export async function ask(q, docIds = []) {
  const question = String(q || '').trim();
  if (!question) throw fail('empty');
  const cfg = settings();
  if (!cfg.url || !cfg.chatModel) throw noModel(cfg);
  const sources = await search(question, docIds, 8);
  const docs = listDocs().filter((d) => (docIds.length ? docIds.includes(d.id) : sources.some((s) => s.doc === d.id)));
  const maps = [];
  const mine = [];
  for (const d of docs.slice(0, 4)) {
    const full = getDocument(d.id);
    if (full.map) maps.push(`## ${d.name}${d.approved ? ' (kullanıcı onayladı)' : ''}\n${full.map.slice(0, 2500)}`);
    for (const x of full.questions) if (x.answer) mine.push(`- (${d.name}) Soru: ${x.q}\n  Kullanıcının yanıtı: ${x.answer}`);
    for (const c of full.comments) mine.push(`- (${d.name}) ${c.text}`);
  }
  const context = [
    maps.length ? `# Belge haritaları\n${maps.join('\n\n')}` : '',
    mine.length ? `# Kullanıcının notları (belgeden değil, kullanıcıdan)\n${mine.join('\n').slice(0, 4000)}` : '',
    sources.length ? `# Kaynak parçalar\n${sources.map((s) => `[${s.name} s.${s.page}]\n${s.text}`).join('\n\n')}` : '# Kaynak parçalar\n(Soruyla eşleşen bölüm bulunamadı.)',
  ].filter(Boolean).join('\n\n');
  const answer = await llm.chat({ url: cfg.url, key: cfg.key, kind: cfg.kind, model: cfg.chatModel, maxTokens: 1200, messages: [{ role: 'system', content: PROMPT.answer }, { role: 'user', content: `${context}\n\n# Soru\n${question}` }] });
  return { answer, sources };
}

// ---------- Siteler: tarayıcı testleri için salt okunur bilgi ----------
// Bir uygulamayı test edecek yapay zekâ (ör. Atölye'deki oturum) ekranı kendisi keşfetmek yerine buradan sorar:
// hangi ekranlar var, bir ekrana nasıl gidilir, o ekrandaki alan ve düğmelerin seçicileri neler. Her yanıtta hem
// yapılı veri hem de modele doğrudan verilebilecek kısa bir "text" bulunur. Hiçbiri yerel modeli kullanmaz.
function site(id) {
  const meta = metaOf(id);
  if (!meta || meta.kind !== 'site') throw fail('not-found');
  return { meta, cards: part(id, 'ekranlar.json', []) };
}
const siteInfo = (d) => ({ id: d.id, name: d.name, origin: d.origin, screens: d.pages, approved: Boolean(d.approved), understood: d.state === 'anlamlandırıldı', added: d.added });
const siteLine = (d) => `${d.name} (${d.origin}): ${d.pages} ekran${d.approved ? ', kullanıcı onayladı' : d.state === 'anlamlandırıldı' ? ', onay bekliyor' : ', henüz anlamlandırılmadı'}`;

export function listSites() {
  const sites = listDocs().filter((d) => d.kind === 'site');
  return { sites: sites.map(siteInfo), text: sites.length ? sites.map((d) => `- [${d.id}] ${siteLine(d)}`).join('\n') : 'Fikirhane\'de gezilmiş site yok. Önce Fikirhane\'de "Site gez" ile uygulama tanıtılmalı.' };
}

/** Sitenin özeti: harita (varsa), kullanıcının notları ve ekran listesi */
export function siteOverview(id) {
  const { meta, cards } = site(id);
  const full = getDocument(id);
  const notes = [...full.questions.filter((x) => x.answer).map((x) => `Soru: ${x.q} Yanıt: ${x.answer}`), ...full.comments.map((c) => c.text)];
  const text = [
    `# ${siteLine(meta)}`,
    full.map && `## Harita\n${full.map.slice(0, 4000)}`,
    notes.length && `## Kullanıcının notları (ekran kartlarıyla çelişirse bunlar esas alınır)\n${notes.map((n) => `- ${n}`).join('\n').slice(0, 3000)}`,
    `## Ekranlar\n${cards.map((c) => `${c.no}. ${c.title} — ${c.path}${c.changed ? ' (değişmiş görünüyor)' : ''}`).join('\n')}`,
    scenarios(id).length && `## Senaryolar (kayıtlı, yeniden çalıştırılabilir)\n${scenarios(id).map(scenLine).join('\n')}`,
  ].filter(Boolean).join('\n\n');
  return { site: siteInfo(meta), map: full.map, notes, screens: cards.map((c) => ({ no: c.no, title: c.title, path: c.path, url: c.url, dialog: c.dialog, from: c.from, via: c.via, iz: c.iz, changed: Boolean(c.changed) })), scenarios: scenarios(id).map(scenInfo), text };
}

/** Tek ekran: alanlar, düğmeler, bağlantılar ve seçicileri */
export function siteScreen(id, no) {
  const { cards } = site(id);
  const card = cards.find((c) => c.no === Number(no));
  if (!card) throw fail('not-found');
  // Bir senaryo bu ekranda kaldıysa ve ekran karttan farklı çıktıysa: kart eskimiş olabilir, bunu soran da bilmeli
  const stale = card.changed ? `\nUyarı: bu ekran ${card.changed.at.slice(0, 10)} tarihli bir çalıştırmada karttan farklı çıktı (arayüz değişmiş olabilir).`
    + `${card.changed.added.length ? ` Yeni: ${card.changed.added.map((e) => `${e.kind} ${e.name}`).join('; ')}.` : ''}${card.changed.removed.length ? ` Artık yok: ${card.changed.removed.map((e) => `${e.kind} ${e.name}`).join('; ')}.` : ''}` : '';
  return { screen: card, text: screenGuide(card, cards) + stale };
}

/** Bir ekrana gidiş yolu: doğrudan adres ve kaydedilen tıklama zinciri */
export function siteRoute(id, no) {
  const r = routeTo(site(id).cards, no);
  if (!r) throw fail('not-found');
  return r;
}

/** "Üye nereden eklenir", "doğum tarihi alanı" gibi bir sorguyla eşleşen ekranlar ve o ekranlardaki eşleşen öğeler */
export async function siteFind(q, id) {
  const query = String(q || '').trim();
  if (!query) throw fail('empty');
  const ids = id ? [site(id).meta.id] : listDocs().filter((d) => d.kind === 'site').map((d) => d.id);
  const want = new Set(tokens(query));
  const score = (name) => tokens(name).filter((t) => want.has(t)).length;
  const results = [];
  for (const hit of ids.length ? await search(query, ids, 12) : []) {
    if (results.length >= 5 || results.some((r) => r.site === hit.doc && r.no === hit.page)) continue;
    const card = part(hit.doc, 'ekranlar.json', []).find((c) => c.no === hit.page);
    if (!card) continue;
    const elements = [...card.fields.map((x) => ({ kind: 'alan', ...x })), ...card.buttons.map((x) => ({ kind: x.role === 'tab' ? 'sekme' : 'düğme', ...x })), ...card.links.map((x) => ({ kind: 'bağlantı', ...x }))]
      .map((x) => ({ kind: x.kind, name: x.name, locator: x.locator, hit: score(x.name) })).filter((x) => x.hit > 0).sort((a, b) => b.hit - a.hit).slice(0, 8)
      .map((x) => ({ kind: x.kind, name: x.name, locator: x.locator }));
    results.push({ site: hit.doc, name: hit.name, no: card.no, title: card.title, path: card.path, url: card.url, dialog: card.dialog, elements });
  }
  const text = results.length
    ? results.map((r) => [`[${r.site}] Ekran ${r.no}: ${r.title} — ${r.dialog ? `${r.path} (açık pencere)` : r.url}`, ...r.elements.map((e) => `- ${e.kind} ${e.name}${e.locator ? `: ${e.locator}` : ''}`)].join('\n')).join('\n\n')
    : 'Eşleşen ekran bulunamadı.';
  return { results, text };
}

// ---------- Senaryolar: bir sitede adım adım yapılan işlerin saklanan tarifleri ----------
// Senaryoyu test yapan araç (ör. Atölye'deki oturum) ya da kullanıcı kaydeder; Fikirhane denetler, saklar ve
// Playwright betiğine çevirir. Betiği Fikirhane çalıştırmaz; çalıştıran sonucu bildirir (bkz. senaryo.js).
const scenFile = (id) => path.join(dirOf(id), 'senaryolar.json');
const scenarios = (id) => part(id, 'senaryolar.json', []).filter((x) => x && x.id && Array.isArray(x.steps));
const scenInfo = (x) => ({ id: x.id, name: x.name, description: x.description || '', steps: x.steps.length, status: x.status || 'denenmedi', updated: x.updated, last: x.runs?.[0] || null, vars: scenarioVars(x.steps) });
const scenLine = (x) => `- [${x.id}] ${x.name} (${x.steps.length} adım) — ${statusText(x)}`;

export function listScenarios(id) {
  site(id);
  const all = scenarios(id);
  return { scenarios: all.map(scenInfo), text: all.length ? all.map(scenLine).join('\n') : 'Bu site için kayıtlı senaryo yok.' };
}
export function getScenario(id, sid) {
  site(id);
  const x = scenarios(id).find((s) => s.id === sid);
  if (!x) throw fail('not-found');
  return { scenario: x, text: scenarioText(x) };
}
/** Senaryo ekler ya da günceller (kimlikle; kimlik yoksa aynı adlı senaryo güncellenir). Adımlar denetlenir. */
export function saveScenario(id, { id: sid, name, description, steps } = {}) {
  const { meta, cards } = site(id);
  const title = line(name, 80);
  if (!title) throw fail('no-name');
  const clean = normalizeSteps(steps, { origin: meta.origin, cards });
  const all = scenarios(id);
  const now = new Date().toISOString();
  let x = sid ? all.find((s) => s.id === String(sid)) : all.find((s) => fold(s.name) === fold(title));
  if (sid && !x) throw fail('not-found');
  if (x) {
    // Adımlar değiştiyse eski sonuç artık bu senaryoyu anlatmaz
    if (JSON.stringify(x.steps) !== JSON.stringify(clean)) x.status = 'denenmedi';
    Object.assign(x, { name: title, description: line(description, 300), steps: clean, updated: now });
  } else {
    if (all.length >= MAX_SCENARIOS) throw fail('too-many-scenarios');
    x = { id: `s${crypto.randomBytes(3).toString('hex')}`, name: title, description: line(description, 300), steps: clean, created: now, updated: now, status: 'denenmedi', runs: [] };
    all.push(x);
  }
  writeJson(scenFile(id), all);
  // Kartlarda bulunmayan seçiciler yanlış olmayabilir (kartlar her öğeyi içermez) ama denenmemiştir: söylenir
  const known = new Set(cards.flatMap((c) => [...c.fields, ...c.buttons, ...c.links].map((e) => e.locator)).filter(Boolean));
  const unknown = clean.filter((s) => s.locator && !known.has(s.locator) && !known.has(s.locator.replace(/\.(first|last)\(\)$|\.nth\(\d+\)$/, ''))).length;
  return { scenario: x, text: `Kaydedildi.\n${scenarioText(x)}${unknown ? `\nNot: ${unknown} adımın seçicisi ekran kartlarında yok; çalıştırılarak doğrulanmalı.` : ''}` };
}
/** Bir ekrana gidişi (gezintide kaydedilen tıklama zinciri) senaryo olarak kaydeder */
export function scenarioFromScreen(id, no) {
  const { cards } = site(id);
  const r = routeTo(cards, no);
  if (!r) throw fail('not-found');
  const target = cards.find((c) => c.no === r.target);
  if (r.steps.some((s) => s.action === 'click' && !s.locator)) throw fail('no-route');
  const steps = r.steps.map((s) => (s.action === 'goto' ? { do: 'goto', url: s.url } : { do: 'click', locator: s.locator, note: `Ekran ${s.screen}: ${s.title}` }));
  const head = target.dialog || target.headings[0];
  if (head) steps.push({ do: 'expect', text: head });
  return saveScenario(id, { name: `${target.title} ekranına git`, description: 'Gezintide kaydedilen yoldan üretildi.', steps });
}
export function removeScenario(id, sid) {
  site(id);
  const all = scenarios(id);
  if (!all.some((s) => s.id === sid)) throw fail('not-found');
  writeJson(scenFile(id), all.filter((s) => s.id !== sid));
}
/** Senaryonun çalıştırılabilir Playwright betiği. base: betiğin sonucu bildireceği Fikirhane adresi. */
export function scriptOf(id, sid, { base, version }) {
  const { meta } = site(id);
  const { scenario } = getScenario(id, sid);
  const vars = scenarioVars(scenario.steps);
  return { file: fileName(scenario), vars, script: scenarioScript({ site: meta, scenario, base, version }),
    text: `Betik: ${fileName(scenario)} (${scenario.steps.length} adım). Çalıştırma: node ${fileName(scenario)}\nPlaywright klasörü FIKIRHANE_PLAYWRIGHT ile, oturum klasörü FIKIRHANE_PROFIL ile verilir.${vars.length ? `\nGerekli değişkenler: ${vars.map((v) => `FIKIRHANE_VAR_${v.toUpperCase()}`).join(', ')}` : ''}` };
}
/**
 * Betiğin bildirdiği çalıştırma sonucunu kaydeder. Senaryo kaldıysa ve kaldığı ekran kartından farklıysa kart
 * "değişmiş" olarak işaretlenir (kartın kendisi değiştirilmez; site yeniden gezilince güncellenir).
 */
export function recordRun(id, sid, result) {
  const { meta, cards } = site(id);
  const all = scenarios(id);
  const x = all.find((s) => s.id === sid);
  if (!x) throw fail('not-found');
  const { run, changed, text } = judgeRun(x, result, { origin: meta.origin, cards });
  x.runs = [run, ...(x.runs || [])].slice(0, 10);
  x.status = run.ok ? 'geçti' : 'kaldı';
  writeJson(scenFile(id), all);
  if (changed) {
    const card = cards.find((c) => c.no === changed.no);
    card.changed = { at: changed.at, added: changed.added, removed: changed.removed };
    writeJson(path.join(dirOf(id), 'ekranlar.json'), cards);
  }
  return { status: x.status, changed: changed ? changed.no : null, text };
}
