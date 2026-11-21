// Dil modeli sunucusu (bu bilgisayardaki Ollama, LM Studio, llama.cpp ya da ağdaki bir kurum gateway'i) ile konuşma.
// OpenAI uyumlu uç noktalar kullanılır: …/models, …/chat/completions, …/embeddings. Belgeler yalnızca ayarlarda yazan
// adrese gider.
//
// Adres kuralı Atölye'ninkiyle aynıdır (Atölye: src/kopru.js, openaiEndpoint): aynı kayıt iki uygulamada aynı adrese
// gider, dışa aktarılan dosya iki yönde de aynı sunucuyu gösterir. Biri değişirse öteki de değişmelidir.

/** Kayıtlı adres: yazıldığı gibi kalır; yalnızca baştaki/sondaki boşluk ve sondaki eğik çizgiler atılır */
export const base = (url) => String(url || '').trim().replace(/\/+$/, '');
/**
 * OpenAI uyumlu sohbet uç noktası: tam adres yazıldıysa (…/chat/completions) olduğu gibi kullanılır; adres bir sürüm
 * yoluyla (/v1, /v2) bitiyorsa ona, değilse /v1'e eklenir.
 */
export const chatUrl = (url) => { const u = base(url); return /\/chat\/completions$/i.test(u) ? u : /\/v\d+$/i.test(u) ? `${u}/chat/completions` : `${u}/v1/chat/completions`; };
/** Sohbet uç noktasının yanındaki uç nokta (models, embeddings) */
const beside = (url, name) => chatUrl(url).replace(/\/chat\/completions$/i, `/${name}`);
/** Anthropic uyumlu uç nokta: Claude Code'un yaptığı gibi adrese /v1/messages eklenir (sondaki /v1 yinelenmez) */
const messagesUrl = (url) => `${base(url).replace(/\/v1$/i, '')}/v1/messages`;
/** Sunucunun kökü (Ollama'nın kendi model listesi için) */
const root = (url) => base(url).replace(/\/chat\/completions$/i, '').replace(/\/v\d+$/i, '');
/** İki adres aynı sunucuyu mu gösteriyor (http://x, http://x/v1 ve http://x/v1/chat/completions aynıdır) */
export const sameServer = (a, b) => Boolean(base(a) && base(b)) && chatUrl(a).toLowerCase() === chatUrl(b).toLowerCase();
// Kurum içi gateway'ler anahtarı farklı başlıklarda bekleyebilir; üçü birden gönderilir
const headers = (key) => ({ 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...(key ? { authorization: `Bearer ${key}`, 'api-key': key, 'x-api-key': key } : {}) });
const fail = (code, detail, status) => Object.assign(new Error(detail || code), { code, detail, status });

export function validUrl(url) {
  try { const u = new URL(base(url)); return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username; } catch { return false; }
}

// Ulaşılamayan sunucu: hangi sunucu ve neden. Kurum ağındaki bir adres o ağın dışından denenince çoğunlukla yanıt
// gelmez (zaman aşımı); bu, bu bilgisayarda çalışmayan bir sunucudan (bağlantı reddedildi) ayırt edilebilsin.
const REASONS = { ECONNREFUSED: 'bağlantı reddedildi; sunucu çalışmıyor olabilir', ENOTFOUND: 'bu adda bir sunucu bulunamadı', EAI_AGAIN: 'sunucu adı çözülemedi',
  ECONNRESET: 'bağlantı kesildi', ETIMEDOUT: 'bağlantı kurulamadı (zaman aşımı)', UND_ERR_CONNECT_TIMEOUT: 'bağlantı kurulamadı (zaman aşımı)', EHOSTUNREACH: 'sunucuya giden yol yok', ENETUNREACH: 'ağa ulaşılamıyor' };
function unreachable(url, err, timeoutMs) {
  let host = ''; try { host = new URL(url).host; } catch { /* yoksay */ }
  const code = String(err.cause?.code || err.code || '');
  const timedOut = err.name === 'TimeoutError' || err.cause?.name === 'TimeoutError';
  const why = timedOut ? `${Math.round(timeoutMs / 1000)} saniyede yanıt gelmedi` : REASONS[code] ? `${REASONS[code]}` : /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code) ? `sunucunun sertifikası doğrulanamadı (${code})` : (code || err.cause?.message || err.message);
  return fail('unreachable', `${host}: ${why}`);
}

