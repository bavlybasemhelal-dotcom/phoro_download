const fs = require('node:fs/promises');
const path = require('node:path');
const dns = require('node:dns/promises');
const net = require('node:net');
const sharp = require('sharp');

const MAX_IMAGE_BYTES = 18 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const aliases = {
  مكرونه: ['pasta', 'macaroni'], الملكه: ['el maleka', 'elmaleka', 'al maleka', 'almaleka'],
  جبنه: ['cheese'], دومتي: ['domty', 'domti'], زيتون: ['olive', 'olives'],
  رز: ['rice'], ارز: ['rice'], لبن: ['milk'], حليب: ['milk'], بيبسي: ['pepsi'],
  كوكاكولا: ['coca cola', 'coca-cola'], شيبسي: ['chipsy'], جهينه: ['juhayna'],
  بسكويت: ['biscuit', 'biscuits'], شاي: ['tea'], سكر: ['sugar'], زيت: ['oil'],
  فراوله: ['strawberry'], شوكولاته: ['chocolate'], برتقال: ['orange'],
  سامسونج: ['samsung'], ايفون: ['iphone'], ابل: ['apple'], شاومي: ['xiaomi'],
  اديداس: ['adidas'], نايك: ['nike'], لوريال: ['l oreal', 'loreal'],
  شامبو: ['shampoo'], بوش: ['bosch'], ليجو: ['lego'], لوجيتك: ['logitech'],
};
const ignored = new Set(['بال', 'ب', 'في', 'مع', 'من', 'عبوه', 'علبه', 'كيس', 'منتج', 'product', 'pack', 'the', 'with', 'and']);

function normalize(value) {
  return String(value).normalize('NFKC').toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x6f0))
    .replace(/(\d)\s*(مل|ملي|ml|gm|جرام|غرام|جم|kg|كجم|كغ|g|لتر|liter|litre)\b/gi, '$1 $2')
    .replace(/[^\p{L}\p{N}.]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function tokens(value) {
  return normalize(value).split(' ').map(t => t.startsWith('بال') && t.length > 4 ? t.slice(3) : t)
    .filter(t => t && !ignored.has(t));
}

function parseProducts(text) {
  const seen = new Set(), products = [];
  let duplicates = 0;
  for (let line of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    line = line.replace(/^(?:[-*•]\s+|\d+[.)\-]\s+)/, '');
    const [name, ...queryParts] = line.split('|');
    const clean = name.trim();
    if (!clean || clean.length > 250) throw new Error('اسم المنتج لازم يكون من حرف واحد لحد 250 حرف.');
    const key = normalize(clean);
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    const query = queryParts.join('|').trim() || clean;
    if (query.length > 350) throw new Error('وصف البحث طويل؛ الحد 350 حرف.');
    products.push({ id: String(products.length + 1), name: clean, query });
  }
  if (!products.length) throw new Error('اكتب اسم منتج واحد على الأقل، كل منتج في سطر.');
  if (products.length > 2500) throw new Error('قسم القائمة لأجزاء؛ الحد 2500 منتج في المرة.');
  return { products, duplicates };
}

