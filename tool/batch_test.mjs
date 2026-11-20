// =====================================================================
// საკადასტრო გეგმების მასობრივი ტესტი (batch).
//
//   node batch_test.mjs <PDF-ების საქაღალდე> <შედეგის საქაღალდე> [--ref <ოფიციალური ფაილების საქაღალდე>]
//
// რას აკეთებს:
//  1. ყველა PDF-ს (ქვესაქაღალდეებიც, .zip-ების შიგნითაც) გადაიყვანს იმავე ბირთვით (core.mjs), რასაც
//     ვებ-ხელსაწყო და ექსთენშენი იყენებს; რასტრულზე - იგივე რასტრული რეჟიმი (@napi-rs/canvas).
//  2. თითო ფაილს ანიჭებს კატეგორიას (იხ. CATEGORIES): წარმატება, ფართობის შეუსაბამობა, ბადე ვერ
//     მოიძებნა, საზღვარი ვერ მოიძებნა, არ არის გეგმა, ზონა გაურკვეველია...
//  3. თუ --ref მითითებულია: ოფიციალური კონტურები (.shp/.prj, .zip, .kml, .geojson; მაგ. maps.gov.ge-დან)
//     გეომეტრიით (არა სახელით) ეწყვილება შედეგს და ითვლება IoU, Hausdorff, საშუალო მანძილი, წანაცვლება.
//  4. წერს: results.csv (Excel-ისთვის), results.json, report.html (ჯამი + ცხრილი), ok.kml (ყველა
//     წარმატებული ერთ ფაილში) და failed/<კატეგორია>/ - წარუმატებელი PDF-ების ასლები (გასაანალიზებლად).
// =====================================================================
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import * as core from "./core.mjs";
import { describeMap } from "../plan_reader/plan_reader.mjs";

// ---------- კატეგორიები (რიგი = სიმძიმე, ანგარიშშიც ამ რიგით) ----------
export const CATEGORIES = {
  ok: 'წარმატება',
  ok_notes: 'წარმატება შენიშვნით (მაგ. დამრგვალება)',
  ok_warnings: 'წარმატება გაფრთხილებით (ერთხაზიანი ბადე, მრუდები...)',
  raster: 'რასტრული (დაბალი სიზუსტე)',
  ref_mismatch: 'ოფიციალურ კონტურს არ ემთხვევა (IoU < 0.95 და გადახრა > 1.5 pt)',
  area_mismatch: 'ფართობი ზღვარს გარეთაა',
  zone_ambiguous: 'UTM ზონა გაურკვეველია (37N/38N ორივე ჯდება)',
  outside_georgia: 'შედეგი საქართველოს გარეთ ხვდება',
  grid_missing: 'საყრდენი ბადე ვერ მოიძებნა',
  no_boundary: 'წითელი საზღვარი ვერ მოიძებნა',
  raster_failed: 'რასტრული რეჟიმი ვერ შესრულდა',
  not_plan: 'საკადასტრო გეგმა არ არის (ნახაზი/სხვა)',
  unreadable: 'PDF ვერ წავიკითხე / დაშიფრულია',
  error: 'სხვა შეცდომა',
};
const BAD = new Set(['ref_mismatch', 'area_mismatch', 'zone_ambiguous', 'outside_georgia', 'grid_missing', 'no_boundary', 'raster_failed', 'unreadable', 'error']);

