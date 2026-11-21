// Gezgin: bir web uygulamasını bu bilgisayarda kurulu tarayıcıyla (Edge ya da Chrome) gezer ve her ekranın yapısını
// "ekran kartı" olarak çıkarır: adres, başlıklar, alanlar, düğmeler, bağlantılar ve bunların test seçicileri.
// Ek kütüphane kullanmaz: tarayıcı --remote-debugging-pipe ile başlatılır ve DevTools protokolü süreç borusundan
// konuşulur; açık bir hata ayıklama kapısı olmadığı için bilgisayardaki başka bir program araya giremez.
//
// Sınırlar (bilerek):
//   - Hiçbir düğmeye basılmaz, hiçbir form gönderilmez. Otomatik gezinti yalnızca aynı sitedeki bağlantıların
//     adresine gider; çıkış, silme, indirme gibi görünen bağlantılar atlanır.
//   - Alanlara yazılan değerler ve tablo satırlarındaki veriler okunmaz; kartta yalnızca yapı (etiketler) durur.
//   - Tarayıcı geçici bir profille (<veri klasörü>/gezgin/…) açılır; gezinti bitince profil (çerezler dahil) silinir.
//     Uygulama beklenmedik biçimde kapanırsa kalan profil bir sonraki gezintinin başında silinir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v, n = 80) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const MAX_CARDS = 300;
const profilesDir = () => path.join(process.env.FIKIRHANE_HOME || path.join(os.homedir(), '.fikirhane'), 'gezgin');
const MAX_STATES = 6; // aynı adres kalıbında (açılan pencere, sekme gibi) en fazla bu kadar farklı durum kaydedilir

