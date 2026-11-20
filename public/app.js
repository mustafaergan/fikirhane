// Fikirhane arayüzü: belge listesi, belge ayrıntısı (harita, bölüm notları, sorular, notlarım) ve soru-yanıt.
const $ = (s, root = document) => root.querySelector(s);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) n.append(c);
  return n;
};
// replaceChildren boş değerleri (false, null) metin olarak yazar; el() gibi bunları atlar
const fill = (node, ...kids) => node.replaceChildren(...kids.flat(Infinity).filter((c) => c != null && c !== false));
const api = (path, body, method = body ? 'POST' : 'GET') => fetch(path, { method, headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-fikirhane': '1' }, body: body ? JSON.stringify(body) : undefined })
  .then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));

const state = { config: null, docs: [], current: null, doc: null, view: 'doc', tab: 'harita', chat: [], asking: false, poll: null };
const content = $('#content');
// Belgenin birimi: PDF'te sayfa, sayfasız belgede bölüm, gezilen sitede ekran
const unit = (d) => (d?.kind === 'site' ? 'ekran' : d?.paged ? 'sayfa' : 'bölüm');
const Unit = (d) => unit(d).replace(/^./, (c) => c.toLocaleUpperCase('tr'));

// ---------- Küçük Markdown çizici (başlık, liste, kalın; HTML çalıştırılmaz) ----------
function inline(text) {
  const out = [];
  for (const part of String(text).split(/(\*\*[^*]+\*\*|\[[^\]\n]{1,80}s\.\s?\d+[^\]\n]{0,12}\]|\(s\.\s?\d+(?:[–-]\d+)?\))/g)) {
    if (!part) continue;
    if (part.startsWith('**')) out.push(el('strong', { text: part.slice(2, -2) }));
    else if (/^\[.*s\.\s?\d+.*\]$|^\(s\./.test(part)) out.push(el('span', { class: 'cite', text: part }));
    else out.push(part);
  }
  return out;
}
function markdown(text) {
  const root = el('div', { class: 'md' });
  let list = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) { if (!list) { list = el('ul'); root.append(list); } list.append(el('li', {}, inline(li[1]))); continue; }
    list = null;
    if (h) root.append(el(h[1].length <= 2 ? 'h2' : 'h3', {}, inline(h[2])));
    else if (line.trim()) root.append(el('p', {}, inline(line)));
  }
  return root;
}

// ---------- Belge listesi ----------
const STATE_TEXT = { dizinlendi: 'aranabilir', 'anlamlandırılıyor': 'anlamlandırılıyor', 'anlamlandırıldı': 'anlamlandırıldı' };
function docBadge(d) {
  if (d.job?.state === 'running') return [el('span', { class: 'dot work' }), `${d.job.kind} ${d.job.done}/${d.job.total}`];
  if (d.approved) return [el('span', { class: 'dot ok' }), 'onaylandı'];
  if (d.state === 'anlamlandırıldı') return [el('span', { class: 'dot warn' }), 'onay bekliyor'];
  return [el('span', { class: 'dot' }), STATE_TEXT[d.state] || d.state];
}
function renderList() {
  $('#docCount').textContent = state.docs.length ? String(state.docs.length) : '';
  $('#allBtn').classList.toggle('active', !state.current);
  $('#docList').replaceChildren(...(state.docs.length ? state.docs.map((d) => el('button', { type: 'button', class: `doc-item${d.id === state.current ? ' active' : ''}`, title: d.name, onclick: () => openDoc(d.id) },
    el('span', { class: 'd-name', text: d.name }),
    el('span', { class: 'd-meta' }, docBadge(d), ` · ${d.pages} ${unit(d)}`)))
    : [el('div', { class: 'list-empty', text: 'Henüz belge yok. "Belge ekle" ile başlayın.' })]));
}
async function loadDocs() {
  const r = await api('/api/docs');
  if (r.docs) state.docs = r.docs;
  renderList();
  const running = state.docs.some((d) => d.job?.state === 'running');
  clearTimeout(state.poll);
  if (running) state.poll = setTimeout(async () => { await loadDocs(); if (state.current && state.view === 'doc') refreshDoc(); }, 1500);
}

