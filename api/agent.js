const PROVIDERS = {
  pollinations: { url: "https://gen.pollinations.ai/v1/chat/completions", kind: "openai" },
  openrouter: { url: "https://openrouter.ai/api/v1/chat/completions", kind: "openai" },
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", kind: "openai" },
  cohere: { url: "https://api.cohere.com/v2/chat", kind: "cohere" },
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", kind: "openai" }
};
// Only models listed as free on Google’s official Gemini API pricing page are eligible for auto-free routing.
const GEMINI_FREE_MODELS = [
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
  { id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview" }
];
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
    gemini: [],
    notes: {
      gemini: "يُعرض في الوضع التلقائي فقط نموذج Gemini الموجود في قائمة Google المجانية؛ تظل الحصة وحدود الحساب مطبقة.",
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
  if (apiKeys.gemini?.trim()) {
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models", { headers: { Accept: "application/json", "x-goog-api-key": apiKeys.gemini.trim() }, signal: AbortSignal.timeout(9000) });
      if (r.ok) {
        const body = await r.json();
        const available = new Set((body.models || []).filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent")).map(m => String(m.name || "").replace(/^models\//, "")));
        result.gemini = GEMINI_FREE_MODELS.filter(m => available.has(m.id)).map(m => ({ ...m, verifiedFree: true }));
        if (!result.gemini.length) result.notes.gemini = "لم يُرجع مفتاحك أي نموذج من قائمة Gemini المجانية المعتمدة. تحقق من أهلية الخطة المجانية والموديلات المتاحة في AI Studio.";
      } else {
        const detail = await r.text();
        result.notes.gemini = `تعذر جلب نماذج Gemini (HTTP ${r.status}): ${detail.slice(0, 180)}`;
      }
    } catch (e) { result.notes.gemini = "تعذر الوصول إلى كتالوج Gemini: " + e.message; }
  }
  if (apiKeys.groq?.trim()) {
    try {
      const r = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${apiKeys.groq.trim()}`, Accept: "application/json" }, signal: AbortSignal.timeout(9000) });
      if (r.ok) {
        const body = await r.json();
        // Exclude models known from runtime errors to require manual terms acceptance,
        // return malformed JSON frequently, or be unusable under the observed tiny output-token quota.
        const excludedGroq = /whisper|guard|embed|tts|speech|audio|canopylabs\/orpheus-arabic-saudi|allam-2-7b|qwen\/qwen3\.8-27b/i;
        result.groq = (body.data || []).filter(m => m.id && !excludedGroq.test(m.id) && !/deprecated|preview/i.test(String(m.id)))
          .map(m => ({ id: m.id, name: m.id, requiresFreeTierConfirmation: true }))
          .sort((a, b) => {
            const preferred = id => /llama-3\.3-70b-versatile|llama-3\.1-8b-instant|openai\/gpt-oss-20b/i.test(id) ? 0 : 1;
            return preferred(a.id) - preferred(b.id);
          }).slice(0, 15);
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
async function callProvider(provider, key, model, sys, user, maxTokens = 1200) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`مزود غير مدعوم: ${provider}`);
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  if (provider === "openrouter") { headers["HTTP-Referer"] = process.env.APP_URL || "https://vercel.app"; headers["X-Title"] = "PromptForge AI"; }
  let body;
  if (provider === "cohere") body = { model, messages: [{ role: "system", content: sys }, { role: "user", content: user }], temperature: 0.6, max_tokens: maxTokens };
  else body = { model, messages: [{ role: "system", content: sys }, { role: "user", content: user }], temperature: 0.2, max_tokens: Math.max(256, Math.min(maxTokens, provider === "gemini" ? 1800 : 1200)), stream: false, ...(provider === "gemini" || provider === "groq" ? { response_format: { type: "json_object" } } : {}), ...(provider === "gemini" ? { reasoning_effort: "low" } : {}) };
  let response;
  // Retry one transient 503 overload response; do not blindly retry quota 429s.
  for (let attempt = 0; attempt < 2; attempt++) {
    response = await fetch(cfg.url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(18000) });
    if (response.status !== 503 || attempt === 1) break;
    const retryAfter = Number(response.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(1800, retryAfter * 1000) : 800;
    await response.body?.cancel().catch(() => {});
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  const raw = await response.text();
  if (!response.ok) {
    let detail = raw.slice(0, 350);
    try { const j = JSON.parse(raw); detail = j.error?.message || j.message || j.error || detail; } catch {}
    throw new Error(`${provider} HTTP ${response.status}: ${String(detail).slice(0, 350)}`);
  }
  const json = JSON.parse(raw);
  const content = provider === "cohere" ? (json.message?.content || []).map(x => x.text || "").join("\n") : json.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error(`${provider}: استجابة فارغة من النموذج (HTTP ${response.status}); تحقق من توافق النموذج مع Chat Completions أو جرّب نموذجاً آخر.`);
  return content;
}
function parseAgentJson(raw) {
  if (raw && typeof raw === "object") return raw;
  const source = String(raw || "").replace(new RegExp("^\\uFEFF"), "").trim();
  const candidates = [source];
  const fenceStart = source.indexOf("```");
  if (fenceStart >= 0) {
    const firstLineEnd = source.indexOf("\n", fenceStart);
    const fenceEnd = source.indexOf("```", firstLineEnd + 1);
    if (firstLineEnd >= 0 && fenceEnd > firstLineEnd) candidates.push(source.slice(firstLineEnd + 1, fenceEnd).trim());
  }
  const first = source.indexOf("{");
  const last = source.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(source.slice(first, last + 1));
  let lastError;
  for (const candidate of [...new Set(candidates)]) {
    try { return JSON.parse(candidate); } catch (e) { lastError = e; }
    const cleaned = candidate.replace(/,\s*([}\]])/g, "$1");
    try { return JSON.parse(cleaned); } catch (e) { lastError = e; }
  }
  const detail = lastError && lastError.message ? lastError.message : "صيغة غير معروفة";
  throw new Error("تعذر تحليل JSON من النموذج: " + detail + ". أعد المحاولة أو استخدم مزودًا آخر.");
}

function normalizeResult(data) {
  const keys = ["Clarity", "Completeness", "Tool Compatibility", "Specificity", "Creativity"];
  data.scores = data.scores || {};
  for (const key of keys) data.scores[key] = Math.max(1, Math.min(10, Number(data.scores[key]) || 5));
  data.average_score = Number((keys.reduce((sum, key) => sum + data.scores[key], 0) / keys.length).toFixed(1));
  return data;
}

function auditFinalPrompt(prompt, p, plan) {
  const text = String(prompt || "");
  const lower = text.toLowerCase();
  const checks = [];
  const add = (name, ok, message, evidence = "") => checks.push({ name, ok: Boolean(ok), message: ok ? "" : message, evidence });
  add("non_empty_prompt", text.trim().length >= 20, "البرومبت النهائي فارغ أو قصير جدًا.", text.trim().length + " حرفًا");
  const ratio = String(p.ratio || "").trim();
  if (ratio) {
    const ratioOk = lower.includes(ratio.toLowerCase()) || new RegExp("--ar\\s+" + ratio.replace(":", "\\s*:\\s*")).test(text) ||
      /aspect ratio/i.test(text) || (ratio === "9:16" && /vertical|portrait/i.test(text));
    add("requested_aspect_ratio", ratioOk, "لم يظهر دليل كافٍ على نسبة الأبعاد المطلوبة: " + ratio, ratioOk ? "عُثر على النسبة أو وصف اتجاه متوافق." : "لم يُعثر على النسبة أو وصف اتجاه متوافق.");
  }
  const target = String(p.target || "");
  if (/midjourney/i.test(target)) {
    add("midjourney_invalid_style_parameter", !/--style\s+cinematic\b/i.test(text), "معامل --style cinematic قد لا يكون صالحًا؛ اجعل cinematic وصفًا نصيًا.", "فحص صيغة معامل Midjourney.");
  }
  const required = Array.isArray(plan?.required_elements) ? plan.required_elements : [];
  const requirementResults = required.slice(0, 15).map((item) => {
    const phrase = String(item || "").trim();
    const words = phrase.toLowerCase().split(/[^a-z0-9\u0600-\u06ff]+/).filter(w => w.length >= 4);
    const matchedWords = words.filter(w => lower.includes(w));
    const ratioMatched = words.length ? matchedWords.length / words.length : lower.includes(phrase.toLowerCase());
    const ok = ratioMatched >= 0.5 || lower.includes(phrase.toLowerCase());
    return { requirement: phrase, ok, evidence: matchedWords.length ? "تطابق نصي: " + matchedWords.slice(0, 6).join(", ") : "لم يُعثر على تطابق نصي واضح.", confidence: words.length ? Number(ratioMatched.toFixed(2)) : (ok ? 1 : 0) };
  });
  for (const r of requirementResults) add("planned_requirement", r.ok, "قد يكون أحد متطلبات الخطة مفقودًا: " + r.requirement, r.evidence);
  const notes = String(p.notes || "");
  const explicitNegatives = [];
  if (/no text|without text|no lettering/i.test(notes)) explicitNegatives.push({ name: "no_text_constraint", regex: /no text|without text|no lettering/i });
  if (/no watermark|without watermark/i.test(notes)) explicitNegatives.push({ name: "no_watermark_constraint", regex: /no watermark|without watermark/i });
  for (const item of explicitNegatives) add(item.name, item.regex.test(text), "لم يتم الحفاظ بوضوح على القيد: " + item.name, "تم فحص القيد النصي الصريح.");
  const issues = checks.filter(x => !x.ok);
  return { passed: issues.length === 0, checks, issues: issues.map(x => x.message), requirement_results: requirementResults, checked_at: new Date().toISOString() };
}

function runLocalPromptTools(prompt, p) {
  const text = String(prompt || "");
  const target = String(p.target || "");
  const ratio = String(p.ratio || "");
  const checks = [];
  checks.push({ name: "non_empty_prompt", ok: text.trim().length >= 20, message: "البرومبت النهائي فارغ أو قصير جدًا." });
  checks.push({ name: "visual_specificity", ok: /lighting|composition|texture|camera|background|material|color|mood|lens|subject/i.test(text), message: "أضف تفاصيل بصرية مثل الإضاءة والتكوين والخامات." });
  if (ratio) {
    const ratioMentioned = text.includes(ratio) || new RegExp("--ar\\s+" + ratio.replace(":", "\\s*:\\s*")).test(text) || /aspect ratio/i.test(text) || (ratio === "9:16" && /vertical|portrait/i.test(text)) || (ratio === "16:9" && /horizontal|landscape|widescreen/i.test(text));
    checks.push({ name: "aspect_ratio", ok: ratioMentioned, message: "تحقق من تضمين نسبة الأبعاد المطلوبة: " + ratio });
  }
  if (/midjourney/i.test(target)) {
    const unsupportedStyle = /--style\s+cinematic\b/i.test(text);
    checks.push({ name: "midjourney_parameter_sanity", ok: !unsupportedStyle, message: "المعامل --style cinematic قد لا يكون صالحًا في Midjourney؛ استخدم وصفًا نصيًا للأسلوب." });
    checks.push({ name: "midjourney_v6_syntax", ok: !/--v\s+5\b/i.test(text) || /v5/i.test(text), message: "تأكد من أن إصدار Midjourney ومعاملاته يطابقان اختيارك." });
  }
  if (/no text|no watermark/i.test(text)) checks.push({ name: "negative_constraints", ok: true, message: "" });
  const issues = checks.filter(x => !x.ok).map(x => x.message);
  return { tool: "local_prompt_validator", passed: checks.every(x => x.ok), checks, issues };
}

async function runAgentPipeline(provider, key, model, p) {
  const trace = [];
  let providerRateLimited = false;
  const isRateLimitError = error => /HTTP 429|rate limit|rate_limit|tokens per minute|TPM/i.test(String(error?.message || error || ""));
  const startedAt = Date.now();
  const base = userPrompt(p);
  const planSystem = "You are the planning component of PromptForge. Convert the user's creative request into a concise actionable plan. Return ONLY valid JSON: {\"goal\":\"...\",\"required_elements\":[\"...\"],\"visual_strategy\":\"...\",\"tool_constraints\":[\"...\"],\"validation_criteria\":[\"...\"],\"risks_or_unknowns\":[\"...\"]}. Do not write the final prompt yet. Explanations must use the requested language.";
  let plan;
  try {
    plan = parseAgentJson(await callProvider(provider, key, model, planSystem, base, 650));
    if (!plan || !Array.isArray(plan.required_elements) || !Array.isArray(plan.validation_criteria)) throw new Error("خطة غير مكتملة");
    trace.push({ step: "planning", status: "completed", tool: "llm_planner", details: plan });
  } catch (e) {
    providerRateLimited = isRateLimitError(e);
    plan = { goal: p.idea, required_elements: [], visual_strategy: "Use the user idea and explicit settings to build a clear, tool-compatible visual prompt. Semantic requirements were not independently decomposed because planning failed.", tool_constraints: [String(p.target || ""), String(p.ratio || "")].filter(Boolean), validation_criteria: ["non-empty", "specific", "tool-compatible", "preserve explicit user constraints"], risks_or_unknowns: ["The planning model did not return a valid plan; semantic requirement auditing is limited."] };
    trace.push({ step: "planning", status: "fallback", tool: "basic_plan", reason: String(e.message || e).slice(0, 180) });
  }

  const generationSystem = systemPrompt() + "\n\nAGENT PLAN (follow this plan):\n" + JSON.stringify(plan) + "\n\nReturn valid JSON matching the required output schema. Preserve user constraints.";
  if (providerRateLimited) throw new Error("تجاوز مزود النموذج حد الاستخدام (HTTP 429) أثناء التخطيط؛ انتظر تجدد الحصة أو استخدم مزودًا آخر.");
  let rawDraft;
  let data;
  try {
    rawDraft = await callProvider(provider, key, model, generationSystem, base, 2200);
    data = normalizeResult(parseAgentJson(rawDraft));
  } catch (firstError) {
    // HTTP/provider failures are not JSON parse failures. Preserve them so auto-routing
    // can skip a model that needs terms acceptance or has exhausted its quota.
    if (/HTTP 400|HTTP 401|HTTP 403|HTTP 404|HTTP 429|HTTP 5\d\d|requires terms acceptance|rate limit|OTPM|TPM/i.test(String(firstError.message || firstError))) throw firstError;
    const repairSystem = "Return ONLY one complete valid JSON object matching this schema: " + JSON.stringify({ analysis: "brief Arabic intent summary", draft_prompt: "short English prompt", final_prompt: "complete English visual prompt", scores: { Clarity: 7, Completeness: 7, "Tool Compatibility": 7, Specificity: 7, Creativity: 7 }, evaluation_text: "brief Arabic evaluation", average_score: 7, parameters: "brief Arabic settings" }) + ". No markdown fences, no comments, no trailing commas. Keep strings concise and close every quote and brace.";
    try {
      const repairedRaw = await callProvider(provider, key, model, repairSystem, "Create the requested prompt now. User request and constraints:\n" + base.slice(0, 5000) + "\nRequired plan:\n" + JSON.stringify(plan).slice(0, 1800) + "\nPrevious response (repair only if useful):\n" + String(rawDraft || "").slice(0, 2500), 2200);
      data = normalizeResult(parseAgentJson(repairedRaw));
      trace.push({ step: "draft", status: "recovered", tool: "json_repair_retry", reason: String(firstError.message || firstError).slice(0, 180) });
    } catch (repairError) {
      throw new Error("تعذر إنشاء JSON صالح حتى بعد محاولة إصلاح واحدة. السبب الأول: " + String(firstError.message || firstError).slice(0, 180) + "؛ محاولة الإصلاح: " + String(repairError.message || repairError).slice(0, 180));
    }
  }
  trace.push({ step: "draft", status: "completed", tool: "llm_generator" });

  const evaluatorSystem = "You are an independent quality reviewer for image/video prompts. Evaluate the draft against the user's request and agent plan. Return ONLY valid JSON: {\"scores\":{\"Clarity\":1,\"Completeness\":1,\"Tool Compatibility\":1,\"Specificity\":1,\"Creativity\":1},\"issues\":[\"specific issue\"],\"must_improve\":true,\"evaluation_text\":\"brief explanation in requested language\"}. Scores are integers 1-10. Do not inflate scores. Do not claim that an image/video was actually generated or tested.";
  let review = null;
  let reviewMode = "model";
  let validation = runLocalPromptTools(data.final_prompt, p);
  try {
    if (providerRateLimited) throw new Error("تم تخطي المراجعة لأن المزود تجاوز حد TPM في مرحلة سابقة (HTTP 429).");
    review = parseAgentJson(await callProvider(provider, key, model, evaluatorSystem, "USER REQUIREMENTS:\n" + base.slice(0, 4500) + "\nPLAN:\n" + JSON.stringify(plan).slice(0, 2500) + "\nDRAFT PROMPT:\n" + String(data.final_prompt || "").slice(0, 5000), 650));
    const required = ["Clarity", "Completeness", "Tool Compatibility", "Specificity", "Creativity"];
    if (!review.scores || required.some(k => !Number.isFinite(Number(review.scores[k])))) throw new Error("مراجعة النموذج لم تتضمن درجات صالحة.");
    review.scores = Object.fromEntries(required.map(k => [k, Math.max(1, Math.min(10, Math.round(Number(review.scores[k]))))]));
    review.issues = Array.isArray(review.issues) ? review.issues.filter(x => typeof x === "string") : [];
    review.must_improve = review.must_improve === true || review.issues.length > 0;
    trace.push({ step: "independent_review", status: "completed", tool: "llm_reviewer", score: Number((required.reduce((s,k)=>s+review.scores[k],0)/required.length).toFixed(1)), issues_count: review.issues.length });
  } catch (e) {
    providerRateLimited = providerRateLimited || isRateLimitError(e);
    reviewMode = "fallback";
    const issues = validation.issues.slice();
    review = { scores: { Clarity: 6, Completeness: 6, "Tool Compatibility": validation.passed ? 7 : 4, Specificity: validation.passed ? 7 : 5, Creativity: 6 }, issues, must_improve: issues.length > 0, evaluation_text: "تعذرت المراجعة المستقلة بواسطة النموذج؛ تم استخدام فحص برمجي محدود فقط." };
    trace.push({ step: "independent_review", status: "fallback", tool: "local_checks_only", reason: String(e.message || e).slice(0, 180), issues_count: issues.length });
  }

  const requestedPasses = Math.max(0, Math.min(2, Number(p.maxRevisionPasses ?? 2) || 0));
  // Avoid repeated calls to a provider after it has explicitly rate-limited this request.
  const maxPasses = providerRateLimited ? 0 : requestedPasses;
  let revisionPasses = 0;
  const revisionHistory = [];
  const initialDraftPrompt = String(data.final_prompt || "");
  if (providerRateLimited && requestedPasses > 0) {
    trace.push({ step: "revision", status: "skipped_rate_limit", tool: "local_validation_only", reason: "توقفنا عن إرسال طلبات إضافية إلى المزود بعد HTTP 429 لتجنب استهلاك الحصة وإعادة الفشل." });
  }
  for (let pass = 1; pass <= maxPasses; pass++) {
    validation = runLocalPromptTools(data.final_prompt, p);
    const issues = [...(review.issues || []), ...validation.issues];
    const reviewAverage = Number((Object.values(review.scores).reduce((s,v)=>s+Number(v),0)/5).toFixed(1));
    if (!review.must_improve && validation.passed && (reviewMode === "fallback" || reviewAverage >= 8)) {
      trace.push({ step: "revision", status: "not_needed", pass, reason: "review_and_tools_passed" });
      break;
    }
    const revisionSystem = "You are the revision component of a prompt-engineering agent. Fix the supplied issues using the user request, agent plan, and tool-validation report. Preserve all required constraints. Do not claim to have generated or tested media. Return ONLY valid JSON using the standard PromptForge result schema.";
    const revisionUser = "USER REQUEST:\n" + base + "\nPLAN:\n" + JSON.stringify(plan) + "\nCURRENT RESULT:\n" + JSON.stringify(data) + "\nREVIEW ISSUES:\n" + JSON.stringify(issues) + "\nLOCAL TOOL VALIDATION:\n" + JSON.stringify(validation) + "\nRevise pass " + pass + " of " + maxPasses + ".";
    try {
      if (providerRateLimited) throw new Error("تم إيقاف التحسين بالنموذج بعد بلوغ حد TPM (HTTP 429)؛ سيُستخدم الإصلاح المحلي الآمن فقط.");
      const revised = normalizeResult(parseAgentJson(await callProvider(provider, key, model, revisionSystem, revisionUser.slice(0, 9000), 1000)));
      const previousPrompt = data.final_prompt;
      if (typeof revised.final_prompt !== "string" || revised.final_prompt.trim().length < 20) throw new Error("المراجعة لم تنتج برومبت صالحًا.");
      data = { ...data, ...revised, draft_prompt: data.draft_prompt || initialDraftPrompt };
      revisionPasses++;
      validation = runLocalPromptTools(data.final_prompt, p);
      const revisionRecord = { pass, method: "model", changed: data.final_prompt !== previousPrompt, before: previousPrompt, after: data.final_prompt, before_validation: runLocalPromptTools(previousPrompt, p), after_validation: validation, issues_addressed: issues };
      revisionHistory.push(revisionRecord);
      trace.push({ step: "revision", status: "completed", pass, tool: "llm_revision", changed: revisionRecord.changed, validation_passed: validation.passed, changes_summary: data.final_prompt !== previousPrompt ? "تغيّر نص البرومبت؛ راجع المقارنة لمعرفة التفاصيل." : "لم يتغير نص البرومبت." });
      review = { ...review, must_improve: !validation.passed, issues: validation.issues };
    } catch (e) {
      const revisionError = String(e.message || e).slice(0, 220);
      // Avoid repeating the same request immediately after a rate-limit response.
      let retrySucceeded = false;
      const rateLimited = isRateLimitError(revisionError);
      providerRateLimited = providerRateLimited || rateLimited;
      try {
        if (rateLimited) throw new Error("تجاوز حد الاستخدام 429؛ تم إيقاف إعادة المحاولة لتجنب استهلاك الحصة، وسيُستخدم الإصلاح المحلي الآمن إن أمكن.");
        const retrySystem = "Edit the prompt only. Return ONLY JSON with one property: final_prompt (string). Preserve the user's requirements. Do not explain.";
        const retryUser = "Improve this prompt for " + String(p.target || "the selected tool") + " with aspect ratio " + String(p.ratio || "") + ". Fix these issues: " + JSON.stringify(issues) + "\nPROMPT:\n" + String(data.final_prompt || "");
        const retryResult = parseAgentJson(await callProvider(provider, key, model, retrySystem, retryUser.slice(0, 5000), 450));
        const retryPrompt = typeof retryResult.final_prompt === "string" ? retryResult.final_prompt : "";
        if (retryPrompt.trim().length >= 20) {
          const previousPrompt = String(data.final_prompt || "");
          data.final_prompt = retryPrompt.trim();
          revisionPasses++;
          validation = runLocalPromptTools(data.final_prompt, p);
          revisionHistory.push({ pass, method: "model_retry", changed: data.final_prompt !== previousPrompt, before: previousPrompt, after: data.final_prompt, before_validation: runLocalPromptTools(previousPrompt, p), after_validation: validation, issues_addressed: issues });
          trace.push({ step: "revision", status: "completed_retry", pass, tool: "llm_revision_retry", changed: data.final_prompt !== previousPrompt, validation_passed: validation.passed, changes_summary: data.final_prompt !== previousPrompt ? "تغيّر نص البرومبت بعد إعادة المحاولة." : "لم يتغير نص البرومبت بعد إعادة المحاولة.", first_error: revisionError });
          review = { ...review, must_improve: !validation.passed, issues: validation.issues };
          retrySucceeded = true;
        } else {
          throw new Error("إعادة المحاولة لم تُرجع final_prompt صالحًا.");
        }
      } catch (retryError) {
        trace.push({ step: "revision_retry", status: "failed", pass, reason: String(retryError.message || retryError).slice(0, 220), first_error: revisionError });
      }
      if (retrySucceeded) continue;
      // Deterministic fallback: apply only safe, explainable text repairs when the revision model fails.
      const previousPrompt = String(data.final_prompt || "");
      let repairedPrompt = previousPrompt;
      const repairs = [];
      if (/midjourney/i.test(String(p.target || "")) && /--style\s+cinematic\b/i.test(repairedPrompt)) {
        repairedPrompt = repairedPrompt.replace(/--style\s+cinematic\b/ig, "cinematic");
        repairs.push("استبدال معامل --style cinematic بوصف نصي");
      }
      const ratio = String(p.ratio || "");
      if (ratio && !repairedPrompt.includes(ratio) && !/--ar\s+\d+:\d+|aspect ratio/i.test(repairedPrompt)) {
        repairedPrompt += /midjourney/i.test(String(p.target || "")) ? " --ar " + ratio : " Aspect ratio " + ratio + ".";
        repairs.push("إضافة نسبة الأبعاد المطلوبة");
      }
      if (repairedPrompt.trim().length >= 20 && repairedPrompt !== previousPrompt) {
        data.final_prompt = repairedPrompt;
        validation = runLocalPromptTools(data.final_prompt, p);
        revisionPasses++;
        revisionHistory.push({ pass, method: "deterministic_fallback", changed: true, before: previousPrompt, after: data.final_prompt, before_validation: runLocalPromptTools(previousPrompt, p), after_validation: validation, changes_summary: repairs.join("، "), issues_addressed: issues });
        trace.push({ step: "revision", status: "completed_fallback", pass, tool: "deterministic_repair", changed: true, repairs, changes_summary: repairs.join("، "), model_error: String(e.message || e).slice(0, 220), validation_passed: validation.passed });
        review = { ...review, must_improve: !validation.passed, issues: validation.issues };
      } else {
        trace.push({ step: "revision", status: "failed", pass, tool: "llm_revision", reason: String(e.message || e).slice(0, 220), fallback: "لم تُجرَ تعديلات آلية لأن الإصلاح الآمن لم يكن واضحًا." });
        break;
      }
    }
  }

  validation = runLocalPromptTools(data.final_prompt, p);

  // Independent decision audit: compare request, plan and final prompt.
  let decisionAudit = { status: "unavailable", summary: "تعذر إكمال التدقيق المستقل؛ الفحوص المحلية متاحة بشكل منفصل.", preserved_requirements: [], potential_violations: [], decisions_reviewed: [], uncertainty: ["لم يكتمل تدقيق النموذج المستقل."] };
  try {
    if (providerRateLimited) throw new Error("تم إيقاف استدعاءات النموذج بعد HTTP 429؛ لم يُرسل طلب تدقيق إضافي حتى لا يتكرر استهلاك الحصة. الفحص المحلي ليس تدقيقًا مستقلًا.");
    const auditSystem = 'You are an independent quality auditor. Compare USER REQUEST, PLAN, and FINAL PROMPT. Return ONLY valid JSON: {"status":"pass|warning|fail","summary":"string","preserved_requirements":["string"],"potential_violations":["string"],"decisions_reviewed":[{"decision":"string","evidence":"string","verdict":"supported|uncertain|conflict","reason":"string"}],"uncertainty":["string"]}. Identify omissions, contradictions, and unjustified changes. Distinguish verifiable text facts from subjective design judgments. Never claim the image was generated or visually checked.';
    const auditUser = "USER REQUEST:\n" + base + "\nPLAN:\n" + JSON.stringify(plan) + "\nFINAL PROMPT:\n" + String(data.final_prompt || "") + "\nLOCAL VALIDATION:\n" + JSON.stringify(validation);
    const a = parseAgentJson(await callProvider(provider, key, model, auditSystem, ("USER REQUEST:\n" + base.slice(0, 3500) + "\nPLAN:\n" + JSON.stringify(plan).slice(0, 1800) + "\nFINAL PROMPT:\n" + String(data.final_prompt || "").slice(0, 4500) + "\nLOCAL VALIDATION:\n" + JSON.stringify(validation).slice(0, 1200)), 650));
    if (!a || !Array.isArray(a.potential_violations) || !Array.isArray(a.decisions_reviewed)) throw new Error("تقرير التدقيق غير مكتمل.");
    const normalizedDecisions = a.decisions_reviewed.filter(x => x && typeof x === "object").map(x => ({
      decision: String(x.decision || "قرار غير مسمى"),
      evidence: String(x.evidence || "لم يقدم المدقق دليلًا واضحًا."),
      verdict: ["supported","uncertain","conflict"].includes(x.verdict) ? x.verdict : "uncertain",
      reason: String(x.reason || "لم يقدم المدقق تفسيرًا كافيًا.")
    }));
    const normalizedViolations = a.potential_violations.filter(x => typeof x === "string" && x.trim()).map(x => x.trim());
    const normalizedUncertainty = Array.isArray(a.uncertainty) ? a.uncertainty.filter(x => typeof x === "string" && x.trim()) : [];
    const unsupportedDecisions = normalizedDecisions.filter(x => x.verdict !== "supported");
    let auditedStatus = ["pass","warning","fail"].includes(a.status) ? a.status : "warning";
    // Never allow a model to report PASS while listing conflicts, uncertainty, or missing decision evidence.
    if (normalizedViolations.length || normalizedUncertainty.length || unsupportedDecisions.length) {
      if (auditedStatus === "pass") auditedStatus = normalizedDecisions.some(x => x.verdict === "conflict") ? "fail" : "warning";
    }
    if (!normalizedDecisions.length && auditedStatus === "pass") auditedStatus = "warning";
    decisionAudit = {
      status: auditedStatus,
      summary: String(a.summary || "اكتمل التدقيق.") + (auditedStatus !== a.status ? " تم خفض الحالة تلقائيًا بسبب وجود مخالفات أو قرارات غير محسومة." : ""),
      preserved_requirements: Array.isArray(a.preserved_requirements) ? a.preserved_requirements.filter(x => typeof x === "string") : [],
      potential_violations: normalizedViolations,
      decisions_reviewed: normalizedDecisions,
      uncertainty: normalizedUncertainty
    };
    trace.push({ step: "decision_audit", status: decisionAudit.status === "pass" ? "completed" : decisionAudit.status === "fail" ? "failed" : "warning", tool: "independent_llm_audit", summary: decisionAudit.summary, violations: decisionAudit.potential_violations.length, decisions_reviewed: decisionAudit.decisions_reviewed.length, unresolved_decisions: unsupportedDecisions.length });
  } catch (e) {
    providerRateLimited = providerRateLimited || isRateLimitError(e);
    // Honest deterministic fallback: concrete local evidence, never label it an independent model audit.
    const promptText = String(data.final_prompt || "").toLowerCase();
    const localDecisions = [];
    const localViolations = [];
    const ratio = String(p.ratio || "");
    const ratioOk = !ratio || promptText.includes(ratio.toLowerCase()) || /aspect ratio/i.test(promptText) || (ratio === "9:16" && /vertical|portrait/i.test(promptText));
    localDecisions.push({ decision: "تضمين نسبة الأبعاد المطلوبة", evidence: ratio ? "النسبة المطلوبة: " + ratio : "لم يحدد المستخدم نسبة أبعاد.", verdict: ratioOk ? "supported" : "conflict", reason: ratioOk ? "وجدت إشارة نصية متوافقة مع النسبة أو الوصف العمودي." : "لم يُعثر على النسبة المطلوبة أو وصف بديل واضح." });
    if (!ratioOk) localViolations.push("قد تكون نسبة الأبعاد المطلوبة مفقودة من البرومبت.");
    const requirements = Array.isArray(plan.required_elements) ? plan.required_elements : [];
    const preserved = [];
    for (const item of requirements.slice(0, 12)) {
      const words = String(item).toLowerCase().split(/[^a-z0-9\u0600-\u06ff]+/).filter(w => w.length > 3);
      const matched = words.length > 0 && words.some(w => promptText.includes(w));
      (matched ? preserved : localViolations).push(String(item));
      localDecisions.push({ decision: "متطلب من خطة الوكيل: " + String(item), evidence: matched ? "عُثر على كلمة أو عبارة مرتبطة بالمتطلب في البرومبت." : "لم يُعثر على تطابق نصي واضح.", verdict: matched ? "supported" : "uncertain", reason: "هذا فحص نصي تقريبي وليس فهمًا دلاليًا كاملًا." });
    }
    decisionAudit = {
      status: "warning",
      summary: "تعذّر تدقيق نموذج مستقل؛ عُرض بديل برمجي محدود. لا يُعدّ هذا اجتيازًا للتدقيق المستقل.",
      preserved_requirements: preserved,
      potential_violations: localViolations,
      decisions_reviewed: localDecisions,
      uncertainty: ["فشل التدقيق المستقل: " + String(e.message || e).slice(0, 180), "الفحص المحلي تقريبي وقد يفوّت المعنى أو المرادفات؛ يلزم إعادة المحاولة للتحقق المستقل."]
    };
    trace.push({ step: "decision_audit", status: "fallback_warning", tool: "deterministic_audit_fallback", reason: String(e.message || e).slice(0, 220), decisions_reviewed: localDecisions.length, potential_violations: localViolations.length });
  }

  // Final deterministic gate: independently re-check the actual final text, not model claims.
  const finalAudit = auditFinalPrompt(data.final_prompt, p, plan);
  const existingAuditIssues = Array.isArray(decisionAudit.potential_violations) ? decisionAudit.potential_violations.slice() : [];
  const finalAuditIssues = finalAudit.issues.filter(Boolean);
  const mergedViolations = [...new Set([...existingAuditIssues, ...finalAuditIssues])];
  const unresolvedFinalRequirements = finalAudit.requirement_results.filter(x => !x.ok);
  if (mergedViolations.length || unresolvedFinalRequirements.length || !finalAudit.passed) {
    if (decisionAudit.status === "pass") decisionAudit.status = unresolvedFinalRequirements.length ? "warning" : "fail";
    decisionAudit.potential_violations = mergedViolations;
    decisionAudit.summary = (decisionAudit.summary || "اكتمل التدقيق.") + " فحص المطابقة النهائي: " +
      (finalAudit.passed ? "اجتاز الفحوص البرمجية المستقلة." : "اكتُشفت نقاط تحتاج إلى مراجعة.");
  }
  decisionAudit.final_checks = finalAudit.checks;
  decisionAudit.requirement_results = finalAudit.requirement_results;
  decisionAudit.final_check_passed = finalAudit.passed;
  // One authoritative status per stage: no UI badge may imply success when final checks failed.
  trace.push({ step: "final_audit_gate", status: finalAudit.passed ? "completed" : "warning", tool: "deterministic_final_audit", checks_passed: finalAudit.checks.filter(x => x.ok).length, checks_total: finalAudit.checks.length, issues: finalAudit.issues });
  if (providerRateLimited) trace.push({ step: "provider_usage", status: "rate_limited", provider, model, reason: "توقف الوكيل عن استدعاءات النموذج الإضافية بعد HTTP 429؛ استُكملت الفحوص المحلية فقط." });
  trace.push({ step: "tool_validation", status: validation.passed && finalAudit.passed ? "completed" : "warning", tool: validation.tool, checks: validation.checks, issues: [...validation.issues, ...finalAudit.issues] });
  if (typeof data.final_prompt !== "string" || data.final_prompt.trim().length < 20) throw new Error("لم ينتج الوكيل برومبت نهائيًا صالحًا.");
  data.scores = review.scores || data.scores;
  data.average_score = Number((Object.values(data.scores).reduce((s,v)=>s+Number(v),0)/5).toFixed(1));
  data.evaluation_text = (review.evaluation_text || data.evaluation_text || "") + (validation.issues.length ? "\n\nنتائج الفحص البرمجي: " + validation.issues.join(" ") : "\n\nاجتاز البرومبت الفحوص البرمجية المحددة.");
  data.agent = {
    version: "4.0",
    mode: "plan-review-revise-independent-audit-final-gate",
    review_mode: reviewMode,
    plan,
    tool_validation: { ...validation, passed: validation.passed && finalAudit.passed, final_audit: finalAudit },
    decision_audit: decisionAudit,
    steps: trace,
    elapsed_ms: Date.now() - startedAt,
    max_revision_passes: maxPasses,
    revision_passes_completed: revisionPasses,
    initial_draft_prompt: initialDraftPrompt,
    revision_history: revisionHistory
  };
  return normalizeResult(data);
}

async function tryAuto(p, action) {
  const keys = p.apiKeys || {};
  const confirmed = p.freeTierConfirmed || {};
  const catalog = await getFreeCatalog(keys, { force: true });
  const attempts = [];
  // Interleave providers so OpenRouter's several catalog entries cannot consume the entire retry budget.
  const queues = [];
  if (keys.gemini?.trim()) queues.push({ provider: "gemini", key: keys.gemini.trim(), models: catalog.gemini.slice(0, 4) });
  if (keys.pollinations?.trim()) queues.push({ provider: "pollinations", key: keys.pollinations.trim(), models: catalog.pollinations.slice(0, 4) });
  if (keys.openrouter?.trim()) queues.push({ provider: "openrouter", key: keys.openrouter.trim(), models: catalog.openrouter.slice(0, 5) });
  if (keys.groq?.trim() && confirmed.groq === true) queues.push({ provider: "groq", key: keys.groq.trim(), models: catalog.groq.slice(0, 5) });
  if (keys.cohere?.trim() && confirmed.cohere === true) queues.push({ provider: "cohere", key: keys.cohere.trim(), models: catalog.cohere.slice(0, 5) });
  for (let round = 0; round < 5; round++) {
    for (const queue of queues) {
      const model = queue.models[round];
      if (model) attempts.push({ provider: queue.provider, key: queue.key, model: model.id });
    }
  }

  if (action === "test-auto") {
    const statuses = [];
    for (const provider of ["gemini", "pollinations", "openrouter", "groq", "cohere"]) {
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
      gemini: catalog.gemini.length, pollinations: catalog.pollinations.length, openrouter: catalog.openrouter.length,
      groq: catalog.groq.length, cohere: catalog.cohere.length
    }};
  }
  if (!attempts.length) throw new Error("لم يتم إعداد أي مزوّد مؤهل للوضع المجاني. أدخل مفتاح Gemini أو مفاتيح مزودين آخرين. فعّل تأكيد الخطة المجانية لـ Groq/Cohere فقط إذا كنت متأكداً من نوع حسابك.");
  const failures = [];
  const rateLimitedProviders = new Set();
  // Try more than one provider, but never keep hammering a provider after it returns 429.
  for (const item of attempts.slice(0, 10)) {
    if (rateLimitedProviders.has(item.provider)) continue;
    try {
      const data = await runAgentPipeline(item.provider, item.key, item.model, p);
      const steps = Array.isArray(data?.agent?.steps) ? data.agent.steps : [];
      const providerWasRateLimited = steps.some(step => step.step === "provider_usage" && step.status === "rate_limited");
      if (providerWasRateLimited) {
        const error = "تم إنشاء مسودة جزئية، لكن المزود تجاوز حد الاستخدام أثناء مراحل التدقيق؛ لن تُعتمد النتيجة كنجاح كامل.";
        rateLimitedProviders.add(item.provider);
        failures.push({ provider: item.provider, model: item.model, error });
        console.warn(JSON.stringify({ event: "promptforge_auto_provider_rate_limited_mid_pipeline", provider: item.provider, model: item.model, error }));
        continue;
      }
      data.routing = { mode: "auto-free", provider: item.provider, model: item.model, fallbackCount: failures.length,
        attempted: failures.map(x => ({ provider: x.provider, model: x.model, error: x.error })) };
      return data;
    } catch (e) {
      const error = String(e?.message || e).slice(0, 450);
      if (/HTTP 429|rate limit|rate_limit|TPM|OTPM/i.test(error)) rateLimitedProviders.add(item.provider);
      failures.push({ provider: item.provider, model: item.model, error });
      console.warn(JSON.stringify({ event: "promptforge_auto_fallback", provider: item.provider, model: item.model, error }));
    }
  }
  const isRateLimited = f => /HTTP 429|rate limit|rate_limit|TPM/i.test(f.error);
  const rateLimited = failures.some(isRateLimited);
  const allRateLimited = failures.length > 0 && failures.every(isRateLimited);
  const unavailable = failures.some(f => /HTTP 503|HTTP 502|timeout|timed out|aborted/i.test(f.error));
  const has503 = failures.some(f => /HTTP 503|UNAVAILABLE|high demand/i.test(f.error));
  const has429 = failures.some(isRateLimited);
  const headline = allRateLimited
    ? "كل النماذج التي جُرّبت رفضت الطلب بسبب حد الاستخدام (429). تحقق من الحصة في لوحة المزود أو استخدم مزودًا آخر."
    : has503 && has429
      ? "Gemini يواجه ضغطًا مؤقتًا (503) ونموذج آخر تجاوز حد الاستخدام (429). أُعيدت محاولة 503 تلقائيًا؛ جرّب لاحقًا أو أضف مزودًا بديلًا."
      : unavailable && !rateLimited
        ? "النماذج التي جُرّبت غير متاحة مؤقتًا (مهلة/503). أُعيدت محاولة 503 تلقائيًا؛ جرّب لاحقًا أو أضف مزودًا بديلًا."
        : "فشل بعض مزودي النماذج لأسباب مختلفة؛ راجع خطأ كل نموذج أدناه. أخطاء 400/404 تتطلب تعديل إعداد النموذج، أما 429 فتعني حد استخدام.";
  throw new Error(headline + " " + failures.map(f => `${f.provider}/${f.model}: ${f.error}`).join(" | ").slice(0, 1400));
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
    const message = String(error?.message || "حدث خطأ غير متوقع في تنفيذ الوكيل.").slice(0, 1400);
    const requestId = (globalThis.crypto?.randomUUID?.() || "pf-" + Date.now().toString(36));
    const upstreamMatch = message.match(/HTTP (400|401|403|404|408|409|413|429|500|502|503|504)\b/);
    const status = upstreamMatch || /تعذر الاتصال بمزود|استجابة فارغة من النموذج|ليست JSON صالحًا/.test(message) ? 502 : 500;
    console.error(JSON.stringify({
      event: "promptforge_request_failed",
      request_id: requestId,
      action: req.body?.action || "generate",
      provider: req.body?.provider || "unknown",
      model: req.body?.model || "unknown",
      status,
      error_name: error?.name || "Error",
      message
    }));
    return res.status(status).json({ error: message, requestId, errorType: status === 502 ? "upstream_provider_error" : "internal_error" });
  }
}