function filename(name, id) {
  const clean = String(name).normalize('NFC').replace(/[\x00-\x1f<>:"/\\|?*]/g, ' ')
    .replace(/[.\s]+$/g, '').trim().slice(0, 85) || 'product';
  return `${String(id).padStart(4, '0')}-${clean}`;
}

function htmlDecode(value) {
  return String(value).replace(/&(?:quot|amp|lt|gt|apos|#\d+|#x[\da-f]+);/gi, entity => {
    const known = { '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&apos;': "'" };
    if (known[entity.toLowerCase()]) return known[entity.toLowerCase()];
    const code = entity.toLowerCase().startsWith('&#x') ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

function httpUrl(value) {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; }
  catch { return ''; }
}

function parseBing(html) {
  const images = [], seen = new Set();
  for (const match of html.matchAll(/\bm=(?:"([^"]+)"|'([^']+)')/g)) {
    try {
      const item = JSON.parse(htmlDecode(match[1] || match[2]));
      const imageUrl = httpUrl(item.murl);
      if (!imageUrl || seen.has(imageUrl)) continue;
      seen.add(imageUrl);
      images.push({ imageUrl, thumbnailUrl: httpUrl(item.turl) || imageUrl, sourceUrl: httpUrl(item.purl), title: String(item.t || item.desc || '').replace(/[\uE000-\uF8FF]/g, '') });
    } catch { /* A malformed search tile is skipped. */ }
  }
  return images;
}

function rankCandidate(product, candidate) {
  let decoded = candidate.sourceUrl + ' ' + candidate.imageUrl;
  try { decoded = decodeURIComponent(decoded); } catch { /* Leave malformed escapes unchanged. */ }
  const haystack = normalize(candidate.title + ' ' + decoded);
  const wanted = tokens(product.query);
  const matched = [], missing = [];
  for (const token of wanted) {
    const options = [token, ...(aliases[token] || [])];
    const found = options.some(option => {
      const target = normalize(option);
      if (/^\d+(?:\.\d+)?$/.test(target)) return new RegExp(`(?:^|[^0-9])${target.replace('.', '\\.')}(?:$|[^0-9])`).test(haystack);
      return (` ${haystack} `).includes(` ${target} `) || (target.length > 3 && haystack.includes(target));
    });
    (found ? matched : missing).push(token);
  }
  const coverage = wanted.length ? matched.length / wanted.length : 0;
  // This is metadata coverage, never a probability of visual correctness.
  const score = Math.round(coverage * 100);
  const generic = wanted.length < 2;
  return { ...candidate, score, missing, generic, strong: !generic && missing.length === 0, reason: generic ? 'الاسم عام؛ أضف الماركة أو النوع.' : missing.length ? 'الوصف ناقص: ' + missing.join('، ') : 'كلمات البحث موجودة في الوصف؛ راجع شكل المنتج.' };
}

function sourcePriority(candidate) {
  let url;
  try { url = new URL(candidate.sourceUrl); } catch { return 0; }
  const host = url.hostname.toLowerCase();
  const official = ['samsung.com', 'adidas.com', 'adidas.ae', 'bosch-professional.com', 'lorealparisusa.com'];
  let priority = official.some(domain => host === domain || host.endsWith('.' + domain)) ? 20 : 0;
  if (/\/(?:products?|shop|store|item|dp)\//i.test(url.pathname)) priority += 5;
  if (/\b(?:news|review|comparison|versus|insurance|assurance|manual|tutorial|renders|leak)\b|مقارنه|مراجعه|تسريب/i.test(normalize(candidate.title + ' ' + url.pathname))) priority -= 10;
  return priority;
}

async function searchImages(product, { suffix = '', signal, apiKey = '' } = {}) {
  const query = `${product.query} ${suffix}`.trim();
  let candidates;
  if (apiKey) {
    const response = await fetch('https://google.serper.dev/images', { method: 'POST', headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: query, gl: 'eg', hl: 'ar', num: 20 }), signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(25000)]) });
    if (!response.ok) throw new Error(`خدمة البحث رجّعت ${response.status}؛ راجع المفتاح أو الرصيد.`);
    const data = await response.json();
    candidates = (data.images || []).filter(x => httpUrl(x.imageUrl)).map(x => ({ title: x.title || '', imageUrl: httpUrl(x.imageUrl), thumbnailUrl: httpUrl(x.thumbnailUrl) || httpUrl(x.imageUrl), sourceUrl: httpUrl(x.link) }));
  } else {
    const url = new URL('https://www.bing.com/images/search');
    url.searchParams.set('q', query); url.searchParams.set('setlang', 'ar'); url.searchParams.set('adlt', 'strict');
    const response = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(25000)]) });
    if (!response.ok) throw new Error(`البحث متوقف مؤقتًا (${response.status}). جرّب بعد شوية أو استخدم مفتاح Serper.`);
    candidates = parseBing(await response.text());
    if (!candidates.length) throw new Error('البحث ما رجّعش صور قابلة للقراءة. ممكن الخدمة تكون وقفت الطلب؛ جرّب لاحقًا أو مفتاح Serper.');
  }
  const unique = [...new Map(candidates.map(x => [x.imageUrl, x])).values()];
  return unique.map(x => rankCandidate(product, x)).sort((a, b) => b.score - a.score || sourcePriority(b) - sourcePriority(a)).slice(0, 8).map((x, i) => ({ ...x, id: String(i + 1) }));
}

