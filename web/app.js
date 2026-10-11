const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let token = '', jobs = [], current = null, page = 1, selectedProduct = null, actionBusy = false, importBusy = false, pollBusy = false, lastCards = '', lastDialog = '';
const statuses = { pending: 'منتظر البحث', searching: 'جاري البحث…', review: 'محتاج مراجعة', approved: 'جاهز للرفع', error: 'تعذر البحث', skipped: 'متخطّي' };
const imageIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 3-3 5 5"/></svg>';

async function api(endpoint, data) {
  const options = data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Token': token }, body: JSON.stringify(data) };
  const response = await fetch(endpoint, options), value = await response.json();
  if (!response.ok) throw new Error(value.error || 'حصل خطأ في البرنامج.');
  return value;
}
let toastTimer;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000); }
function errorAt(id, message) { $(id).textContent = message || ''; $(id).hidden = !message; }
function updateJob(job) {
  const old = jobs.findIndex(x => x.id === job.id);
  if (old >= 0) jobs[old] = job; else jobs.unshift(job);
  if (!current || current.id === job.id) current = job;
  renderHistory(); render();
}
function renderHistory() {
  const values = jobs.map(job => `<option value="${esc(job.id)}">${esc(new Date(job.created).toLocaleString('ar-EG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))} · ${job.products.length} منتج</option>`).join('');
  $('history').innerHTML = '<option value="">دفعة جديدة</option>' + values;
  $('history').value = current?.id || '';
}
function render() {
  const products = current?.products || [], running = current?.status === 'running';
  $('empty').hidden = !!current; $('job-panel').hidden = !current;
  $('count-total').textContent = products.length;
  $('count-downloaded').textContent = products.filter(p => p.draftFile).length;
  $('count-review').textContent = products.filter(p => p.status === 'review').length;
  $('count-approved').textContent = products.filter(p => p.status === 'approved').length;
  $('start').disabled = importBusy || actionBusy || jobs.some(j => j.status === 'running');
  if (!current) return;
  const done = products.filter(p => !['pending', 'searching'].includes(p.status)).length;
  $('progress').max = products.length || 1; $('progress').value = done;
  const statusLabel = running ? 'جاري البحث والتنزيل' : current.status === 'paused' ? 'البحث متوقف مؤقتًا' : 'البحث خلص — راجع الصور المقترحة';
  const label = `${statusLabel} · ${done} من ${products.length}${current.error ? ' · ' + current.error : ''}`;
  if ($('job-status').textContent !== label) $('job-status').textContent = label;
  $('job-path').textContent = current.output;
  $('pause').hidden = !running; $('pause').disabled = actionBusy;
  $('resume').hidden = running || !products.some(p => ['pending', 'error', 'searching'].includes(p.status)); $('resume').disabled = actionBusy;
  const needle = $('filter-text').value.toLocaleLowerCase(), status = $('filter-status').value;
  const filtered = products.filter(p => p.name.toLocaleLowerCase().includes(needle) && (status === 'all' || p.status === status));
  const maxPage = Math.max(1, Math.ceil(filtered.length / 20)); page = Math.min(page, maxPage);
  const visible = filtered.slice((page - 1) * 20, page * 20);
  const html = visible.map(p => {
    const selected = p.candidates?.find(x => x.id === p.selected);
    const disabled = actionBusy || p.status === 'searching';
    const photo = p.previewUrl ? `<img src="${esc(p.previewUrl)}&v=${esc(p.selected)}" alt="الصورة المختارة لـ ${esc(p.name)}" loading="lazy" width="84" height="92">` : imageIcon;
    const note = p.error || (p.status === 'approved' ? 'تم حفظ الصورة في ready؛ تقدر ترفعها على موقعك.' : selected ? `تطابق الوصف ${selected.score}% · ${p.image?.width} × ${p.image?.height} بكسل. راجع المنتج.` : p.status === 'pending' || p.status === 'searching' ? 'هنبحث عن الصورة باسم المنتج.' : 'اختار صورة من البدائل، أو ضيف تفاصيل للاسم.');
    return `<article class="product-card"><div class="card-top"><div class="photo-box">${photo}</div><div class="card-copy"><h3>${esc(p.name)}</h3><span class="badge ${esc(p.status)}">${esc(statuses[p.status] || p.status)}</span></div></div><p class="card-note">${esc(note)}</p><div class="card-actions"><button class="secondary" type="button" data-action="review" data-id="${p.id}" ${disabled ? 'disabled' : ''}>${p.candidates.length ? 'عرض البدائل' : 'تعديل البحث'}</button><button class="${p.status === 'approved' ? 'secondary' : 'primary'}" type="button" data-action="approve" data-id="${p.id}" ${disabled || !p.draftFile || p.status === 'approved' ? 'disabled' : ''}>${p.status === 'approved' ? 'معتمدة' : 'اعتماد الصورة'}</button></div></article>`;
  }).join('') || '<p class="hint">مفيش منتجات تحت الفلتر ده.</p>';
  if (lastCards !== html) { $('cards').innerHTML = html; lastCards = html; }
  $('page-label').textContent = `${page} / ${maxPage} · ${filtered.length} منتج`;
  $('previous').disabled = page <= 1; $('next').disabled = page >= maxPage;
  if ($('review-dialog').open) renderDialog();
}

