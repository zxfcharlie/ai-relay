const { nanoid } = require('nanoid');

// Cost is computed and stored at write time, against whatever pricing is
// configured *then* — later admin price edits don't rewrite history, same
// as how a real bill works (you pay the rate in effect when you used it).
function computeCost(pricing, modelId, inputTokens, outputTokens) {
  const rate = pricing && pricing[modelId];
  if (!rate) return null;
  const inputCost = (inputTokens / 1e6) * (Number(rate.inputPer1M) || 0);
  const outputCost = (outputTokens / 1e6) * (Number(rate.outputPer1M) || 0);
  return inputCost + outputCost;
}

// entry: { userId, conversationId, provider, model, inputTokens, outputTokens, cachedInputTokens }
function recordUsage(db, entry) {
  const inputTokens = Number(entry.inputTokens) || 0;
  const outputTokens = Number(entry.outputTokens) || 0;
  if (!inputTokens && !outputTokens) return; // nothing usable was reported — skip a zero row
  db.usage.push({
    id: nanoid(),
    userId: entry.userId,
    conversationId: entry.conversationId,
    provider: entry.provider,
    model: entry.model,
    inputTokens,
    outputTokens,
    cachedInputTokens: Number(entry.cachedInputTokens) || 0,
    cost: computeCost(db.settings.pricing, entry.model, inputTokens, outputTokens),
    createdAt: new Date().toISOString()
  });
}

function dayKey(iso) {
  return iso.slice(0, 10); // 'YYYY-MM-DD', consistent regardless of local TZ since createdAt is stored as UTC ISO
}

// Builds a continuous [{ date, tokens, cost }] series covering the last
// `days` days (including today), zero-filled where there's no usage, so
// charts/heatmaps don't have to special-case gaps.
function dailySeries(entries, days) {
  const byDay = new Map();
  for (const e of entries) {
    const k = dayKey(e.createdAt);
    const cur = byDay.get(k) || { tokens: 0, cost: 0, hasCost: false };
    cur.tokens += e.inputTokens + e.outputTokens;
    if (e.cost != null) { cur.cost += e.cost; cur.hasCost = true; }
    byDay.set(k, cur);
  }
  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const k = d.toISOString().slice(0, 10);
    const cur = byDay.get(k);
    out.push({ date: k, tokens: cur ? cur.tokens : 0, cost: cur && cur.hasCost ? cur.cost : null });
  }
  return out;
}

function summarize(entries) {
  let inputTokens = 0, outputTokens = 0, cost = 0, hasCost = false;
  for (const e of entries) {
    inputTokens += e.inputTokens;
    outputTokens += e.outputTokens;
    if (e.cost != null) { cost += e.cost; hasCost = true; }
  }
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cost: hasCost ? cost : null };
}

function byModel(entries) {
  const map = new Map();
  for (const e of entries) {
    const key = `${e.provider}:${e.model}`;
    const cur = map.get(key) || { provider: e.provider, model: e.model, inputTokens: 0, outputTokens: 0, cost: 0, hasCost: false, requests: 0 };
    cur.inputTokens += e.inputTokens;
    cur.outputTokens += e.outputTokens;
    cur.requests += 1;
    if (e.cost != null) { cur.cost += e.cost; cur.hasCost = true; }
    map.set(key, cur);
  }
  return [...map.values()]
    .map((m) => ({ ...m, totalTokens: m.inputTokens + m.outputTokens, cost: m.hasCost ? m.cost : null }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

module.exports = { recordUsage, computeCost, dailySeries, summarize, byModel };
