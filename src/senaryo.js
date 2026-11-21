// Senaryolar: gezilmiş bir sitede adım adım yapılan bir işin (ör. "yeni üye ekle") saklanan tarifi.
// Bir senaryo bir kez yazılır (test yapan araç ya da kullanıcı tarafından), sonra Playwright betiği olarak yeniden
// oynatılır: yapay zekâ her adımda sayfaya bakmaz, yalnızca "geçti / şu adımda kaldı" sonucunu görür.
//
// Fikirhane betiği kendisi ÇALIŞTIRMAZ (hiçbir düğmeye basmaz): betiği üretir; çalıştıran araç sonucu geri bildirir.
// Betik saklanan metinden değil denetlenmiş adımlardan üretilir: seçiciler dar bir dilbilgisine göre ayrıştırılıp
// yeniden yazılır, diğer bütün değerler metin sabiti olarak gömülür. Böylece bir senaryoya kod sokulamaz.
import { makeCard, screenPath, PAGE_CARD } from './gezgin.js';

const fail = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const S = (v, n = 80) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
export const MAX_STEPS = 60;
export const MAX_SCENARIOS = 40;

// ---------- Seçiciler ----------
// Kabul edilen biçim: getByRole('button', { name: 'Kaydet' }), getByLabel('Ad'), getByPlaceholder(…), getByTestId(…),
// getByText(…), getByTitle(…), getByAltText(…), locator('css'), ardından isteğe bağlı .first() .last() .nth(2)
// .filter({ hasText: '…' }) ve zincirleme (en çok 6 parça). Başta "page." olabilir.
const isStr = (v) => typeof v === 'string' && v.length > 0 && v.length <= 300;
const opts = (o, allowed) => o && typeof o === 'object' && Object.entries(o).every(([k, v]) => Object.hasOwn(allowed, k) && typeof v === allowed[k] && (typeof v !== 'string' || v.length <= 300));
const textArgs = (a) => a.length >= 1 && a.length <= 2 && isStr(a[0]) && (a.length === 1 || opts(a[1], { exact: 'boolean' }));
const none = (a) => a.length === 0;
const FN = {
  getByRole: (a) => a.length >= 1 && a.length <= 2 && isStr(a[0]) && /^[a-z]+$/.test(a[0])
    && (a.length === 1 || opts(a[1], { name: 'string', exact: 'boolean', checked: 'boolean', selected: 'boolean', expanded: 'boolean', pressed: 'boolean', disabled: 'boolean', level: 'number' })),
  getByLabel: textArgs, getByPlaceholder: textArgs, getByText: textArgs, getByTitle: textArgs, getByAltText: textArgs,
  getByTestId: (a) => a.length === 1 && isStr(a[0]),
  locator: (a) => a.length >= 1 && a.length <= 2 && isStr(a[0]) && (a.length === 1 || opts(a[1], { hasText: 'string' })),
  filter: (a) => a.length === 1 && opts(a[0], { hasText: 'string' }),
  first: none, last: none,
  nth: (a) => a.length === 1 && Number.isInteger(a[0]) && a[0] >= 0 && a[0] < 1000,
};
const REFINE = ['first', 'last', 'nth', 'filter'];

