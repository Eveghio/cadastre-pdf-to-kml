// ---------- UI ----------
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const bytesOf = (id) => { const s = document.getElementById(id).textContent.trim(); const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };

let pdfLib = null;
async function loadPdf() {
  if (pdfLib) return pdfLib;
  const mod = URL.createObjectURL(new Blob([bytesOf('lib-pdf')], { type: 'text/javascript' }));
  const worker = URL.createObjectURL(new Blob([bytesOf('lib-worker')], { type: 'text/javascript' }));
  pdfLib = await import(mod);
  pdfLib.GlobalWorkerOptions.workerSrc = worker;
  return pdfLib;
}

const results = []; window.__cadResults = results; // {stem, kml, zip, parts:[{name,data}]}
const usedStems = new Set();

// claude.ai-ზე გამოქვეყნებისას ჩამოტვირთვა მხოლოდ პლატფორმის "downloads" შესაძლებლობით მუშაობს;
// ლოკალურად გახსნილ ფაილში - ჩვეულებრივი ბმულით.
let dlCap; const dlReady = (async () => { try { dlCap = (window.claude && window.claude.use) ? await window.claude.use('downloads') : null; } catch { dlCap = null; } })();
async function download(name, data, type) {
  await Promise.race([dlReady, new Promise(r => setTimeout(r, 300))]);
  if (dlCap) {
    let fname = name, payload = data;
    if (/\.kml$/i.test(name)) { fname = name.replace(/\.kml$/i, '_kml.zip'); payload = makeZip([{ name, data }]); } // .kml პლატფორმაზე დაუშვებელია
    try { await dlCap.save({ filename: fname, data: new Blob([payload]) }); }
    catch (e) { if (e && e.code !== 'declined') $('#status').textContent = 'ჩამოტვირთვა ვერ მოხერხდა: ' + (e.message || e.code); }
    return;
  }
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function convert(file) {
  const lib = await loadPdf();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await lib.getDocument({ data, verbosity: 0, isEvalSupported: false }).promise;
  const page = await doc.getPage(1);
  const ex = await extractPage(page, lib.OPS);
  let g;
  try { g = buildGeometry(ex); }
  catch (e) { if (ex.imageOps >= 3) g = await rasterGeometry(page, ex); else throw e; }
  let stem = safeName(g.meta.code, file.name.replace(/\.pdf$/i, '')), n = 2; const base = stem;
  while (usedStems.has(stem)) stem = `${base}_${n++}`;
  usedStems.add(stem);
  const r = { g, stem, zone: g.meta.zone, hemi: g.meta.hemi };
  buildOutputs(r);
  return r;
}

async function rasterGeometry(page, ex) { // საზღვარი სურათშია: გვერდს ვარენდერებთ და წითელ ხაზს ვუყვებით
  const frame = gridFrame(ex);
  if (!frame) throw new Error('რასტრული PDF: ბადის ჩარჩო ვერ ვიპოვე, გეორეფერენსი შეუძლებელია.');
  const ov = (b) => Math.max(0, Math.min(b[2], frame[2]) - Math.max(b[0], frame[0])) * Math.max(0, Math.min(b[3], frame[3]) - Math.max(b[1], frame[1]));
  const imgs = ex.images.filter(im => ov(im.bbox) > 0).sort((a, b) => ov(b.bbox) - ov(a.bbox));
  const nativePt = imgs.length ? imgs[0].ptPerPx : 0.5;
  let scale = Math.min(6, Math.max(2, 2.5 / nativePt));
  const fw = frame[2] - frame[0], fh = frame[3] - frame[1];
  scale = Math.min(scale, Math.sqrt(5e6 / (fw * fh))); // ტელეფონის მეხსიერებისთვის (~5 მლნ პიქსელი)
  const vp = page.getViewport({ scale });
  const [ax, ay] = vp.convertToViewportPoint(frame[0], frame[1]), [bx, by] = vp.convertToViewportPoint(frame[2], frame[3]);
  const x0 = Math.floor(Math.min(ax, bx)) + 2, y0 = Math.floor(Math.min(ay, by)) + 2;
  const W = Math.ceil(Math.max(ax, bx)) - 2 - x0, H = Math.ceil(Math.max(ay, by)) - 2 - y0;
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -x0, -y0] }).promise;
  const img = ctx.getImageData(0, 0, W, H);
  const t = traceRedBoundary(img.data, W, H, nativePt * scale);
  canvas.width = canvas.height = 0;
  const ringPdf = t.ring.map(([x, y]) => vp.convertToPdfPoint(x + x0, y + y0));
  const g = buildGeometryRaster(ex, ringPdf, nativePt);
  g.notes.push(`რასტრი: ორიგინალი სურათის პიქსელი ≈ ${(nativePt * Math.max(Math.abs(g.info.scaleX), Math.abs(g.info.scaleY))).toFixed(2)} მ, საზღვრის ხაზის სისქე ≈ ${(t.lineWidthPx / scale * Math.abs(g.info.scaleX)).toFixed(2)} მ.`);
  return g;
}