function publicIp(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)));
  }
  if (net.isIP(address) === 6) {
    if (address.toLowerCase().startsWith('::ffff:')) {
      const rest = address.slice(7);
      if (net.isIP(rest) === 4) return publicIp(rest);
      const parts = rest.split(':');
      if (parts.length === 2) return publicIp(`${parseInt(parts[0], 16) >> 8}.${parseInt(parts[0], 16) & 255}.${parseInt(parts[1], 16) >> 8}.${parseInt(parts[1], 16) & 255}`);
      return false;
    }
    return /^2[0-9a-f]{3}:/i.test(address); // Global unicast only.
  }
  return false;
}

async function validateRemote(url) {
  const safe = httpUrl(url);
  if (!safe) throw new Error('رابط الصورة لازم يبدأ بـ https أو http.');
  const u = new URL(safe);
  if (u.port && !['80', '443'].includes(u.port)) throw new Error('منفذ الرابط غير مدعوم.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!ips.length || ips.some(x => !publicIp(x.address))) throw new Error('روابط الشبكة المحلية غير مدعومة.');
  return safe;
}

async function imageBytes(url, signal) {
  let current = url;
  for (let step = 0; step < 5; step++) {
    current = await validateRemote(current);
    const response = await fetch(current, { redirect: 'manual', headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.5' }, signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(20000)]) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('تحويل رابط الصورة غير مكتمل.');
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`موقع الصورة رفض التحميل (${response.status}).`); }
    if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) { await response.body?.cancel(); throw new Error('الصورة أكبر من 18 ميجا.'); }
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_IMAGE_BYTES) throw new Error('الصورة أكبر من 18 ميجا.');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks);
  }
  throw new Error('رابط الصورة بيحوّل مرات كتير.');
}

async function prepareImage(input, format = 'jpg') {
  const metadata = await sharp(input, { limitInputPixels: 40_000_000 }).metadata();
  if (!['jpeg', 'png', 'webp', 'avif', 'heif', 'gif', 'tiff'].includes(metadata.format)) throw new Error('الملف مش صورة مناسبة.');
  if (Math.min(metadata.width || 0, metadata.height || 0) < 180) throw new Error('الصورة صغيرة جدًا؛ أقل ضلع لازم يكون 180 بكسل.');
  let pipeline = sharp(input, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true });
  pipeline = format === 'webp' ? pipeline.webp({ quality: 88 }) : pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 90, mozjpeg: true });
  return pipeline.toBuffer({ resolveWithObject: true });
}

async function saveImage(url, target, { format = 'jpg', signal } = {}) {
  const input = await imageBytes(url, signal);
  const { data, info } = await prepareImage(input, format);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target + '.tmp', data);
  await fs.rename(target + '.tmp', target);
  return { width: info.width, height: info.height, bytes: data.length };
}

function csvCell(value) {
  let s = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

function manifestCsv(job) {
  const rows = [['اسم المنتج', 'البحث', 'الحالة', 'ملف الصورة', 'المصدر', 'رابط الصورة', 'تطابق الوصف', 'ملاحظة']];
  for (const p of job.products) {
    const candidate = p.candidates?.find(x => x.id === p.selected);
    rows.push([p.name, p.query, p.status, p.approvedFile || p.draftFile || '', candidate?.sourceUrl || '', candidate?.imageUrl || '', candidate?.score ?? '', p.error || candidate?.reason || '']);
  }
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}

module.exports = { normalize, tokens, parseProducts, filename, htmlDecode, parseBing, rankCandidate, sourcePriority, searchImages, publicIp, validateRemote, prepareImage, saveImage, manifestCsv };
