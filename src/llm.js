// Yerel dil modeli sunucusu (Ollama, LM Studio, llama.cpp, kurum içi gateway vb.) ile konuşma. OpenAI uyumlu uç noktalar
// kullanılır: …/models, …/chat/completions, …/embeddings. Belgeler yalnızca ayarlarda yazan adrese gider.

/** Kayıtlı adres: sondaki eğik çizgi, /chat/completions ve /v1 atılır (başka bir sürüm yolu, ör. /v2, kalır) */
export const base = (url) => String(url || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '').replace(/\/+$/, '').replace(/\/v1$/i, '');
/** API kökü: adres bir sürüm yoluyla (/v2 gibi) bitiyorsa o, değilse /v1 eklenir */
const api = (url) => { const u = base(url); return /\/v\d+$/i.test(u) ? u : `${u}/v1`; };
// Kurum içi gateway'ler anahtarı farklı başlıklarda bekleyebilir; üçü birden gönderilir
const headers = (key) => ({ 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...(key ? { authorization: `Bearer ${key}`, 'api-key': key, 'x-api-key': key } : {}) });
const fail = (code, detail, status) => Object.assign(new Error(detail || code), { code, detail, status });

export function validUrl(url) {
  try { const u = new URL(base(url)); return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username; } catch { return false; }
}

async function request(url, { method = 'GET', key, body, timeoutMs = 30_000, signal } = {}) {
  let res;
  try {
    res = await fetch(url, { method, headers: headers(key), body: body ? JSON.stringify(body) : undefined, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (signal?.aborted) throw fail('cancelled');
    throw fail('unreachable', err.cause?.code || err.message);
  }
  const text = await res.text();
  if (!res.ok) throw fail(res.status === 404 ? 'not-found' : 'bad-response', `HTTP ${res.status} ${text.slice(0, 200)}`, res.status);
  try { return JSON.parse(text); } catch { throw fail('bad-response', text.slice(0, 200)); }
}

/** Sunucudaki modeller (OpenAI uyumlu liste; yoksa Ollama'nın kendi listesi) */
export async function listModels({ url, key }) {
  try {
    const d = await request(`${api(url)}/models`, { key, timeoutMs: 8000 });
    const ids = (Array.isArray(d?.data) ? d.data : []).map((m) => m?.id).filter(Boolean);
    if (ids.length) return ids;
  } catch (err) { if (err.code === 'unreachable') throw err; }
  const d = await request(`${base(url).replace(/\/v\d+$/i, '')}/api/tags`, { key, timeoutMs: 8000 });
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
  let text;
  if (kind === 'anthropic') {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const body = { model, max_tokens: maxTokens, messages: messages.filter((m) => m.role !== 'system'), ...(system ? { system } : {}) };
    const d = await retry(() => send(`${api(url)}/messages`, { ...body, temperature }), () => send(`${api(url)}/messages`, body));
    text = Array.isArray(d?.content) ? d.content.filter((p) => p?.type === 'text').map((p) => p.text).join('') : null;
    if (typeof text !== 'string' || (!text && !Array.isArray(d?.content))) throw fail('bad-response', JSON.stringify(d).slice(0, 200));
  } else {
    const body = { model, messages, stream: false };
    const d = await retry(() => send(`${api(url)}/chat/completions`, { ...body, temperature, max_tokens: maxTokens }), () => send(`${api(url)}/chat/completions`, body));
    text = d?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw fail('bad-response', JSON.stringify(d).slice(0, 200));
  }
  // Düşünen modellerin <think> bölümü yanıta alınmaz
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/** Metinlerin embedding vektörleri (her biri Float32Array) */
export async function embed({ url, key, model, input, timeoutMs = 300_000, signal }) {
  const d = await request(`${api(url)}/embeddings`, { method: 'POST', key, timeoutMs, signal, body: { model, input } });
  const rows = (Array.isArray(d?.data) ? d.data : []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((r) => Float32Array.from(r.embedding || []));
  if (rows.length !== input.length || !rows[0]?.length) throw fail('bad-response', 'embedding yanıtı eksik');
  return rows;
}