function buildOutputs(r) { // ზონის შეცვლისას ფაილები თავიდან გენერირდება
  const { g, stem } = r;
  const ll = toLonLat(g.groups, r.zone, r.hemi);
  r.kml = new TextEncoder().encode(makeKML(g.meta.code || stem, ll));
  const shp = makeShapefile(g.groups, { code: g.meta.code, areaPdf: g.meta.areaPdf, areaCalc: g.areaCalc, zone: r.zone, hemi: r.hemi });
  r.parts = [{ name: `${stem}.shp`, data: shp.shp }, { name: `${stem}.shx`, data: shp.shx }, { name: `${stem}.dbf`, data: shp.dbf }, { name: `${stem}.prj`, data: shp.prj }];
  r.zip = makeZip(r.parts);
  r.inGeorgia = groupsInGeorgia(g.groups, r.zone, r.hemi);
}

function preview(groups) {
  const all = groups.flatMap(gr => gr.outer);
  const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const w = x1 - x0 || 1, h = y1 - y0 || 1, pad = Math.max(w, h) * 0.05;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `${-pad} ${-pad} ${w + 2 * pad} ${h + 2 * pad}`);
  svg.setAttribute('class', 'prev');
  const d = groups.map(gr => [gr.outer, ...gr.holes].map(r => 'M' + r.map(([x, y]) => `${(x - x0).toFixed(2)} ${(y1 - y).toFixed(2)}`).join('L') + 'Z').join('')).join('');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', d); p.setAttribute('fill-rule', 'evenodd'); p.setAttribute('class', 'poly');
  p.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(p);
  return svg;
}