/** Seçici metnini ayrıştırır: [{ fn, args }]. Tanınmayan her şey "bad-locator" hatasıdır. */
export function parseLocator(input) {
  const s = String(input ?? '').trim();
  let i = s.startsWith('page.') ? 5 : 0;
  const bad = () => { throw fail('bad-locator', { detail: s.slice(0, 80) }); };
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const string = () => {
    const q = s[i++];
    let out = '';
    for (; i < s.length && s[i] !== q; i++) {
      if (s[i] === '\\') { const c = s[++i]; if (c === undefined) bad(); out += c === 'n' ? '\n' : c === 't' ? '\t' : c; } else if (q === '`' && s[i] === '$') bad(); else out += s[i];
    }
    if (s[i] !== q) bad();
    i++;
    return out;
  };
  const value = () => {
    ws();
    if (s[i] === "'" || s[i] === '"' || s[i] === '`') return string();
    if (s[i] === '{') return object();
    const m = /^(true|false|\d{1,4})(?![\w.])/.exec(s.slice(i));
    if (!m) bad();
    i += m[0].length;
    return m[1] === 'true' ? true : m[1] === 'false' ? false : Number(m[1]);
  };
  const object = () => {
    i++;
    const o = {};
    for (ws(); s[i] !== '}'; ws()) {
      const m = /^[A-Za-z]\w*/.exec(s.slice(i));
      if (!m || m[0] === '__proto__' || m[0] === 'constructor') bad();
      i += m[0].length;
      ws();
      if (s[i++] !== ':') bad();
      const v = value();
      if (v !== null && typeof v === 'object') bad(); // iç içe nesne yok
      o[m[0]] = v;
      ws();
      if (s[i] === ',') i++; else if (s[i] !== '}') bad();
    }
    i++;
    return o;
  };
  const parts = [];
  for (;;) {
    ws();
    const m = /^[A-Za-z]\w*/.exec(s.slice(i));
    if (!m || !Object.hasOwn(FN, m[0])) bad();
    i += m[0].length;
    ws();
    if (s[i++] !== '(') bad();
    const args = [];
    for (ws(); s[i] !== ')'; ws()) {
      if (i >= s.length || args.length >= 2) bad();
      args.push(value());
      ws();
      if (s[i] === ',') i++; else if (s[i] !== ')') bad();
    }
    i++;
    if (!FN[m[0]](args)) bad();
    parts.push({ fn: m[0], args });
    ws();
    if (s[i] !== '.') break;
    i++;
  }
  if (i !== s.length || parts.length > 6 || REFINE.includes(parts[0].fn)) bad();
  return parts;
}
const lit = (v) => (typeof v === 'string' ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\t/g, '\\t')}'`
  : v && typeof v === 'object' ? `{ ${Object.entries(v).map(([k, x]) => `${k}: ${lit(x)}`).join(', ')} }` : String(v));
/** Ayrıştırılmış seçicinin okunur hâli (ekran kartlarındaki biçimle aynı) */
export const locatorText = (parts) => parts.map((p) => `${p.fn}(${p.args.map(lit).join(', ')})`).join('.');
/** Betiğe yazılan hâli: bütün değerler JSON sabitidir */
const locatorCode = (parts) => `page.${parts.map((p) => `${p.fn}(${p.args.map((a) => JSON.stringify(a)).join(', ')})`).join('.')}`;

// ---------- Adımlar ----------
const DO = ['goto', 'click', 'fill', 'select', 'check', 'uncheck', 'press', 'expect', 'expectVisible', 'expectHidden', 'expectUrl'];
const WITH_LOCATOR = ['click', 'check', 'uncheck', 'expectVisible', 'expectHidden', 'fill', 'select'];
const KEY = /^[A-Za-z0-9]{1,20}(\+[A-Za-z0-9]{1,20}){0,3}$/;
const VAR = /\{\{([A-Za-z][A-Za-z0-9_]{0,30})\}\}/g;
const SECRET_NAME = /parola|şifre|sifre|password|passwd|\bpin\b|gizli/i;

/**
 * Dışarıdan gelen adımları denetler ve saklanacak hâle getirir. Kabul edilen adımlar:
 *   { do: 'goto', url | screen }            { do: 'click' | 'check' | 'uncheck', locator }
 *   { do: 'fill' | 'select', locator, value } { do: 'press', key }
 *   { do: 'expect', text }  { do: 'expectVisible' | 'expectHidden', locator }  { do: 'expectUrl', text }
 * Değerlerde {{ad}} biçiminde değişken kullanılabilir; parola alanlarına sabit değer yazılamaz (dosyada açık durur).
 */