function renderDialog(resetQuery = false) {
  const p = current?.products.find(x => x.id === selectedProduct);
  if (!p) return;
  const signature = JSON.stringify([p, current.status, actionBusy]);
  if (!resetQuery && signature === lastDialog) return;
  lastDialog = signature;
  $('dialog-title').textContent = p.name;
  if (resetQuery) $('query').value = p.query;
  $('research').disabled = actionBusy || current.status === 'running';
  $('research').title = current.status === 'running' ? 'أوقف البحث مؤقتًا قبل تغيير الوصف.' : '';
  $('dialog-approve').disabled = actionBusy || !p.draftFile || p.status === 'approved';
  $('dialog-approve').textContent = p.status === 'approved' ? 'الصورة معتمدة' : 'اعتماد الصورة المختارة';
  $('dialog-skip').disabled = actionBusy;
  $('candidates').innerHTML = p.candidates.map(c => {
    const selected = p.selected === c.id;
    return `<article class="candidate ${selected ? 'chosen' : ''}"><img src="${esc(c.thumbnailUrl)}" alt="${esc(c.title || 'صورة مقترحة للمنتج')}" loading="lazy" width="160" height="130"><h3>${esc(c.title || 'صورة بدون وصف')}</h3><div class="score">تطابق الوصف ${c.score}%</div><p class="hint">${esc(c.reason)}</p>${c.downloadError ? `<p class="hint">تعذر التنزيل: ${esc(c.downloadError)}</p>` : ''}${c.sourceUrl ? `<a href="${esc(c.sourceUrl)}" target="_blank" rel="noopener noreferrer">زيارة مصدر الصورة ↗</a>` : ''}<div class="spacer"></div><button type="button" class="${selected ? 'primary' : 'secondary'}" data-candidate="${c.id}" ${actionBusy || selected ? 'disabled' : ''}>${selected ? 'الصورة المختارة' : 'اختار ونزّل'}</button></article>`;
  }).join('') || '<p class="hint">اكتب الماركة والنوع في وصف البحث، واضغط «ابحث تاني» بعد انتهاء الدفعة أو إيقافها.</p>';
}

async function productAction(action, product, extra = {}) {
  if (!current || actionBusy) return;
  const jobId = current.id;
  actionBusy = true; errorAt('dialog-error', ''); render(); if ($('review-dialog').open) renderDialog();
  try {
    const value = await api('/api/' + action, { job: jobId, product, ...extra });
    if (current?.id === jobId) updateJob(value);
    if ($('review-dialog').open) renderDialog();
    toast(action === 'approve' ? 'الصورة اتنسخت لمجلد ready.' : action === 'select' ? 'الصورة نزلت. راجعها وبعدها اعتمدها.' : action === 'skip' ? 'تم تخطّي المنتج.' : 'نتائج البحث اتحدّثت.');
  } catch (e) { if ($('review-dialog').open) errorAt('dialog-error', e.message); else toast(e.message); }
  finally { actionBusy = false; render(); if ($('review-dialog').open) renderDialog(); }
}