// ---------- PDF -> გეომეტრია (ui.js-ის convert/rasterGeometry-ის Node ვერსია) ----------
let canvasLib = null;
async function rasterGeometry(page, ex) {
  if (!canvasLib) canvasLib = await import("@napi-rs/canvas");
  const frame = core.gridFrame(ex);
  if (!frame) throw new Error('რასტრული PDF: ბადის ჩარჩო ვერ ვიპოვე, გეორეფერენსი შეუძლებელია.');
  const ov = (b) => Math.max(0, Math.min(b[2], frame[2]) - Math.max(b[0], frame[0])) * Math.max(0, Math.min(b[3], frame[3]) - Math.max(b[1], frame[1]));
  const imgs = ex.images.filter(im => ov(im.bbox) > 0).sort((a, b) => ov(b.bbox) - ov(a.bbox));
  const nativePt = imgs.length ? imgs[0].ptPerPx : 0.5;
  let scale = Math.min(6, Math.max(2, 2.5 / nativePt));
  const fw = frame[2] - frame[0], fh = frame[3] - frame[1];
  scale = Math.min(scale, Math.sqrt(5e6 / (fw * fh)));
  const vp = page.getViewport({ scale });
  const [ax, ay] = vp.convertToViewportPoint(frame[0], frame[1]), [bx, by] = vp.convertToViewportPoint(frame[2], frame[3]);
  const x0 = Math.floor(Math.min(ax, bx)) + 2, y0 = Math.floor(Math.min(ay, by)) + 2;
  const W = Math.ceil(Math.max(ax, bx)) - 2 - x0, H = Math.ceil(Math.max(ay, by)) - 2 - y0;
  const canvas = canvasLib.createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -x0, -y0] }).promise;
  const img = ctx.getImageData(0, 0, W, H);
  const t = core.traceRedBoundary(img.data, W, H, nativePt * scale);
  const ringPdf = t.ring.map(([x, y]) => vp.convertToPdfPoint(x + x0, y + y0));
  return core.buildGeometryRaster(ex, ringPdf, nativePt);
}

export async function convertFile(bytes) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, isEvalSupported: false }).promise;
  try {
    const page = await doc.getPage(1);
    const ex = await core.extractPage(page, pdfjs.OPS);
    let g, rasterError = null;
    try { g = core.buildGeometry(ex); }
    catch (e) {
      if (ex.imageOps < 3) throw e;
      try { g = await rasterGeometry(page, ex); } catch (e2) { rasterError = e2; }
      if (rasterError) { rasterError.raster = true; throw rasterError; }
    }
    return { g, ex };
  } finally { await doc.destroy(); }
}

// ---------- კლასიფიკაცია ----------
function classifyError(msg, isRaster) {
  if (/საყრდენი ბადე/.test(msg)) return 'grid_missing';
  if (isRaster) return 'raster_failed';
  if (/საზღვარი|სურათია|რასტრ/.test(msg)) return 'no_boundary';
  if (/Invalid PDF|password|encrypt|Unexpected|XRef/i.test(msg)) return 'unreadable';
  return 'error';
}
function classifyResult(g, inGeorgia, ref) {
  if (!inGeorgia) return 'outside_georgia';
  if (g.meta.zoneAssumed && !g.meta.zoneAuto && (g.meta.zoneCandidates || []).length > 1) return 'zone_ambiguous';
  // პატარა ნაკვეთზე IoU მკაცრია (8 კვ.მ-ზე 0.1 მ გადახრა IoU-ს 0.9-მდე ამცირებს), ამიტომ ემთხვევა, თუ
  // უდიდესი გადახრა ≤ 1.5 pt ქაღალდზე (წვეროების ხმაური ~0.35-0.4 pt, 447 გეგმა, 2026-11-20)
  const refTolMeters = Math.max(0.05, 1.5 * Math.max(Math.abs(g.info.scaleX), Math.abs(g.info.scaleY)));
  if (ref && ref.iou < 0.95 && ref.hausdorff > refTolMeters) return 'ref_mismatch';
  const tol = g.areaTolerancePct ?? 1;
  if (Number.isFinite(g.diffPct) && Math.abs(g.diffPct) > tol) return 'area_mismatch';
  if (g.raster) return 'raster';
  if (g.warnings.length) return 'ok_warnings';
  if (g.notes.length) return 'ok_notes';
  return 'ok';
}