export function normalizeSteps(input, { origin, cards = [] }) {
  if (!Array.isArray(input) || !input.length) throw fail('no-steps');
  if (input.length > MAX_STEPS) throw fail('too-many-steps');
  const secret = new Set(cards.flatMap((c) => c.fields.filter((f) => f.type === 'password').map((f) => f.locator)).filter(Boolean));
  return input.map((raw, n) => {
    const bad = (why) => fail('bad-step', { detail: `${n + 1}. adım: ${why}` });
    if (!raw || typeof raw !== 'object') throw bad('adım bir nesne olmalı');
    const kind = String(raw.do || '');
    if (!DO.includes(kind)) throw bad(`bilinmeyen işlem "${S(kind, 20)}" (geçerli: ${DO.join(', ')})`);
    const step = { do: kind };
    const text = (key, max, required) => {
      const v = raw[key] == null ? '' : String(raw[key]);
      if (required && !v.trim()) throw bad(`"${key}" gerekli`);
      if (v.length > max) throw bad(`"${key}" çok uzun`);
      step[key] = v;
    };
    if (kind === 'goto') {
      if (raw.url == null && raw.screen != null) {
        const c = cards.find((x) => x.no === Number(raw.screen));
        if (!c) throw bad(`Ekran ${S(raw.screen, 10)} yok`);
        if (c.dialog) throw bad('açık pencerenin adresi olmaz; onu açan tıklama adımını kullanın');
        step.url = c.url;
      } else {
        const given = String(raw.url || '').trim();
        if (!given || given.length > 500) throw bad('"url" gerekli');
        let u;
        try { u = new URL(given.replace(VAR, 'x'), origin); } catch { throw bad('adres geçersiz'); }
        if (u.origin !== origin) throw bad('adres bu sitede olmalı');
        step.url = /^https?:\/\//i.test(given) ? given : origin + (given.startsWith('/') ? '' : '/') + given;
      }
    } else if (WITH_LOCATOR.includes(kind)) {
      try { step.locator = locatorText(parseLocator(raw.locator)); } catch { throw bad(`seçici anlaşılamadı: ${S(raw.locator, 80)}`); }
      if (kind === 'fill' || kind === 'select') {
        text('value', 500, false);
        if (kind === 'fill' && step.value && !step.value.includes('{{') && (secret.has(step.locator) || SECRET_NAME.test(step.locator))) {
          throw fail('secret-literal', { detail: `${n + 1}. adım: ${step.locator}` });
        }
      }
    } else if (kind === 'press') {
      step.key = String(raw.key || '');
      if (!KEY.test(step.key)) throw bad('tuş adı geçersiz (ör. Enter, Tab, Control+A)');
    } else text('text', 200, true); // expect, expectUrl
    if (raw.note) step.note = S(raw.note, 120);
    return step;
  });
}

const pathOf = (url) => { try { return screenPath(url); } catch { return url; } };
/** Adımın okunur hâli */
export function stepLabel(s) {
  switch (s.do) {
    case 'goto': return `Git: ${s.url.includes('{{') ? s.url : pathOf(s.url)}`;
    case 'click': return `Tıkla: ${s.locator}`;
    case 'fill': return `Doldur: ${s.locator} = ${s.value}`;
    case 'select': return `Seç: ${s.locator} = ${s.value}`;
    case 'check': return `İşaretle: ${s.locator}`;
    case 'uncheck': return `İşareti kaldır: ${s.locator}`;
    case 'press': return `Tuş: ${s.key}`;
    case 'expect': return `Bekle: "${s.text}" görünsün`;
    case 'expectVisible': return `Bekle: ${s.locator} görünsün`;
    case 'expectHidden': return `Bekle: ${s.locator} kaybolsun`;
    default: return `Bekle: adres "${s.text}" içersin`;
  }
}
/** Senaryodaki {{değişken}} adları */
export const scenarioVars = (steps) => [...new Set(steps.flatMap((s) => [s.url, s.value, s.text].filter(Boolean).flatMap((v) => [...v.matchAll(VAR)].map((m) => m[1]))))];

const STATUS = { 'geçti': 'son çalıştırma geçti', 'kaldı': 'son çalıştırma kaldı', denenmedi: 'henüz çalıştırılmadı' };
export const statusText = (scn) => { const r = scn.runs?.[0]; return `${STATUS[scn.status] || STATUS.denenmedi}${r ? ` (${r.at.slice(0, 10)}${r.ok ? '' : `, ${r.step}. adım`})` : ''}`; };
/** Senaryonun modele ve kullanıcıya gösterilecek düz metni */
export function scenarioText(scn) {
  const vars = scenarioVars(scn.steps);
  return [
    `Senaryo [${scn.id}]: ${scn.name} — ${statusText(scn)}`,
    scn.description,
    scn.warn && `Uyarı: ${scn.warn}`,
    ...scn.steps.map((s, i) => `${i + 1}. ${stepLabel(s)}${s.note ? ` — ${s.note}` : ''}`),
    vars.length && `Değişkenler: ${vars.map((v) => `{{${v}}}`).join(', ')} (çalıştırırken FIKIRHANE_VAR_${vars[0].toUpperCase()}=… biçiminde verilir)`,
  ].filter(Boolean).join('\n');
}