$('examples').addEventListener('click', () => { $('names').value = 'رز\nمكرونة الملكة\nجبنة دومتي بالزيتون'; $('names').focus(); errorAt('form-error', ''); });
async function importFile() {
  const file = $('file').files[0]; if (!file) return;
  if (file.size > 5 * 1024 * 1024) return errorAt('form-error', 'الملف كبير؛ الحد 5 ميجا.');
  importBusy = true; render(); errorAt('form-error', '');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer()), chunks = [];
    for (let i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
    const value = await api('/api/parse', { base64: btoa(chunks.join('')), encoding: $('encoding').value });
    $('names').value = value.products.map(p => p.name === p.query ? p.name : `${p.name} | ${p.query}`).join('\n');
    $('file-label').textContent = file.name;
    toast(`تمت قراءة ${value.products.length} منتج${value.duplicates ? `، وتجاهل ${value.duplicates} مكرر` : ''}.`);
  } catch (e) { errorAt('form-error', e.message); }
  finally { importBusy = false; render(); }
}
$('file').addEventListener('change', importFile); $('encoding').addEventListener('change', importFile);
$('setup-form').addEventListener('submit', async event => {
  event.preventDefault(); if (actionBusy || importBusy) return;
  actionBusy = true; render(); errorAt('form-error', '');
  try {
    const job = await api('/api/start', { text: $('names').value, output: $('output').value, suffix: $('suffix').value, format: $('format').value, apiKey: $('api-key').value });
    current = job; page = 1; updateJob(job); toast('البحث بدأ. تقدر توقفه وتستكمله بعدين.');
  } catch (e) { errorAt('form-error', e.message); }
  finally { actionBusy = false; render(); }
});
$('history').addEventListener('change', () => { current = jobs.find(j => j.id === $('history').value) || null; page = 1; lastCards = ''; render(); });
for (const id of ['filter-text', 'filter-status']) $(id).addEventListener(id === 'filter-text' ? 'input' : 'change', () => { page = 1; render(); });
$('previous').addEventListener('click', () => { page--; render(); }); $('next').addEventListener('click', () => { page++; render(); });
$('cards').addEventListener('click', event => {
  const button = event.target.closest('button[data-action]'); if (!button || !current) return;
  if (button.dataset.action === 'review') { selectedProduct = button.dataset.id; errorAt('dialog-error', ''); renderDialog(true); $('review-dialog').showModal(); }
  else productAction('approve', button.dataset.id);
});
$('close-dialog').addEventListener('click', () => $('review-dialog').close());
$('candidates').addEventListener('click', event => { const button = event.target.closest('button[data-candidate]'); if (button) productAction('select', selectedProduct, { candidate: button.dataset.candidate }); });
$('dialog-approve').addEventListener('click', () => productAction('approve', selectedProduct));
$('dialog-skip').addEventListener('click', () => productAction('skip', selectedProduct));
$('research-form').addEventListener('submit', event => { event.preventDefault(); productAction('research', selectedProduct, { query: $('query').value, apiKey: $('api-key').value }); });
for (const action of ['pause', 'resume']) $(action).addEventListener('click', async () => {
  if (!current || actionBusy) return;
  actionBusy = true; render();
  try { await api('/api/' + action, { job: current.id, apiKey: $('api-key').value }); toast(action === 'pause' ? 'جاري إيقاف البحث…' : 'البحث اتستكمل.'); await refresh(); }
  catch (e) { toast(e.message); }
  finally { actionBusy = false; render(); }
});
$('open-folder').addEventListener('click', async () => { if (current) { try { await api('/api/open-folder', { job: current.id }); } catch (e) { toast(e.message); } } });
async function refresh() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const values = await Promise.all(jobs.filter(j => j.status === 'running' || j.id === current?.id).map(j => api('/api/job?id=' + encodeURIComponent(j.id))));
    for (const value of values) {
      const index = jobs.findIndex(j => j.id === value.id); jobs[index] = value;
      if (current?.id === value.id) current = value;
    }
    render();
  } finally { pollBusy = false; }
}
async function init() {
  try { const value = await api('/api/bootstrap'); token = value.token; jobs = value.jobs; $('output').value = value.defaultOutput; renderHistory(); render(); }
  catch (e) { errorAt('form-error', 'تعذر الاتصال بالبرنامج. افتح أداة التشغيل تاني.'); }
}
init(); setInterval(() => refresh().catch(() => {}), 1500);
