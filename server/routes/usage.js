const express = require('express');
const { getDB } = require('../db');
const { requireAuth } = require('../auth');
const { dailySeries, summarize, byModel } = require('../services/usage');

const router = express.Router();

function withinDays(entries, days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return entries.filter((e) => new Date(e.createdAt).getTime() >= cutoff);
}

function withinCurrentMonth(entries) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return entries.filter((e) => {
    const d = new Date(e.createdAt);
    return d.getUTCFullYear() === y && d.getUTCMonth() === m;
  });
}

router.get('/summary', requireAuth, (req, res) => {
  const db = getDB();
  // Non-admins can only ever see their own usage; admins can opt into a
  // team-wide view via ?scope=all.
  const wantsAll = req.query.scope === 'all' && req.user.isAdmin;
  const scope = wantsAll ? 'all' : 'self';
  const entries = wantsAll ? db.usage : db.usage.filter((e) => e.userId === req.user.id);

  const series = dailySeries(entries, 183); // ~6 months, for the heatmap
  const trend90 = series.slice(-90);

  const modelBreakdown = byModel(entries);
  const hasPricingGaps = modelBreakdown.some((m) => m.cost == null && (m.inputTokens || m.outputTokens));

  res.json({
    scope,
    today: summarize(withinDays(entries, 1)),
    last7Days: summarize(withinDays(entries, 7)),
    lifetime: summarize(entries),
    dailySeries: series,
    trend90,
    byModel: modelBreakdown,
    hasPricingGaps,
    monthlyBudgetUSD: db.settings.monthlyBudgetUSD || null,
    monthSpend: summarize(withinCurrentMonth(entries)).cost
  });
});

module.exports = router;