// ---------- ფაილების შეგროვება (zip-ები იხსნება დროებით საქაღალდეში) ----------
function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.some(x => e.name.toLowerCase().endsWith(x))) out.push(p);
  }
  return out;
}
function unzipAll(dir) { // ყველა .zip -> დროებითი საქაღალდე (ერთი დონე ჩადგმულიც)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-'));
  let i = 0;
  const go = (d) => { for (const z of walk(d, ['.zip'])) { const to = path.join(tmp, String(i++)); fs.mkdirSync(to);
    try { execFileSync('unzip', ['-qq', '-o', z, '-d', to]); go(to); } catch { /* დაზიანებული zip - გამოვტოვებთ */ } } };
  go(dir);
  return tmp;
}

// ---------- ოფიციალური კონტურები (reference) ----------
// shp: მხოლოდ პოლიგონები (ტიპი 5/15/25); რგოლები even-odd წესით (ხვრელების კლასიფიკაცია საჭირო არ არის)
function readShp(file) {
  const b = fs.readFileSync(file), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = []; let o = 100;
  while (o + 8 <= b.length) {
    const len = dv.getInt32(o + 4, false) * 2; const r = o + 8; o = r + len;
    if (len < 44) continue;
    const type = dv.getInt32(r, true); if (![5, 15, 25].includes(type)) continue;
    const nParts = dv.getInt32(r + 36, true), nPts = dv.getInt32(r + 40, true);
    const parts = []; for (let i = 0; i < nParts; i++) parts.push(dv.getInt32(r + 44 + 4 * i, true));
    const p0 = r + 44 + 4 * nParts, rings = [];
    for (let i = 0; i < nParts; i++) {
      const a = parts[i], z = i + 1 < nParts ? parts[i + 1] : nPts, ring = [];
      for (let k = a; k < z; k++) ring.push([dv.getFloat64(p0 + 16 * k, true), dv.getFloat64(p0 + 16 * k + 8, true)]);
      rings.push(ring);
    }
    out.push(rings);
  }
  return out;
}
function prjZone(file) { // .prj -> 37 / 38 / 'deg' / null
  const p = file.replace(/\.shp$/i, '.prj');
  const alt = fs.existsSync(p) ? p : fs.existsSync(p.replace(/\.prj$/, '.PRJ')) ? p.replace(/\.prj$/, '.PRJ') : null;
  if (!alt) return null;
  const t = fs.readFileSync(alt, 'utf8');
  const m = t.match(/zone[_ ]?(3[78])/i) || t.match(/UTM[^"]*?(3[78])/i) || t.match(/central_meridian",?\s*(39|45)/i);
  if (m) return m[1] === '39' ? 37 : m[1] === '45' ? 38 : +m[1];
  if (/^GEOGCS/.test(t.trim())) return 'deg';
  return null;
}
const inGeo = ([lon, lat]) => lon > 39.9 && lon < 46.8 && lat > 41.0 && lat < 43.7;
function shpToLonLat(rings, zone) { // -> [ [ [lon,lat]... ] ] ან null
  const isDeg = Math.abs(rings[0][0][0]) <= 180 && Math.abs(rings[0][0][1]) <= 90;
  if (isDeg) return [rings];
  const zones = zone === 37 || zone === 38 ? [zone] : [38, 37];
  const res = [];
  for (const z of zones) {
    const ll = rings.map(r => r.map(([e, n]) => core.utmToLonLat(e, n, z, 'N')));
    if (inGeo(ll[0][0])) res.push(ll);
  }
  return res; // ზონა უცნობია და ორივე ჯდება -> ორივე ვარიანტი (დაწყვილება აირჩევს)
}
function kmlPolys(text) { // KML: თითო Polygon = რგოლების სია
  const polys = [];
  for (const pm of text.match(/<Polygon[\s\S]*?<\/Polygon>/g) || []) {
    const rings = [];
    for (const c of pm.match(/<coordinates>([\s\S]*?)<\/coordinates>/g) || [])
      rings.push(c.replace(/<\/?coordinates>/g, '').trim().split(/\s+/).map(s => s.split(',').map(Number).slice(0, 2)));
    if (rings.length) polys.push(rings);
  }
  return polys;
}
function geojsonPolys(obj) { // -> [{ rings, code }]; code = properties.code (ექსთენშენის official.geojson)
  const out = [];
  const g = (geom, code) => { if (!geom) return;
    // MultiPolygon-ის ყველა ნაწილი ერთ ობიექტად (even-odd), რომ ნაკვეთი ერთიანად შედარდეს
    if (geom.type === 'Polygon') out.push({ rings: geom.coordinates.map(r => r.map(p => p.slice(0, 2))), code });
    else if (geom.type === 'MultiPolygon') out.push({ rings: geom.coordinates.flatMap(p => p.map(r => r.map(q => q.slice(0, 2)))), code });
    else if (geom.type === 'GeometryCollection') geom.geometries.forEach(x => g(x, code)); };
  if (obj.type === 'FeatureCollection') obj.features.forEach(f => g(f.geometry, f.properties && f.properties.code));
  else if (obj.type === 'Feature') g(obj.geometry, obj.properties && obj.properties.code); else g(obj);
  return out;
}
export function loadReferences(dir) {
  const tmp = unzipAll(dir), refs = [];
  for (const d of [dir, tmp]) {
    for (const f of walk(d, ['.shp'])) {
      let zone = null; try { zone = prjZone(f); } catch { }
      try { for (const rings of readShp(f)) for (const ll of shpToLonLat(rings, zone === 'deg' ? null : zone)) refs.push({ file: path.relative(d, f), rings: ll }); } catch { }
    }
    for (const f of walk(d, ['.kml'])) for (const rings of kmlPolys(fs.readFileSync(f, 'utf8'))) refs.push({ file: path.relative(d, f), rings });
    for (const f of walk(d, ['.geojson', '.json'])) { try { for (const { rings, code } of geojsonPolys(JSON.parse(fs.readFileSync(f, 'utf8')))) refs.push({ file: path.relative(d, f), rings, code }); } catch { } }
  }
  for (const r of refs) r.bb = bboxLL(r.rings);
  return refs;
}

// ---------- გეომეტრიული შედარება (ლოკალური მეტრული პროექცია ცენტრის გარშემო) ----------
function bboxLL(rings) { let a = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rings) for (const [x, y] of r) a = [Math.min(a[0], x), Math.min(a[1], y), Math.max(a[2], x), Math.max(a[3], y)]; return a; }
const R = 6371008.8;
function projector(lat0, lon0) { const k = Math.cos(lat0 * Math.PI / 180);
  return ([lon, lat]) => [(lon - lon0) * Math.PI / 180 * R * k, (lat - lat0) * Math.PI / 180 * R]; }
