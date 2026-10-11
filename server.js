const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { parseProducts, filename, searchImages, saveImage, manifestCsv } = require('./lib');

const ROOT = __dirname, DATA = path.join(ROOT, '.data'), WEB = path.join(ROOT, 'web');
const TOKEN = crypto.randomBytes(24).toString('hex');
const jobs = new Map(), controllers = new Map(), busyProducts = new Set();
let port;

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file + '.tmp', JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(file + '.tmp', file);
}

// Serialize writes per job so polling/mutations never race the temporary file.
const writes = new Map();
function persist(job) {
  const snapshot = JSON.parse(JSON.stringify(job));
  const promise = (writes.get(job.id) || Promise.resolve()).catch(() => {}).then(async () => {
    await atomicJson(path.join(DATA, job.id + '.json'), snapshot);
    await fs.writeFile(path.join(job.output, 'report.csv'), manifestCsv(snapshot), 'utf8');
  });
  writes.set(job.id, promise);
  return promise;
}

function getJob(id) { const job = jobs.get(id); if (!job) throw new Error('الدفعة دي مش موجودة.'); return job; }
function getProduct(job, id) { const p = job.products.find(x => x.id === id); if (!p) throw new Error('المنتج مش موجود.'); return p; }
function publicJob(job) {
  return { ...job, products: job.products.map(p => ({ ...p, previewUrl: p.draftFile ? `/api/photo?job=${job.id}&product=${p.id}` : null })) };
}

async function downloadCandidate(job, p, candidate, signal) {
  const key = job.id + '/' + p.id;
  if (busyProducts.has(key)) throw new Error('المنتج ده بيتحمّل بالفعل.');
  busyProducts.add(key);
  try {
    const extension = job.format === 'webp' ? 'webp' : 'jpg';
    const relative = path.join('review', `${filename(p.name, p.id)}-${candidate.id}.${extension}`);
    const target = path.join(job.output, relative);
    const info = await saveImage(candidate.imageUrl, target, { format: job.format, signal });
    // Previous approval remains until a new image is successfully downloaded.
    if (p.approvedFile) {
      await fs.rename(path.join(job.output, p.approvedFile), path.join(job.output, 'review', 'previous-' + path.basename(p.approvedFile))).catch(() => {});
      delete p.approvedFile;
    }
    p.selected = candidate.id; p.draftFile = relative; p.image = info; p.status = 'review'; p.error = '';
  } finally { busyProducts.delete(key); }
}

async function runJob(job, apiKey = '') {
  if (controllers.has(job.id)) throw new Error('الدفعة شغالة بالفعل.');
  const controller = new AbortController(); controllers.set(job.id, controller);
  job.status = 'running'; job.error = ''; await persist(job);
  try {
    for (const p of job.products) {
      if (controller.signal.aborted) break;
      if (!['pending', 'error', 'searching'].includes(p.status)) continue;
      p.status = 'searching'; p.error = ''; await persist(job);
      try {
        p.candidates = await searchImages(p, { suffix: job.suffix, signal: controller.signal, apiKey });
        p.status = 'review';
        const matches = p.candidates.filter(x => x.strong);
        if (matches.length) {
          let downloaded = false;
          for (const candidate of matches.slice(0, 3)) {
            if (controller.signal.aborted) break;
            try { await downloadCandidate(job, p, candidate, controller.signal); downloaded = true; break; }
            catch (e) { if (controller.signal.aborted) throw e; candidate.downloadError = e.message; }
          }
          if (!downloaded && !controller.signal.aborted) p.error = 'لقيت نتائج وصفها مطابق، لكن تنزيلها فشل. اختار بديل.';
        } else {
          p.error = 'لم يتم التنزيل تلقائيًا: ' + (p.candidates[0]?.reason || 'مفيش نتائج.');
        }
      } catch (e) {
        p.status = controller.signal.aborted ? 'pending' : 'error';
        p.error = controller.signal.aborted ? '' : (e.message || 'تعذر البحث.');
      }
      await persist(job);
      if (!controller.signal.aborted) await new Promise(resolve => {
        const finish = () => { clearTimeout(timeout); controller.signal.removeEventListener('abort', finish); resolve(); };
        const timeout = setTimeout(finish, 1100);
        controller.signal.addEventListener('abort', finish, { once: true });
      });
    }
    job.status = controller.signal.aborted ? 'paused' : 'done';
  } catch (e) { job.status = 'paused'; job.error = 'تعذر حفظ الدفعة: ' + e.message; }
  finally { controllers.delete(job.id); await persist(job); }
}