// ---------- Betik ----------
const T = (v) => (v.includes('{{') ? `V(${JSON.stringify(v)})` : JSON.stringify(v));
function stepCode(s) {
  const L = s.locator ? locatorCode(parseLocator(s.locator)) : ''; // saklanan metin yeniden ayrıştırılır: dosya elle bozulmuş olsa da koda dönüşemez
  switch (s.do) {
    case 'goto': return `page.goto(${T(s.url)})`;
    case 'click': return `${L}.click()`;
    case 'fill': return `${L}.fill(${T(s.value)})`;
    case 'select': return `${L}.selectOption(${T(s.value)})`;
    case 'check': return `${L}.check()`;
    case 'uncheck': return `${L}.uncheck()`;
    case 'press': if (!KEY.test(s.key)) throw fail('bad-step'); return `page.keyboard.press(${JSON.stringify(s.key)})`;
    case 'expect': return `page.getByText(${T(s.text)}).first().waitFor({ state: 'visible' })`;
    case 'expectVisible': return `${L}.first().waitFor({ state: 'visible' })`;
    case 'expectHidden': return `${L}.first().waitFor({ state: 'hidden' })`;
    case 'expectUrl': return `page.waitForURL((u) => (u.pathname + u.search + u.hash).includes(${T(s.text)}))`;
    default: throw fail('bad-step');
  }
}

/**
 * Senaryonun tek başına çalışan Playwright betiği (Node.js, .mjs). Betik adımları sırayla yürütür, kısa bir sonuç
 * yazar ve sonucu Fikirhane'ye bildirir; kaldıysa kaldığı ekranın yapısını da gönderir (kartla karşılaştırılır).
 */