function card(file, r, err) {
  const c = el('section', 'card');
  const head = el('div', 'cardhead');
  if (r) {
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'selbox'; cb.checked = !!r.selected; cb.title = 'მონიშვნა';
    cb.onchange = () => { r.selected = cb.checked; c.classList.toggle('sel', cb.checked); updateBar(); };
    const lab = el('label', 'chk'); lab.appendChild(cb); head.appendChild(lab);
    if (r.selected) c.classList.add('sel');
  }
  head.appendChild(el('div', 'fname', file.name));
  const x = el('button', 'xbtn', '✕'); x.title = 'წაშლა';
  x.onclick = () => { if (r) removeResult(r); c.remove(); updateBar(); };
  head.appendChild(x); c.appendChild(head);
  if (r) r.el = c;
  if (err) { c.classList.add('bad'); c.appendChild(el('div', 'err', 'შეცდომა: ' + err)); return c; }
  const { g } = r;
  const d = g.diffPct;
  const tol = g.areaTolerancePct ?? 1; // 1%, ან მეტი, თუ გეგმის ფართობის დამრგვალება თავად აჭარბებს 1%-ს (პატარა ნაკვეთი)
  const level = g.raster ? (!r.inGeorgia ? 'bad' : 'warn') : (!Number.isFinite(d) || Math.abs(d) > tol || !r.inGeorgia) ? 'bad' : ((tol === 1 && Math.abs(d) > 0.5) || g.warnings.length || (g.meta.zoneCorrected && r.zone === g.meta.zone) ? 'warn' : 'ok');
  c.classList.add(level);
  const top = el('div', 'top');
  top.appendChild(preview(g.groups));
  const info = el('div', 'info');
  info.appendChild(el('div', 'code', g.meta.code || '(კოდი ვერ წავიკითხე)'));
  const rows = [
    ['ფართობი PDF-ში' + (g.meta.areaZone ? ` (${g.meta.areaZone}N)` : ''), g.meta.areaPdf != null ? g.meta.areaPdf.toLocaleString('ka-GE') + ' კვ.მ' : '—'],
    ['გამოთვლილი', g.areaCalc.toFixed(g.areaCalc < 100 ? 2 : 1) + ' კვ.მ'], // პატარა ნაკვეთზე 6.49 და არა 6.5
    ['სხვაობა', Number.isFinite(d) ? (d >= 0 ? '+' : '') + d.toFixed(2) + '%' : '—'],
    ['რგოლები / წვეროები', `${g.ringCount} / ${g.vertexCount}` + (g.groups.some(x => x.holes.length) ? ' (ხვრელით)' : '')],
    ['საყრდენი ბადე', `${g.info.gridX}×${g.info.gridY}, ნარჩენი ${Math.max(g.info.residX, g.info.residY).toFixed(2)} მ` + (g.info.glyphLabels ? ' (ციფრები ნახაზიდან ამოცნობილი)' : '')],
    ['სავარაუდო ცდომილება', (() => { const a = accuracyEstimate(g); const m = (v) => v < 0.05 ? `${(v * 100).toFixed(1)} სმ` : `${v.toFixed(2)} მ`; return `ტიპური ±${m(a.typical)}, მაქს. ±${m(a.max)}`; })()],
    ['PDF-ის ტიპი', g.raster ? 'რასტრული (სურათი)' : 'ვექტორული'],
  ];
  for (const [k, v] of rows) { const row = el('div', 'row'); row.appendChild(el('span', 'k', k)); row.appendChild(el('span', 'v', v)); info.appendChild(row); }
  const zrow = el('div', 'row'); zrow.appendChild(el('span', 'k', 'სისტემა'));
  const zv = el('span', 'v');
  {
    zv.appendChild(document.createTextNode('WGS 84 / UTM '));
    const sel = document.createElement('select');
    for (const z of [37, 38]) { const o = document.createElement('option'); o.value = z; o.textContent = z + 'N'; if (z === r.zone) o.selected = true; sel.appendChild(o); }
    sel.onchange = () => { r.zone = +sel.value; buildOutputs(r); c.replaceWith(card(file, r)); };
    zv.appendChild(sel);
  }
  zrow.appendChild(zv); info.appendChild(zrow);
  top.appendChild(info); c.appendChild(top);
  if (g.meta.zoneAssumed) {
    const cands = g.meta.zoneCandidates || [];
    if (g.meta.zoneAuto) c.appendChild(el('div', 'note', `UTM ზონა PDF-ში არ წერია. განისაზღვრა კოორდინატებიდან: საქართველოს ფარგლებში მხოლოდ ${cands[0]}N ხვდება. საჭიროების შემთხვევაში შეცვალეთ.`));
    else c.appendChild(el('div', 'warnmsg', `⚠ UTM ზონა PDF-ში არ წერია და კოორდინატებიდან ვერ განისაზღვრა (${cands.length ? cands.join('N და ') + 'N' : 'არც ერთი ზონა'} ხვდება საქართველოში). აირჩიეთ ზონა ხელით.`));
  }
  if (g.meta.zoneCorrected && r.zone === g.meta.zone) c.appendChild(el('div', 'warnmsg', `⚠ PDF-ში ზონა ${g.meta.zoneStated}${r.hemi} წერია, მაგრამ ამ კოორდინატებით ნაკვეთი საქართველოს გარეთ ხვდება; საქართველოში მხოლოდ ${r.zone}${r.hemi} ხვდება, ამიტომ გამოვიყენე ${r.zone}${r.hemi}. საჭიროების შემთხვევაში შეცვალეთ.`));
  if (!r.inGeorgia) c.appendChild(el('div', 'warnmsg', `⚠ ${r.zone}${r.hemi} ზონით კოორდინატები საქართველოს გარეთ ხვდება — ზონა არასწორია.`));
  for (const w of g.warnings) c.appendChild(el('div', 'warnmsg', '⚠ ' + w));
  for (const nt of g.notes) c.appendChild(el('div', 'note', nt));
  const btns = el('div', 'btns');
  const b1 = el('button', null, 'KML ჩამოტვირთვა'); b1.onclick = () => download(`${r.stem}.kml`, r.kml, 'application/vnd.google-earth.kml+xml');
  const b2 = el('button', null, 'SHP (ZIP) ჩამოტვირთვა'); b2.onclick = () => download(`${r.stem}_shp.zip`, r.zip, 'application/zip');
  btns.append(b1, b2); c.appendChild(btns);
  return c;
}