async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('الملف كبير جدًا؛ الحد 8 ميجا.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new Error('بيانات الطلب مش سليمة.'); }
}

function json(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

function localFile(job, relative) {
  const file = path.resolve(job.output, relative);
  if (!file.startsWith(path.resolve(job.output) + path.sep)) throw new Error('مسار الملف غير صالح.');
  return file;
}

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/bootstrap') return json(res, { token: TOKEN, defaultOutput: path.join(ROOT, 'product-images'), jobs: [...jobs.values()].sort((a, b) => b.created.localeCompare(a.created)).map(publicJob) });
  if (req.method === 'GET' && url.pathname === '/api/job') return json(res, publicJob(getJob(url.searchParams.get('id'))));
  if (req.method === 'GET' && url.pathname === '/api/photo') {
    const job = getJob(url.searchParams.get('job')), p = getProduct(job, url.searchParams.get('product'));
    if (!p.draftFile) throw new Error('الصورة لسه ما اتنزّلتش.');
    const data = await fs.readFile(localFile(job, p.draftFile));
    res.writeHead(200, { 'Content-Type': job.format === 'webp' ? 'image/webp' : 'image/jpeg', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    return res.end(data);
  }
  if (req.method !== 'POST') return json(res, { error: 'الطلب غير موجود.' }, 404);
  if (req.headers['x-app-token'] !== TOKEN) return json(res, { error: 'حدّث صفحة البرنامج وحاول تاني.' }, 403);
  const data = await body(req);
  if (url.pathname === '/api/quit') { json(res, { ok: true }); setTimeout(shutdown, 150); return; }
  if (url.pathname === '/api/parse') {
    let content = data.text;
    if (data.base64) {
      const bytes = Buffer.from(data.base64, 'base64');
      let encoding = data.encoding || 'utf-8';
      if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
      if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
      try { content = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
      catch { throw new Error('ترميز الملف مش مناسب. اختار Windows-1256 لو العربي ظاهر غلط.'); }
    }
    return json(res, parseProducts(content || ''));
  }
  if (url.pathname === '/api/start') {
    if (controllers.size) throw new Error('فيه دفعة بتبحث بالفعل؛ أوقفها أو استنى لما تخلص.');
    const parsed = parseProducts(data.text || '');
    const outputBase = path.resolve(String(data.output || path.join(ROOT, 'product-images')).trim());
    if (outputBase.length > 160) throw new Error('اختار مسار حفظ أقصر من 160 حرف عشان أسماء الملفات على ويندوز.');
    const id = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + crypto.randomBytes(3).toString('hex');
    const job = { id, created: new Date().toISOString(), output: path.join(outputBase, id), format: data.format === 'webp' ? 'webp' : 'jpg', suffix: String(data.suffix || '').trim().slice(0, 120), status: 'pending', products: parsed.products.map(p => ({ ...p, status: 'pending', candidates: [], selected: null })) };
    await fs.mkdir(path.join(job.output, 'ready'), { recursive: true });
    await fs.mkdir(path.join(job.output, 'review'), { recursive: true });
    jobs.set(id, job); await persist(job);
    runJob(job, String(data.apiKey || '')).catch(e => console.error('Job:', e.message));
    return json(res, publicJob(job));
  }
  const job = getJob(data.job);
  if (url.pathname === '/api/pause') { controllers.get(job.id)?.abort(); return json(res, { ok: true }); }
  if (url.pathname === '/api/resume') {
    if (controllers.size) throw new Error('استنى لحد ما الدفعة الحالية تقف.');
    if (!job.products.some(p => ['pending', 'error', 'searching'].includes(p.status))) throw new Error('البحث خلص؛ راجع الصور أو عدّل وصف المنتج.');
    runJob(job, String(data.apiKey || '')).catch(e => console.error('Job:', e.message));
    return json(res, { ok: true });
  }
  if (url.pathname === '/api/open-folder') {
    if (process.platform === 'win32') spawn('explorer.exe', [job.output], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return json(res, { path: job.output });
  }
  const p = getProduct(job, data.product);
  if (p.status === 'searching' || busyProducts.has(job.id + '/' + p.id)) throw new Error('استنى لما المنتج يخلص تحميل.');
  if (url.pathname === '/api/select') {
    const candidate = p.candidates.find(c => c.id === data.candidate);
    if (!candidate) throw new Error('الصورة مش موجودة.');
    await downloadCandidate(job, p, candidate);
  } else if (url.pathname === '/api/approve') {
    if (!p.draftFile) throw new Error('اختار وحمّل صورة الأول.');
    if (p.status === 'approved') return json(res, publicJob(job));
    const approvedFile = path.join('ready', `${filename(p.name, p.id)}.${job.format}`);
    await fs.copyFile(localFile(job, p.draftFile), localFile(job, approvedFile));
    p.approvedFile = approvedFile; p.status = 'approved'; p.error = '';
  } else if (url.pathname === '/api/skip') {
    if (p.approvedFile) {
      await fs.rename(localFile(job, p.approvedFile), path.join(job.output, 'review', 'previous-' + path.basename(p.approvedFile)));
      delete p.approvedFile;
    }
    p.status = 'skipped';
  } else if (url.pathname === '/api/research') {
    if (controllers.has(job.id)) throw new Error('أوقف الدفعة مؤقتًا قبل تعديل البحث.');
    const query = String(data.query || '').trim();
    if (!query || query.length > 350) throw new Error('اكتب وصف بحث من حرف واحد لحد 350 حرف.');
    const candidates = await searchImages({ ...p, query }, { suffix: job.suffix, apiKey: String(data.apiKey || '') });
    if (p.approvedFile) {
      await fs.rename(localFile(job, p.approvedFile), path.join(job.output, 'review', 'previous-' + path.basename(p.approvedFile)));
      delete p.approvedFile;
    }
    p.query = query; p.candidates = candidates; p.status = 'review'; p.selected = null; delete p.draftFile; delete p.image; p.error = '';
  } else return json(res, { error: 'الطلب غير موجود.' }, 404);
  await persist(job); return json(res, publicJob(job));
}

async function loadJobs() {
  await fs.mkdir(DATA, { recursive: true });
  for (const name of await fs.readdir(DATA)) {
    if (!name.endsWith('.json')) continue;
    try {
      const job = JSON.parse(await fs.readFile(path.join(DATA, name), 'utf8'));
      if (job.status === 'running') { job.status = 'paused'; job.products.filter(p => p.status === 'searching').forEach(p => { p.status = 'pending'; }); }
      jobs.set(job.id, job);
    } catch (e) { console.error('Could not load a saved job:', name, e.message); }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return json(res, { error: 'Host غير مسموح.' }, 403);
    const origin = req.headers.origin;
    if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) return json(res, { error: 'Origin غير مسموح.' }, 403);
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const staticFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
    const file = staticFiles[url.pathname];
    if (!file) { res.writeHead(404); return res.end('Not found'); }
    const bytes = await fs.readFile(path.join(WEB, file[0]));
    res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: http:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
    res.end(bytes);
  } catch (e) { if (!res.headersSent) json(res, { error: e.message || 'حصل خطأ.' }, 400); else res.end(); }
});

async function start() {
  await loadJobs();
  port = Number(process.env.PHOTO_DESK_PORT) || 4317;
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
      break;
    } catch (e) { if (e.code === 'EADDRINUSE' && attempt < 14) port++; else throw e; }
  }
  const url = `http://127.0.0.1:${port}`;
  await atomicJson(path.join(DATA, 'runtime.json.tmp-info'), { port, pid: process.pid, url });
  console.log(`Product Photos ready: ${url}`);
  if (process.argv.includes('--open') && process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function shutdown() {
  for (const controller of controllers.values()) controller.abort();
  server.close();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
start().catch(e => { console.error(e.message); process.exitCode = 1; });
