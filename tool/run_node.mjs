import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "fs";
import path from "path";
import * as core from "./core.mjs";

const [pdf, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const data = new Uint8Array(fs.readFileSync(pdf));
const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
const page = await doc.getPage(1);
const ex = await core.extractPage(page, pdfjs.OPS);
const g = core.buildGeometry(ex);
const ll = core.toLonLat(g.groups, g.meta.zone, g.meta.hemi);
const stem = core.safeName(g.meta.code, path.basename(pdf, ".pdf"));
fs.writeFileSync(path.join(outDir, stem + ".kml"), core.makeKML(g.meta.code || stem, ll));
const shp = core.makeShapefile(g.groups, { code: g.meta.code, areaPdf: g.meta.areaPdf, areaCalc: g.areaCalc, zone: g.meta.zone, hemi: g.meta.hemi });
const zip = core.makeZip([
  { name: stem + ".shp", data: shp.shp }, { name: stem + ".shx", data: shp.shx },
  { name: stem + ".dbf", data: shp.dbf }, { name: stem + ".prj", data: shp.prj }]);
fs.writeFileSync(path.join(outDir, stem + "_shp.zip"), zip);
fs.writeFileSync(path.join(outDir, stem + ".json"), JSON.stringify({
  meta: g.meta, info: g.info, areaCalc: g.areaCalc, diffPct: g.diffPct, areaTolerancePct: g.areaTolerancePct, warnings: g.warnings, notes: g.notes,
  groups: g.groups, ll }));
console.log(path.basename(pdf), "| code", g.meta.code, "rings", g.ringCount, "verts", g.vertexCount,
  "| area pdf", g.meta.areaPdf, "calc", g.areaCalc.toFixed(2), "diff", g.diffPct.toFixed(4) + "%",
  "| grid", g.info.gridX + "/" + g.info.gridY, "scale", g.info.scaleX.toFixed(4), g.info.scaleY.toFixed(4),
  "| warnings:", g.warnings.length ? g.warnings.join(" ; ") : "none", "| notes:", g.notes.length ? g.notes.join(" ; ") : "none");
