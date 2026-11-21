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
    state.info && el('div', { class: 'result ok', text: state.info }),
    job?.state === 'error' && el('div', { class: 'result err', text: `İşlem durdu: ${job.error}` }),
    running && [el('div', { class: 'progress' }, el('div', { style: `width:${Math.round((job.done / Math.max(1, job.total)) * 100)}%` })),
      el('div', { class: 'progress-text', text: `${job.kind}: ${job.done}/${job.total}. Yerel modelin hızına göre sürer; sayfayı kapatabilirsiniz, iş arka planda devam eder.` })],
    el('div', { class: 'actions' },
      running ? el('button', { class: 'btn', type: 'button', text: 'Durdur', onclick: () => act(`/api/docs/${meta.id}/cancel`) })
        : [meta.understood < meta.sections || !map
          ? el('button', { class: 'btn primary', type: 'button', disabled: !llmReady, title: llmReady ? null : 'Önce Ayarlar\'dan yerel modeli tanımlayın', text: meta.understood ? 'Anlamlandırmaya devam et' : 'Anlamlandır', onclick: () => act(`/api/docs/${meta.id}/understand`) })
          : el('button', { class: `btn${meta.approved ? '' : ' primary'}`, type: 'button', text: meta.approved ? 'Onayı geri al' : 'Onayla', title: 'Haritayı ve notları okudum; sorular buna göre yanıtlansın', onclick: () => act(`/api/docs/${meta.id}/approve`, { approved: !meta.approved }) }),
        !meta.embedDim && state.config?.settings?.embedModel ? el('button', { class: 'btn', type: 'button', text: 'Anlamsal dizin oluştur', title: 'Kelimesi geçmese de anlamca yakın bölümleri bulur', onclick: () => act(`/api/docs/${meta.id}/embed`) }) : null],
      meta.kind === 'site' && el('button', { class: 'btn', type: 'button', text: 'Yeniden gez', title: 'Arayüz değiştiyse siteyi yeniden gezin; bitirirken "Var olanı güncelle" bu kaydı günceller (notlarınız ve senaryolar korunur)', onclick: () => openTour(meta.start || meta.origin) }),
      el('span', { class: 'spacer' }),
      (() => { const b = el('button', { class: 'btn ghost', type: 'button', text: 'Belgeyi sil' }); b.onclick = async () => { if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = 'Emin misiniz?'; b.classList.add('danger'); return; } await api(`/api/docs/${meta.id}`, null, 'DELETE'); state.current = null; state.doc = null; await loadDocs(); render(); }; return b; })()),
    !llmReady && el('p', { style: 'margin:10px 0 0', text: 'Anlamlandırma ve soru yanıtlama için yerel model gerekir. Ayarlar\'dan (sol üstteki dişli) sunucu adresini ve modeli girin. Model olmadan da "Yalnızca ara" ile belgede arama yapabilirsiniz.' }));
  state.notice = null;
  state.info = null;

  const TABS =[...(meta.kind === 'site' ? [['ekranlar', `Ekranlar (${state.doc.screens?.length || 0})`], ['senaryolar', `Senaryolar (${state.doc.scenarios?.length || 0})`]] : []), ['harita', 'Harita'], ['notlar', `Bölüm notları (${notes.length})`], ['sorular', `Sorular (${answered}/${questions.length})`], ['yorumlar', `Notlarım (${comments.length})`]];
  const tabs = el('div', { class: 'tabs' }, TABS.map(([id, name]) => el('button', { type: 'button', class: `tab${state.tab === id ? ' on' : ''}`, text: name, onclick: () => { state.tab = id; render(); } })));
  content.replaceChildren(head, tabs, ...tabBody());
}
function tabBody() {
  const { meta, map, notes, questions, comments } = state.doc;
  if (state.tab === 'ekranlar') {
    const list = state.doc.screens || [];
    const unseen = list.filter((s) => s.mark === 'görülmedi').length;
    const MARK = { yeni: ['ok', 'yeni', 'Son gezintide ilk kez görüldü'], 'değişti': ['warn', 'değişti', 'Son gezintide yapısı farklı çıktı; kart güncellendi'], 'görülmedi': ['', 'son gezintide görülmedi', 'Kaldırılmış ya da o gezintide açılmamış olabilir; kart olduğu gibi duruyor'] };
    const prune = el('button', { class: 'btn', type: 'button', text: `Görülmeyen ${unseen} ekranı sil` });
    prune.onclick = async () => {
      if (!prune.dataset.sure) { prune.dataset.sure = '1'; prune.textContent = 'Emin misiniz?'; prune.classList.add('danger'); return; }
      const r = await api(`/api/docs/${meta.id}/screens/prune`, {});
      if (!r.ok) alertBox(r.error); else { await loadDocs(); await refreshDoc(); }
    };
    return [
      el('p', { style: 'color:var(--text-2);font-size:13.5px;margin:0 0 10px', text: 'Gezinti sırasında kaydedilen ekranlar. Kartta ekranın yapısı durur: başlıklar, alanlar, düğmeler, bağlantılar. Alanlara yazılan değerler ve tablolardaki veriler kaydedilmez.' }),
      unseen > 0 && el('div', { class: 'actions', style: 'margin-bottom:10px' }, el('span', { style: 'color:var(--text-2);font-size:13px;flex:1;min-width:220px', text: `${unseen} ekran son gezintide görülmedi. Kaldırıldıysa silebilirsiniz; o gezintide yalnızca açmadıysanız dokunmayın.` }), el('span', { class: 'spacer' }), prune),
      ...list.map((s) => el('div', { class: 'note' },
        el('div', { class: 'note-head' }, el('span', { text: `Ekran ${s.no}` }), el('span', { class: 's-path', text: s.path }),
          el('button', { type: 'button', text: 'Senaryo yap', title: 'Bu ekrana gidişi (gezintide kaydedilen yol) yeniden çalıştırılabilir bir senaryo olarak kaydeder', onclick: async () => {
            const r = await api(`/api/sites/${meta.id}/scenarios/from-screen`, { no: s.no });
            if (r.ok) { state.tab = 'senaryolar'; await refreshDoc(); } else alertBox(r.error);
          } }),
          el('button', { type: 'button', text: 'Kartı göster', onclick: () => showPage(meta.id, s.no, meta.name) })),
        el('div', { style: 'font-weight:600' }, s.title, MARK[s.mark] && el('span', { class: `badge ${MARK[s.mark][0]}`, style: 'margin-left:8px;font-weight:400', title: MARK[s.mark][2], text: MARK[s.mark][1] }), s.changed && el('span', { class: 'badge warn', style: 'margin-left:8px;font-weight:400', title: 'Bir senaryo bu ekranda kaldı ve ekran karttan farklı çıktı; site yeniden gezilmeli', text: 'değişmiş görünüyor' })),
        el('div', { class: 's-via', text: [s.from || s.via ? `Geliş: ${[s.from && `Ekran ${s.from}`, s.via].filter(Boolean).join(' → ')}` : '', `${s.fields} alan`, `${s.buttons} düğme`, `${s.links} bağlantı`].filter(Boolean).join(' · ') }))),
    ].filter(Boolean);
  }
  if (state.tab === 'senaryolar') {
    const list = state.doc.scenarios || [];
    const BADGE = { 'geçti': ['ok', 'Geçti'], 'kaldı': ['warn', 'Kaldı'] };
    return [
      el('p', { style: 'color:var(--text-2);font-size:13.5px;margin:0 0 10px', text: 'Senaryo, bu uygulamada adım adım yapılan bir işin saklanan tarifidir. Test yapan araç (ör. Atölye) senaryoyu kaydeder ve sonraki seferlerde sayfayı yeniden keşfetmek yerine betiğini çalıştırır. Fikirhane betiği kendisi çalıştırmaz: üretir ve bildirilen sonucu kaydeder.' }),
      ...list.map((s) => {
        const [kind, label] = BADGE[s.status] || ['', 'Çalıştırılmadı'];
        const del = el('button', { class: 'btn ghost', type: 'button', text: 'Sil' });
        del.onclick = async () => {
          if (!del.dataset.sure) { del.dataset.sure = '1'; del.textContent = 'Emin misiniz?'; del.classList.add('danger'); return; }
          await api(`/api/sites/${meta.id}/scenarios/${s.id}`, null, 'DELETE'); refreshDoc();
        };
        return el('div', { class: 'note' },
          el('div', { class: 'actions', style: 'margin-bottom:6px' }, el('b', { text: s.name }), el('span', { class: `badge ${kind}`, text: label }),
            s.last && el('span', { class: 's-via', text: `${new Date(s.last.at).toLocaleString('tr-TR')}${s.last.ok ? ` · ${(s.last.ms / 1000).toFixed(1)} sn` : ''}` })),
          s.description && el('div', { class: 's-via', text: s.description }),
          s.warn && el('div', { class: 'result err', style: 'margin-top:6px', text: s.warn }),
          el('pre', { class: 'steps-text', text: s.text.split('\n').filter((l) => /^\d+\. |^Değişkenler:/.test(l)).join('\n') }),
          s.last && !s.last.ok && el('div', { class: 'result err', text: `Son çalıştırma ${s.last.step}. adımda kaldı: ${s.last.error || 'hata bildirilmedi'}` }),
          el('div', { class: 'actions' },
            el('button', { class: 'btn', type: 'button', text: 'Betiği indir', title: 'Playwright betiği (.mjs); çalıştırma bilgisi dosyanın başında yazar', onclick: async () => {
              const r = await api(`/api/sites/${meta.id}/scenarios/${s.id}/script`);
              if (r.script) download(r.file, r.script, 'text/javascript'); else alertBox(r.error);
            } }),
            el('span', { class: 'spacer' }), del));
      }),
      !list.length && el('div', { class: 'result', text: 'Henüz senaryo yok. "Ekranlar" sekmesindeki "Senaryo yap", o ekrana gidişi senaryo olarak kaydeder; daha uzun senaryoları test yapan araç kaydeder.' }),
    ].filter(Boolean);
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
const tour = { data: null, browser: true, timer: null, note: null, url: '', limit: 30, goal: '', mode: 'emin-degilse', steps: 40, answers: {}, formOpen: false };
// Model gezsin: siteyi dil modeli gezer; bilmediğini sorar. Onay kipleri sunucudaki kesif.js ile aynı adları taşır.
const MODE_TEXT = { 'emin-degilse': 'Emin olmadığı düğmelerde sorsun (önerilen)', 'her-adim': 'Her adımda sorsun', serbest: 'Hiç sormasın (yalnızca deneme ortamında)' };
const EXPLORE_INFO = 'Model ekranları dolaşır ve akışları çıkarır; giriş bilgisi ya da doldurulması gereken bir alan çıkınca size sorar. Verdiğiniz değerleri tarayıcıya Fikirhane yazar, modele göndermez. Sorulanlar bu site için kaydedilir ve bir daha sorulmaz (parola diske yazılmaz; yalnızca Fikirhane kapanana kadar bellekte tutulur). Model "Çıkış"a basmaz; silme, gönderme gibi işlemlerden ve ne yaptığı adından anlaşılmayan düğmelerden önce size sorar.';
function exploreForm() {
  const goal = el('textarea', { rows: '2', placeholder: 'Örn. "Rezervasyon arama ve ayrıntı ekranlarını çıkar". Boş bırakırsanız model ana ekranları ve temel işleri kendisi arar.' });
  goal.value = tour.goal;
  goal.oninput = () => { tour.goal = goal.value; };
  const mode = el('select', {}, Object.entries(MODE_TEXT).map(([value, text]) => el('option', { value, text })));
  mode.value = tour.mode;
  mode.onchange = () => { tour.mode = mode.value; };
  const steps = el('input', { type: 'number', class: 'short', min: '3', max: '150', title: 'Model en çok kaç adım atsın (3–150)' });
  steps.value = tour.steps;
  steps.oninput = () => { tour.steps = Number(steps.value) || 40; };
  return [el('label', { class: 'field' }, el('span', { text: 'Modelin amacı (isteğe bağlı)' }), goal),
    el('div', { class: 'row2' }, el('label', { class: 'field' }, el('span', { text: 'Onay' }), mode), el('label', { class: 'field' }, el('span', { text: 'En çok adım' }), steps))];
}
const exploreBody = () => ({ goal: tour.goal, mode: tour.mode, limit: tour.steps });
// Modelin sorusu: alan değerleri (Fikirhane yazar), düz soru (yanıt modele gider) ya da bir tıklama için izin
function pendingForm(p) {
  const a = tour.answers[p.id] ||= { values: {}, text: '' };
  const send = (body) => tourAct('/api/tour/explore/answer', { id: p.id, ...body });
  if (p.kind === 'onay') {
    return el('div', { class: 'ask' }, el('p', {}, el('b', { text: 'Model şunu yapmak istiyor: ' }), p.what),
      el('p', { text: `${p.why}${p.remember ? ' Kararınız bu site için kaydedilir ve aynı düğme için yeniden sorulmaz.' : ''}` }),
      el('div', { class: 'actions' }, el('button', { class: 'btn primary', type: 'button', text: 'İzin ver', onclick: () => send({ allow: true }) }), el('button', { class: 'btn', type: 'button', text: 'İzin verme', onclick: () => send({ allow: false }) })));
  }
  if (p.kind === 'soru') {
    const text = el('textarea', { rows: '2', placeholder: 'Yanıtınız' });
    text.value = a.text;
    text.oninput = () => { a.text = text.value; };
    return el('div', { class: 'ask' }, el('p', {}, el('b', { text: 'Model soruyor: ' }), p.soru), text,
      el('p', { class: 'xnote', text: 'Yanıtınız modele gönderilir ve bu site için kaydedilir.' }),
      el('div', { class: 'actions' }, el('button', { class: 'btn primary', type: 'button', text: 'Yanıtla', onclick: () => send({ text: a.text }) }), el('button', { class: 'btn', type: 'button', text: 'Yanıtlama', onclick: () => send({ skip: true }) })));
  }
  const submit = () => send({ values: a.values });
  return el('div', { class: 'ask' }, el('p', {}, el('b', { text: 'Model bu bilgileri istiyor: ' }), p.soru),
    p.again && el('p', { class: 'xnote', text: 'Kayıtlı yanıt bu gezintide kullanıldı ama işe yaramamış görünüyor; doğrusunu yazın.' }),
    p.fields.map((f) => {
      const input = f.options?.length ? el('select', {}, el('option', { value: '', text: '(seçin)' }), f.options.map((o) => el('option', { value: o, text: o })))
        : el('input', { type: f.secret ? 'password' : 'text', spellcheck: 'false', autocomplete: 'off' });
      input.value = a.values[f.no] || '';
      input.oninput = () => { a.values[f.no] = input.value; };
      input.onchange = input.oninput;
      input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
      return el('label', { class: 'field' }, el('span', { text: `${f.name}${f.required ? ' (zorunlu)' : ''}${f.secret ? ' · kaydedilmez, modele gönderilmez' : ''}` }), input);
    }),
    el('p', { class: 'xnote', text: 'Değerleri tarayıcıya Fikirhane yazar; modele gönderilmez. Parola dışındakiler bu site için kaydedilir.' }),
    el('div', { class: 'actions' }, el('button', { class: 'btn primary', type: 'button', text: 'Doldur ve devam et', onclick: submit }),
      el('button', { class: 'btn', type: 'button', text: 'Tarayıcıda kendim yaptım', title: 'Açık tarayıcı penceresinde bu adımı (ör. girişi) kendiniz yapın, sonra buna basın', onclick: () => send({ manual: true }) }),
      el('button', { class: 'btn ghost', type: 'button', text: 'Bu bilgiyi verme', onclick: () => send({ skip: true }) })));
}
function explorePanel(t) {
  const x = t.explore;
  if (!x) return null;
  const p = x.running ? x.pending : null;
  const KIND = { 'uyarı': 'warn', 'akış': 'flow', ekran: 'flow' };
  const head = x.running ? (p ? 'Model sizden yanıt bekliyor' : `Model geziyor: ${x.done}/${x.limit} adım. Bu sırada tarayıcı penceresine dokunmayın.`) : x.state === 'hata' ? 'Model gezintisi durdu' : `Model gezintisi bitti (${x.done} adım)`;
  const s = x.saved || { fields: [], questions: [], decisions: [] };
  const savedN = s.fields.length + s.questions.length + s.decisions.length;
  return el('div', { class: 'card explore' },
    el('div', { class: 'working' }, x.running && !p && el('span', { class: 'spin' }), head),
    x.error && el('div', { class: 'result err', text: x.error }),
    !x.running && x.summary && el('div', { class: 'result', text: x.summary }),
    x.log.length > 0 && el('div', { class: 'explore-log' }, x.log.slice(-12).map((e) => el('div', { class: `xl ${KIND[e.kind] || ''}` }, e.n ? el('b', { text: `${e.n}.` }) : null, `${e.text}${e.result ? ` ${e.result}` : ''}`))),
    p && pendingForm(p),
    x.flows.length > 0 && el('p', { text: `Çıkarılan akışlar: ${x.flows.map((f) => `${f.name} (${f.steps} adım${f.ok ? '' : '; senaryoya çevrilemez'})`).join('; ')}. Gezintiyi bitirince senaryo olarak kaydedilir.` }),
    savedN > 0 && el('p', { class: 'xnote' }, `Bu site için kayıtlı: ${[s.fields.length && `${s.fields.length} alan (${s.fields.map((f) => f.name).join(', ')})`, s.questions.length && `${s.questions.length} soru`, s.decisions.length && `${s.decisions.length} düğme kararı`].filter(Boolean).join(', ')}. Model bunları yeniden sormaz. `,
      el('button', { class: 'link', type: 'button', text: 'Unut', title: 'Bu site için kayıtlı yanıtları ve kararları siler', onclick: () => tourAct('/api/tour/explore/forget') })));
}
async function loadTour() {
  const r = await api('/api/tour');
  tour.data = r.tour || null;
  tour.browser = r.browser !== false;
  $('#siteBtn').querySelector('span').textContent = tour.data ? `Gezinti sürüyor · ${tour.data.count} ekran` : 'Site gez';
  const typing = $('#tourBody').contains(document.activeElement) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
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
      el('p', { text: 'Alanlara yazdıklarınız, parolanız ve tablolardaki veriler kaydedilmez. Siz gezerken Fikirhane hiçbir düğmeye basmaz, hiçbir formu göndermez. Tarayıcı geçici bir profille açılır; gezinti bitince oturum bilgisi silinir.' }),
      el('label', { class: 'field' }, el('span', { text: 'Site adresi' }), url),
      !tour.browser && el('div', { class: 'result err', text: 'Bu bilgisayarda Microsoft Edge ya da Google Chrome bulunamadı.' }),
      note,
      el('div', { class: 'actions', style: 'margin-bottom:14px' }, el('button', { class: 'btn primary', type: 'button', text: 'Tarayıcıyı aç (ben gezeceğim)', disabled: !tour.browser, onclick: start })),
      el('div', { class: 'card' }, el('h3', { text: 'Model gezsin' }),
        el('p', { text: `Siteyi sizin yerinize ${state.config.settings.ready ? `${state.config.settings.chatModel} modeli` : 'dil modeli'} gezer. ${EXPLORE_INFO}` }),
        exploreForm(),
        el('div', { class: 'actions' }, el('button', { class: 'btn primary', type: 'button', text: 'Model gezsin', disabled: !tour.browser || !state.config.settings.ready,
          title: state.config.settings.ready ? 'Tarayıcı açılır ve model gezmeye başlar' : 'Önce Ayarlar\'dan bir dil modeli tanımlayın',
          onclick: async () => { tour.note = { kind: '', text: 'Tarayıcı açılıyor…' }; renderTour(); await tourAct('/api/tour', { url: tour.url, explore: exploreBody() }); } }))));
    return;
  }
  const x = t.explore;
  const exploring = Boolean(x?.running);
  const open = t.state === 'açık';
  const crawling = t.crawl?.running;
  const limit = el('input', { type: 'number', class: 'short', min: '1', max: '200', title: 'En fazla kaç yeni ekran' });
  limit.value = tour.limit;
  limit.oninput = () => { tour.limit = Number(limit.value) || 30; };
  const old = t.existing?.[0];
  const finish = async (update) => {
    const r = await tourAct('/api/tour/finish', update ? { update } : {});
    if (!r.ok) return;
    $('#tourDialog').close();
    await loadDocs();
    await openDoc(r.meta.id);
    if (r.text) { state.tab = 'ekranlar'; state.info = r.text; render(); }
  };
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
    open && !exploring && el('p', { text: 'Açılan tarayıcı penceresinde gezin; her yeni ekran kendiliğinden kaydedilir. Adres değişmeden açılan bir pencere ya da sekme listeye gelmediyse "Bu ekranı kaydet"e basın.' }),
    explorePanel(t),
    open && !exploring && !crawling && tour.formOpen && el('div', { class: 'card' }, el('h3', { text: 'Modele gezdir' }),
      el('p', { text: `Model, tarayıcının o an bulunduğu ekrandan devam eder (girişi kendiniz yaptıysanız yeniden sormaz). ${EXPLORE_INFO}` }),
      exploreForm(),
      el('div', { class: 'actions' }, el('button', { class: 'btn primary', type: 'button', text: 'Başlat', disabled: !state.config.settings.ready, title: state.config.settings.ready ? null : 'Önce Ayarlar\'dan bir dil modeli tanımlayın',
        onclick: async () => { const r = await tourAct('/api/tour/explore', exploreBody()); if (r.ok) { tour.formOpen = false; renderTour(); } } }),
      el('button', { class: 'btn ghost', type: 'button', text: 'Vazgeç', onclick: () => { tour.formOpen = false; renderTour(); } }))),
    t.crawl && el('div', { class: 'working' }, crawling && el('span', { class: 'spin' }),
      `Otomatik gezinti${crawling ? '' : ' bitti'}: ${t.crawl.done} adres gezildi, ${t.crawl.added} yeni ekran${crawling ? `, ${t.crawl.queued} sırada` : ''}${t.crawl.skipped ? `. ${t.crawl.skipped} bağlantı güvenlik için atlandı (çıkış, silme, indirme).` : '.'}`),
    el('div', { class: 'screen-list' }, t.cards.length
      ? [...t.cards].reverse().map((c) => el('div', { class: 'screen', title: c.via ? `Geliş: ${c.via}` : null }, el('b', { text: `${c.no}.` }), el('span', { class: 's-title', text: c.title }), el('span', { class: 's-path', text: c.path })))
      : el('div', { class: 'list-empty', text: 'Henüz ekran yok. Sayfa yüklenince ilk ekran buraya gelir.' })),
    note,
    el('div', { class: 'actions' },
      exploring && el('button', { class: 'btn', type: 'button', text: 'Modeli durdur', onclick: () => tourAct('/api/tour/explore/stop') }),
      open && !crawling && !exploring && !tour.formOpen && el('button', { class: 'btn', type: 'button', text: 'Modele gezdir', title: 'Buradan sonrasını dil modeli gezsin: ekranları dolaşır, akışları çıkarır, bilmediğini size sorar', onclick: () => { tour.formOpen = true; renderTour(); } }),
      open && !crawling && !exploring && el('button', { class: 'btn', type: 'button', text: 'Bu ekranı kaydet', onclick: async () => { const r = await tourAct('/api/tour/capture'); if (r.ok && !r.added) { tour.note = { kind: '', text: r.no ? `Bu ekran zaten kayıtlı (Ekran ${r.no}).` : 'Bu sayfa kaydedilmedi (başka bir sitede ya da boş).' }; renderTour(); } } }),
      open && !crawling && !exploring && [el('button', { class: 'btn', type: 'button', text: 'Bağlantıları otomatik gez', title: 'Kaydedilen ekranlardaki bağlantıların adresine gider; düğmelere basmaz. Çıkış, silme ve indirme bağlantıları atlanır. Bu sırada tarayıcı penceresine dokunmayın.', onclick: () => tourAct('/api/tour/crawl', { limit: tour.limit }) }), limit],
      crawling && el('button', { class: 'btn', type: 'button', text: 'Durdur', onclick: () => tourAct('/api/tour/stop') }),
      el('span', { class: 'spacer' }),
      cancel,
      // Bu site daha önce gezildiyse var olan kayıt güncellenir: ekran numaraları, notlar ve senaryolar korunur
      old && el('button', { class: 'btn', type: 'button', text: 'Yeni belge olarak kaydet', disabled: !t.count, title: 'Var olan kayda dokunmadan ayrı bir belge oluşturur', onclick: () => finish() }),
      el('button', { class: 'btn primary', type: 'button', text: old ? 'Var olanı güncelle' : 'Bitir ve kaydet', disabled: !t.count,
        title: old ? `"${old.name}" kaydını günceller: ekran numaraları, notlarınız ve senaryolar korunur; bu gezintide görülmeyen ekranlar silinmez, işaretlenir` : null, onclick: () => finish(old?.id) })));
}
function openTour(url) { tour.note = null; if (typeof url === 'string' && !tour.data) tour.url = url; $('#app').classList.remove('menu-open'); renderTour(); $('#tourDialog').showModal(); loadTour(); }
$('#siteBtn').onclick = openTour;
$('#tourClose').onclick = () => $('#tourDialog').close();