function insideEO(rings, x, y) { let c = false;
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; }
  return c; }
function segDist(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); }
function distToRings(p, rings) { let d = Infinity;
  for (const r of rings) for (let i = 0; i < r.length; i++) d = Math.min(d, segDist(p, r[i], r[(i + 1) % r.length])); return d; }
function densify(rings, step) { const out = [];
  for (const r of rings) for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]); }
  return out; }
export function compareRings(A, B) { // A, B: [ [ [lon,lat]... ] ] -> {iou, hausdorff, meanDist, shiftE, shiftN}
  const bb = bboxLL([...A, ...B]), P = projector((bb[1] + bb[3]) / 2, (bb[0] + bb[2]) / 2);
  const a = A.map(r => r.map(P)), b = B.map(r => r.map(P));
  const [x0, y0] = P([bb[0], bb[1]]), [x1, y1] = P([bb[2], bb[3]]);
  const N = 300, sx = (x1 - x0) / N, sy = (y1 - y0) / N; let inter = 0, uni = 0, ca = [0, 0, 0], cb = [0, 0, 0];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = x0 + (i + 0.5) * sx, y = y0 + (j + 0.5) * sy, ia = insideEO(a, x, y), ib = insideEO(b, x, y);
    if (ia && ib) inter++; if (ia || ib) uni++;
    if (ia) ca = [ca[0] + x, ca[1] + y, ca[2] + 1]; if (ib) cb = [cb[0] + x, cb[1] + y, cb[2] + 1];
  }
  const step = Math.max(0.05, Math.hypot(x1 - x0, y1 - y0) / 400);
  const da = densify(a, step).map(p => distToRings(p, b)), db = densify(b, step).map(p => distToRings(p, a));
  const all = da.concat(db);
  return { iou: uni ? inter / uni : 0, hausdorff: Math.max(...all), meanDist: all.reduce((s, x) => s + x, 0) / all.length,
    shiftE: ca[2] && cb[2] ? ca[0] / ca[2] - cb[0] / cb[2] : NaN, shiftN: ca[2] && cb[2] ? ca[1] / ca[2] - cb[1] / cb[2] : NaN };
}
function bestReference(llRings, refs, code) {
  const bb = bboxLL(llRings), pad = 0.0005;
  let best = null;
  // ოფიციალურს კოდი აქვს (ექსთენშენის ZIP): მხოლოდ იმავე კოდთან; კოდის გარეშე ფაილებში - გეომეტრიით
  const sameCode = code ? refs.filter(r => r.code === code) : [];
  // კოდი გეგმიდან ვერ წავიკითხეთ -> ყველასთან გეომეტრიით (IoU ≥ 0.05, თორემ მეზობელი ნაკვეთი იქნება);
  // კოდი ვიცით, მაგრამ ოფიციალურებში არ არის (მაგ. გაუქმებული/გაყოფილი) -> მხოლოდ უკოდო ფაილები
  const pool = sameCode.length ? sameCode : code ? refs.filter(r => !r.code) : refs;
  for (const r of pool) {
    if (sameCode.length) { const c = compareRings(llRings, r.rings); if (!best || c.iou > best.iou) best = { ...c, file: r.file }; continue; }
    if (r.bb[2] < bb[0] - pad || r.bb[0] > bb[2] + pad || r.bb[3] < bb[1] - pad || r.bb[1] > bb[3] + pad) continue;
    const c = compareRings(llRings, r.rings);
    if (c.iou >= 0.05 && (!best || c.iou > best.iou)) best = { ...c, file: r.file };
  }
  return best;
}