async function request(url, { method = 'GET', key, body, timeoutMs = 30_000, signal } = {}) {
  let res;
  try {
    res = await fetch(url, { method, headers: headers(key), body: body ? JSON.stringify(body) : undefined, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (signal?.aborted) throw fail('cancelled');
    throw unreachable(url, err, timeoutMs);
  }
  const text = await res.text();
  if (!res.ok) throw fail(res.status === 404 ? 'not-found' : 'bad-response', `HTTP ${res.status} ${text.slice(0, 200)}`, res.status);
  try { return JSON.parse(text); } catch { throw fail('bad-response', text.slice(0, 200)); }
}

/** Sunucudaki modeller (OpenAI uyumlu liste; yoksa Ollama'nın kendi listesi) */
export async function listModels({ url, key }) {
  try {
    const d = await request(beside(url, 'models'), { key, timeoutMs: 8000 });
    const ids = (Array.isArray(d?.data) ? d.data : []).map((m) => m?.id).filter(Boolean);
    if (ids.length) return ids;
  } catch (err) { if (err.code === 'unreachable') throw err; }
  const d = await request(`${root(url)}/api/tags`, { key, timeoutMs: 8000 });
  return (Array.isArray(d?.models) ? d.models : []).map((m) => m?.name).filter(Boolean);
}

/**
 * Modele mesajları gönderir, yanıt metnini döndürür. kind: "openai" (…/chat/completions; varsayılan) ya da
 * "anthropic" (…/v1/messages; Atölye'de Anthropic uyumlu olarak kayıtlı sunucular için).
 */
export async function chat({ url, key, kind, model, messages, temperature = 0.2, maxTokens = 1200, timeoutMs = 600_000, signal }) {
  const send = (endpoint, body) => request(endpoint, { method: 'POST', key, timeoutMs, signal, body });
  // Bazı sunucular ve modeller temperature (ya da max_tokens) alanını reddeder: istek bu alan olmadan yinelenir
  const retry = async (first, second) => { try { return await first(); } catch (err) { if (err.status !== 400 && err.status !== 422) throw err; return second(); } };
  // Bir kez sorar: { text (görünen yanıt), cut (uzunluk sınırında kesildi), thought (model düşünme çıktısı üretti) }
  const once = async (limit) => {
    if (kind === 'anthropic') {
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const body = { model, max_tokens: limit, messages: messages.filter((m) => m.role !== 'system'), ...(system ? { system } : {}) };
      const d = await retry(() => send(messagesUrl(url), { ...body, temperature }), () => send(messagesUrl(url), body));
      if (!Array.isArray(d?.content)) throw fail('bad-response', JSON.stringify(d).slice(0, 200));
      return visible(d.content.filter((p) => p?.type === 'text').map((p) => p.text).join(''), d.stop_reason === 'max_tokens', d.content.some((p) => /thinking/.test(p?.type || '')));
    }
    const body = { model, messages, stream: false };
    const d = await retry(() => send(chatUrl(url), { ...body, temperature, max_tokens: limit }), () => send(chatUrl(url), body));
    const choice = d?.choices?.[0];
    const msg = choice?.message;
    if (!msg || typeof msg !== 'object') throw fail('bad-response', JSON.stringify(d).slice(0, 200));
    // Düşünen modellerde (qwen, deepseek, glm…) düşünme ayrı alanda gelir; ayrılan uzunluk düşünmeye yetmediyse content null olur
    const content = Array.isArray(msg.content) ? msg.content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('') : typeof msg.content === 'string' ? msg.content : '';
    return visible(content, choice.finish_reason === 'length', Boolean(msg.reasoning_content || msg.reasoning || d?.usage?.completion_tokens_details?.reasoning_tokens));
  };
  const id = `${chatUrl(url)}|${model}`;
  let r = await once(thinkers.has(id) ? maxTokens + THINK_ROOM : maxTokens);
  // Uzunluk sınırı düşünmeye de sayılır: düşünen model sınıra takıldıysa (yanıt boş ya da yarım) düşünme payı eklenip bir
  // kez yeniden sorulur ve model anımsanır; sonraki sorular baştan o payla gider (her soru iki kez sorulmaz).
  if (r.cut && (r.thought || !r.text) && !thinkers.has(id)) {
    thinkers.add(id);
    r = await once(maxTokens + THINK_ROOM);
  }
  if (!r.text) throw fail('empty-answer', r.cut ? 'yanıt uzunluğu düşünmeye yetmedi' : '');
  return r.text;
}
// Düşünme payı (token) ve düşündüğü görülen modeller (sunucu + model). Fikirhane yeniden başlayınca liste sıfırlanır.
const THINK_ROOM = 4096;
const thinkers = new Set();
/** Görünen yanıt: <think> bölümü (kesildiği için kapanmamış olsa da) yanıta alınmaz */
function visible(content, cut, thought) {
  const text = String(content || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
  return { text, cut: Boolean(cut), thought: Boolean(thought) || /<think>/.test(String(content || '')) };
}

/** Metinlerin embedding vektörleri (her biri Float32Array) */
export async function embed({ url, key, model, input, timeoutMs = 300_000, signal }) {
  const d = await request(beside(url, 'embeddings'), { method: 'POST', key, timeoutMs, signal, body: { model, input } });
  const rows = (Array.isArray(d?.data) ? d.data : []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((r) => Float32Array.from(r.embedding || []));
  if (rows.length !== input.length || !rows[0]?.length) throw fail('bad-response', 'embedding yanıtı eksik');
  return rows;
}