// ---------- Ayarlar (yerel model) ----------
function renderSettings(note) {
  const s = state.config.settings;
  const field = (label, input, hint) => el('label', { class: 'field' }, el('span', { text: label }), input, hint && el('small', { text: hint }));
  const inp = (value, attrs = {}) => { const i = el('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', ...attrs }); i.value = value || ''; return i; };
  // Model kaynağı: elle girilen sunucu ya da Atölye'de tanımlı bir model (src = Atölye model kimliği, elle ise boş)
  const atolye = [...(state.config.atolye || [])];
  if (s.source && s.missing && !atolye.some((m) => m.id === s.atolye)) atolye.push({ id: s.atolye, name: '(bulunamayan model)', model: '', url: '', kind: '', gone: true });
  const src = state.draft?.source ?? (s.source ? s.atolye : '');
  const picked = atolye.find((m) => m.id === src);
  const own = s.source ? s.manual : s; // elle girilmiş sunucu (Atölye modeli seçiliyken de saklı durur)
  const url = inp(state.draft?.url ?? own.url, { placeholder: 'http://localhost:11434' });
  const chat = inp(state.draft?.chatModel ?? own.chatModel, { list: 'modelList', placeholder: 'qwen3:8b' });
  const embed = inp(state.draft?.embedModel ?? s.embedModel, { list: 'modelList', placeholder: 'bge-m3 (isteğe bağlı)' });
  const key = inp('', { type: 'password', placeholder: own.hasKey ? 'Kayıtlı (değiştirmek için yenisini yazın)' : 'Çoğu yerel sunucuda gerekmez' });
  const keep = () => { state.draft = { url: url.value, chatModel: chat.value, embedModel: embed.value, source: src }; };
  const body = () => (src ? { source: 'atolye', atolye: src, embedModel: embed.value } : { url: url.value, chatModel: chat.value, embedModel: embed.value, key: key.value });
  const source = el('select', {}, el('option', { value: '', text: 'Elle girilen sunucu' }), atolye.map((m) => el('option', { value: m.id, text: `Atölye: ${m.name}${m.model && m.model !== m.name ? ` (${m.model})` : ''}` })));
  source.value = src;
  source.onchange = () => { keep(); state.draft.source = source.value; renderSettings(); };
  // Dışa / içe aktarma (dosya biçimi Atölye ile ortak; API anahtarı şifreleme anahtarıyla korunur)
  const io = state.io;
  const close = el('button', { class: 'btn ghost', type: 'button', text: 'Vazgeç', onclick: () => { keep(); state.io = null; renderSettings(); } });
  const doImport = async (extra = {}) => {
    const r = await api('/api/settings/import', { data: state.io.data, pass: state.io.pass || '', ...extra });
    if (r.ok && r.choose) { state.io = { ...state.io, choose: r.choose }; return renderSettings(); }
    if (r.ok) {
      state.config.settings = r.settings; state.draft = null; state.io = null; renderChip(); render();
      return renderSettings({ kind: 'ok', text: `İçe aktarıldı: ${r.model}. "Bağlantıyı dene" ile doğrulayın.${r.anthropic ? ' Bu kayıt Anthropic uyumlu olarak tanımlı; sohbet için o biçim kullanılır.' : ''}` });
    }
    if (r.code === 'need-pass') { state.io = { ...state.io, ask: true }; return renderSettings(); }
    if (r.code !== 'bad-pass') state.io = null;
    renderSettings({ kind: 'err', text: r.error });
  };
  const doExport = async () => {
    const r = await api('/api/settings/export', { pass: state.io.pass });
    if (r.ok) { downloadJson('fikirhane-yerel-llm.json', r.file); state.io = null; }
    renderSettings(r.ok ? { kind: 'ok', text: 'Dışa aktarıldı: fikirhane-yerel-llm.json' } : { kind: 'err', text: r.error });
  };
  const picker = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
  picker.onchange = async () => { const f = picker.files[0]; if (!f) return; keep(); state.io = { mode: 'import', data: await f.text(), pass: '' }; doImport(); };
  const pass = inp(io?.pass, io?.mode === 'import' ? { type: 'password', placeholder: 'Dosyanın şifreleme anahtarı' } : {});
  pass.oninput = () => { state.io.pass = pass.value; };
  pass.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); if (io.mode === 'export') doExport(); else doImport(); } };
  const ioPanel = !io ? null
    : io.mode === 'export' ? el('div', { class: 'card' },
      field('Şifreleme anahtarı', pass, 'API anahtarı dosyaya açık yazılmaz; bu anahtarla şifrelenir ve içe aktarırken aynı anahtar sorulur. Değiştirmezseniz anahtar "fikirhane" olur. Dosya Atölye\'de de içe aktarılabilir.'),
      el('div', { class: 'actions' }, el('button', { class: 'btn primary', type: 'button', text: 'Dosyayı indir', onclick: doExport }), close))
      : io.choose ? el('div', { class: 'card' },
        el('p', { text: 'Dosyada birden çok model var. Fikirhane tek bir model kullanır; almak istediğinize tıklayın.' }),
        io.choose.map((m) => el('button', { type: 'button', class: 'source', onclick: () => doImport({ pick: m.i }) }, el('b', { text: m.name }), `${m.model} · ${m.url}${m.kind === 'anthropic' ? ' · Anthropic uyumlu' : ''}`)),
        el('div', { class: 'actions', style: 'margin-top:10px' }, close))
        : io.ask ? el('div', { class: 'card' },
          field('Şifreleme anahtarı', pass, 'Dosya dışa aktarılırken kullanılan anahtarı yazın. Atölye\'de değiştirmediyseniz anahtar "atolye", Fikirhane\'de "fikirhane" olur.'),
          el('div', { class: 'actions' }, el('button', { class: 'btn primary', type: 'button', text: 'İçe aktar', onclick: () => doImport() }), close))
          : null;
  fill($('#settingsBody'),
    el('p', { text: 'Fikirhane bu bilgisayarda ya da ağınızda çalışan bir dil modeli sunucusunu kullanır (Ollama, LM Studio, llama.cpp, kurum içi bir gateway vb.). Belgeleriniz yalnızca yazdığınız adrese gider.' }),
    atolye.length > 0 && field('Model kaynağı', source, 'Atölye\'de tanımlı bir yerel modeli seçerseniz adres, model ve API anahtarı her kullanımda Atölye\'nin kaydından okunur; Atölye\'de değiştirdiğinizde burada da değişir.'),
    src && el('div', { class: `result${picked?.gone ? ' err' : ''}`, text: picked?.gone || !picked ? 'Bu model Atölye\'de artık yok. Başka bir model seçin ya da sunucuyu elle girin.'
      : `Sunucu: ${picked.url} · Model: ${picked.model} · ${picked.kind === 'anthropic' ? 'Anthropic uyumlu' : 'OpenAI uyumlu'} · API anahtarı: ${picked.hasKey ? 'Atölye\'de kayıtlı' : 'yok'}` }),
    !src && field('Sunucu adresi', url, 'Ollama: http://localhost:11434 · LM Studio: http://localhost:1234 · Kurum içi gateway: size verilen adres (ör. https://llm.sirket.com/v1; tam uç nokta, …/chat/completions, yazıldıysa olduğu gibi kullanılır)'),
    !src && field('Sohbet modeli', chat, 'Belgeyi okuyan ve soruları yanıtlayan model. "Bağlantıyı dene" sunucudaki modelleri listeye getirir.'),
    field('Embedding modeli (isteğe bağlı)', embed, src ? 'Anlamsal arama için; aynı sunucuda olmalıdır (ör. bge-m3). Boş bırakırsanız yalnızca kelime araması yapılır.' : 'Anlamsal arama için (ör. bge-m3, nomic-embed-text). Boş bırakırsanız yalnızca kelime araması yapılır.'),
    !src && field('API anahtarı (isteğe bağlı)', key),
    el('datalist', { id: 'modelList' }, (state.models || []).map((m) => el('option', { value: m }))),
    note && el('div', { class: `result ${note.kind}`, text: note.text }),
    // Dışa/içe aktarma bölümü açıkken asıl düğmeler gösterilmez: "Kaydet" o sırada içe aktarmaz, üstteki (boş olabilen)
    // formu kaydetmeye çalışır ve dosyayla ilgisi olmayan bir adres hatası verirdi
    !io && el('div', { class: 'actions' },
      el('button', { class: 'btn', type: 'button', text: 'Bağlantıyı dene', onclick: async () => {
        keep(); renderSettings({ kind: '', text: 'Deneniyor… Model ilk kez yükleniyorsa bir dakika kadar sürebilir.' });
        const r = await api('/api/settings/test', body());
        if (r.models) state.models = r.models;
        renderSettings(r.ok ? { kind: 'ok', text: `Sunucuya ulaşıldı${r.models.length ? `, ${r.models.length} model var` : ''}.${r.chat ? ' Sohbet modeli yanıt verdi.' : ''}${r.embed ? ` Embedding modeli çalışıyor (${r.embed} boyut).` : ''}` } : { kind: 'err', text: r.error });
      } }),
      el('button', { class: 'btn primary', type: 'button', text: 'Kaydet', onclick: async () => {
        keep();
        const r = await api('/api/settings', body());
        if (r.ok) { state.config.settings = r.settings; state.draft = null; renderChip(); render(); }
        renderSettings(r.ok ? { kind: 'ok', text: 'Kaydedildi.' } : { kind: 'err', text: r.error });
      } }),
      el('span', { class: 'spacer' }),
      s.ready && !s.source && !src && el('button', { class: 'btn', type: 'button', text: 'Dışa aktar', title: 'Yerel model ayarını dosyaya yazar (API anahtarı şifreli)', onclick: () => { keep(); state.io = { mode: 'export', pass: 'fikirhane' }; renderSettings(); } }),
      el('button', { class: 'btn', type: 'button', text: 'İçe aktar', title: 'Fikirhane\'den ya da Atölye\'den dışa aktarılmış yerel model dosyasını alır', onclick: () => picker.click() }),
      picker),
    ioPanel && el('div', { style: 'margin-top:12px' }, ioPanel));
  // Bölüm pencerenin altında açılır: küçük pencerede de görünsün
  if (ioPanel) { ioPanel.scrollIntoView({ block: 'nearest' }); if (!io.choose) { pass.focus(); pass.select(); } }
}
function download(name, text, type) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const downloadJson = (name, data) => download(name, `${JSON.stringify(data, null, 2)}\n`, 'application/json');
function renderChip() {
  const s = state.config.settings;
  $('#llmChip').replaceChildren(el('span', { class: `dot ${s.ready ? 'ok' : 'warn'}` }),
    el('span', { text: s.ready ? `Yerel model: ${s.chatModel}${s.source ? ' (Atölye)' : ''}` : s.missing ? 'Atölye modeli bulunamadı (ayarla)' : 'Yerel model tanımlı değil (ayarla)' }));
}
const openSettings = async () => {
  state.draft = null; state.io = null; renderSettings(); $('#settingsDialog').showModal();
  // Atölye'deki model listesi bu arada değişmiş olabilir: yeniden okunur
  const c = await api('/api/config');
  if (!c.settings) return;
  state.config = c; renderChip();
  if ($('#settingsDialog').open && !state.draft && !state.io && !$('#settingsBody').contains(document.activeElement)) renderSettings();
};
$('#settingsBtn').onclick = openSettings;
// Model etiketi: Atölye'de tanımlı modeller varsa Ayarlar'a girmeden aralarında geçilir; yoksa doğrudan Ayarlar açılır
function closeModelMenu() { $('#modelMenu')?.remove(); document.removeEventListener('click', closeModelMenu); }
async function openModelMenu(e) {
  e?.stopPropagation();
  if ($('#modelMenu')) return closeModelMenu();
  const c = await api('/api/config'); // Atölye'deki liste bu arada değişmiş olabilir
  if (c.settings) { state.config = c; renderChip(); }
  const s = state.config.settings;
  const list = state.config.atolye || [];
  const own = s.source ? s.manual : s; // elle girilmiş sunucu
  if (!list.length) return openSettings();
  const choose = async (body) => {
    closeModelMenu();
    const r = await api('/api/settings', { ...body, embedModel: s.embedModel });
    if (r.ok) { state.config.settings = r.settings; renderChip(); render(); } else alert(r.error);
  };
  const item = (label, sub, on, pick) => el('button', { type: 'button', class: `mm-item${on ? ' on' : ''}`, onclick: on ? closeModelMenu : pick }, el('span', { class: 'mm-name', text: label }), sub && el('span', { class: 'mm-sub', text: sub }));
  const menu = el('div', { id: 'modelMenu', class: 'model-menu', role: 'menu' },
    el('div', { class: 'mm-title', text: 'Kullanılacak model' }),
    list.map((m) => item(m.name, m.model !== m.name ? m.model : 'Atölye', s.source === 'atolye' && s.atolye === m.id, () => choose({ source: 'atolye', atolye: m.id }))),
    own?.url && own?.chatModel && item(own.chatModel, 'elle girilen sunucu', !s.source, () => choose({ url: own.url, chatModel: own.chatModel })),
    el('button', { type: 'button', class: 'mm-item mm-more', text: 'Ayarlar…', onclick: () => { closeModelMenu(); openSettings(); } }));
  menu.onclick = (ev) => ev.stopPropagation();
  $('#llmChip').after(menu);
  setTimeout(() => document.addEventListener('click', closeModelMenu), 0);
}
$('#llmChip').onclick = openModelMenu;
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
async function checkUpdate(manual) {
  const u = await api(manual ? '/api/update?refresh=1' : '/api/update');
  $('#updateBtn').hidden = !u?.available;
  if (u?.available) { $('#updateBtn').textContent = `Güncelleme var: ${u.latest}`; $('#updateBtn').onclick = async () => { $('#updateBtn').textContent = 'Güncelleniyor…'; await api('/api/update/apply', {}); setTimeout(() => location.reload(), 20000); }; }
  return u;
}
// Sürüm yazısına tıklamak depoyu hemen yeniden sorar (zamanlı denetimi beklemeden) ve sonucu kısa süre gösterir
const versionLabel = () => `Fikirhane ${state.config.version || ''}`;
$('#versionText').onclick = async () => {
  const v = $('#versionText');
  if (v.disabled) return;
  v.disabled = true;
  v.textContent = `${versionLabel()} · denetleniyor…`;
  const u = await checkUpdate(true);
  v.textContent = `${versionLabel()} · ${u?.available ? `yeni sürüm: ${u.latest}` : u?.failed || !u?.latest ? 'depo okunamadı (ağ bağlantısını kontrol edin)' : 'güncel'}`;
  setTimeout(() => { v.textContent = versionLabel(); v.disabled = false; }, 6000);
};

// ---------- Başlangıç ----------
state.config = await api('/api/config');
$('#versionText').textContent = versionLabel();
renderChip();
await loadDocs();
state.view = 'chat';
render();
checkUpdate();
loadTour();
setInterval(checkUpdate, 30 * 60 * 1000);