// ---------- Adresler ----------
const ID_PART = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;
const routeHash = (u) => (/^#[/!]/.test(u.hash) ? u.hash : '');
// Sorgu değerleri üç türdür: ekranı seçen kelime (?action=list; eski tip uygulamalar böyle yönlenir), kimlik (?id=12)
// ve geri kalan her şey (arama metni, süzgeç: kullanıcının verisi). Yalnızca ilki ekranı belirler ve karta yazılır.
const ROUTE_KEY = /^(action|act|do|cmd|view|tab|module|mod|mode|section|screen|route|page|menu|sayfa|islem|sekme|bolum|ekran)$/i;
const ROUTE_WORD = /^[a-z][\w.-]{0,30}$/i;
function query(u) {
  const out = [];
  for (const key of [...new Set(u.searchParams.keys())].sort()) {
    const value = u.searchParams.get(key);
    out.push({ key, value, kind: ID_PART.test(value) ? 'id' : ROUTE_KEY.test(key) && ROUTE_WORD.test(value) ? 'route' : 'data' });
  }
  return out;
}
const joinQuery = (list) => (list.length ? `?${list.join('&')}` : '');
/** Ekranın adresi (gösterim): yol + sorgu (veri değerleri "…" olur) + varsa "#/…" biçimli uygulama yolu */
export function screenPath(url) {
  const u = new URL(url);
  return u.pathname + joinQuery(query(u).map((q) => `${q.key}=${q.kind === 'route' ? q.value : q.kind === 'id' ? '{id}' : '…'}`)) + routeHash(u);
}
/** Adres kalıbı: sayı ve kimlik görünümlü bölümler {id} olur; /urun/12 ile /urun/57 aynı ekrandır */
export function urlPattern(url) {
  const u = new URL(url);
  const parts = (p) => p.split('/').map((s) => (ID_PART.test(s) ? '{id}' : s)).join('/');
  // Veri değerli sorgu anahtarları (arama, süzgeç, kaynak) ekranı değiştirmez: /liste ile /liste?q=… aynı ekrandır
  return parts(u.pathname) + joinQuery(query(u).filter((q) => q.kind !== 'data').map((q) => (q.kind === 'route' ? `${q.key}=${q.value}` : `${q.key}={id}`))) + parts(routeHash(u));
}
/** Gidilebilir adres: ekranı seçen kelimeler ve kimlikler kalır, veri değerleri (arama metni vb.) atılır */
export function cleanUrl(url) {
  const u = new URL(url);
  return u.origin + u.pathname + joinQuery(query(u).filter((q) => q.kind !== 'data').map((q) => `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value)}`)) + routeHash(u);
}
const DANGER = /(çıkış|cikis|oturumu kapat|log-?out|sign-?out|\bsil\b|silin|delete|remove|kaldır|iptal|cancel|onayla|approve|reddet|reject|gönder|export|dışa aktar|indir|download|yazdır|print)/i;
const FILE = /\.(pdf|zip|rar|7z|xlsx?|docx?|pptx?|csv|exe|msi|png|jpe?g|gif|svg|mp4|mp3)$/i;
/** Otomatik gezintide gidilmeyecek bağlantı: adı ya da adresi değiştiren/sonlandıran bir işleme benziyor */
export function dangerous(name, href) {
  let u;
  try { u = new URL(href); } catch { return true; }
  return !/^https?:$/.test(u.protocol) || DANGER.test(name || '') || DANGER.test(decodeURIComponent(u.pathname + u.search)) || FILE.test(u.pathname);
}

// ---------- Tarayıcıda çalışan bölüm ----------
// Bu işlev metne çevrilip sayfaya gönderilir; dışarıdaki hiçbir değişkeni kullanamaz.
function pageLib() {
  const clean = (s, n = 80) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const visible = (el) => { if (!el.getClientRects().length) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, SELECT: 1, TEXTAREA: 1, INPUT: 1 };
  // Öğenin görünen metni; alanların içindeki değerler (kullanıcının yazdığı) alınmaz
  const textOf = (node) => {
    let t = '';
    for (const c of node.childNodes) {
      if (c.nodeType === 3) t += c.nodeValue;
      else if (c.nodeType === 1 && !SKIP[c.tagName]) t += c.tagName === 'IMG' ? ` ${c.alt || ''} ` : ` ${textOf(c)} `;
      if (t.length > 300) break;
    }
    return t;
  };
  const TAG_ROLE = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button' };
  const INPUT_ROLE = { button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox' };
  const roleOf = (el) => clean(el.getAttribute('role'), 20) || (el.tagName === 'INPUT' ? INPUT_ROLE[el.type] || 'textbox' : TAG_ROLE[el.tagName]) || (el.isContentEditable ? 'textbox' : '');
  const labelled = (el) => {
    const ids = el.getAttribute('aria-labelledby');
    if (ids) {
      const t = clean(ids.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? textOf(n) : ''; }).join(' '));
      if (t) return t;
    }
    return clean(el.getAttribute('aria-label'));
  };
  const ACTION = ['link', 'button', 'tab', 'menuitem'];
  const nameOf = (el, role) => {
    const a = labelled(el);
    if (a) return { name: a, how: 'role' };
    if (ACTION.includes(role)) {
      if (el.tagName === 'INPUT') return { name: clean(el.value || el.alt || el.title), how: 'role' };
      return { name: clean(textOf(el)) || clean(el.title), how: 'role' };
    }
    const lab = el.labels && el.labels[0];
    if (lab && clean(textOf(lab))) return { name: clean(textOf(lab)), how: 'label' };
    if (el.placeholder) return { name: clean(el.placeholder), how: 'placeholder' };
    const own = SKIP[el.tagName] ? '' : clean(textOf(el));
    if (own) return { name: own, how: 'role' };
    return { name: clean(el.title || el.getAttribute('name')), how: '' };
  };
  const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  // Playwright biçiminde seçici: önce test kimliği, sonra etiket/rol, en son id ya da name
  const locatorOf = (el, role, name, how) => {
    const tid = clean(el.getAttribute('data-testid'));
    if (tid) return `getByTestId(${q(tid)})`;
    if (name && how === 'label') return `getByLabel(${q(name)})`;
    if (name && how === 'placeholder') return `getByPlaceholder(${q(name)})`;
    if (name && how === 'role' && role) return `getByRole(${q(role)}, { name: ${q(name)} })`;
    if (el.id) return `locator(${q(`#${CSS.escape(clean(el.id))}`)})`;
    const n = clean(el.getAttribute('name'));
    return n ? `locator(${q(`[name="${n}"]`)})` : '';
  };
  // Veri satırı mı: başlık satırı olan bir tablonun gövde satırı (yerleşim için kullanılan tablolar sayılmaz)
  const inRow = (el) => {
    const tr = el.closest('tr');
    if (tr) {
      const table = tr.closest('table');
      return Boolean(table && (table.tHead || table.querySelector('tr > th')) && !tr.closest('thead') && !tr.querySelector(':scope > th'));
    }
    const row = el.closest('[role="row"]');
    return Boolean(row && !row.querySelector('[role="columnheader"]'));
  };
  const card = () => {
    const modal = [...document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]')].filter(visible)
      .filter((d) => d.getAttribute('aria-modal') === 'true' || (d.tagName === 'DIALOG' && d.matches(':modal'))).pop();
    const root = modal || document;
    const uniq = (list, max) => [...new Set(list.filter(Boolean))].slice(0, max);
    const out = { url: location.href, origin: location.origin, title: clean(document.title, 120), h1: '', dialog: '', headings: [], links: [], buttons: [], fields: [], columns: [], unnamed: 0 };
    const heads = [...root.querySelectorAll('h1, h2, h3, [role="heading"]')].filter(visible);
    out.headings = uniq(heads.map((h) => clean(textOf(h))), 12);
    const h1 = [...document.querySelectorAll('h1')].find(visible); // açık pencerede de sayfanın kendi başlığı
    out.h1 = h1 ? clean(textOf(h1)) : '';
    if (modal) out.dialog = labelled(modal) || out.headings[0] || 'pencere';
    out.columns = uniq([...root.querySelectorAll('th, [role="columnheader"]')].filter(visible).map((h) => clean(textOf(h), 40)), 30);
    const SEL = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [role="textbox"], [role="searchbox"], [contenteditable="true"]';
    for (const el of root.querySelectorAll(SEL)) {
      if (out.links.length + out.buttons.length + out.fields.length >= 400) break;
      if ((el.tagName === 'INPUT' && el.type === 'hidden') || !visible(el)) continue;
      const role = roleOf(el);
      if (!role) continue;
      const row = inRow(el);
      const { name, how } = nameOf(el, role);
      const base = { name, row, locator: row ? '' : locatorOf(el, role, name, how) };
      if (role === 'link') out.links.push({ ...base, href: typeof el.href === 'string' ? el.href : '' });
      else if (ACTION.includes(role)) {
        if (name) out.buttons.push({ ...base, role, disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true') });
        else out.unnamed++;
      } else {
        out.fields.push({ ...base,
          type: el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'INPUT' ? el.type : role,
          required: Boolean(el.required || el.getAttribute('aria-required') === 'true'),
          options: el.tagName === 'SELECT' ? [...el.options].slice(0, 8).map((o) => clean(o.textContent, 40)).filter(Boolean) : [] });
      }
    }
    return out;
  };
  const clicked = (el) => { const role = roleOf(el); const row = inRow(el); return { role, row, name: row ? '' : nameOf(el, role).name }; };
  return { card, clicked };
}
/** Sayfada çalışan kart çıkarıcının kaynağı: senaryo betikleri kaldıkları ekranı aynı kodla özetler */
export const PAGE_CARD = `(${pageLib})().card()`;
// Sayfa durulana kadar (öğe sayısı değişmeyene kadar, en çok ~5 sn) beklenir, sonra kart çıkarılır
const EXTRACT = `(async () => { await new Promise((done) => { let last = -1, same = 0, n = 0; const t = setInterval(() => {
  const c = document.getElementsByTagName('*').length; same = c === last && document.readyState === 'complete' ? same + 1 : 0; last = c;
  if (same >= 2 || ++n > 24) { clearInterval(t); done(); } }, 200); }); return (${pageLib})().card(); })()`;
// Kullanıcının tıkladığı öğenin rolü ve adı (yazdıkları değil) Fikirhane'ye bildirilir: "bu ekrana nasıl gelindi"
const WATCH = `(() => { if (window.__fikirhaneIz) return; window.__fikirhaneIz = true; const F = (${pageLib})();
  addEventListener('click', (e) => { try {
    const t = e.target && e.target.closest && e.target.closest('a[href], button, summary, input[type=submit], input[type=button], [role=button], [role=link], [role=tab], [role=menuitem]');
    if (t && window.fikirhaneTik) window.fikirhaneTik(JSON.stringify(F.clicked(t)));
  } catch (err) { /* yoksay */ } }, true); })()`;

// ---------- Kart ----------
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const digits = (s) => String(s).replace(/\d+/g, '#').toLowerCase();
/** Sayfadan gelen ham veriyi (güvenilmez) temizler, kısaltır ve karta çevirir */
export function makeCard(raw, origin) {
  const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
  const c = { url: cleanUrl(raw.url), path: screenPath(raw.url), pattern: urlPattern(raw.url), dialog: S(raw.dialog), headings: list(raw.headings, 12).map((h) => S(h)).filter(Boolean),
    fields: [], buttons: [], links: [], columns: list(raw.columns, 30).map((h) => S(h, 40)).filter(Boolean), rowActions: [], rowLinks: [], external: 0, unnamed: Number(raw.unnamed) || 0 };
  const base = S(raw.h1) || S(raw.title, 120) || c.path;
  c.title = c.dialog ? `${base} › ${c.dialog}` : base;
  for (const f of list(raw.fields, 200)) {
    if (f?.row) continue; // tablo satırlarındaki alanlar veridir
    const type = S(f.type, 20) || 'text';
    c.fields.push({ name: S(f.name) || `(adsız ${type})`, type, required: Boolean(f.required), options: list(f.options, 8).map((o) => S(o, 40)).filter(Boolean), locator: S(f.locator, 200) });
  }
  const rows = new Set();
  const seen = new Map();
  for (const b of list(raw.buttons, 200)) {
    const name = S(b?.name);
    if (!name) continue;
    if (b.row) { rows.add(name); continue; }
    const key = `${b.role}|${name}`;
    if (seen.has(key)) { seen.get(key).n++; continue; }
    const item = { name, role: S(b.role, 20) || 'button', n: 1, disabled: Boolean(b.disabled), locator: S(b.locator, 200) };
    seen.set(key, item); c.buttons.push(item);
  }
  c.rowActions = [...rows].slice(0, 12);
  const groups = new Map(); // adres kalıbı → bağlantılar
  for (const l of list(raw.links, 400)) {
    let u;
    try { u = new URL(l.href); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    if (u.origin !== origin) { c.external++; continue; }
    const href = cleanUrl(u.href); // arama metni gibi veri değerleri bağlantıdan da atılır
    const pattern = urlPattern(href);
    if (!groups.has(pattern)) groups.set(pattern, []);
    groups.get(pattern).push({ name: S(l.name), href, path: screenPath(href), pattern, row: Boolean(l.row), locator: S(l.locator, 200) });
  }
  for (const [pattern, items] of groups) {
    // Aynı kalıpta (…/{id}) yinelenen ya da tablo satırındaki bağlantılar veridir: tek satırda özetlenir
    if (items.every((x) => x.row) || (pattern.includes('{id}') && items.length >= 3)) { c.rowLinks.push({ pattern, n: items.length, sample: items[0].href }); continue; }
    const names = new Set();
    for (const x of items) { if (x.row || names.has(x.name)) continue; names.add(x.name); c.links.push({ name: x.name, href: x.href, path: x.path, pattern, locator: x.locator }); }
  }
  c.links = c.links.slice(0, 80);
  c.rowLinks = c.rowLinks.slice(0, 12);
  // Parmak izi: ekranın yapısı (adlar, roller); veriler ve sayılar girmez. Arayüz değişince iz de değişir.
  c.iz = sha([...new Set([`d:${c.dialog}`, ...c.fields.map((f) => `f:${f.name}:${f.type}`), ...c.buttons.map((b) => `b:${b.role}:${b.name}`), ...c.links.map((l) => `l:${l.name}:${l.pattern}`), ...c.columns.map((x) => `c:${x}`)].map(digits))].sort().join('\n'));
  return c;
}

const TYPE_TR = { text: 'metin', password: 'parola', email: 'e-posta', number: 'sayı', date: 'tarih', 'datetime-local': 'tarih ve saat', time: 'saat', tel: 'telefon', url: 'adres', search: 'arama', file: 'dosya', checkbox: 'onay kutusu', radio: 'seçenek', select: 'seçim', textarea: 'uzun metin', textbox: 'metin', combobox: 'seçim', switch: 'aç/kapa', range: 'kaydırıcı' };
const ROLE_TR = { link: 'bağlantısı', button: 'düğmesi', tab: 'sekmesi', menuitem: 'menü öğesi' };
const some = (items, f, max) => items.slice(0, max).map(f).join('; ') + (items.length > max ? `; … (+${items.length - max})` : '');
/** Ekranların çoğunda (en az 3 ekran ve %60) yinelenen bağlantılar: sitenin ortak menüsü */
export function commonLinks(cards) {
  const count = new Map();
  for (const c of cards) for (const k of new Set(c.links.map((l) => `${l.name}|${l.pattern}`))) count.set(k, (count.get(k) || 0) + 1);
  return new Set([...count].filter(([, n]) => n >= 3 && n >= cards.length * 0.6).map(([k]) => k));
}
/**
 * Kartın satırları: yerel modelin ve aramanın okuyacağı düz metin (seçiciler ekranlar.json'da durur).
 * Ortak menü her kartta yinelenmez; yalnızca ilk ekranda bir kez yazılır.
 */
export function cardLines(c, cards = [], common = commonLinks(cards)) {
  const from = c.from && cards.find((x) => x.no === c.from);
  const isCommon = (l) => common.has(`${l.name}|${l.pattern}`);
  const menu = c.links.filter(isCommon);
  const own = c.links.filter((l) => !isCommon(l));
  const link = (l) => `${l.name || '(adsız)'} → ${l.path}`;
  return [
    `Ekran ${c.no}: ${c.title}`,
    `Adres: ${c.path}`,
    c.dialog && `Açık pencere: ${c.dialog}`,
    (from || c.via) && `Geliş: ${[from && `Ekran ${from.no} (${from.title})`, c.via].filter(Boolean).join(' → ')}`,
    c.headings.length && `Başlıklar: ${c.headings.join(' | ')}`,
    c.fields.length && `Alanlar: ${some(c.fields, (f) => `${f.name} (${TYPE_TR[f.type] || f.type}${f.required ? ', zorunlu' : ''}${f.options.length ? `: ${f.options.join(', ')}` : ''})`, 40)}`,
    c.buttons.length && `Düğmeler: ${some(c.buttons, (b) => `${b.name}${b.role === 'tab' ? ' [sekme]' : b.role === 'menuitem' ? ' [menü]' : ''}${b.n > 1 ? ` (${b.n} adet)` : ''}${b.disabled ? ' (kapalı)' : ''}`, 40)}`,
    c.unnamed > 0 && `Adsız düğmeler: ${c.unnamed} (erişilebilir adı yok)`,
    own.length && `Bağlantılar: ${some(own, link, 40)}`,
    menu.length && (c.no === cards[0]?.no ? `Ortak menü (ekranların çoğunda var): ${some(menu, link, 40)}` : `Ortak menü: var (Ekran ${cards[0].no} kartında yazıyor)`),
    c.columns.length && `Tablo sütunları: ${c.columns.join(' | ')}`,
    c.rowActions.length && `Satır işlemleri: ${c.rowActions.join('; ')}`,
    c.rowLinks.length && `Satır bağlantıları: ${c.rowLinks.map((r) => `${r.pattern} (${r.n} adet)`).join('; ')}`,
    c.external > 0 && `Dış bağlantılar: ${c.external}`,
    c.mark === 'görülmedi' && 'Not: bu ekran son gezintide görülmedi; kaldırılmış ya da o gezintide açılmamış olabilir.',
  ].filter(Boolean);
}
export const cardText = (c, cards, common) => cardLines(c, cards, common).join('\n');
/** Arama parçaları: kart satır sınırlarından bölünür; her parça hangi ekrana ait olduğunu başında taşır */
export function cardChunks(cards, size = 900) {
  const chunks = [];
  const common = commonLinks(cards);
  for (const c of cards) {
    const [head, ...rest] = cardLines(c, cards, common).flatMap((l) => (l.length > size ? l.match(new RegExp(`.{1,${size - 100}}(?:; |$)|.{1,${size - 100}}`, 'g')) : [l]));
    let cur = head;
    for (const line of rest) {
      if (cur.length + line.length + 1 > size) { chunks.push({ id: chunks.length, page: c.no, text: cur }); cur = head; }
      cur += `\n${line}`;
    }
    chunks.push({ id: chunks.length, page: c.no, text: cur });
  }
  return chunks;
}

// ---------- Tarayıcı testleri için: seçicili ekran özeti ve gidiş yolu ----------
const q1 = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const withLocator = (x) => (x.locator ? `: ${x.locator}` : ' (seçici yok)');
/** Ekranın test yazmaya yetecek özeti: her alan, düğme ve bağlantı Playwright biçiminde seçicisiyle */
export function screenGuide(c, cards = [], common = commonLinks(cards)) {
  const first = c.no === cards[0]?.no;
  const links = first ? c.links : c.links.filter((l) => !common.has(`${l.name}|${l.pattern}`));
  const from = c.from && cards.find((x) => x.no === c.from);
  const block = (title, items, f) => (items.length ? [`${title}:`, ...items.slice(0, 60).map((x) => `- ${f(x)}`), ...(items.length > 60 ? [`- … (+${items.length - 60})`] : [])] : []);
  return [
    `Ekran ${c.no}: ${c.title}`,
    `Adres: ${c.url}${c.pattern.includes('{id}') ? ` (kalıp: ${c.pattern}; örnek kayıt)` : ''}`,
    c.dialog && `Açık pencere: ${c.dialog} (adres değişmeden, tıklamayla açılır)`,
    (from || c.via) && `Geliş: ${[from && `Ekran ${from.no} (${from.title})`, c.via].filter(Boolean).join(' → ')}`,
    ...block('Alanlar', c.fields, (f) => `${f.name} (${TYPE_TR[f.type] || f.type}${f.required ? ', zorunlu' : ''}${f.options.length ? `: ${f.options.join(', ')}` : ''})${withLocator(f)}`),
    ...block('Düğmeler', c.buttons, (b) => `${b.name}${b.role === 'tab' ? ' [sekme]' : b.role === 'menuitem' ? ' [menü]' : ''}${b.n > 1 ? ` (${b.n} adet; .nth(i) ile seçilir)` : ''}${b.disabled ? ' (kapalı)' : ''}${withLocator(b)}`),
    ...block(first && common.size ? 'Bağlantılar (ortak menü dahil)' : 'Bağlantılar', links, (l) => `${l.name || '(adsız)'} → ${l.path}${withLocator(l)}`),
    !first && links.length < c.links.length && `Ortak menü: ${c.links.length - links.length} bağlantı (seçicileri Ekran ${cards[0].no} özetinde)`,
    c.columns.length && `Tablo sütunları: ${c.columns.join(' | ')}`,
    c.rowActions.length && `Satır işlemleri (her satırda yinelenir): ${c.rowActions.join('; ')}`,
    c.rowLinks.length && `Satır bağlantıları: ${c.rowLinks.map((r) => `${r.pattern} (${r.n} adet)`).join('; ')}`,
    c.unnamed > 0 && `Adsız düğmeler: ${c.unnamed} (erişilebilir adı yok; rol ve adla seçilemez)`,
  ].filter(Boolean).join('\n');
}

/**
 * Bir ekrana gidiş: doğrudan adres (varsa) ve gezinti sırasında kaydedilen tıklama zinciri, seçicileriyle.
 * { target, direct, steps: [{ screen, title, action: 'goto'|'click', url?, what?, locator? }], text } ya da null
 */
export function routeTo(cards, no) {
  const target = cards.find((c) => c.no === Number(no));
  if (!target) return null;
  const chain = [];
  for (let c = target; c && !chain.includes(c); c = cards.find((x) => x.no === c.from)) chain.unshift(c);
  // Zincir, adresiyle açılabilen en yakın ekrandan başlar (tıklaması kaydedilmemiş bir adım varsa öncesi atılır)
  let begin = 0;
  chain.forEach((c, i) => { if (i > 0 && !c.step && !c.dialog) begin = i; });
  const steps = chain.slice(begin).map((c, i, list) => {
    if (i === 0) return { screen: c.no, title: c.title, action: 'goto', url: c.url };
    const prev = list[i - 1];
    const st = c.step || { role: '', name: '', row: false };
    let locator = '';
    if (st.row) locator = st.role === 'link' && c.pattern.includes('{id}') ? `locator(${q1(`a[href*="${c.pattern.split('{id}')[0]}"]`)}).first()` : '';
    else if (st.role === 'link') locator = prev.links.find((l) => l.name === st.name || l.path === st.name)?.locator || '';
    else locator = prev.buttons.find((b) => b.name === st.name && b.role === st.role)?.locator || '';
    return { screen: c.no, title: c.title, action: 'click', what: c.via || 'kaydedilmemiş bir adım', locator };
  });
  const direct = target.dialog ? '' : target.url;
  const line = (s, i) => `${i + 1}. ${s.action === 'goto' ? `page.goto(${q1(s.url)})` : s.locator ? `page.${s.locator}.click()` : `${s.what} (seçici bulunamadı; ekran özetine bakın)`} → Ekran ${s.screen}: ${s.title}`;
  const text = [
    `Ekran ${target.no}: ${target.title}`,
    direct ? `Doğrudan: page.goto(${q1(direct)})${target.pattern.includes('{id}') ? ' (örnek kayıt; kimlik ortama göre değişebilir)' : ''}` : 'Doğrudan adresi yok: açık pencere, tıklamayla açılır.',
    steps.length > 1 && `Adım adım (gezintide kaydedilen yol):\n${steps.map(line).join('\n')}`,
  ].filter(Boolean).join('\n');
  return { target: target.no, direct, steps, text };
}

// ---------- Tarayıcı ----------
export function findBrowser() {
  const custom = process.env.FIKIRHANE_TARAYICI;
  if (custom) return fs.existsSync(custom) ? custom : null;
  const roots = [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean);
  const list = process.platform === 'win32'
    ? [...roots.map((p) => path.join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe')), ...roots.map((p) => path.join(p, 'Google', 'Chrome', 'Application', 'chrome.exe'))]
    : process.platform === 'darwin' ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return list.find((f) => fs.existsSync(f)) || null;
}

/** DevTools protokolü, tarayıcı sürecinin 3. ve 4. borusu üzerinden (her ileti JSON + sıfır baytı) */
class Cdp {
  constructor(proc) {
    this.out = proc.stdio[3];
    this.seq = 0;
    this.wait = new Map();
    this.listen = null;
    let rest = Buffer.alloc(0);
    proc.stdio[4].on('data', (chunk) => {
      rest = Buffer.concat([rest, chunk]);
      for (let i = rest.indexOf(0); i >= 0; i = rest.indexOf(0)) {
        const text = rest.toString('utf8', 0, i);
        rest = rest.subarray(i + 1);
        let msg;
        try { msg = JSON.parse(text); } catch { continue; }
        const w = msg.id && this.wait.get(msg.id);
        if (w) { this.wait.delete(msg.id); clearTimeout(w.timer); if (msg.error) w.reject(new Error(msg.error.message)); else w.resolve(msg.result); }
        else if (msg.method && this.listen) { try { this.listen(msg); } catch (err) { console.warn(`[gezinti] ${err.message}`); } }
      }
    });
    for (const s of [proc.stdio[3], proc.stdio[4]]) s.on('error', () => {});
  }

  send(method, params = {}, sessionId, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.wait.delete(id); reject(new Error(`tarayıcı yanıt vermedi (${method})`)); }, timeoutMs);
      this.wait.set(id, { resolve, reject, timer });
      try { this.out.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`); } catch (err) { clearTimeout(timer); this.wait.delete(id); reject(err); }
    });
  }

  close() {
    for (const w of this.wait.values()) { clearTimeout(w.timer); w.reject(new Error('tarayıcı kapandı')); }
    this.wait.clear();
  }
}

// ---------- Gezinti (aynı anda bir tane) ----------
let active = null;
const clickText = (k) => (k.row ? (k.role === 'link' ? 'tablo satırındaki bağlantı' : 'tablo satırındaki bir öğe') : `"${S(k.name)}" ${ROLE_TR[k.role] || 'öğesi'}`);

function addCard(tour, raw, { from, step }, session) {
  if (!raw || raw.origin !== tour.origin) return null; // başka sitedeki sayfalar (ör. ortak giriş sayfası) kaydedilmez
  let c;
  try { c = makeCard(raw, tour.origin); } catch { return null; }
  const key = `${c.pattern}|${c.iz}`;
  let card = tour.keys.get(key);
  const fresh = !card;
  if (fresh) {
    const n = tour.states.get(c.pattern) || 0;
    if (n >= MAX_STATES || tour.cards.length >= MAX_CARDS) return null;
    tour.states.set(c.pattern, n + 1);
    // Tıklanan öğe "önceki ekran" sayılan kartta yoksa (ör. o kart sonradan kapanan bir pencereydi) öğeyi içeren
    // atasına çıkılır; böylece gidiş yolu gereksiz adım içermez.
    if (step && !step.row) {
      const has = (k) => (step.role === 'link' ? k.links.some((l) => l.name === step.name || l.path === step.name) : k.buttons.some((b) => b.name === step.name && b.role === step.role));
      for (let k = tour.cards[from - 1], i = 0; k && i < 20; k = tour.cards[k.from - 1], i++) if (has(k)) { from = k.no; break; }
    }
    // step: bu ekrana getiren tıklama (rol + ad); via onun okunur hâli. Gidiş yolu çıkarılırken seçiciye çevrilir.
    card = { no: tour.cards.length + 1, ...c, from: from || null, step: step ? { role: S(step.role, 20), name: S(step.name), row: Boolean(step.row) } : null, via: step ? S(clickText(step), 120) : '' };
    tour.cards.push(card);
    tour.keys.set(key, card);
  }
  if (session) session.card = card.no;
  return { card, fresh };
}

async function capture(tour, s, opt = {}) {
  const run = async () => {
    if (tour.state !== 'açık') return null;
    let raw;
    try { raw = (await tour.cdp.send('Runtime.evaluate', { expression: EXTRACT, awaitPromise: true, returnByValue: true }, s.id, 20_000)).result?.value; } catch { return null; }
    const before = s.card;
    const click = s.click && Date.now() - s.click.at < 15_000 ? s.click : null;
    const r = addCard(tour, raw, { from: opt.from ?? before, step: opt.step ?? click }, s);
    if (r && (r.fresh || r.card.no !== before)) s.click = null; // ekran değiştiyse tıklama kullanıldı
    return r;
  };
  s.busy = (s.busy || Promise.resolve()).then(run, run);
  return s.busy;
}

async function attach(tour, targetId) {
  let id;
  try { id = (await tour.cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId; } catch { return; }
  const s = { id, targetId, card: null, click: null, timer: null, busy: null, loaded: null };
  tour.sessions.set(id, s);
  try {
    await tour.cdp.send('Page.enable', {}, id);
    await tour.cdp.send('Runtime.enable', {}, id);
    await tour.cdp.send('Runtime.addBinding', { name: 'fikirhaneTik' }, id);
    await tour.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: WATCH }, id);
    await tour.cdp.send('Runtime.evaluate', { expression: WATCH }, id);
  } catch { /* sekme hemen kapandıysa */ }
  if (!tour.main) tour.main = s;
}

function onEvent(tour, msg) {
  if (msg.method === 'Target.targetCreated' && msg.params.targetInfo.type === 'page') { attach(tour, msg.params.targetInfo.targetId); return; }
  if (msg.method === 'Target.detachedFromTarget') { tour.sessions.delete(msg.params.sessionId); return; }
  const s = msg.sessionId && tour.sessions.get(msg.sessionId);
  if (!s) return;
  const crawling = tour.crawl?.running && s === tour.main;
  const later = (ms) => { clearTimeout(s.timer); s.timer = setTimeout(() => capture(tour, s), ms); };
  if (msg.method === 'Page.loadEventFired' || msg.method === 'Page.navigatedWithinDocument') {
    tour.last = s;
    if (s.loaded) { s.loaded(); s.loaded = null; }
    if (!crawling) later(500);
  } else if (msg.method === 'Runtime.bindingCalled' && msg.params.name === 'fikirhaneTik') {
    try { const k = JSON.parse(msg.params.payload); s.click = { role: S(k.role, 20), name: S(k.name), row: Boolean(k.row), at: Date.now() }; } catch { return; }
    tour.last = s;
    if (!crawling) later(1200); // adres değişmeden açılan pencere ya da sekme de ayrı bir durum olarak kaydedilir
  } else if (msg.method === 'Page.javascriptDialogOpening' && crawling) {
    tour.cdp.send('Page.handleJavaScriptDialog', { accept: false }, s.id).catch(() => {});
  }
}

function normalizeUrl(url) {
  let text = String(url || '').trim();
  if (text && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `${/^(localhost|127\.|\[::1\])/i.test(text) ? 'http' : 'https'}://${text}`;
  let u;
  try { u = new URL(text); } catch { throw fail('bad-site'); }
  if (!/^https?:$/.test(u.protocol) || !u.hostname) throw fail('bad-site');
  return u;
}

/** Tarayıcıyı açar ve verilen adrese gider. Kullanıcı giriş yapıp gezer; her yeni ekran kendiliğinden kaydedilir. */
export async function startTour({ url, headless = process.env.FIKIRHANE_GEZGIN_GIZLI === '1' } = {}) {
  const start = normalizeUrl(url);
  if (active) throw fail('tour-busy'); // pencere kapanmış olsa da kaydedilen ekranlar bitirilmeyi ya da vazgeçilmeyi bekler
  const exe = findBrowser();
  if (!exe) throw fail('no-browser');
  fs.rmSync(profilesDir(), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); // önceki gezintiden kalan olursa
  fs.mkdirSync(profilesDir(), { recursive: true });
  const profile = fs.mkdtempSync(path.join(profilesDir(), 'profil-'));
  const args = ['--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-default-apps', '--disable-search-engine-choice-screen',
    '--disable-features=Translate,msEdgeWelcomePage,EdgeFirstRunExperience', '--edge-skip-compat-layer-relaunch', '--window-size=1280,900', ...(headless ? ['--headless=new'] : []), 'about:blank'];
  let proc;
  // Windows bazı süreçlere uyumluluk katmanı değişkeni (__COMPAT_LAYER) verir; Edge bunu görünce kendini yeniden
  // başlatır, ilk süreç hemen kapanır ve boru bağlantısı kopar. Değişken tarayıcıya aktarılmaz.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== '__COMPAT_LAYER'));
  try { proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: false, env }); } catch (err) { fs.rmSync(profile, { recursive: true, force: true }); throw fail('browser-failed', { detail: err.message }); }
  const tour = { id: crypto.randomBytes(4).toString('hex'), origin: start.origin, start: start.href, state: 'açık', started: new Date().toISOString(), cards: [], keys: new Map(), states: new Map(),
    sessions: new Map(), main: null, last: null, crawl: null, error: '', proc, profile, cdp: new Cdp(proc) };
  active = tour;
  const ended = (why) => {
    if (tour.state === 'kapandı') return;
    tour.state = 'kapandı';
    if (why) tour.error = why;
    if (tour.crawl) tour.crawl.running = false;
    tour.cdp.close();
    for (const s of tour.sessions.values()) clearTimeout(s.timer);
    // Geçici profil (çerezler, oturum) silinir; tarayıcı dosyaları bırakana kadar birkaç kez denenir
    tour.cleaned = fs.promises.rm(profilesDir(), { recursive: true, force: true, maxRetries: 30, retryDelay: 300 }).catch(() => {});
  };
  proc.on('error', (err) => ended(`Tarayıcı başlatılamadı: ${err.message}`));
  proc.on('exit', () => ended(tour.closing ? '' : 'Tarayıcı penceresi kapatıldı.'));
  tour.cdp.listen = (msg) => onEvent(tour, msg);
  try {
    await tour.cdp.send('Target.setDiscoverTargets', { discover: true });
    for (let i = 0; i < 100 && !tour.main && tour.state === 'açık'; i++) await sleep(100);
    if (!tour.main) { // başlangıç sekmesi yoksa açılır
      const t = await tour.cdp.send('Target.createTarget', { url: 'about:blank' });
      for (let i = 0; i < 50 && ![...tour.sessions.values()].some((s) => s.targetId === t.targetId); i++) await sleep(100);
    }
    if (!tour.main) throw new Error('sekme açılamadı');
    const r = await tour.cdp.send('Page.navigate', { url: start.href }, tour.main.id);
    if (r.errorText && !/ABORTED/.test(r.errorText)) tour.error = `Adres açılamadı: ${r.errorText}`;
  } catch (err) {
    await closeTour(tour);
    if (active === tour) active = null;
    throw fail('browser-failed', { detail: err.message });
  }
  return tour.id;
}

async function closeTour(tour) {
  if (tour.state === 'kapandı') { await Promise.race([tour.cleaned, sleep(10_000)]); return; }
  tour.closing = true;
  const gone = new Promise((r) => tour.proc.once('exit', r));
  tour.cdp.send('Browser.close', {}, undefined, 3000).catch(() => {});
  await Promise.race([gone, sleep(3000)]);
  if (tour.state !== 'kapandı') { try { tour.proc.kill(); } catch { /* zaten kapanmış */ } await Promise.race([gone, sleep(2000)]); }
  await Promise.race([tour.cleaned, sleep(10_000)]); // profil silinmeden gezinti bitmiş sayılmaz
}
process.on('exit', () => { try { if (active?.state === 'açık') active.proc.kill(); } catch { /* yoksay */ } });

const need = () => { if (!active) throw fail('no-tour'); return active; };
const open = () => { const t = need(); if (t.state !== 'açık') throw fail('tour-closed'); return t; };

export function tourStatus() {
  const t = active;
  if (!t) return null;
  return { id: t.id, origin: t.origin, state: t.state, error: t.error, count: t.cards.length,
    cards: t.cards.slice(-60).map((c) => ({ no: c.no, title: c.title, path: c.path, via: c.via, fields: c.fields.length, buttons: c.buttons.length, links: c.links.length })),
    crawl: t.crawl ? { running: t.crawl.running, done: t.crawl.done, queued: t.crawl.queue.length, added: t.crawl.added, skipped: t.crawl.skipped } : null };
}

/** Kullanıcının o an baktığı ekranı kaydeder (adres değişmeden açılan durumlar için) */
export async function captureNow() {
  const t = open();
  const s = t.last && t.sessions.has(t.last.id) ? t.last : t.main;
  const r = await capture(t, s);
  return { added: Boolean(r?.fresh), no: r?.card.no || null };
}

/** Kaydedilen ekranlardaki bağlantıları izleyerek sitenin kalanını gezer. Yalnızca adrese gider; hiçbir şeye basmaz. */
export function crawlTour({ limit = 30 } = {}) {
  const t = open();
  if (t.crawl?.running) throw fail('busy');
  const max = Math.max(1, Math.min(200, Math.floor(Number(limit)) || 30));
  const c = { running: true, done: 0, added: 0, skipped: 0, queue: [] };
  t.crawl = c;
  const seen = new Set(t.cards.map((x) => x.pattern));
  const offer = (card) => {
    const items = [...card.links.map((l) => ({ href: l.href, name: l.name, pattern: l.pattern, step: { role: 'link', name: l.name || l.path, row: false } })),
      ...card.rowLinks.map((r) => ({ href: r.sample, name: '', pattern: r.pattern, step: { role: 'link', name: '', row: true } }))];
    for (const it of items) {
      if (seen.has(it.pattern)) continue;
      seen.add(it.pattern);
      if (dangerous(it.name, it.href)) { c.skipped++; continue; }
      c.queue.push({ ...it, from: card.no });
    }
  };
  t.cards.forEach(offer);
  const s = t.main;
  c.promise = (async () => {
    while (c.queue.length && c.added < max && c.running && t.state === 'açık') {
      const item = c.queue.shift();
      const loaded = new Promise((r) => { s.loaded = r; });
      let r;
      try { r = await t.cdp.send('Page.navigate', { url: item.href }, s.id); } catch { break; }
      c.done++;
      if (r.errorText) { s.loaded = null; continue; }
      await Promise.race([loaded, sleep(15_000)]);
      const got = await capture(t, s, { from: item.from, step: item.step });
      if (got?.fresh) { c.added++; offer(got.card); }
      await sleep(250);
    }
    c.running = false;
  })();
  return c;
}
export function stopCrawl() { const t = need(); if (t.crawl) t.crawl.running = false; }

/** Gezintiyi bitirir: tarayıcı kapanır, kartlar döner (kitaplığa "site" olarak eklenmek üzere) */
export async function finishTour() {
  const t = need();
  if (!t.cards.length) throw fail('no-screens');
  if (t.crawl) { t.crawl.running = false; await Promise.race([t.crawl.promise, sleep(20_000)]); }
  await closeTour(t);
  active = null;
  return { origin: t.origin, start: cleanUrl(t.start), cards: t.cards };
}
export async function cancelTour() {
  const t = active;
  if (!t) return;
  if (t.crawl) t.crawl.running = false;
  await closeTour(t);
  active = null;
}

/** Yalnızca testler için: gezilen sayfada betik çalıştırır (kullanıcının tıklamasını taklit eder) ve tarayıcıyı kapatır */
export const _deneme = {
  evaluate: (expression) => { const t = open(); return t.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, t.main.id); },
  kill: () => open().proc.kill(),
};
