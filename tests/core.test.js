const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { parseProducts, normalize, filename, parseBing, rankCandidate, sourcePriority, publicIp, validateRemote, prepareImage, manifestCsv } = require('../lib');

test('Arabic text, BOM, list numbering, query overrides and duplicates', () => {
  const parsed = parseProducts('\ufeff# notes\r\n1. مكرونة الملكة\r\n• جبنة دومتى بالزيتون | Domty cheese olives\nمكرونه الملكه\n\n');
  assert.equal(parsed.duplicates, 1); assert.equal(parsed.products.length, 2);
  assert.equal(parsed.products[1].query, 'Domty cheese olives');
  assert.equal(normalize('دُومْتَى ٤٠٠'), 'دومتي 400');
  assert.throws(() => parseProducts('# nothing\n\n'));
});
test('Distinct pack sizes are retained and filenames cannot escape output', () => {
  assert.equal(parseProducts('رز 400 جم\nرز 4000 جم').products.length, 2);
  const result = filename('../../CON:منتج\\test?', '12');
  assert.equal(result.includes('/'), false); assert.equal(result.includes('\\'), false);
  assert.match(result, /^0012-/);
});
test('Bing tiles decode entities, deduplicate URLs and reject non-HTTP images', () => {
  const data = JSON.stringify({ murl: 'https://example.com/image.jpg?a=1&b=2', purl: 'https://example.com/product', turl: 'https://example.com/thumb.jpg', t: 'Brand & product' }).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const html = `<a class="iusc" m="${data}"></a><a m="${data}"></a><a m="{&quot;murl&quot;:&quot;file:///C:/secret&quot;}"></a>`;
  const images = parseBing(html); assert.equal(images.length, 1);
  assert.equal(images[0].title, 'Brand & product'); assert.equal(images[0].imageUrl, 'https://example.com/image.jpg?a=1&b=2');
});
test('A generic product is never an automatic download even with full text coverage', () => {
  const c = rankCandidate({ query: 'رز' }, { title: 'Basmati rice', sourceUrl: '', imageUrl: '' });
  assert.equal(c.score, 100); assert.equal(c.generic, true); assert.equal(c.strong, false);
});
test('Brand and flavor are required, including Arabic-to-English aliases', () => {
  const query = { query: 'جبنة دومتي بالزيتون' };
  const full = rankCandidate(query, { title: 'Domty cheese with olives', sourceUrl: '', imageUrl: '' });
  assert.equal(full.strong, true);
  const wrongFlavor = rankCandidate(query, { title: 'Domty cheese with pepper', sourceUrl: '', imageUrl: '' });
  assert.equal(wrongFlavor.strong, false); assert.deepEqual(wrongFlavor.missing, ['زيتون']);
  const wrongBrand = rankCandidate(query, { title: 'Other cheese with olives', sourceUrl: '', imageUrl: '' });
  assert.equal(wrongBrand.strong, false); assert.ok(wrongBrand.missing.includes('دومتي'));
});
test('Numbers do not match different larger pack sizes', () => {
  const wrong = rankCandidate({ query: 'Brand rice 400' }, { title: 'Brand rice 4000g', sourceUrl: '', imageUrl: '' });
  assert.equal(wrong.strong, false); assert.ok(wrong.missing.includes('400'));
});
test('Matched product pages are preferred over insurance, leaks and articles', () => {
  const official = sourcePriority({ sourceUrl: 'https://www.samsung.com/eg/product/galaxy-a55', title: 'Samsung Galaxy A55' });
  const fakeOfficial = sourcePriority({ sourceUrl: 'https://samsung.com.fake.example/product/a55', title: 'Samsung Galaxy A55' });
  const insurance = sourcePriority({ sourceUrl: 'https://example.com/insurance/a55', title: 'Assurance Samsung Galaxy A55' });
  assert.ok(official > fakeOfficial); assert.ok(fakeOfficial > insurance);
});
test('Local and private download URLs are rejected, including mapped IPv6', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.5', '169.254.169.254', '::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) assert.equal(publicIp(address), false, address);
  assert.equal(publicIp('8.8.8.8'), true); assert.equal(publicIp('2606:4700:4700::1111'), true);
  await assert.rejects(validateRemote('http://127.0.0.1/private'));
  await assert.rejects(validateRemote('file:///C:/Windows'));
});
test('Image conversion validates bytes, keeps proportions and prevents upscaling', async () => {
  const image = await sharp({ create: { width: 2000, height: 1000, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const converted = await prepareImage(image, 'jpg');
  assert.equal(converted.info.width, 1400); assert.equal(converted.info.height, 700); assert.equal(converted.info.format, 'jpeg');
  const small = await sharp({ create: { width: 200, height: 300, channels: 3, background: 'white' } }).png().toBuffer();
  const smallConverted = await prepareImage(small, 'webp');
  assert.equal(smallConverted.info.width, 200); assert.equal(smallConverted.info.height, 300);
  const tooSmall = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'white' } }).png().toBuffer();
  await assert.rejects(prepareImage(tooSmall)); await assert.rejects(prepareImage(Buffer.from('<html>not an image</html>')));
});
test('Manifest preserves sources and neutralizes spreadsheet formulas', () => {
  const result = manifestCsv({ products: [{ name: '=HYPERLINK("bad")', query: 'Product', status: 'review', selected: '1', candidates: [{ id: '1', sourceUrl: 'https://example.com/product', imageUrl: 'https://example.com/p.jpg', score: 100, reason: 'Review visually' }] }] });
  assert.ok(result.startsWith('\ufeff')); assert.ok(result.includes("'=HYPERLINK")); assert.ok(result.includes('https://example.com/product'));
});
