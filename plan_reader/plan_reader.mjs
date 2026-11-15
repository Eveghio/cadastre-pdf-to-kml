// NAPR "საკადასტრო რუკის" PDF-ის ტიპის ამოცნობა (ბრაუზერი / service worker / Node 18+).
// ცვლის ინსტრუქციის pdfText/describePdf-ს. დამატებით:
//  - დაშიფრული ასლები (Standard handler, RC4/AES-ის გარეშე: V1/V2, ცარიელი პაროლი) იშიფრება
//  - თითო ფონტის გაშიფვრა: ToUnicode -> /Encoding /Differences (glyph-სახელები) -> Latin-1
//  - Object stream-ებში (ObjStm) მყოფი ობიექტებიც იკითხება
//  - ლათინური (AcadNusx) სათაურები: sakadastro gegma, situaciuri naxazi, azomviTi naxazi

const latin = (b) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return s; };
const bytesOf = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };

async function inflate(bytes) {
  const ds = new DecompressionStream("deflate"), w = ds.writable.getWriter();
  w.write(bytes).catch(() => {}); w.close().catch(() => {});
  const r = ds.readable.getReader(), parts = [];
  try { for (;;) { const { done, value } = await r.read(); if (done) break; parts.push(value); } } catch (e) { /* ნაწილობრივ გახსნილი */ }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

// ---------- MD5 + RC4 (დაშიფრული ასლებისთვის) ----------
function md5(bytes) {
  const K = new Uint32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  const n = bytes.length, len = ((n + 8) >> 6) + 1 << 6, m = new Uint8Array(len);
  m.set(bytes); m[n] = 0x80; const bits = n * 8;
  for (let i = 0; i < 8; i++) m[len - 8 + i] = Math.floor(bits / 2 ** (8 * i)) & 255;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const dv = new DataView(m.buffer);
  for (let o = 0; o < len; o += 64) {
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + dv.getUint32(o + 4 * g, true)) >>> 0;
      A = D; D = C; C = B;
      const s = S[(i >> 4) * 4 + (i & 3)];
      B = (B + ((F << s) | (F >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16), ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(4 * i, v, true));
  return out;
}
function rc4(key, data) {
  const S = new Uint8Array(256); for (let i = 0; i < 256; i++) S[i] = i;
  for (let i = 0, j = 0; i < 256; i++) { j = (j + S[i] + key[i % key.length]) & 255; [S[i], S[j]] = [S[j], S[i]]; }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + S[i]) & 255; [S[i], S[j]] = [S[j], S[i]];
    out[k] = data[k] ^ S[(S[i] + S[j]) & 255];
  }
  return out;
}
const PAD = bytesOf("\x28\xbf\x4e\x5e\x4e\x75\x8a\x41\x64\x00\x4e\x56\xff\xfa\x01\x08\x2e\x2e\x00\xb6\xd0\x68\x3e\x80\x2f\x0c\xa9\xfe\x64\x53\x69\x7a");

// ---------- PDF სტრიქონები ----------
function parseLiteral(s, i) { // s[i] === "(" -> [bytesString, nextIndex]
  let depth = 1, j = i + 1, out = "";
  while (j < s.length && depth) {
    const c = s[j];
    if (c === "\\") {
      const e = s[j + 1];
      const mp = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
      if (mp[e] !== undefined) { out += mp[e]; j += 2; }
      else if (e >= "0" && e <= "7") { const m = /^[0-7]{1,3}/.exec(s.slice(j + 1, j + 4))[0]; out += String.fromCharCode(parseInt(m, 8) & 255); j += 1 + m.length; }
      else if (e === "\r" || e === "\n") { j += 2; if (e === "\r" && s[j] === "\n") j++; }
      else { out += e; j += 2; }
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (!depth) break; }
    out += c; j++;
  }
  return [out, j + 1];
}
const hexStr = (h) => { h = h.replace(/[^0-9A-Fa-f]/g, ""); if (h.length % 2) h += "0"; let o = ""; for (let i = 0; i < h.length; i += 2) o += String.fromCharCode(parseInt(h.slice(i, i + 2), 16)); return o; };

// ---------- ობიექტები ----------
export async function readObjects(bytes) {
  const s = latin(bytes), objs = new Map(); // num -> {gen, dict, data(Uint8Array|null)}
  const re = /(\d+)\s+(\d+)\s+obj\b/g; let m;
  const heads = []; while ((m = re.exec(s))) heads.push([+m[1], +m[2], m.index + m[0].length]);
  for (let k = 0; k < heads.length; k++) {
    const [num, gen, st] = heads[k];
    const lim = k + 1 < heads.length ? heads[k + 1][2] : s.length;
    const endobj = s.indexOf("endobj", st), stop = endobj >= 0 && endobj < lim ? endobj : lim;
    const body = s.slice(st, stop);
    const sm = /stream\r?\n/.exec(body);
    if (sm) {
      const ds = st + sm.index + sm[0].length, de = s.indexOf("endstream", ds);
      objs.set(num, { gen, dict: body.slice(0, sm.index), raw: bytes.subarray(ds, de < 0 ? ds : de) });
    } else objs.set(num, { gen, dict: body, raw: null });
  }
  return { s, objs };
}

