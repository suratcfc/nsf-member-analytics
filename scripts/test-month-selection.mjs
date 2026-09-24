import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const ctx = { window: {}, monthYearOrder: [2569,2568,2567,2566,2565,2564] };
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL('../data/tableau-live.js', import.meta.url), 'utf8'), ctx);
vm.runInContext('var D=window.NSF_TABLEAU_LIVE;', ctx);
for (const name of ['driveMonthEnd','reviewedCumulativeMonths','cumulativeSeries','selectableMonths']) {
  const start = html.indexOf('  function '+name+'(');
  assert.ok(start >= 0, name);
  const end = html.indexOf('\n  }', start) + 4;
  vm.runInContext(html.slice(start, end), ctx);
}
const series = vm.runInContext('selectableMonths()', ctx);
const current = series.find(s => s.year === 2569);
assert.ok(current);
assert.equal(current.months.filter(m => ['2026-01','2026-02'].includes(m.key)).reduce((n,m)=>n+m.members,0),11617);
for (const s of series) {
  assert.equal(new Set(s.months.map(m=>m.key)).size,s.months.length);
  assert.ok(s.months.every(m=>Number.isInteger(m.members)&&m.members>=0));
  const expected = s.year===2569 ? ctx.window.NSF_TABLEAU_LIVE.totals.members : ctx.window.NSF_TABLEAU_LIVE.cumulativeYears.find(h=>h.year===s.year).members;
  assert.equal(s.months.reduce((n,m)=>n+m.members,0),expected,'annual reconciliation '+s.year);
}
assert.ok(!current.months.some(m=>m.key > current.asOf.slice(0,7)));
const prior = series.find(s=>s.year===2568);
assert.equal(prior.months.length,12);
assert.equal(prior.months.filter(m=>m.partial).length,0);
assert.equal(prior.months[11].members,9722);
assert.equal(11617+prior.months[11].members,21339);
console.log('Month selection tests passed: example, full years, missing months, cross-year totals.');
