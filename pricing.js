// pricing.js: rough API-rate cost of a transcript's token usage (USD per million tokens).
// A Claude subscription isn't billed per token, so the UI labels this an estimate.
// Rates from the Claude API model table (2026-09-25). Cache writes are 1.25x input;
// cache reads are 0.1x input unless the model lists its own rate.
const RATES = [
  [/fable-5|mythos-5/, { in: 10, out: 50, read: 0.25 }],
  [/opus-5-5/, { in: 4, out: 20, read: 0.2 }],
  [/opus-(5|4-[5-8])/, { in: 5, out: 25 }],
  [/opus-4/, { in: 15, out: 75 }],
  [/sonnet-5/, { in: 2, out: 10, read: 0.2 }],
  [/sonnet/, { in: 3, out: 15 }],
  [/haiku-4-5/, { in: 1, out: 5 }],
  [/haiku/, { in: 0.8, out: 4 }],
];

function rate(model) {
  const r = RATES.find(([re]) => re.test(model || ''))?.[1];
  return r && { in: r.in, out: r.out, write: r.in * 1.25, read: r.read ?? r.in * 0.1 };
}

// u: { in, out, cw, cr } token counts for one model
function cost(model, u) {
  const r = rate(model);
  if (!r) return 0;
  return (u.in * r.in + u.out * r.out + u.cw * r.write + u.cr * r.read) / 1e6;
}

module.exports = { cost };