export function scenarioScript({ site, scenario, base, version }) {
  const vars = scenarioVars(scenario.steps);
  const steps = scenario.steps.map((s) => `  [${JSON.stringify(stepLabel(s))}, (page) => ${stepCode(s)}],`).join('\n');
  const meta = { site: site.id, id: scenario.id, name: scenario.name, origin: site.origin, start: site.start || `${site.origin}/`, base };
  return `// Fikirhane senaryosu: ${S(scenario.name, 80)} (${S(site.name, 60)})
// Bu dosyayı Fikirhane ${S(version, 20)} üretti; elle düzenlemeyin, senaryoyu Fikirhane'de güncelleyip betiği yeniden alın.
//
// Çalıştırma:  node ${fileName(scenario)}          (Playwright gerekir)
//              node ${fileName(scenario)} --giris  (tarayıcıyı görünür açar: giriş yapıp pencereyi kapatın; FIKIRHANE_PROFIL ister)
// Ortam değişkenleri (hepsi isteğe bağlı):
//   FIKIRHANE_PLAYWRIGHT  Playwright kütüphanesinin klasörü (verilmezse "playwright" paketi aranır)
//   FIKIRHANE_PROFIL      kalıcı tarayıcı profili klasörü: oturum (giriş) çalıştırmalar arasında korunur
//   FIKIRHANE_KANAL       msedge (varsayılan) | chrome | chromium
//   FIKIRHANE_GORUNUR=1   tarayıcı penceresini göster      FIKIRHANE_SURE  adım başına bekleme (ms, varsayılan 8000)
//   FIKIRHANE_BILDIRME=1  sonucu Fikirhane'ye gönderme${vars.length ? `\n//   ${vars.map((v) => `FIKIRHANE_VAR_${v.toUpperCase()}`).join(', ')}  senaryodaki ${vars.map((v) => `{{${v}}}`).join(', ')} değerleri` : ''}
// Çıkış kodu: 0 geçti, 1 kaldı, 2 çalıştırılamadı.
import { createRequire } from 'node:module';

const E = process.env;
const META = ${JSON.stringify(meta)};
const VARS = ${JSON.stringify(vars)};
const V = (s) => s.replace(/\\{\\{(\\w+)\\}\\}/g, (_, k) => E['FIKIRHANE_VAR_' + k.toUpperCase()] ?? '');
const STEPS = [
${steps}
];
const PAGE_CARD = ${JSON.stringify(PAGE_CARD)};

const stop = (text) => { console.log(text); process.exit(2); };
const missing = VARS.filter((k) => E['FIKIRHANE_VAR_' + k.toUpperCase()] === undefined);
const login = process.argv.includes('--giris');
if (missing.length && !login) stop('ÇALIŞTIRILAMADI: şu değişkenler verilmeli: ' + missing.map((k) => 'FIKIRHANE_VAR_' + k.toUpperCase()).join(', '));
let chromium;
try { ({ chromium } = createRequire(import.meta.url)(E.FIKIRHANE_PLAYWRIGHT || 'playwright')); } catch { stop('ÇALIŞTIRILAMADI: Playwright bulunamadı. FIKIRHANE_PLAYWRIGHT ile kütüphanenin klasörünü verin.'); }
if (login && !E.FIKIRHANE_PROFIL) stop('ÇALIŞTIRILAMADI: --giris için FIKIRHANE_PROFIL (oturumun saklanacağı klasör) verilmeli.');

const channel = E.FIKIRHANE_KANAL || 'msedge';
// Windows'un __COMPAT_LAYER değişkeni tarayıcıya aktarılmaz: Edge onu görünce kendini yeniden başlatır ve bağlantı kopar
const env = Object.fromEntries(Object.entries(E).filter(([k]) => k.toUpperCase() !== '__COMPAT_LAYER'));
const options = { headless: !(login || E.FIKIRHANE_GORUNUR === '1'), env, ...(channel === 'chromium' ? {} : { channel }) };
let browser = null;
let context;
try {
  if (E.FIKIRHANE_PROFIL) context = await chromium.launchPersistentContext(E.FIKIRHANE_PROFIL, options);
  else { browser = await chromium.launch(options); context = await browser.newContext(); }
} catch (err) { stop('ÇALIŞTIRILAMADI: tarayıcı açılamadı: ' + String(err.message).split('\\n')[0]); }
const page = context.pages()[0] || await context.newPage();
page.setDefaultTimeout(Number(E.FIKIRHANE_SURE) || 8000);

if (login) {
  await page.goto(META.start).catch(() => {});
  console.log('Giriş yapın, sonra tarayıcı penceresini kapatın. Oturum şu klasörde saklanır: ' + E.FIKIRHANE_PROFIL);
  await new Promise((done) => context.on('close', done));
  console.log('Oturum kaydedildi.');
  process.exit(0);
}

const started = Date.now();
let failed = null;
for (let i = 0; i < STEPS.length && !failed; i++) {
  try { await STEPS[i][1](page); } catch (err) { failed = { step: i + 1, name: STEPS[i][0], error: String(err.message).split('\\n')[0].slice(0, 300) }; }
}
const result = { ok: !failed, steps: STEPS.length, ms: Date.now() - started };
if (failed) {
  Object.assign(result, { step: failed.step, error: failed.error, url: page.url() });
  try { result.screen = await page.evaluate(PAGE_CARD); } catch { /* sayfa özetlenemedi */ }
}
await context.close().catch(() => {});
if (browser) await browser.close().catch(() => {});

let reply = '';
if (E.FIKIRHANE_BILDIRME !== '1') {
  try {
    const r = await fetch(META.base + '/api/sites/' + META.site + '/scenarios/' + META.id + '/result', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fikirhane': '1' }, body: JSON.stringify(result), signal: AbortSignal.timeout(5000) });
    reply = (await r.json()).text || '';
  } catch { /* Fikirhane çalışmıyorsa sonuç yalnızca buraya yazılır */ }
}
if (reply) console.log(reply);
else if (!failed) console.log('GEÇTİ: ' + META.name + ' (' + STEPS.length + ' adım, ' + (result.ms / 1000).toFixed(1) + ' sn)');
else {
  console.log('KALDI: ' + META.name + ' ' + failed.step + '. adımda (' + failed.step + '/' + STEPS.length + '): ' + failed.name + '\\nHata: ' + failed.error + '\\nKaldığı adres: ' + result.url);
  const names = (list) => (list || []).map((x) => x.name).filter(Boolean).slice(0, 15).join('; ');
  if (result.screen) console.log('Görünen düğmeler: ' + names(result.screen.buttons) + '\\nGörünen alanlar: ' + names(result.screen.fields));
}
process.exit(failed ? 1 : 0);
`;
}
const slug = (name) => String(name).toLocaleLowerCase('tr').replace(/[çğıöşü]/g, (c) => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' })[c]).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'senaryo';
export const fileName = (scenario) => `senaryo-${slug(scenario.name)}.mjs`;

// ---------- Çalıştırma sonucu ----------
const elements = (c) => [...c.fields.map((x) => ({ kind: 'alan', ...x })), ...c.buttons.map((x) => ({ kind: x.role === 'tab' ? 'sekme' : 'düğme', ...x })), ...c.links.map((x) => ({ kind: 'bağlantı', ...x }))]
  .map((x) => ({ key: `${x.kind}|${x.name}`, kind: x.kind, name: x.name, locator: x.locator }));
/** İki kart arasındaki yapı farkı: { added: [...], removed: [...] } (öğeler: { kind, name, locator }) */
export function cardDiff(old, now) {
  const a = elements(old);
  const b = elements(now);
  const drop = ({ key: _k, ...x }) => x;
  return { added: b.filter((x) => !a.some((y) => y.key === x.key)).map(drop), removed: a.filter((x) => !b.some((y) => y.key === x.key)).map(drop) };
}

/**
 * Betiğin bildirdiği sonucu (güvenilmez) değerlendirir: kaydı, kaldıysa ekranın karta göre değişip değişmediğini ve
 * modele verilecek kısa metni döndürür. { run, changed: { no, at, added, removed } | null, text }
 */
export function judgeRun(scenario, result, { origin, cards = [] }) {
  const total = scenario.steps.length;
  const ok = result?.ok === true;
  const run = { at: new Date().toISOString(), ok, ms: Math.max(0, Math.min(86_400_000, Math.floor(Number(result?.ms)) || 0)) };
  if (ok) return { run, changed: null, text: `GEÇTİ: "${scenario.name}" (${total} adım, ${(run.ms / 1000).toFixed(1)} sn). Sonuç Fikirhane'ye kaydedildi.` };
  run.step = Math.max(1, Math.min(total, Math.floor(Number(result?.step)) || 1));
  run.error = S(result?.error, 300);
  const lines = [`KALDI: "${scenario.name}" ${run.step}. adımda (${run.step}/${total}): ${stepLabel(scenario.steps[run.step - 1])}`, run.error && `Hata: ${run.error}`];
  let now = null;
  try { if (result?.screen?.origin === origin) now = makeCard(result.screen, origin); } catch { /* özet kullanılamıyor */ }
  let changed = null;
  if (!now) lines.push('Kaldığı ekranın özeti alınamadı (başka bir sitede ya da sayfa kapanmış olabilir).');
  else {
    lines.push(`Kaldığı ekran: ${now.title} — ${now.path}`);
    const same = cards.filter((c) => c.pattern === now.pattern && Boolean(c.dialog) === Boolean(now.dialog));
    const exact = same.find((c) => c.iz === now.iz);
    const line = (x) => `- ${x.kind} ${x.name}${x.locator ? `: ${x.locator}` : ''}`;
    if (!same.length) lines.push('Bu ekran Fikirhane\'de kayıtlı değil: senaryo beklenmeyen bir ekrana gitmiş ya da ekran gezintiye eklenmemiş.');
    else if (exact) lines.push(`Ekran kayıtlı hâliyle aynı (Ekran ${exact.no}): arayüz değişmemiş. Sorun seçicide, beklemede ya da veride olabilir.`);
    else {
      const best = same.map((c) => ({ c, d: cardDiff(c, now) })).sort((x, y) => (x.d.added.length + x.d.removed.length) - (y.d.added.length + y.d.removed.length))[0];
      changed = { no: best.c.no, at: run.at, added: best.d.added.slice(0, 20), removed: best.d.removed.slice(0, 20) };
      lines.push(`Ekran ${best.c.no} kayıtlı hâlinden farklı: arayüz değişmiş görünüyor.`,
        changed.added.length && `Yeni öğeler:\n${changed.added.slice(0, 8).map(line).join('\n')}`,
        changed.removed.length && `Artık olmayan öğeler:\n${changed.removed.slice(0, 8).map(line).join('\n')}`);
    }
    if (!changed) {
      const shown = elements(now).filter((x) => x.kind !== 'bağlantı').slice(0, 12);
      if (shown.length) lines.push(`Şu an görünen öğeler:\n${shown.map(line).join('\n')}`);
    }
  }
  return { run, changed, text: lines.filter(Boolean).join('\n') };
}
