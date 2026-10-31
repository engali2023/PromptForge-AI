const PROVIDERS = {
  pollinations: { url: "https://gen.pollinations.ai/v1/chat/completions", kind: "openai" },
  openrouter: { url: "https://openrouter.ai/api/v1/chat/completions", kind: "openai" },
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", kind: "openai" },
  cohere: { url: "https://api.cohere.com/v2/chat", kind: "cohere" }
};
let catalogCache = { at: 0, data: null };

function systemPrompt() {
  return `You are PromptForge AI, an autonomous Agentic Prompt Engineer. Follow this pipeline: intent analysis, visual decomposition, style selection, composition planning, technical parameters, draft prompt, self-evaluation, self-correction, final polish. Final image/video prompt MUST be in English; explanations in requested language. For video prompts include camera movement, lighting, mood and pacing. Do not invent unsupported model parameters. Return ONLY valid JSON:
{"analysis":"Arabic explanation of intent, visual decomposition, style and composition","draft_prompt":"initial English prompt","final_prompt":"corrected polished English prompt ready to paste","scores":{"Clarity":1,"Completeness":1,"Tool Compatibility":1,"Specificity":1,"Creativity":1},"evaluation_text":"Arabic self-evaluation, rationale, weaknesses and corrections","average_score":8.0,"parameters":"Arabic technical settings, aspect ratio, model-specific parameters, negative prompt if supported, usage tips"}
Use integer scores 1-10; scores must honestly reflect the output. Keep target syntax compatible with the selected tool. Respect requested style, aspect ratio, notes and language.`;
}
function userPrompt(p) {
  return `User idea: ${p.idea}\nExtra notes: ${p.notes || "None"}\nTarget tool: ${p.target}\nVisual style: ${p.style}\nAspect ratio: ${p.ratio}\nDepth: ${p.depth}\nExplanation language: ${p.language}\n${p.refine ? "Perform an additional refinement pass; strengthen specificity and tool compatibility." : ""}\nExecute the complete agent pipeline.`;
}
function priceValues(model) {
  const values = [];
  const add = v => { if (v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v))) values.push(Number(v)); };
  const p = model?.pricing || model?.price || {};
  for (const k of ["prompt", "completion", "input", "output", "request", "image", "audio", "video", "per_token", "input_price", "output_price"]) add(p[k]);
  for (const k of ["prompt_price", "completion_price", "input_price", "output_price", "price_per_token"]) add(model?.[k]);
  return values;
}
function isVerifiedFree(model, provider) {
  if (!model || typeof model !== "object") return false;
  if (model.free === true || model.is_free === true || model.pricing?.free === true) return true;
  const prices = priceValues(model);
  if (!prices.length || prices.some(v => v !== 0)) return false;
  if (provider === "openrouter") return String(model.id || "").endsWith(":free");
  return true;
}
async function getFreeCatalog(apiKeys = {}, options = {}) {
  const useCache = !options.force && !apiKeys.groq?.trim() && !apiKeys.cohere?.trim();
  if (useCache && catalogCache.data && Date.now() - catalogCache.at < 60_000) return catalogCache.data;
  const result = {
    pollinations: [],
    openrouter: [{ id: "openrouter/free", name: "OpenRouter Free Router (توجيه مجاني تلقائي)", verifiedFree: true }],
    groq: [],
    cohere: [],
    notes: {
      groq: "تظهر النماذج عند إدخال مفتاح Groq؛ لا يستخدمها التوجيه التلقائي إلا بعد تأكيد أن الحساب ضمن الخطة/الحصة المجانية.",
      cohere: "تظهر النماذج عند إدخال مفتاح Cohere؛ لا يستخدمها التوجيه التلقائي إلا بعد تأكيد أن المفتاح ضمن Trial/الحصة المجانية."
    }
  };
  const settled = await Promise.allSettled([
    fetch("https://gen.pollinations.ai/models?category=text", { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(9000) }),
    fetch("https://openrouter.ai/api/v1/models", { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(9000) })
  ]);
  if (settled[0].status === "fulfilled" && settled[0].value.ok) {
    const body = await settled[0].value.json();
    const list = Array.isArray(body) ? body : (body.data || body.models || body.items || []);
    result.pollinations = list.filter(m => isVerifiedFree(m, "pollinations") && (m.type === undefined || /text|chat/i.test(String(m.type)) || (m.category && /text/i.test(String(m.category)))))
      .map(m => ({ id: m.id || m.name || m.model, name: m.title || m.name || m.id || m.model, verifiedFree: true }))
      .filter(m => m.id).slice(0, 30);
  }
  if (settled[1].status === "fulfilled" && settled[1].value.ok) {
    const body = await settled[1].value.json();
    const list = body.data || body.models || [];
    const free = list.filter(m => isVerifiedFree(m, "openrouter")).map(m => ({ id: m.id, name: m.name || m.id, verifiedFree: true }));
    result.openrouter = [{ id: "openrouter/free", name: "OpenRouter Free Router (توجيه مجاني تلقائي)", verifiedFree: true }, ...free];
  }
  if (apiKeys.groq?.trim()) {
    try {
      const r = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${apiKeys.groq.trim()}`, Accept: "application/json" }, signal: AbortSignal.timeout(9000) });
      if (r.ok) {
        const body = await r.json();
        result.groq = (body.data || []).filter(m => m.id && !/whisper|guard|embed|tts|speech|audio/i.test(m.id))
          .map(m => ({ id: m.id, name: m.id, requiresFreeTierConfirmation: true })).slice(0, 30);
      } else result.notes.groq = `تعذر جلب كتالوج Groq (HTTP ${r.status}).`;
    } catch (e) { result.notes.groq = "تعذر الوصول إلى كتالوج Groq: " + e.message; }
  }
  if (apiKeys.cohere?.trim()) {
    try {
      const r = await fetch("https://api.cohere.com/v1/models?endpoint=chat&limit=100", { headers: { Authorization: `Bearer ${apiKeys.cohere.trim()}`, Accept: "application/json" }, signal: AbortSignal.timeout(9000) });
      if (r.ok) {
        const body = await r.json();
        result.cohere = (body.models || body.data || []).filter(m => {
          const id = m.name || m.id, endpoints = Array.isArray(m.endpoints) ? m.endpoints : [];
          return id && (!endpoints.length || endpoints.includes("chat") || m.is_chat === true);
        }).map(m => ({ id: m.name || m.id, name: m.name || m.id, requiresFreeTierConfirmation: true })).slice(0, 30);
      } else result.notes.cohere = `تعذر جلب كتالوج Cohere (HTTP ${r.status}).`;
    } catch (e) { result.notes.cohere = "تعذر الوصول إلى كتالوج Cohere: " + e.message; }
  }
  if (useCache) catalogCache = { at: Date.now(), data: result };
  return result;
}
async function callProvider(provider, key, model, sys, user) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`مزود غير مدعوم: ${provider}`);
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  if (provider === "openrouter") { headers["HTTP-Referer"] = process.env.APP_URL || "https://vercel.app"; headers["X-Title"] = "PromptForge AI"; }
  let body;
  if (provider === "cohere") body = { model, messages: [{ role: "system", content: sys }, { role: "user", content: user }], temperature: 0.6, max_tokens: 3500 };
  else body = { model, messages: [{ role: "system", content: sys }, { role: "user", content: user }], temperature: 0.6, max_tokens: 3500, stream: false };
  const response = await fetch(cfg.url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
  const raw = await response.text();
  if (!response.ok) {
    let detail = raw.slice(0, 350);
    try { const j = JSON.parse(raw); detail = j.error?.message || j.message || j.error || detail; } catch {}
    throw new Error(`${provider} HTTP ${response.status}: ${String(detail).slice(0, 350)}`);
  }
  const json = JSON.parse(raw);
  const content = provider === "cohere" ? (json.message?.content || []).map(x => x.text || "").join("\n") : json.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error(`${provider}: استجابة فارغة من النموذج.`);
  return content;
}
function parseAgentJson(raw) {
  try { return JSON.parse(raw); } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("النموذج لم يرجع JSON صالحاً؛ سيتم تجربة نموذج آخر في الوضع التلقائي.");
    return JSON.parse(match[0]);
  }
}
function normalizeResult(data) {
  const keys = ["Clarity", "Completeness", "Tool Compatibility", "Specificity", "Creativity"];
  data.scores = data.scores || {};
  for (const key of keys) data.scores[key] = Math.max(1, Math.min(10, Number(data.scores[key]) || 5));
  data.average_score = Number((keys.reduce((sum, key) => sum + data.scores[key], 0) / keys.length).toFixed(1));
  return data;
}

async function runAgentPipeline(provider, key, model, p) {
  const trace = [];
  const startedAt = Date.now();
  const base = userPrompt(p);
  const rawDraft = await callProvider(provider, key, model, systemPrompt(), base);
  let data = normalizeResult(parseAgentJson(rawDraft));
  trace.push({ step: "draft", status: "completed" });

  const evaluatorSystem = "You are a strict quality reviewer for image/video prompts. Evaluate the supplied draft against the user's request. Do not rewrite the prompt yet. Return ONLY valid JSON with schema: {\"scores\":{\"Clarity\":1,\"Completeness\":1,\"Tool Compatibility\":1,\"Specificity\":1,\"Creativity\":1},\"average_score\":1,\"issues\":[\"specific issue\"],\"must_improve\":true,\"evaluation_text\":\"brief explanation in the requested explanation language\"}. Scores are integers from 1 to 10. Penalize missing requested details, vague wording, unsupported parameters, and incompatibility with the selected tool. A score of 8+ requires a usable, specific, complete prompt.";
  const evaluatorUser = "USER REQUIREMENTS:\n" + base + "\n\nDRAFT TO REVIEW:\n" + JSON.stringify(data) + "\n\nEvaluate only against these requirements.";
  let review = null;
  try {
    review = parseAgentJson(await callProvider(provider, key, model, evaluatorSystem, evaluatorUser));
    trace.push({ step: "independent_review", status: "completed" });
  } catch (e) {
    trace.push({ step: "independent_review", status: "unavailable", reason: String(e.message || e).slice(0, 180) });
  }

  if (review && review.scores) {
    data.scores = review.scores;
    data.average_score = Number(review.average_score) || 0;
    data.evaluation_text = review.evaluation_text || data.evaluation_text || "";
  }
  const needsRevision = review && (review.must_improve === true ||
    Number(review.average_score) < 8 ||
    (Array.isArray(review.issues) && review.issues.length > 0));

  if (needsRevision) {
    const revisionSystem = "You are a prompt engineer revising a draft using a review report. Fix concrete issues; preserve the user's intent and constraints. Do not claim to have generated or tested an image/video. Return ONLY valid JSON using schema: {\"analysis\":\"explanation in requested language\",\"draft_prompt\":\"original draft\",\"final_prompt\":\"improved final English prompt\",\"scores\":{\"Clarity\":1,\"Completeness\":1,\"Tool Compatibility\":1,\"Specificity\":1,\"Creativity\":1},\"evaluation_text\":\"what was corrected, in requested language\",\"average_score\":8,\"parameters\":\"technical settings and caveats in requested language\"}.";
    const revisionUser = "USER REQUIREMENTS:\n" + base + "\n\nCURRENT RESULT:\n" + JSON.stringify(data) + "\n\nREVIEW REPORT:\n" + JSON.stringify(review) + "\n\nRevise once. Ensure final_prompt follows the requested tool and aspect ratio.";
    try {
      const revised = normalizeResult(parseAgentJson(await callProvider(provider, key, model, revisionSystem, revisionUser)));
      data = { ...data, ...revised };
      trace.push({ step: "revision", status: "completed" });
    } catch (e) {
      trace.push({ step: "revision", status: "failed", reason: String(e.message || e).slice(0, 180) });
    }
  } else {
    trace.push({ step: "revision", status: "not_needed" });
  }

  if (typeof data.final_prompt !== "string" || data.final_prompt.trim().length < 20) {
    throw new Error("لم ينتج النموذج برومبت نهائيًا صالحًا؛ جرّب نموذجًا آخر أو أعد المحاولة.");
  }
  data.agent = {
    version: "2.0",
    mode: "bounded-review-and-revision",
    steps: trace,
    elapsed_ms: Date.now() - startedAt,
    max_revision_passes: 1
  };
  return normalizeResult(data);
}

async function tryAuto(p, action) {
  const keys = p.apiKeys || {};
  const confirmed = p.freeTierConfirmed || {};
  const catalog = await getFreeCatalog(keys, { force: true });
  const attempts = [];
  if (keys.pollinations?.trim()) for (const m of catalog.pollinations.slice(0, 4)) attempts.push({ provider: "pollinations", key: keys.pollinations.trim(), model: m.id });
  if (keys.openrouter?.trim()) for (const m of catalog.openrouter.slice(0, 5)) attempts.push({ provider: "openrouter", key: keys.openrouter.trim(), model: m.id });
  if (keys.groq?.trim() && confirmed.groq === true) for (const m of catalog.groq.slice(0, 5)) attempts.push({ provider: "groq", key: keys.groq.trim(), model: m.id });
  if (keys.cohere?.trim() && confirmed.cohere === true) for (const m of catalog.cohere.slice(0, 5)) attempts.push({ provider: "cohere", key: keys.cohere.trim(), model: m.id });

  if (action === "test-auto") {
    const statuses = [];
    for (const provider of ["pollinations", "openrouter", "groq", "cohere"]) {
      const key = keys[provider]?.trim();
      if (!key) { statuses.push({ provider, ok: false, message: "لم يتم إدخال مفتاح" }); continue; }
      if ((provider === "groq" || provider === "cohere") && confirmed[provider] !== true) {
        statuses.push({ provider, ok: false, message: "لم يتم تأكيد أن المفتاح ضمن الخطة/الحصة المجانية؛ لم يُستخدم في التوجيه التلقائي." }); continue;
      }
      const models = attempts.filter(a => a.provider === provider);
      if (!models.length) { statuses.push({ provider, ok: false, message: "لم يُعثر على نموذج مرشح في كتالوج الخدمة أو تعذر جلبه." }); continue; }
      let success = false, message = "لم ينجح الاختبار";
      for (const item of models.slice(0, 2)) {
        try {
          const reply = await callProvider(item.provider, item.key, item.model, "Reply with only OK.", "Reply with only OK to confirm this connection.");
          statuses.push({ provider, ok: true, model: item.model, reply: reply.trim().slice(0, 50) }); success = true; break;
        } catch (e) { message = e.message; }
      }
      if (!success) statuses.push({ provider, ok: false, message });
    }
    return { success: statuses.some(s => s.ok), statuses, catalog: {
      pollinations: catalog.pollinations.length, openrouter: catalog.openrouter.length,
      groq: catalog.groq.length, cohere: catalog.cohere.length
    }};
  }
  if (!attempts.length) throw new Error("لم يتم إعداد أي مزوّد مؤهل للوضع المجاني. أدخل مفاتيح API، وفعّل تأكيد الخطة المجانية لـ Groq/Cohere فقط إذا كنت متأكداً من نوع حسابك.");
  const failures = [];
  for (const item of attempts) {
    try {
      const data = await runAgentPipeline(item.provider, item.key, item.model, p);
      data.routing = { mode: "auto-free", provider: item.provider, model: item.model, fallbackCount: failures.length,
        attempted: failures.map(x => ({ provider: x.provider, model: x.model, error: x.error })) };
      return data;
    } catch (e) { failures.push({ provider: item.provider, model: item.model, error: e.message }); }
  }
  throw new Error("تعذّر تنفيذ الطلب عبر جميع النماذج المجانية/المؤكدة المتاحة. " + failures.map(f => `${f.provider}/${f.model}: ${f.error}`).join(" | ").slice(0, 1400));
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "استخدم POST فقط." }); }
  try {
    const p = req.body || {};
    if (p.action === "free-models") return res.status(200).json(await getFreeCatalog(p.apiKeys || {}, { force: true }));
    if (p.provider === "auto-free" || p.action === "test-auto") {
      const result = await tryAuto(p, p.action === "test-auto" ? "test-auto" : "generate");
      if (p.action === "test-auto" && !result.success) return res.status(502).json({ ...result, error: "لم ينجح اختبار أي مزود مجاني مُعدّ." });
      return res.status(200).json(result);
    }
    if (!Object.keys(PROVIDERS).includes(p.provider)) return res.status(400).json({ error: "مزود غير مدعوم." });
    if (!p.apiKey?.trim()) return res.status(400).json({ error: "أدخل مفتاح API في إعدادات الموقع." });
    if (!p.model?.trim()) return res.status(400).json({ error: "أدخل اسم النموذج." });
    if (p.provider === "pollinations" || p.provider === "openrouter") {
      const catalog = await getFreeCatalog();
      const allowed = (catalog[p.provider] || []).some(m => m.id === p.model.trim());
      if (!allowed) return res.status(400).json({ error: "تم منع هذا النموذج لأن كتالوج الأسعار لا يؤكد أنه مجاني. استخدم الوضع التلقائي المجاني أو حدّث قائمة النماذج المجانية." });
    }
    if (p.action === "test") {
      const reply = await callProvider(p.provider, p.apiKey.trim(), p.model.trim(), "You are a connectivity test. Reply with only the word OK.", "Reply with only OK to confirm the API connection.");
      return res.status(200).json({ success: true, provider: p.provider, model: p.model, reply: reply.trim().slice(0, 100) });
    }
    if (!p.idea?.trim()) return res.status(400).json({ error: "الفكرة مطلوبة." });
    const data = await runAgentPipeline(p.provider, p.apiKey.trim(), p.model.trim(), p);
    data.routing = { mode: "manual", provider: p.provider, model: p.model, fallbackCount: 0, attempted: [] };
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message || "حدث خطأ في تنفيذ الوكيل." });
  }
}