// ---------- ანგარიში ----------
const csvCell = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fx = (v, d) => Number.isFinite(v) ? v.toFixed(d) : '';

function writeReport(outDir, rows, hasRef) {
  const cols = ['file', 'category', 'code', 'appNo', 'prepared', 'producer', 'format', 'zone', 'areaPdf', 'areaCalc', 'diffPct', 'tolPct',
    'gridX', 'gridY', 'scaleX', 'scaleY', 'glyph', 'iso', 'residMax', 'rings', 'verts', 'refIoU', 'refHausdorff', 'refMean', 'refShiftE', 'refShiftN', 'refFile', 'ms', 'message'];
  fs.writeFileSync(path.join(outDir, 'results.csv'), '﻿' + cols.join(',') + '\n' + rows.map(r => cols.map(c => csvCell(r[c])).join(',')).join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(rows, null, 1));
  const counts = {}; for (const r of rows) counts[r.category] = (counts[r.category] || 0) + 1;
  const ref = rows.filter(r => Number.isFinite(r.refIoU));
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  const sum = Object.keys(CATEGORIES).filter(k => counts[k]).map(k =>
    `<tr class="${BAD.has(k) ? 'bad' : k.startsWith('ok') ? 'good' : 'mid'}"><td>${k}</td><td>${esc(CATEGORIES[k])}</td><td>${counts[k]}</td><td>${(100 * counts[k] / rows.length).toFixed(1)}%</td></tr>`).join('');
  const body = rows.map(r => `<tr class="${BAD.has(r.category) ? 'bad' : r.category.startsWith('ok') ? 'good' : 'mid'}">` +
    ['file', 'category', 'code', 'format', 'zone', 'areaPdf', 'areaCalc', 'diffPct', 'gridX', 'gridY', 'scaleX', 'refIoU', 'refHausdorff', 'message'].map(c => `<td>${esc(r[c])}</td>`).join('') + '</tr>').join('');
  fs.writeFileSync(path.join(outDir, 'report.html'), `<!doctype html><meta charset="utf-8"><title>გეგმების ტესტი</title>
<style>body{font:14px system-ui,sans-serif;margin:16px;color:#222}table{border-collapse:collapse;margin:8px 0 20px}td,th{border:1px solid #ccc;padding:3px 6px;vertical-align:top}
th{background:#f3f3f3;position:sticky;top:0}.good td:nth-child(2){color:#18794e}.bad td:nth-child(2){color:#c0392b;font-weight:600}.mid td:nth-child(2){color:#b7791f}
td:last-child{max-width:520px;font-size:12px;color:#555}</style>
<h1>საკადასტრო გეგმების ტესტი</h1><p>ფაილი: ${rows.length}; თარიღი: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</p>
<table><tr><th>კატეგორია</th><th>აღწერა</th><th>რაოდ.</th><th>%</th></tr>${sum}</table>
${hasRef ? `<p>ოფიციალურ კონტურთან დაწყვილდა: ${ref.length}; IoU მედიანა ${fx(med(ref.map(r => r.refIoU)), 4)}, მინ. ${fx(Math.min(...ref.map(r => r.refIoU)), 4)}; Hausdorff მედიანა ${fx(med(ref.map(r => r.refHausdorff)), 2)} მ, მაქს. ${fx(Math.max(...ref.map(r => r.refHausdorff)), 2)} მ</p>` : ''}
<table><tr>${['ფაილი', 'კატეგორია', 'კოდი', 'ფორმატი', 'ზონა', 'ფართ. PDF', 'გამოთვლ.', 'სხვაობა %', 'ბადე X', 'ბადე Y', 'მ/pt', 'IoU', 'Hausdorff მ', 'შეტყობინება'].map(h => `<th>${h}</th>`).join('')}</tr>${body}</table>`);
  return counts;
}

