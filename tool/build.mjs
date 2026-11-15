import fs from "fs";
const root = new URL(".", import.meta.url).pathname;
const read = (p) => fs.readFileSync(root + p);
const b64 = (p) => read(p).toString("base64");

// core.mjs -> ჩვეულებრივი კოდი (export-ების გარეშე), რომ ერთ module-ში მოთავსდეს
const core = read("core.mjs").toString("utf8").replace(/^export (async function|function|const)/gm, "$1");
const ui = read("ui.js").toString("utf8");
const css = read("style.css").toString("utf8");
const pdfLib = b64("node_modules/pdfjs-dist/legacy/build/pdf.min.mjs");
const worker = b64("node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs");
const ver = JSON.parse(read("node_modules/pdfjs-dist/package.json")).version;

const html = `<!doctype html>
<html lang="ka"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>საკადასტრო გეგმა → KML / SHP</title>
<style>${css}</style></head>
<body><main>
<h1>საკადასტრო გეგმა → KML / SHP</h1>
<p class="sub">ჩააგდეთ NAPR-ის საკადასტრო გეგმის PDF (ერთი ან რამდენიმე). ფაილები არსად იგზავნება — ყველაფერი თქვენს ბრაუზერში მუშაობს, ინტერნეტი საჭირო არაა.</p>
<label id="drop"><b>PDF-ის ჩაგდება აქ ან არჩევა</b><span>შეიძლება რამდენიმე ფაილი ერთად</span><input id="file" type="file" accept="application/pdf,.pdf" multiple></label>
<div id="status"></div>
<div id="bar" hidden>
  <div class="barrow"><label class="chk"><input type="checkbox" id="selall"> ყველას მონიშვნა</label><span id="selcount"></span>
  <button id="delsel" class="ghost">მონიშნულების წაშლა</button></div>
  <div class="barrow"><span class="lbl">მონიშნულების ექსპორტი:</span>
  <button id="kml1">KML – ერთ ფაილად</button><button id="kmlz">KML – ცალ-ცალკე (ZIP)</button><button id="shpz">SHP (ZIP)</button></div>
</div>
<div id="cards"></div>
<footer>შედეგის სიზუსტე PDF-ში ჩაწერილი რიცხვებითაა შეზღუდული, ის ოფიციალურ shp-ს არ ცვლის. ყოველი ფაილისთვის გამოთვლილი ფართობი შედარებულია PDF-ში დაწერილს: მწვანე — ემთხვევა, ყვითელი/წითელი — გადაამოწმეთ. წყარო: pdf.js ${ver}.</footer>
</main>
<script id="lib-pdf" type="application/octet-stream">${pdfLib}</script>
<script id="lib-worker" type="application/octet-stream">${worker}</script>
<script type="module">
${core}
${ui}
</script>
</body></html>`;
fs.mkdirSync(root + "dist", { recursive: true });
fs.writeFileSync(root + "dist/cadastre_pdf_to_kml.html", html);
fs.writeFileSync(root + "../index.html", html); // GitHub Pages
console.log("built", (html.length / 1024 / 1024).toFixed(2), "MB");