export function encryptionKey(s, objs) {
  const tm = s.match(/\/Encrypt\s+(\d+)\s+\d+\s+R/); if (!tm) return null;
  const e = objs.get(+tm[1]); if (!e) return null;
  const d = e.dict, V = +(d.match(/\/V\s+(\d+)/) || [0, 0])[1], R = +(d.match(/\/R\s+(\d+)/) || [0, 2])[1];
  if (V > 2 || /\/CFM\s*\/AESV/.test(d)) return { unsupported: true }; // AES - არ არის მხარდაჭერილი
  const len = +(d.match(/\/Length\s+(\d+)/) || [0, 40])[1] / 8;
  const getStr = (key) => { const i = d.search(new RegExp("/" + key + "\\s*[(<]")); if (i < 0) return ""; const j = d.indexOf(d[d.indexOf("/" + key, i) + key.length + 1] === "(" ? "(" : "<", i);
    return d[j] === "(" ? parseLiteral(d, j)[0] : hexStr(d.slice(j + 1, d.indexOf(">", j))); };
  const O = bytesOf(getStr("O").slice(0, 32)), P = +(d.match(/\/P\s+(-?\d+)/) || [0, 0])[1];
  const idm = s.match(/\/ID\s*\[\s*<([0-9A-Fa-f]*)>/); const ID = bytesOf(idm ? hexStr(idm[1]) : "");
  const buf = new Uint8Array(32 + 32 + 4 + ID.length); buf.set(PAD, 0); buf.set(O, 32);
  new DataView(buf.buffer).setInt32(64, P, true); buf.set(ID, 68);
  let key = md5(buf).subarray(0, len);
  if (R >= 3) for (let i = 0; i < 50; i++) key = md5(key).subarray(0, len);
  return { key: Uint8Array.from(key), encryptNum: +tm[1] };
}
function objKey(enc, num, gen) {
  const b = new Uint8Array(enc.key.length + 5); b.set(enc.key);
  b[enc.key.length] = num & 255; b[enc.key.length + 1] = (num >> 8) & 255; b[enc.key.length + 2] = (num >> 16) & 255;
  b[enc.key.length + 3] = gen & 255; b[enc.key.length + 4] = (gen >> 8) & 255;
  return md5(b).subarray(0, Math.min(enc.key.length + 5, 16));
}

export async function streamText(o, num, enc) {
  let data = o.raw;
  if (enc && enc.key && num !== enc.encryptNum && !/\/Type\s*\/XRef/.test(o.dict)) data = rc4(objKey(enc, num, o.gen), data);
  if (/\/FlateDecode/.test(o.dict)) { const d = await inflate(data); if (d.length) data = d; }
  return latin(data);
}

// ---------- ფონტები ----------
const GLYPH = { space: " ", period: ".", comma: ",", hyphen: "-", colon: ":", semicolon: ";", slash: "/", parenleft: "(", parenright: ")",
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", underscore: "_",
  numbersign: "#", percent: "%", quotesingle: "'", quotedbl: '"', plus: "+", equal: "=", asterisk: "*", ampersand: "&", exclam: "!", question: "?" };
const glyphChar = (n) => n.length === 1 ? n : GLYPH[n] !== undefined ? GLYPH[n] : /^uni[0-9A-F]{4}$/.test(n) ? String.fromCharCode(parseInt(n.slice(3), 16)) : "";

function cmapToMap(t) { // ToUnicode -> {codeHex: string}, byteLen
  const map = {}; let byteLen = 1;
  const cs = t.match(/begincodespacerange\s*<([0-9A-Fa-f]+)>/); if (cs) byteLen = cs[1].length / 2;
  const u16 = (h) => { let o = ""; for (let i = 0; i + 3 < h.length; i += 4) o += String.fromCharCode(parseInt(h.slice(i, i + 4), 16)); return o; };
  for (const b of t.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const p of b[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) { map[p[1].toUpperCase()] = u16(p[2]); if (!cs) byteLen = p[1].length / 2; }
  for (const b of t.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const p of b[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g)) {
      const a = parseInt(p[1], 16), z = parseInt(p[2], 16), w = p[1].length; if (!cs) byteLen = w / 2;
      if (p[3][0] === "[") { const arr = [...p[3].matchAll(/<([0-9A-Fa-f]+)>/g)]; arr.forEach((x, i) => { map[(a + i).toString(16).toUpperCase().padStart(w, "0")] = u16(x[1]); }); }
      else { const u = parseInt(p[3].slice(1, -1), 16); for (let i = a; i <= z && i - a < 5000; i++) map[i.toString(16).toUpperCase().padStart(w, "0")] = String.fromCharCode(u + i - a); }
    }
  return { map, byteLen };
}

export async function buildFonts(objs, texts) {
  const dictOf = (num) => (objs.get(num) || {}).dict || "";
  const fonts = {}; // resourceName -> decoder(bytesString) => text
  const decoders = new Map(); // fontObjNum -> decoder
  const decoderFor = async (fnum) => {
    if (decoders.has(fnum)) return decoders.get(fnum);
    const fd = dictOf(fnum); let dec = (b) => b; // Latin-1
    const tu = fd.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
    if (tu && texts.has(+tu[1])) {
      const { map, byteLen } = cmapToMap(texts.get(+tu[1]));
      dec = (b) => { let o = ""; for (let i = 0; i + byteLen <= b.length; i += byteLen) { let h = ""; for (let k = 0; k < byteLen; k++) h += b.charCodeAt(i + k).toString(16).toUpperCase().padStart(2, "0"); o += map[h] !== undefined ? map[h] : (byteLen === 1 ? b[i] : ""); } return o; };
    } else {
      let encDict = "";
      const er = fd.match(/\/Encoding\s+(\d+)\s+\d+\s+R/); if (er) encDict = dictOf(+er[1]);
      else { const ei = fd.match(/\/Encoding\s*<<([\s\S]*?)>>/); if (ei) encDict = ei[1]; }
      const dm = encDict.match(/\/Differences\s*\[([\s\S]*?)\]/);
      if (dm) {
        const diff = {}; let code = 0;
        for (const tok of dm[1].match(/\d+|\/[^\s\/\[\]]+/g) || []) { if (tok[0] !== "/") code = +tok; else { diff[code] = glyphChar(tok.slice(1)); code++; } }
        dec = (b) => { let o = ""; for (let i = 0; i < b.length; i++) { const c = b.charCodeAt(i); o += diff[c] !== undefined ? diff[c] : b[i]; } return o; };
      }
    }
    decoders.set(fnum, dec); return dec;
  };
  // ფონტის რესურსები: /Font << /F1 12 0 R ... >> ან /Font 34 0 R
  const resDicts = [];
  for (const [, o] of objs) {
    const d = o.dict;
    for (const m of d.matchAll(/\/Font\s*<<([\s\S]*?)>>/g)) resDicts.push(m[1]);
    for (const m of d.matchAll(/\/Font\s+(\d+)\s+\d+\s+R/g)) resDicts.push(dictOf(+m[1]));
  }
  for (const rd of resDicts) for (const m of rd.matchAll(/\/([^\s\/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) if (!fonts[m[1]]) fonts[m[1]] = await decoderFor(+m[2]);
  return fonts;
}

// ---------- ტექსტი ----------
export function contentText(t, fonts) {
  t = t.replace(/\bBI\b[\s\S]*?\bID\s[\s\S]*?\sEI(?=\s)/g, " "); // inline სურათები (ბინარული) - გამოტოვება
  let out = "", dec = (b) => b; const re = /\/([^\s\/<>\[\]()]+)\s+[-\d.]+\s+Tf|\(|<(?!<)([0-9A-Fa-f\s]*)>|\bT[jJ]\b|'|"|\bET\b|\bTd\b|\bTD\b|\bT\*|\bTm\b/g;
  let m;
  while ((m = re.exec(t))) {
    if (m[1]) { dec = fonts[m[1]] || ((b) => b); continue; }
    if (m[0] === "(") { const [str, nx] = parseLiteral(t, m.index); out += dec(str); re.lastIndex = nx; continue; }
    if (m[2] !== undefined && m[0][0] === "<") { out += dec(hexStr(m[2])); continue; }
    if (/^(ET|Td|TD|T\*|Tm|')$/.test(m[0])) out += " ";
  }
  return out;
}

export async function pdfText(bytes) {
  const { s, objs } = await readObjects(bytes);
  const enc = encryptionKey(s, objs);
  if (enc && enc.unsupported) return { text: "", raw: s, encrypted: true, unsupported: true };
  const texts = new Map();
  for (const [num, o] of objs) if (o.raw) texts.set(num, await streamText(o, num, enc));
  // Object stream-ების შიგთავსი -> ცალკე ობიექტებად
  for (const [num, o] of objs) {
    if (!o.raw || !/\/Type\s*\/ObjStm/.test(o.dict)) continue;
    const t = texts.get(num), first = +(o.dict.match(/\/First\s+(\d+)/) || [0, 0])[1];
    const nums = t.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const st = first + nums[i + 1], en = i + 3 < nums.length ? first + nums[i + 3] : t.length;
      if (!objs.has(nums[i])) objs.set(nums[i], { gen: 0, dict: t.slice(st, en), raw: null });
    }
  }
  const fonts = await buildFonts(objs, texts);
  let text = "";
  for (const [, t] of texts) if (/\bBT\b/.test(t) && /T[jJ]/.test(t)) text += contentText(t, fonts) + " ";
  // Info-ს თარიღი (დაშიფრულ ფაილში - გაშიფრული)
  let created = null;
  const im = s.match(/\/Info\s+(\d+)\s+(\d+)\s+R/);
  if (im && objs.has(+im[1])) {
    const d = objs.get(+im[1]).dict, j = d.search(/\/CreationDate\s*[(<]/);
    if (j >= 0) {
      const k = d.indexOf(d.slice(j).match(/[(<]/)[0], j);
      let v = d[k] === "(" ? parseLiteral(d, k)[0] : hexStr(d.slice(k + 1, d.indexOf(">", k)));
      if (enc && enc.key) v = latin(rc4(objKey(enc, +im[1], +im[2]), bytesOf(v)));
      created = v;
    }
  }
  return { text: text.replace(/\s+/g, " "), raw: s, encrypted: !!enc, created };
}

function pdfDate(v) {
  const m = v && v.match(/D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?([Z+\-])?(\d{2})?'?(\d{2})?/);
  if (!m) return null;
  const off = m[7] && m[7] !== "Z" ? (m[7] === "-" ? -1 : 1) * ((+m[8] || 0) * 60 + (+m[9] || 0)) : 0;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] || 0, +m[5] || 0, +m[6] || 0) - off * 60000);
}

// რეესტრის შტამპი ნახაზებზე: "…აზომვითი ნახაზი არ შეესაბამება #315 დადგენილებას",
// "sakadastro agegmviTi/azomviTi naxazi ar Seesabameba #388-e…". ეს სათაური არ არის - ამოვიღოთ.
const STAMP = /(?:sakadastro|agegmviTi\/?|azomviTi|situaciuri|Sida|საკადასტრო|აგეგმვითი\/?|აზომვითი|სიტუაციური|შიდა)*(?:naxazi|ნახაზი|gegma|გეგმა)(?:arSeesabameba|არშეესაბამება)/g;

// { kind, stamp, confirmed, appNo, prepared, created, signed, encrypted }
export async function describeMap(bytes) {
  const { text, raw, encrypted, unsupported, created } = await pdfText(bytes);
  const flat = text.replace(/\s+/g, "");
  const stamps = flat.match(STAMP) || [];
  const body = flat.replace(STAMP, "");
  const title =
    /სიტუაციურინახაზი|situaciurinaxazi/.test(body) ? "situational-drawing" :
    /აზომვითინახაზი|azomviTinaxazi/.test(body) ? "measurement-drawing" :
    /საკადასტროგეგმა|sakadastrogegma/.test(body) ? "cadastral-plan" : null;
  // "საკადასტრო კოდი" ყველა გეგმაშია (18/18), მაგრამ რეესტრის ნახაზებშიც - ის მხოლოდ დამატებითი პირობაა,
  // გეგმას ნახაზისგან მხოლოდ სათაური არჩევს
  const hasKodi = /საკადასტროკოდი|sakadastrokodi/.test(flat);
  const hasAgency = /საჯარორეესტრისეროვნულისააგენტო|reestriserovnulisaagento/.test(flat);
  let kind = title || (unsupported ? "encrypted-unsupported" : "unknown");
  if (kind === "cadastral-plan" && !hasKodi) kind = "unknown";
  const stamp = stamps.length ? stamps[0] : "";
  // განცხადების ნომერი: შტრიხკოდი *N* | "განცხადების ნომერი: N" | ძველ ფორმატში თარიღის (dd.mm.yy) შემდეგ
  const app = (text.match(/\*(8[89]\d{10})\*/) || flat.match(/განცხადებისნომერი:?(8[89]\d{10})(?!\d)/) ||
    flat.match(/\d{2}\.\d{2}\.\d{2}(8[89]\d{10})(?!\d)/) || text.match(/(?<![\d.])(8[89]\d{10})(?![\d.])/) || [])[1] || "";
  const pd = flat.match(/მომზადებისთარიღი:(\d{2})\/(\d{2})\/(\d{4})/);
  return { kind, stamp, confirmed: kind === "cadastral-plan" && hasAgency, appNo: app,
    prepared: pd ? new Date(+pd[3], +pd[2] - 1, +pd[1]) : null,
    created: pdfDate(created) || pdfDate((raw.match(/\/CreationDate\s*\((D:[^)]*)\)/) || [])[1]),
    signed: /\/ByteRange\s*\[/.test(raw), encrypted };
}
