const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const base = process.env.PHOTO_DESK_URL || 'http://127.0.0.1:4317';
let token;
async function api(route, value) {
  const response = await fetch(base + route, value ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Token': token }, body: JSON.stringify(value) } : {});
  const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
}
async function main() {
  const boot = await api('/api/bootstrap'); token = boot.token;
  const job = await api('/api/start', { text: 'رز\nمكرونة الملكة\nجبنة دومتي بالزيتون\nSamsung Galaxy A55\nAdidas Samba OG\nL\'Oreal Paris Elvive shampoo\nBosch GSB 13 RE drill', output: path.join(__dirname, '..', 'test-output'), format: 'jpg' });
  console.log('LIVE_JOB=' + job.id);
  let latest = job, last = '', attempts = 0;
  while (latest.status === 'running' || latest.status === 'pending') {
    if (++attempts > 180) throw new Error('Live test timed out.');
    await new Promise(resolve => setTimeout(resolve, 2000));
    latest = await api('/api/job?id=' + job.id);
    const report = latest.products.map(p => `${p.name}: ${p.status}, candidates=${p.candidates.length}, downloaded=${!!p.draftFile}`).join('\n');
    if (report !== last) { console.log(report); last = report; }
  }
  assert.equal(latest.products[0].draftFile, undefined, 'Generic rice must not download automatically');
  for (const product of latest.products) {
    if (product.draftFile) {
      const metadata = await sharp(path.join(latest.output, product.draftFile)).metadata();
      assert.ok(metadata.width >= 180 && metadata.height >= 180);
      assert.ok(metadata.width <= 1400 && metadata.height <= 1400);
    }
  }
  await fs.writeFile(path.join(__dirname, '..', 'test-output', 'live-results.json'), JSON.stringify(latest, null, 2));
  console.log('SUMMARY=' + JSON.stringify(latest.products.map(p => ({ name: p.name, candidates: p.candidates.length, downloaded: !!p.draftFile, selectedTitle: p.candidates.find(c => c.id === p.selected)?.title, error: p.error }))));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
