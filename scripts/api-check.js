const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:4317';
let token;
async function api(route, data) {
  const response = await fetch(base + route, data ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Token': token }, body: JSON.stringify(data) } : {});
  const value = await response.json(); if (!response.ok) throw new Error(value.error); return value;
}
async function main() {
  token = (await api('/api/bootstrap')).token;
  const text = 'مكرونة الملكة\nجبنة دومتي بالزيتون';
  const unicode = await api('/api/parse', { base64: Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, 'utf16le')]).toString('base64') });
  assert.equal(unicode.products[0].name, 'مكرونة الملكة');
  const legacy = await api('/api/parse', { base64: Buffer.from([0xd1, 0xd2]).toString('base64'), encoding: 'windows-1256' });
  assert.equal(legacy.products[0].name, 'رز');
  const denied = await fetch(base + '/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'rice' }) });
  assert.equal(denied.status, 403);
  const crossOrigin = await fetch(base + '/api/bootstrap', { headers: { Origin: 'https://example.com' } });
  assert.equal(crossOrigin.status, 403);
  const saved = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'test-output', 'live-results.json'), 'utf8'));
  let job = await api('/api/approve', { job: saved.id, product: '2' });
  const p = job.products.find(p => p.id === '2'); assert.equal(p.status, 'approved');
  const original = await fs.readFile(path.join(job.output, p.draftFile));
  const approved = await fs.readFile(path.join(job.output, p.approvedFile));
  assert.deepEqual(original, approved);
  const manifest = await fs.readFile(path.join(job.output, 'report.csv'), 'utf8'); assert.ok(manifest.includes('approved')); assert.ok(manifest.includes('amazon'));
  const photo = await fetch(base + `/api/photo?job=${job.id}&product=2`); assert.equal(photo.status, 200); assert.equal(photo.headers.get('content-type'), 'image/jpeg');
  // A separate one-item job exercises cancellation and retry without touching the downloaded samples.
  let paused = await api('/api/start', { text: 'رز', output: path.join(__dirname, '..', 'test-output') });
  await api('/api/pause', { job: paused.id });
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250)); paused = await api('/api/job?id=' + paused.id);
    if (paused.status !== 'running') break;
  }
  assert.equal(paused.status, 'paused');
  await api('/api/resume', { job: paused.id });
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1000)); paused = await api('/api/job?id=' + paused.id);
    if (paused.status !== 'running') break;
  }
  assert.equal(paused.status, 'done'); assert.equal(paused.products[0].draftFile, undefined);
  await fs.writeFile(path.join(__dirname, '..', 'test-output', 'api-results.json'), JSON.stringify({ passed: true, jobId: saved.id, pauseJobId: paused.id, checks: ['UTF-16', 'Windows-1256', 'CSRF token', 'origin restriction', 'approval file copy', 'source report', 'image preview', 'pause and resume'] }, null, 2));
  console.log('API PASS: encoding, request protection, ready folder, CSV sources, preview, cancellation and resume.');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