async function handleFiles(fileList) {
  const files = [...fileList].filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!files.length) { $('#status').textContent = 'PDF ფაილი არ არის არჩეული.'; return; }
  $('#status').textContent = 'მუშაობს…';
  for (const f of files) {
    try {
      const r = await convert(f);
      r.file = f; r.selected = false;
      results.push(r);
      $('#cards').prepend(card(f, r));
    } catch (e) {
      console.error(e);
      $('#cards').prepend(card(f, null, e.message || String(e)));
    }
  }
  $('#status').textContent = `დასრულდა: ${results.length} ფაილი`;
  updateBar();
}

function removeResult(r) {
  const i = results.indexOf(r); if (i >= 0) results.splice(i, 1);
  usedStems.delete(r.stem);
}
const selected = () => results.filter(r => r.selected);
function updateBar() {
  const n = selected().length, total = results.length;
  $('#bar').hidden = total === 0 && !document.querySelector('.card');
  $('#selcount').textContent = total ? `მონიშნულია ${n} / ${total}` : '';
  $('#selall').checked = total > 0 && n === total; $('#selall').indeterminate = n > 0 && n < total;
  $('#selall').disabled = total === 0;
  for (const id of ['delsel', 'kml1', 'kmlz', 'shpz']) $('#' + id).disabled = n === 0;
}
function describe(r) {
  const g = r.g, parts = [];
  if (g.meta.areaPdf != null) parts.push(`ფართობი PDF-ში: ${g.meta.areaPdf} კვ.მ`);
  parts.push(`გამოთვლილი: ${g.areaCalc.toFixed(1)} კვ.მ`, `ზონა: UTM ${r.zone}${r.hemi}`, `წყარო: ${r.file ? r.file.name : ''}`);
  if (g.raster) parts.push('რასტრული PDF — დაბალი სიზუსტე');
  return parts.join('; ');
}
const stamp = () => { const d = new Date(), p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; };

const drop = $('#drop'), inp = $('#file');
inp.addEventListener('change', () => { handleFiles(inp.files); inp.value = ''; });
['dragenter', 'dragover'].forEach(ev => window.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => window.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
window.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files); });
$('#selall').onchange = () => { const v = $('#selall').checked; for (const r of results) { r.selected = v; if (r.el) { r.el.classList.toggle('sel', v); const cb = r.el.querySelector('.selbox'); if (cb) cb.checked = v; } } updateBar(); };
$('#delsel').onclick = () => { for (const r of selected()) { removeResult(r); if (r.el) r.el.remove(); } updateBar(); };
$('#kml1').onclick = () => {
  const sel = selected(); if (!sel.length) return;
  const items = sel.map(r => ({ name: r.g.meta.code || r.stem, polysLL: toLonLat(r.g.groups, r.zone, r.hemi), description: describe(r) }));
  download(sel.length === 1 ? `${sel[0].stem}.kml` : `cadastre_${sel.length}_${stamp()}.kml`, new TextEncoder().encode(makeKMLMulti(`საკადასტრო ნაკვეთები (${sel.length})`, items)), 'application/vnd.google-earth.kml+xml');
};
$('#kmlz').onclick = () => {
  const sel = selected(); if (!sel.length) return;
  download(`cadastre_kml_${sel.length}_${stamp()}.zip`, makeZip(sel.map(r => ({ name: `${r.stem}.kml`, data: r.kml }))), 'application/zip');
};
$('#shpz').onclick = () => {
  const sel = selected(); if (!sel.length) return;
  download(`cadastre_shp_${sel.length}_${stamp()}.zip`, makeZip(sel.flatMap(r => r.parts)), 'application/zip');
};
updateBar();
