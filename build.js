// Perfect Reef search catalog builder (Konimbo API, read-only GET requests).
// Writes catalog.json (only visible products: id, title, category, image, brand - no prices)
// and status.json (health report). If anything looks wrong it exits with an error,
// the old catalog stays in place and GitHub emails the repository owner.
const fs = require('fs');
const TOKEN = String(process.env.KONIMBO_TOKEN || '').trim().replace(/^["']|["']$/g, '');
if (!TOKEN) { console.error('Missing KONIMBO_TOKEN secret'); process.exit(1); }
console.log('token check: length ' + TOKEN.length + ', hex only: ' + /^[0-9a-f]+$/i.test(TOKEN) + ' (expected 64 / true)');
const API = 'https://api.konimbo.co.il/v1/items';
const SITE = 'https://www.perfectreef.co.il';
const MIN_ITEMS = +process.env.MIN_ITEMS || 3500;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ATTR = 'id,title,store_category_title,brand,images,visible,slug,updated_at';

async function call(params, tries = 5) {
  const q = new URLSearchParams({ token: TOKEN, visible: 'true', attributes: ATTR, ...params });
  for (let k = 0; k < tries; k++) {
    let r;
    try { r = await fetch(API + '?' + q.toString(), { headers: { Accept: 'application/json' } }); }
    catch (e) { console.log('network error, retry ' + (k + 1)); await sleep(20000); continue; }
    const h = n => r.headers.get(n);
    const cur = +h('x-rate-limit-current') || 0, max = +h('x-rate-limit-maximum') || 100;
    if (r.status === 401 && cur >= max - 1) { console.log('rate limit reached, waiting 10 min'); await sleep(610000); continue; }
    if (!r.ok) { let t = ''; try { t = (await r.text()).replace(/[0-9a-f]{20,}/gi, '[x]').slice(0, 200); } catch (e) {} console.log('HTTP ' + r.status + ', retry ' + (k + 1) + ' | ' + t + ' | rate ' + cur + '/' + max); if (r.status === 401 && k >= 1) break; await sleep(30000); continue; }
    const body = await r.json();
    // keep well under 100 calls / 10 minutes
    await sleep(cur > max - 10 ? 60000 : 6500);
    return { body, total: +h('x-pagination-total') || null, perPage: +h('x-pagination-per-page') || null, link: h('x-pagination-links') || h('link') || '' };
  }
  throw new Error('API request failed after retries');
}

(async () => {
  const st = { started: new Date().toISOString(), ok: false, checks: {} };
  const first = await call({ page: '1' });
  const list = b => Array.isArray(b) ? b : (b.items || b.data || []);
  const p1 = list(first.body);
  st.checks.total_header = first.total; st.checks.per_page = first.perPage;
  st.checks.link_header_present = !!first.link;
  st.checks.fields_first_item = p1[0] ? Object.keys(p1[0]) : [];
  if (!p1.length) throw new Error('API returned no items');

  // pagination check: page 2 must differ from page 1
  const p2 = list((await call({ page: '2' })).body);
  const ids1 = new Set(p1.map(x => x.id));
  st.checks.page_param_works = p2.length > 0 && p2.some(x => !ids1.has(x.id));
  if (!st.checks.page_param_works) throw new Error('pagination with page= does not work');

  const all = new Map(); [...p1, ...p2].forEach(x => all.set(x.id, x));
  const pages = first.total && first.perPage ? Math.ceil(first.total / first.perPage) : 1000;
  for (let p = 3; p <= pages; p++) {
    const items = list((await call({ page: String(p) })).body);
    if (!items.length) break;
    items.forEach(x => all.set(x.id, x));
    if (p % 25 === 0) console.log('page ' + p + '/' + pages + ', items ' + all.size);
  }
  const items = [...all.values()];
  st.checks.items_downloaded = items.length;
  st.checks.non_visible_returned = items.filter(x => x.visible === false || x.visible === 'false').length;
  if (st.checks.non_visible_returned) throw new Error('API returned hidden products');
  if (items.length < MIN_ITEMS) throw new Error('only ' + items.length + ' items (minimum ' + MIN_ITEMS + ')');

  const img = x => { const a = (x.images || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0)); return a[0] ? a[0].url : ''; };
  // product URL check on 5 samples
  const urlOf = x => SITE + '/items/' + x.id;
  const sample = items.filter((_, i) => i % Math.floor(items.length / 5) === 0).slice(0, 5);
  st.checks.url_samples = [];
  for (const x of sample) { let s = 0; try { s = (await fetch(urlOf(x), { redirect: 'follow' })).status; } catch (e) {} st.checks.url_samples.push({ id: x.id, status: s }); await sleep(1500); }
  if (st.checks.url_samples.some(u => u.status !== 200)) throw new Error('product URL check failed');
  // image size variants (smaller image for the suggestions list)
  const im = img(items.find(x => img(x))) || '';
  st.checks.image_variants = {};
  for (const v of ['thumb', 'small', 'medium']) { const u = im.replace('/original/', '/' + v + '/'); let s = 0; try { s = (await fetch(u, { method: 'HEAD' })).status; } catch (e) {} st.checks.image_variants[v] = s; }
  const variant = ['thumb', 'small', 'medium'].find(v => st.checks.image_variants[v] === 200);

  const catIds = {}; const out = [];
  for (const x of items) {
    const c = x.store_category_title || ''; if (!(c in catIds)) catIds[c] = Object.keys(catIds).length;
    let u = img(x); if (variant && u) u = u.replace('/original/', '/' + variant + '/');
    out.push([x.id, String(x.title || '').trim(), catIds[c], u, null, null, x.brand || '']);
  }
  const cats = Object.fromEntries(Object.entries(catIds).map(([k, v]) => [v, k]));
  const catalog = { v: 2, built: new Date().toISOString(), count: out.length, cats, items: out };
  fs.writeFileSync('catalog.json', JSON.stringify(catalog));
  st.ok = true; st.finished = new Date().toISOString(); st.count = out.length; st.image_variant = variant || 'original';
  fs.writeFileSync('status.json', JSON.stringify(st, null, 1));
  console.log('OK: ' + out.length + ' visible products');
})().catch(e => { console.error('FAILED: ' + e.message); process.exit(1); });