// ---------- Görünümler ----------
function setHeader() {
  const d = state.doc?.meta;
  $('#title').textContent = state.current && d ? d.name : 'Tüm belgeler';
  $('#subtitle').textContent = state.current && d ? `${d.pages} ${unit(d)} · ${d.chunks} parça${d.embedDim ? ' · anlamsal dizin var' : ''}` : `${state.docs.length} belge`;
  $('#viewSeg').hidden = !state.current;
  for (const b of $('#viewSeg').children) b.classList.toggle('on', b.dataset.view === state.view);
  $('#scope').textContent = state.current && d ? `Bu belgede: ${d.name}` : 'Tüm belgelerde';
  $('#input').placeholder = state.current ? 'Bu belgeye bir soru sorun…' : 'Belgelerinize bir soru sorun…';
}
function render() {
  setHeader();
  if (!state.docs.length) return renderEmpty();
  if (state.current && state.view === 'doc') return renderDoc();
  renderChat();
}
function renderEmpty() {
  content.replaceChildren(el('div', { class: 'empty' },
    el('div', { class: 'empty-logo', }, (() => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 32 32'); s.innerHTML = '<rect width="32" height="32" rx="8"/><path d="M12 23V9h9M12 16h7"/>'; return s; })()),
    el('h1', { text: 'Belgelerinizi buraya getirin' }),
    el('p', { text: 'Fikirhane büyük belgeleri bu bilgisayardaki yerel dil modeliyle okur, anlamını çıkarır, size sorular sorar ve onayladığınız bilgiyle sorularınızı kaynak göstererek yanıtlar. Belgeleriniz bu bilgisayardan dışarı çıkmaz.' }),
    el('div', { class: 'actions', style: 'justify-content:center' },
      el('button', { class: 'btn primary', type: 'button', text: 'Belge ekle', onclick: () => $('#fileInput').click() }),
      el('button', { class: 'btn', type: 'button', text: 'Site gez', title: 'Bir web uygulamasını gezip ekranlarını kaydeder', onclick: () => openTour() })),
    el('div', { class: 'steps' },
      el('div', { class: 'step' }, el('strong', {}, el('span', { class: 'n', text: '1' }), 'Yükle'), 'PDF, Word ya da metin dosyası. Hemen aranabilir olur; bu adım yapay zekâ kullanmaz.'),
      el('div', { class: 'step' }, el('strong', {}, el('span', { class: 'n', text: '2' }), 'Anlamlandır'), 'Yerel model belgeyi bölüm bölüm okur, notlarını ve haritasını çıkarır, size sorular sorar.'),
      el('div', { class: 'step' }, el('strong', {}, el('span', { class: 'n', text: '3' }), 'Onayla ve sor'), 'Yanıtlarınız ve notlarınız belgeyle birlikte saklanır; sorular bunlara göre yanıtlanır.'))));
}

// ---------- Belge ayrıntısı ----------
async function openDoc(id) {
  state.current = id;
  state.view = 'doc';
  state.tab = 'harita';
  $('#app').classList.remove('menu-open');
  renderList();
  await refreshDoc();
  // Yeni gezilmiş sitede harita henüz yoktur: önce kaydedilen ekranlar gösterilir
  if (state.doc?.meta.kind === 'site' && !state.doc.map) { state.tab = 'ekranlar'; render(); }
}
async function refreshDoc() {
  if (!state.current) return;
  const d = await api(`/api/docs/${state.current}`);
  if (!d.meta) { state.current = null; state.doc = null; await loadDocs(); return render(); }
  // Yazılmakta olan bir yanıt varsa ekran yeniden çizilmez (yazılan kaybolmasın)
  const typing = document.activeElement && content.contains(document.activeElement) && ['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName);
  state.doc = d;
  if (!typing) render(); else setHeader();
}
const act = async (path, body = {}) => { const r = await api(path, body); if (!r.ok && r.error) alertBox(r.error); await loadDocs(); await refreshDoc(); return r; };
function alertBox(text) { state.notice = text; render(); }

function renderDoc() {
  const { meta, map, notes, questions, comments, job } = state.doc;
  const running = job?.state === 'running';
  const llmReady = state.config?.settings?.ready;
  const answered = questions.filter((q) => q.answer).length;
  const head = el('div', { class: `card${meta.state === 'anlamlandırıldı' && !meta.approved ? ' accent' : ''}` },
    el('div', { class: 'facts' },
      el('span', {}, el('b', { text: `${meta.pages} ` }), unit(meta)),
      meta.kind === 'site' && el('span', { text: meta.origin }),
      el('span', {}, el('b', { text: `${meta.understood}/${meta.sections} ` }), 'bölüm anlamlandırıldı'),
      el('span', { class: `badge${meta.approved ? ' ok' : meta.state === 'anlamlandırıldı' ? ' warn' : ''}`, text: meta.approved ? 'Onaylandı' : meta.state === 'anlamlandırıldı' ? 'Onayınızı bekliyor' : 'Aranabilir' }),
      meta.embedDim ? el('span', { class: 'badge ok', text: 'Anlamsal dizin var' }) : null),
    state.notice && el('div', { class: 'result err', text: state.notice }),
    job?.state === 'error' && el('div', { class: 'result err', text: `İşlem durdu: ${job.error}` }),
    running && [el('div', { class: 'progress' }, el('div', { style: `width:${Math.round((job.done / Math.max(1, job.total)) * 100)}%` })),
      el('div', { class: 'progress-text', text: `${job.kind}: ${job.done}/${job.total}. Yerel modelin hızına göre sürer; sayfayı kapatabilirsiniz, iş arka planda devam eder.` })],
    el('div', { class: 'actions' },
      running ? el('button', { class: 'btn', type: 'button', text: 'Durdur', onclick: () => act(`/api/docs/${meta.id}/cancel`) })
        : [meta.understood < meta.sections || !map
          ? el('button', { class: 'btn primary', type: 'button', disabled: !llmReady, title: llmReady ? null : 'Önce Ayarlar\'dan yerel modeli tanımlayın', text: meta.understood ? 'Anlamlandırmaya devam et' : 'Anlamlandır', onclick: () => act(`/api/docs/${meta.id}/understand`) })
          : el('button', { class: `btn${meta.approved ? '' : ' primary'}`, type: 'button', text: meta.approved ? 'Onayı geri al' : 'Onayla', title: 'Haritayı ve notları okudum; sorular buna göre yanıtlansın', onclick: () => act(`/api/docs/${meta.id}/approve`, { approved: !meta.approved }) }),
        !meta.embedDim && state.config?.settings?.embedModel ? el('button', { class: 'btn', type: 'button', text: 'Anlamsal dizin oluştur', title: 'Kelimesi geçmese de anlamca yakın bölümleri bulur', onclick: () => act(`/api/docs/${meta.id}/embed`) }) : null],
      el('span', { class: 'spacer' }),
      (() => { const b = el('button', { class: 'btn ghost', type: 'button', text: 'Belgeyi sil' }); b.onclick = async () => { if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = 'Emin misiniz?'; b.classList.add('danger'); return; } await api(`/api/docs/${meta.id}`, null, 'DELETE'); state.current = null; state.doc = null; await loadDocs(); render(); }; return b; })()),
    !llmReady && el('p', { style: 'margin:10px 0 0', text: 'Anlamlandırma ve soru yanıtlama için yerel model gerekir. Ayarlar\'dan (sol üstteki dişli) sunucu adresini ve modeli girin. Model olmadan da "Yalnızca ara" ile belgede arama yapabilirsiniz.' }));
  state.notice = null;

  const TABS = [...(meta.kind === 'site' ? [['ekranlar', `Ekranlar (${state.doc.screens?.length || 0})`]] : []), ['harita', 'Harita'], ['notlar', `Bölüm notları (${notes.length})`], ['sorular', `Sorular (${answered}/${questions.length})`], ['yorumlar', `Notlarım (${comments.length})`]];
  const tabs = el('div', { class: 'tabs' }, TABS.map(([id, name]) => el('button', { type: 'button', class: `tab${state.tab === id ? ' on' : ''}`, text: name, onclick: () => { state.tab = id; render(); } })));
  content.replaceChildren(head, tabs, ...tabBody());
}
function tabBody() {
  const { meta, map, notes, questions, comments } = state.doc;
  if (state.tab === 'ekranlar') {
    const list = state.doc.screens || [];
    return [
      el('p', { style: 'color:var(--text-2);font-size:13.5px;margin:0 0 10px', text: 'Gezinti sırasında kaydedilen ekranlar. Kartta ekranın yapısı durur: başlıklar, alanlar, düğmeler, bağlantılar. Alanlara yazılan değerler ve tablolardaki veriler kaydedilmez.' }),
      ...list.map((s) => el('div', { class: 'note' },
        el('div', { class: 'note-head' }, el('span', { text: `Ekran ${s.no}` }), el('span', { class: 's-path', text: s.path }), el('button', { type: 'button', text: 'Kartı göster', onclick: () => showPage(meta.id, s.no, meta.name) })),
        el('div', { text: s.title, style: 'font-weight:600' }),
        el('div', { class: 's-via', text: [s.from || s.via ? `Geliş: ${[s.from && `Ekran ${s.from}`, s.via].filter(Boolean).join(' → ')}` : '', `${s.fields} alan`, `${s.buttons} düğme`, `${s.links} bağlantı`].filter(Boolean).join(' · ') }))),
    ];
  }
  if (state.tab === 'harita') {
    if (!map) return [el('div', { class: 'result', text: meta.kind === 'site' ? 'Harita henüz çıkarılmadı. "Anlamlandır" ile yerel model ekran kartlarını okuyup uygulamanın haritasını (ekranlar, temel akışlar) çıkarır.' : 'Harita henüz çıkarılmadı. "Anlamlandır" ile yerel model belgeyi okuyup bir sayfalık haritasını çıkarır.' })];
    const edit = el('textarea', { rows: '16', hidden: true });
    edit.value = map;
    const view = markdown(map);
    const save = el('button', { class: 'btn primary', type: 'button', text: 'Kaydet', hidden: true, onclick: async () => { await api(`/api/docs/${meta.id}/map`, { text: edit.value }); refreshDoc(); } });
    const toggle = el('button', { class: 'btn ghost', type: 'button', text: 'Haritayı düzelt', onclick: () => { edit.hidden = false; save.hidden = false; view.hidden = true; toggle.hidden = true; edit.focus(); } });
    return [el('div', { class: 'note' }, view, edit), el('div', { class: 'actions' }, toggle, save)];
  }
  if (state.tab === 'notlar') {
    return notes.length ? notes.map((n) => el('div', { class: 'note' },
      el('div', { class: 'note-head' }, el('span', { text: n.from === n.to ? `${Unit(meta)} ${n.from}` : `${Unit(meta)} ${n.from}–${n.to}` }), el('button', { type: 'button', text: meta.kind === 'site' ? 'Kartı göster' : 'Asıl metni göster', onclick: () => showPage(meta.id, n.from, meta.name) })),
      markdown(n.note)))
      : [el('div', { class: 'result', text: 'Bölüm notları anlamlandırma sırasında yazılır.' })];
  }
  if (state.tab === 'sorular') {
    if (!questions.length) return [el('div', { class: 'result', text: 'Yerel model belgeyi okuduktan sonra size soracağı sorular burada çıkar. Yanıtlarınız, belgeye soru sorulduğunda dikkate alınır.' })];
    return questions.map((q, i) => {
      const ta = el('textarea', { rows: '2', placeholder: 'Yanıtınızı yazın (boş bırakabilirsiniz)' });
      ta.value = q.answer || '';
      const save = el('button', { class: 'btn', type: 'button', text: 'Kaydet', onclick: async () => { await api(`/api/docs/${meta.id}/answer`, { i, answer: ta.value }); document.activeElement?.blur(); refreshDoc(); } });
      return el('div', { class: `q-block${q.answer ? ' done' : ''}` }, el('div', { class: 'q', text: q.q }), ta, el('div', { class: 'actions', style: 'margin-top:8px' }, save));
    });
  }
  const ta = el('textarea', { rows: '3', placeholder: 'Bu belgeyle ilgili kendi notunuz, yorumunuz ya da kararınız. Örnek: "3. bölümdeki onay süresi artık 5 gün; belgedeki 10 gün eski."' });
  return [
    el('p', { style: 'color:var(--text-2);font-size:13.5px;margin:0 0 10px', text: 'Notlarınız belgeden ayrı tutulur ve yanıtlarda "kullanıcının notu" olarak kullanılır. Belgeyle çelişirse sizin notunuz esas alınır.' }),
    ...comments.map((c) => el('div', { class: 'note' }, el('div', { class: 'note-head' }, el('span', { text: new Date(c.added).toLocaleDateString('tr-TR') }), el('button', { type: 'button', text: 'Sil', onclick: async () => { await api(`/api/docs/${meta.id}/comment/${c.id}`, null, 'DELETE'); refreshDoc(); } })), el('div', { text: c.text, style: 'white-space:pre-wrap' }))),
    ta, el('div', { class: 'actions', style: 'margin-top:8px' }, el('button', { class: 'btn primary', type: 'button', text: 'Not ekle', onclick: async () => { const r = await api(`/api/docs/${meta.id}/comment`, { text: ta.value }); if (r.ok) { ta.value = ''; ta.blur(); refreshDoc(); } } })),
  ];
}
async function showPage(id, page, name) {
  const p = await api(`/api/docs/${id}/page/${page}`);
  $('#pageTitle').textContent = `${name} · ${unit(state.docs.find((d) => d.id === id))} ${page}`;
  $('#pageText').textContent = p.text || p.error || '';
  $('#pageDialog').showModal();
}

// ---------- Soru-yanıt ----------
function renderChat() {
  const nodes = [];
  if (!state.chat.length) nodes.push(el('div', { class: 'empty', style: 'margin-top:6vh' }, el('h1', { text: 'Ne öğrenmek istersiniz?' }),
    el('p', { text: state.current ? 'Sorunuz bu belgeye, haritasına ve notlarınıza dayanarak yanıtlanır; her bilginin yanında sayfası yazar.' : 'Sorunuz bütün belgelerinize dayanarak yanıtlanır; her bilginin yanında hangi belgenin hangi sayfasından geldiği yazar.' })));
  for (const m of state.chat) {
    if (m.role === 'user') { nodes.push(el('div', { class: 'msg-user', text: m.text })); continue; }
    const srcs = m.sources?.length ? el('details', { class: 'sources', open: m.searchOnly || null }, el('summary', { text: `${m.sources.length} kaynak bölüm` }),
      m.sources.map((s) => el('button', { type: 'button', class: 'source', onclick: () => showPage(s.doc, s.page, s.name) }, el('b', { text: `${s.name} s.${s.page}` }), s.text.slice(0, 260) + (s.text.length > 260 ? '…' : '')))) : null;
    nodes.push(el('div', { class: 'msg-ai' }, m.error ? el('div', { class: 'result err', text: m.error }) : m.text ? markdown(m.text) : null, srcs));
  }
  if (state.asking) nodes.push(el('div', { class: 'working' }, el('span', { class: 'spin' }), 'Yerel model yanıtlıyor… Modelin hızına göre bir dakika kadar sürebilir.'));
  content.replaceChildren(...nodes);
  content.scrollTop = content.scrollHeight;
}
async function ask(searchOnly = false) {
  const input = $('#input');
  const q = input.value.trim();
  if (!q || state.asking) return;
  input.value = '';
  autoGrow();
  state.view = 'chat';
  state.chat.push({ role: 'user', text: q });
  state.asking = !searchOnly;
  render();
  const docs = state.current ? [state.current] : [];
  const r = searchOnly ? await api('/api/search', { q, docs }) : await api('/api/ask', { q, docs });
  state.asking = false;
  state.chat.push(r.ok ? (searchOnly ? { role: 'ai', text: r.results.length ? '' : 'Belgelerde eşleşen bölüm bulunamadı.', sources: r.results, searchOnly: true } : { role: 'ai', text: r.answer, sources: r.sources }) : { role: 'ai', error: r.error });
  render();
}
function autoGrow() { const i = $('#input'); i.style.height = 'auto'; i.style.height = `${Math.min(200, i.scrollHeight)}px`; }
$('#input').addEventListener('input', autoGrow);
$('#input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } });
$('#sendBtn').onclick = () => ask();
$('#searchBtn').onclick = () => ask(true);
$('#allBtn').onclick = () => { state.current = null; state.doc = null; state.view = 'chat'; $('#app').classList.remove('menu-open'); renderList(); render(); };
for (const b of $('#viewSeg').children) b.onclick = () => { state.view = b.dataset.view; render(); };

// ---------- Belge yükleme ----------
async function upload(files) {
  for (const f of files) {
    $('#addBtn').querySelector('span').textContent = `Yükleniyor: ${f.name.slice(0, 22)}…`;
    const r = await fetch('/api/docs', { method: 'POST', headers: { 'x-fikirhane': '1', 'x-dosya-adi': encodeURIComponent(f.name), 'content-type': 'application/octet-stream' }, body: f }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
    await loadDocs();
    if (r.ok) await openDoc(r.meta.id); else { state.notice = `${f.name}: ${r.error}`; if (state.current) render(); else alert(state.notice); }
  }
  $('#addBtn').querySelector('span').textContent = 'Belge ekle';
  render();
}
$('#addBtn').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => { upload([...e.target.files]); e.target.value = ''; };
for (const ev of ['dragover', 'dragenter']) document.addEventListener(ev, (e) => { e.preventDefault(); $('#addBtn').classList.add('drag'); });
for (const ev of ['dragleave', 'drop']) document.addEventListener(ev, (e) => { e.preventDefault(); $('#addBtn').classList.remove('drag'); });
document.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) upload([...e.dataTransfer.files]); });

// ---------- Site gezintisi ----------
// Ayrı bir tarayıcı penceresi açılır; kullanıcı gezer, her ekranın yapısı kart olarak kaydedilir, bitince belge olur.
const tour = { data: null, browser: true, timer: null, note: null, url: '', limit: 30 };
async function loadTour() {
  const r = await api('/api/tour');
  tour.data = r.tour || null;
  tour.browser = r.browser !== false;
  $('#siteBtn').querySelector('span').textContent = tour.data ? `Gezinti sürüyor · ${tour.data.count} ekran` : 'Site gez';
  const typing = $('#tourBody').contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
  if ($('#tourDialog').open && !typing) renderTour();
  clearTimeout(tour.timer);
  if (tour.data?.state === 'açık') tour.timer = setTimeout(loadTour, 1500);
}
const tourAct = async (path, body = {}) => { const r = await api(path, body); tour.note = r.ok ? null : { kind: 'err', text: r.error }; document.activeElement?.blur(); await loadTour(); return r; };
function renderTour() {
  const t = tour.data;
  const note = tour.note && el('div', { class: `result ${tour.note.kind}`, text: tour.note.text });
  if (!t) {
    const url = el('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: 'https://uygulama.example.com' });
    url.value = tour.url;
    url.oninput = () => { tour.url = url.value; };
    const start = async () => {
      tour.note = { kind: '', text: 'Tarayıcı açılıyor…' }; renderTour();
      await tourAct('/api/tour', { url: tour.url });
    };
    url.onkeydown = (e) => { if (e.key === 'Enter') start(); };
    fill($('#tourBody'),
      el('p', { text: 'Fikirhane ayrı bir tarayıcı penceresi açar. Orada giriş yapın ve tanıtmak istediğiniz ekranları gezin: her ekranın yapısı (başlıklar, alanlar, düğmeler, bağlantılar) kaydedilir. Sonra bu bilgi sorularınıza ve tarayıcı testlerine kaynak olur.' }),
      el('p', { text: 'Alanlara yazdıklarınız, parolanız ve tablolardaki veriler kaydedilmez. Fikirhane hiçbir düğmeye basmaz, hiçbir formu göndermez. Tarayıcı geçici bir profille açılır; gezinti bitince oturum bilgisi silinir.' }),
      el('label', { class: 'field' }, el('span', { text: 'Site adresi' }), url),
      !tour.browser && el('div', { class: 'result err', text: 'Bu bilgisayarda Microsoft Edge ya da Google Chrome bulunamadı.' }),
      note,
      el('div', { class: 'actions' }, el('button', { class: 'btn primary', type: 'button', text: 'Tarayıcıyı aç', disabled: !tour.browser, onclick: start })));
    return;
  }
  const open = t.state === 'açık';
  const crawling = t.crawl?.running;
  const limit = el('input', { type: 'number', class: 'short', min: '1', max: '200', title: 'En fazla kaç yeni ekran' });
  limit.value = tour.limit;
  limit.oninput = () => { tour.limit = Number(limit.value) || 30; };
  const cancel = el('button', { class: 'btn ghost', type: 'button', text: 'Vazgeç' });
  cancel.onclick = async () => {
    if (t.count && !cancel.dataset.sure) { cancel.dataset.sure = '1'; cancel.textContent = 'Ekranlar silinsin mi?'; cancel.classList.add('danger'); return; }
    await tourAct('/api/tour/cancel');
  };
  fill($('#tourBody'),
    el('div', { class: 'facts' },
      el('span', {}, el('b', { text: `${t.count} ` }), 'ekran kaydedildi'),
      el('span', { text: t.origin }),
      el('span', { class: `badge${open ? ' ok' : ' warn'}`, text: open ? 'Tarayıcı açık' : 'Tarayıcı kapandı' })),
    t.error && el('div', { class: `result${open ? ' err' : ''}`, text: t.error }),
    open && el('p', { text: 'Açılan tarayıcı penceresinde gezin; her yeni ekran kendiliğinden kaydedilir. Adres değişmeden açılan bir pencere ya da sekme listeye gelmediyse "Bu ekranı kaydet"e basın.' }),
    t.crawl && el('div', { class: 'working' }, crawling && el('span', { class: 'spin' }),
      `Otomatik gezinti${crawling ? '' : ' bitti'}: ${t.crawl.done} adres gezildi, ${t.crawl.added} yeni ekran${crawling ? `, ${t.crawl.queued} sırada` : ''}${t.crawl.skipped ? `. ${t.crawl.skipped} bağlantı güvenlik için atlandı (çıkış, silme, indirme).` : '.'}`),
    el('div', { class: 'screen-list' }, t.cards.length
      ? [...t.cards].reverse().map((c) => el('div', { class: 'screen', title: c.via ? `Geliş: ${c.via}` : null }, el('b', { text: `${c.no}.` }), el('span', { class: 's-title', text: c.title }), el('span', { class: 's-path', text: c.path })))
      : el('div', { class: 'list-empty', text: 'Henüz ekran yok. Sayfa yüklenince ilk ekran buraya gelir.' })),
    note,
    el('div', { class: 'actions' },
      open && !crawling && el('button', { class: 'btn', type: 'button', text: 'Bu ekranı kaydet', onclick: async () => { const r = await tourAct('/api/tour/capture'); if (r.ok && !r.added) { tour.note = { kind: '', text: r.no ? `Bu ekran zaten kayıtlı (Ekran ${r.no}).` : 'Bu sayfa kaydedilmedi (başka bir sitede ya da boş).' }; renderTour(); } } }),
      open && !crawling && [el('button', { class: 'btn', type: 'button', text: 'Bağlantıları otomatik gez', title: 'Kaydedilen ekranlardaki bağlantıların adresine gider; düğmelere basmaz. Çıkış, silme ve indirme bağlantıları atlanır. Bu sırada tarayıcı penceresine dokunmayın.', onclick: () => tourAct('/api/tour/crawl', { limit: tour.limit }) }), limit],
      crawling && el('button', { class: 'btn', type: 'button', text: 'Durdur', onclick: () => tourAct('/api/tour/stop') }),
      el('span', { class: 'spacer' }),
      cancel,
      el('button', { class: 'btn primary', type: 'button', text: 'Bitir ve kaydet', disabled: !t.count, onclick: async () => {
        const r = await tourAct('/api/tour/finish');
        if (r.ok) { $('#tourDialog').close(); await loadDocs(); await openDoc(r.meta.id); }
      } })));
}
function openTour() { tour.note = null; $('#app').classList.remove('menu-open'); renderTour(); $('#tourDialog').showModal(); loadTour(); }
$('#siteBtn').onclick = openTour;
$('#tourClose').onclick = () => $('#tourDialog').close();

// ---------- Ayarlar (yerel model) ----------
function renderSettings(note) {
  const s = state.config.settings;
  const field = (label, input, hint) => el('label', { class: 'field' }, el('span', { text: label }), input, hint && el('small', { text: hint }));
  const inp = (value, attrs = {}) => { const i = el('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', ...attrs }); i.value = value || ''; return i; };
  const url = inp(state.draft?.url ?? s.url, { placeholder: 'http://localhost:11434' });
  const chat = inp(state.draft?.chatModel ?? s.chatModel, { list: 'modelList', placeholder: 'qwen3:8b' });
  const embed = inp(state.draft?.embedModel ?? s.embedModel, { list: 'modelList', placeholder: 'bge-m3 (isteğe bağlı)' });
  const key = inp('', { type: 'password', placeholder: s.hasKey ? 'Kayıtlı (değiştirmek için yenisini yazın)' : 'Çoğu yerel sunucuda gerekmez' });
  const keep = () => { state.draft = { url: url.value, chatModel: chat.value, embedModel: embed.value }; };
  const body = () => ({ url: url.value, chatModel: chat.value, embedModel: embed.value, key: key.value });
  fill($('#settingsBody'),
    el('p', { text: 'Fikirhane bu bilgisayarda ya da yerel ağınızda çalışan bir dil modeli sunucusunu kullanır (Ollama, LM Studio, llama.cpp vb.). Belgeleriniz yalnızca yazdığınız adrese gider.' }),
    field('Sunucu adresi', url, 'Ollama: http://localhost:11434 · LM Studio: http://localhost:1234'),
    field('Sohbet modeli', chat, 'Belgeyi okuyan ve soruları yanıtlayan model. "Bağlantıyı dene" sunucudaki modelleri listeye getirir.'),
    field('Embedding modeli (isteğe bağlı)', embed, 'Anlamsal arama için (ör. bge-m3, nomic-embed-text). Boş bırakırsanız yalnızca kelime araması yapılır.'),
    field('API anahtarı (isteğe bağlı)', key),
    el('datalist', { id: 'modelList' }, (state.models || []).map((m) => el('option', { value: m }))),
    note && el('div', { class: `result ${note.kind}`, text: note.text }),
    el('div', { class: 'actions' },
      el('button', { class: 'btn', type: 'button', text: 'Bağlantıyı dene', onclick: async () => {
        keep(); renderSettings({ kind: '', text: 'Deneniyor… Model ilk kez yükleniyorsa bir dakika kadar sürebilir.' });
        const r = await api('/api/settings/test', body());
        if (r.models) state.models = r.models;
        renderSettings(r.ok ? { kind: 'ok', text: `Sunucuya ulaşıldı, ${r.models.length} model var.${r.chat ? ' Sohbet modeli yanıt verdi.' : ''}${r.embed ? ` Embedding modeli çalışıyor (${r.embed} boyut).` : ''}` } : { kind: 'err', text: r.error });
      } }),
      el('button', { class: 'btn primary', type: 'button', text: 'Kaydet', onclick: async () => {
        keep();
        const r = await api('/api/settings', body());
        if (r.ok) { state.config.settings = r.settings; state.draft = null; renderChip(); render(); }
        renderSettings(r.ok ? { kind: 'ok', text: 'Kaydedildi.' } : { kind: 'err', text: r.error });
      } })));
}
function renderChip() {
  const s = state.config.settings;
  $('#llmChip').replaceChildren(el('span', { class: `dot ${s.ready ? 'ok' : 'warn'}` }), el('span', { text: s.ready ? `Yerel model: ${s.chatModel}` : 'Yerel model tanımlı değil (ayarla)' }));
}
const openSettings = () => { state.draft = null; renderSettings(); $('#settingsDialog').showModal(); };
$('#settingsBtn').onclick = openSettings;
$('#llmChip').onclick = openSettings;
$('#settingsClose').onclick = () => $('#settingsDialog').close();
$('#pageClose').onclick = () => $('#pageDialog').close();
for (const d of document.querySelectorAll('dialog')) d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
$('#menuBtn').onclick = () => $('#app').classList.toggle('menu-open');

// ---------- Tema ve güncelleme ----------
const savedTheme = (() => { try { return localStorage.getItem('fikirhane:theme'); } catch { return null; } })();
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
$('#themeBtn').onclick = () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('fikirhane:theme', document.documentElement.dataset.theme); } catch { /* yoksay */ }
};
async function checkUpdate() {
  const u = await api('/api/update');
  $('#updateBtn').hidden = !u?.available;
  if (u?.available) { $('#updateBtn').textContent = `Güncelleme var: ${u.latest}`; $('#updateBtn').onclick = async () => { $('#updateBtn').textContent = 'Güncelleniyor…'; await api('/api/update/apply', {}); setTimeout(() => location.reload(), 20000); }; }
}

// ---------- Başlangıç ----------
state.config = await api('/api/config');
$('#versionText').textContent = `Fikirhane ${state.config.version || ''}`;
renderChip();
await loadDocs();
state.view = 'chat';
render();
checkUpdate();
loadTour();
setInterval(checkUpdate, 30 * 60 * 1000);