function formatName(meta, info) { // PDF-ის ფორმატი ანგარიშისთვის
  const p = `${info.Producer || ''} / ${info.Creator || ''}`;
  if (/Skia|Chromium/i.test(p)) return 'Chromium';
  if (/Gnostice|LANDREG/i.test(p)) return 'Gnostice';
  if (/Ghostscript|PScript/i.test(p)) return 'Ghostscript';
  if (/ArcMap|ESRI/i.test(p)) return 'ArcMap';
  return p.replace(/^ \/ $/, '') || '?';
}

// ---------- მთავარი ----------
async function main() {
  const args = process.argv.slice(2);
  const refIdx = args.indexOf('--ref'); const refDir = refIdx >= 0 ? args.splice(refIdx, 2)[1] : null;
  const [inDir, outDir] = args;
  if (!inDir || !outDir) { console.error('გამოყენება: node batch_test.mjs <PDF-ები> <შედეგი> [--ref <ოფიციალური>]'); process.exit(2); }
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = unzipAll(inDir);
  const pdfs = [...walk(inDir, ['.pdf']), ...walk(tmp, ['.pdf'])];
  // ფაილი სახელის გარეშე (მაგ. ატვირთვები): PDF-ის ხელმოწერით
  for (const f of walk(inDir, [''])) if (!/\.[a-z0-9]{2,5}$/i.test(f) && fs.readFileSync(f).subarray(0, 5).toString() === '%PDF-') pdfs.push(f);
  const refs = refDir ? loadReferences(refDir) : [];
  if (refDir) console.log(`ოფიციალური კონტური: ${refs.length}`);
  const rows = [], okKml = [];
  for (const [i, f] of pdfs.entries()) {
    const rel = f.startsWith(tmp) ? 'zip:' + path.relative(tmp, f) : path.relative(inDir, f);
    const bytes = new Uint8Array(fs.readFileSync(f));
    const row = { file: rel }; const t0 = Date.now();
    try {
      const d = await describeMap(bytes).catch(() => null);
      if (d) { row.appNo = d.appNo; row.prepared = d.prepared ? d.prepared.toISOString().slice(0, 10) : ''; row.kind = d.kind; }
      try {
        const docInfo = await (async () => { const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise; const m = await doc.getMetadata(); await doc.destroy(); return m.info || {}; })();
        row.producer = `${docInfo.Producer || ''} / ${docInfo.Creator || ''}`;
        row.format = formatName(null, docInfo);
      } catch { }
      const { g } = await convertFile(bytes);
      const ll = core.toLonLat(g.groups, g.meta.zone, g.meta.hemi);
      const inGeorgia = core.groupsInGeorgia(g.groups, g.meta.zone, g.meta.hemi);
      Object.assign(row, { code: g.meta.code, zone: g.meta.zone + (g.meta.zoneAuto ? '(ავტო)' : g.meta.zoneCorrected ? '(გასწ.)' : ''),
        areaPdf: g.meta.areaPdf, areaCalc: fx(g.areaCalc, 2), diffPct: fx(g.diffPct, 3), tolPct: fx(g.areaTolerancePct, 2),
        gridX: g.info.gridX, gridY: g.info.gridY, scaleX: fx(g.info.scaleX, 5), scaleY: fx(g.info.scaleY, 5), glyph: g.info.glyphLabels ? 1 : 0,
        iso: g.info.isoAxis || '', residMax: fx(Math.max(g.info.residX || 0, g.info.residY || 0), 3), rings: g.ringCount, verts: g.vertexCount,
        message: [...g.warnings, ...g.notes].join(' | ') });
      if (row.format === undefined) row.format = g.raster ? 'raster' : '';
      if (g.raster) row.format += ' (რასტრი)';
      let ref = null;
      if (refs.length) {
        // ყველა ჯგუფი ერთად (გარე + ხვრელები), lon/lat
        const llRings = ll.flatMap(p => [p.outer, ...p.holes]);
        ref = bestReference(llRings, refs, g.meta.code);
        if (ref) Object.assign(row, { refIoU: +ref.iou.toFixed(4), refHausdorff: +ref.hausdorff.toFixed(3), refMean: +ref.meanDist.toFixed(3),
          refShiftE: +ref.shiftE.toFixed(3), refShiftN: +ref.shiftN.toFixed(3), refFile: ref.file });
      }
      row.category = classifyResult(g, inGeorgia, ref);
      if (!row.category.startsWith('ok') && row.category !== 'raster' && d && d.kind !== 'cadastral-plan') row.category = 'not_plan';
      if (!BAD.has(row.category)) okKml.push({ name: g.meta.code || rel, ll, desc: `${rel}; ფართობი ${g.meta.areaPdf ?? '?'} / ${g.areaCalc.toFixed(2)}` });
    } catch (e) {
      const msg = String(e && e.message || e);
      row.message = msg;
      row.category = classifyError(msg, e && e.raster);
      if (row.kind && row.kind !== 'cadastral-plan') row.category = row.kind === 'encrypted-unsupported' ? 'unreadable' : 'not_plan';
    }
    row.ms = Date.now() - t0;
    rows.push(row);
    if (BAD.has(row.category) || row.category === 'not_plan') {
      const d = path.join(outDir, 'failed', row.category); fs.mkdirSync(d, { recursive: true });
      fs.copyFileSync(f, path.join(d, rel.replace(/[\\/:]/g, '_').replace(/(\.pdf)?$/i, '.pdf')));
    }
    process.stdout.write(`[${i + 1}/${pdfs.length}] ${row.category.padEnd(15)} ${rel}${row.code ? ' ' + row.code : ''}${row.refIoU ? ' IoU ' + row.refIoU : ''}\n`);
  }
  if (okKml.length) {
    fs.writeFileSync(path.join(outDir, 'ok.kml'), core.makeKMLMulti('გეგმების ტესტი', okKml.map(k => ({ name: k.name, polysLL: k.ll, description: k.desc }))));
  }
  const counts = writeReport(outDir, rows, refs.length > 0);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\nჯამი:'); for (const k of Object.keys(CATEGORIES)) if (counts[k]) console.log(`  ${k.padEnd(15)} ${String(counts[k]).padStart(5)}  ${CATEGORIES[k]}`);
  console.log(`ანგარიში: ${path.join(outDir, 'report.html')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
