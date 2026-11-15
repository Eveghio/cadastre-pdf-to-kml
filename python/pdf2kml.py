#!/usr/bin/env python3
"""
NAPR საკადასტრო გეგმის PDF -> KML + Shapefile (ლოკალურად, AI-ს გარეშე).

გამოყენება:
    python pdf2kml.py plan1.pdf plan2.pdf ... [-o out_dir]

რას აკეთებს:
  1. PDF-იდან კითხულობს ბადის ნიშნულებს (481900, 4624300...) და ბადის ხაზებს -> საყრდენი წერტილები
  2. წითელი (1,0,0) ვექტორული ხაზიდან იღებს ნაკვეთის საზღვარს
  3. PDF-ის კოორდინატებს გადაჰყავს UTM-ში (affine, უმცირესი კვადრატებით)
  4. UTM -> WGS84, წერს .kml და .shp (+ .prj, .dbf)
  5. გამოთვლილ ფართობს ადარებს PDF-ში დაწერილ ფართობს და ბეჭდავს სხვაობას

დამოკიდებულებები:  pip install pymupdf pyproj shapely pyshp numpy
"""
import argparse
import math
import re
import sys
import warnings
from pathlib import Path
from xml.sax.saxutils import escape

warnings.filterwarnings("ignore")

import numpy as np
import pymupdf
import shapefile  # pyshp
from pyproj import CRS, Transformer
from shapely.geometry import LineString, Point, Polygon

RED = (1.0, 0.0, 0.0)
TOL = 0.05  # pt, სეგმენტების შეერთების ტოლერანტობი


def _color(d):
    c = d.get("color")
    return tuple(round(x, 2) for x in c) if c else None


def read_labels(page):
    """ბადის ნიშნულები: ({easting: px_x}, {northing: px_y}), ტექსტის ცენტრებით."""
    xs, ys = {}, {}
    for b in page.get_text("dict")["blocks"]:
        for ln in b.get("lines", []):
            for s in ln["spans"]:
                t = s["text"].strip()
                if not t.isdigit():
                    continue
                x0, y0, x1, y1 = s["bbox"]
                horizontal = abs(ln["dir"][0]) > 0.9
                # დიაპაზონი: გვერდის ნომრები და სხვა რიცხვები არ შემოვიდეს
                if len(t) == 6 and horizontal and 166000 <= int(t) <= 834000:       # easting
                    xs.setdefault(int(t), []).append((x0 + x1) / 2)
                elif len(t) == 7 and not horizontal and 3500000 <= int(t) <= 5500000:  # northing
                    ys.setdefault(int(t), []).append((y0 + y1) / 2)
    return ({k: float(np.mean(v)) for k, v in xs.items()},
            {k: float(np.mean(v)) for k, v in ys.items()})


def read_gridlines(page, min_len):
    """გრძელი ღერძისპარალელური ხაზები: (vertical_x_list, horizontal_y_list)."""
    vx, hy = [], []
    for d in page.get_drawings():
        for it in d["items"]:
            if it[0] != "l":
                continue
            a, b = it[1], it[2]
            if abs(a.x - b.x) < 0.01 and abs(a.y - b.y) > min_len:
                vx.append(a.x)
            elif abs(a.y - b.y) < 0.01 and abs(a.x - b.x) > min_len:
                hy.append(a.y)
    return sorted(set(round(v, 3) for v in vx)), sorted(set(round(v, 3) for v in hy))


def snap_labels_to_lines(labels, lines, max_dist=6.0):
    """თითო ნიშნულს უახლოეს ბადის ხაზს ვუსადაგებთ (ტექსტის ცენტრი ზუსტი არაა)."""
    pairs = []
    for val, pos in labels.items():
        if not lines:
            continue
        nearest = min(lines, key=lambda L: abs(L - pos))
        if abs(nearest - pos) <= max_dist:
            pairs.append((nearest, val))
    return sorted(set(pairs))


def robust_pairs(pairs):
    """ცუდი საყრდენები (გამონაკლისები) გამოვრიცხოთ: ბადე წრფივია, ნარჩენი ~0.1 მ."""
    cur = list(pairs)
    while len(cur) > 2:
        a, b = np.polyfit([p for p, _ in cur], [v for _, v in cur], 1)
        res = [abs(v - (a * p + b)) for p, v in cur]
        if max(res) <= 1.0:
            break
        cur.pop(int(np.argmax(res)))
    return cur


def build_transform(page):
    labels_x, labels_y = read_labels(page)
    min_len = min(page.rect.width, page.rect.height) * 0.4
    vx, hy = read_gridlines(page, min_len)
    px = robust_pairs(snap_labels_to_lines(labels_x, vx))
    py = robust_pairs(snap_labels_to_lines(labels_y, hy))
    if len(px) < 2 or len(py) < 2:
        raise RuntimeError(f"საყრდენი ბადე ვერ მოიძებნა (x:{len(px)}, y:{len(py)})")
    ax, bx = np.polyfit([p for p, _ in px], [v for _, v in px], 1)
    ay, by = np.polyfit([p for p, _ in py], [v for _, v in py], 1)
    res_x = max(abs(v - (ax * p + bx)) for p, v in px)
    res_y = max(abs(v - (ay * p + by)) for p, v in py)
    fn = lambda x, y: (ax * x + bx, ay * y + by)
    return fn, dict(grid_x=len(px), grid_y=len(py), resid_x_m=res_x, resid_y_m=res_y,
                    scale_x=ax, scale_y=ay)


def chain_rings(drawings):
    """წითელი 'l' სეგმენტებიდან იკრიბება დახურული რგოლები."""
    rings = []
    for d in drawings:
        if _color(d) != RED:
            continue
        cur = None
        for it in d["items"]:
            if it[0] == "qu":  # PyMuPDF ოთხკუთხედს/ოთხკუთხა კონტურს 'qu' ტიპად აბრუნებს
                q = it[1]
                rings.append([(q.ul.x, q.ul.y), (q.ur.x, q.ur.y), (q.lr.x, q.lr.y), (q.ll.x, q.ll.y), (q.ul.x, q.ul.y)])
                continue
            if it[0] == "re":
                r = it[1]
                rings.append([(r.x0, r.y0), (r.x1, r.y0), (r.x1, r.y1), (r.x0, r.y1), (r.x0, r.y0)])
                continue
            if it[0] != "l":
                continue
            a, b = it[1], it[2]
            if cur is None:
                cur = [(a.x, a.y)]
            elif math.hypot(a.x - cur[-1][0], a.y - cur[-1][1]) > TOL:
                rings.append(cur)
                cur = [(a.x, a.y)]
            cur.append((b.x, b.y))
        if cur:
            rings.append(cur)
    closed = []
    for r in rings:
        if len(r) >= 4 and math.hypot(r[0][0] - r[-1][0], r[0][1] - r[-1][1]) <= TOL:
            closed.append(r[:-1])
    return closed


def parse_meta(text):
    """კოდი, ფართობი(ები) და რუკის UTM ზონა. დასავლეთ საქართველოს PDF-ებში ფართობი ორია (37N/38N);
    რუკის ზონა ცალკე სტრიქონშია: "კოორდინატთა სისტემა: WGS 84 / UTM zone 37N"."""
    code = re.search(r"საკადასტრო\s+კოდი\s*:\s*([\d.]+)", text)
    zone_pat = r"(?:\(\s*WGS\s*84\s*/\s*U\s*TM\s+zone\s*(\d+)\s*([NS])\s*\))?"
    entry = r"(\d[\d\s.,]*?)\s*კ\s*ვ\s*\.?\s*მ\s*" + zone_pat
    area_list = []
    for gm in re.finditer(r"ფართობი\s*:\s*((?:\d[\d\s.,]*?\s*კ\s*ვ\s*\.?\s*მ\s*" + zone_pat.replace("(\\d+)", "\\d+").replace("([NS])", "[NS]") + r"\s*)+)", text):
        if re.search(r"ვალდებულების\s*$", text[max(0, gm.start() - 20):gm.start()]):
            continue
        for em in re.finditer(entry, gm.group(1)):
            area_list.append((float(re.sub(r"\s", "", em.group(1)).replace(",", ".")), int(em.group(2)) if em.group(2) else None))
        break
    crs = re.search(r"კოორდინატთა\s+სისტემა\s*:\s*WGS\s*84\s*/\s*U\s*TM\s+zone\s*(\d+)\s*([NS])", text)
    zone, hemi = (int(crs.group(1)), crs.group(2)) if crs else (None, "N")
    if zone is None:
        allz = re.findall(r"U\s*TM\s+zone\s*(\d+)\s*([NS])", text)
        if len({z for z, _ in allz}) == 1:
            zone, hemi = int(allz[0][0]), allz[0][1]
    area = None
    if area_list:
        area = next((a for a, z in area_list if zone is not None and z == zone), area_list[0][0])
    return (code.group(1) if code else None, area, (zone if zone is not None else 38, hemi), zone is not None, area_list)


def legacy_meta(page):
    """ძველი (2015) ფორმატი: ლათინური ტრანსლიტერაცია, ლეიბლი და მნიშვნელობა ერთ ხაზზე ცალკე span-ებად."""
    spans = []
    for b in page.get_text("dict")["blocks"]:
        for ln in b.get("lines", []):
            for sp in ln["spans"]:
                if sp["text"].strip():
                    spans.append((sp["text"].strip(), sp["bbox"]))
    def after(lab):
        y = (lab[1][1] + lab[1][3]) / 2
        return [t for t, bb in sorted(spans, key=lambda s: s[1][0])
                if s_is_after(bb, lab[1], y)]
    def s_is_after(bb, lb, y):
        return abs((bb[1] + bb[3]) / 2 - y) < 3 and bb[0] >= lb[2] - 2 and bb is not lb
    code = area = None
    lab = next((s for s in spans if re.search(r"sakadastro\s+kodi", s[0], re.I)), None)
    if lab:
        raw = [t for t in after(lab) if t]
        CODE = r"(\d{2}\.\d{2}\.\d{2}\.\d{3}(?:\.\d{3})?)"
        m = re.match(CODE, "".join(raw).replace(" ", "")) or re.fullmatch(CODE, ".".join(raw))
        code = m.group(1) if m else None
    lab = next((s for s in spans if re.search(r"miwis\s+nakveTis\s+farTobi", s[0], re.I)), None)
    if lab:
        m = re.search(r"(\d[\d\s.,]*?)\s*kv\s*\.?\s*m", " ".join(after(lab)), re.I)
        area = float(m.group(1).replace(" ", "").replace(",", ".")) if m else None
    return code, area


def kml_ring(coords):
    return " ".join(f"{lon:.8f},{lat:.8f},0" for lon, lat in coords)


def write_kml(path, name, polys_ll):
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
           f"<name>{escape(name)}</name>"]
    for outer, holes in polys_ll:
        out.append(f"<Placemark><name>{escape(name)}</name><Polygon><outerBoundaryIs><LinearRing>"
                   f"<coordinates>{kml_ring(outer)}</coordinates></LinearRing></outerBoundaryIs>")
        for h in holes:
            out.append(f"<innerBoundaryIs><LinearRing><coordinates>{kml_ring(h)}</coordinates>"
                       "</LinearRing></innerBoundaryIs>")
        out.append("</Polygon></Placemark>")
    out.append("</Document></kml>")
    Path(path).write_text("\n".join(out), encoding="utf-8")


def write_shp(path_noext, crs, polys_utm, code, area_pdf, area_calc):
    w = shapefile.Writer(str(path_noext), shapeType=shapefile.POLYGON)
    w.field("CAD_CODE", "C", 24)
    w.field("AREA_PDF", "N", 14, 2)
    w.field("AREA_CALC", "N", 14, 2)
    for outer, holes in polys_utm:
        # pyshp: გარე რგოლი საათის ისრის მიმართულებით, ხვრელები - საპირისპიროდ
        def orient(ring, cw):
            ring = list(ring) + [ring[0]]
            a = Polygon(ring).exterior.is_ccw
            return ring[::-1] if (a and cw) or (not a and not cw) else ring
        parts = [orient(outer, True)] + [orient(h, False) for h in holes]
        w.poly(parts)
        w.record(code or "", area_pdf or 0, round(area_calc, 2))
    w.close()
    Path(str(path_noext) + ".prj").write_text(crs.to_wkt(), encoding="utf-8")


def in_georgia(lon, lat):
    return 39.9 <= lon <= 46.8 and 41.0 <= lat <= 43.7


def detect_zone(rings_utm):
    """რომელი ზონა(ები) ათავსებს ნაკვეთს საქართველოში (37N / 38N)."""
    found = []
    for z in (37, 38):
        t = Transformer.from_crs(CRS.from_epsg(32600 + z), CRS.from_epsg(4326), always_xy=True)
        if all(in_georgia(*t.transform(x, y)) for r in rings_utm for x, y in r):
            found.append(z)
    return found


def process(pdf_path, out_dir, zone_override=None):
    doc = pymupdf.open(pdf_path)
    page = doc[0]
    code, area_pdf, (zone, hemi), zone_stated, area_list = parse_meta(page.get_text())
    if code is None or area_pdf is None:
        lc, la = legacy_meta(page)
        code, area_pdf = code or lc, area_pdf if area_pdf is not None else la
    fn, tinfo = build_transform(page)
    rings_px = chain_rings(page.get_drawings())
    if not rings_px:
        if len(page.get_images()) >= 3:
            raise RuntimeError("ამ PDF-ში რუკა სურათია (რასტრი), საზღვარი ვექტორული ხაზის სახით არ არის. ზუსტი გარდაქმნა ამ მეთოდით შეუძლებელია.")
        raise RuntimeError("წითელი საზღვრის რგოლი ვერ მოიძებნა")

    rings_all = [[fn(x, y) for x, y in r] for r in rings_px]
    rings_utm = []
    for r in rings_all:  # ArcMap ზოგჯერ საზღვარს ორჯერ ხატავს
        A = Polygon(r).area
        if any(abs(Polygon(k).area - A) <= 1e-3 * A and all(Point(px, py).distance(LineString(k + [k[0]])) <= 0.05 for px, py in r)
               for k in rings_utm):
            continue
        rings_utm.append(r)
    if zone_override:
        zone = zone_override
    elif not zone_stated:
        cands = detect_zone(rings_utm)
        if len(cands) == 1:
            zone = cands[0]
            print(f"  ℹ UTM ზონა PDF-ში არ წერია; კოორდინატებიდან განისაზღვრა {zone}N", file=sys.stderr)
            if len(area_list) > 1:  # ორი ფართობიდან ზონას შესაბამისი
                area_pdf = next((a for a, z in area_list if z == zone), area_pdf)
        else:
            print(f"  ⚠ UTM ზონა PDF-ში არ წერია და ვერ განისაზღვრა (კანდიდატები: {cands}); ვიღებ {zone}N-ს. მიუთითეთ --zone 37 ან --zone 38", file=sys.stderr)
    elif zone_stated:  # PDF-ში წარწერა შეიძლება არასწორი იყოს: საქართველოს გარეთ ხვდება -> სხვა ზონა
        cands = detect_zone(rings_utm)
        if len(cands) == 1 and cands[0] != zone:
            print(f"  ⚠ PDF-ში ზონა {zone}N წერია, მაგრამ ამ კოორდინატებით ნაკვეთი საქართველოს გარეთ ხვდება; ვიყენებ {cands[0]}N-ს", file=sys.stderr)
            zone = cands[0]
    crs_utm = CRS.from_epsg((32600 if hemi == "N" else 32700) + zone)
    to_wgs = Transformer.from_crs(crs_utm, CRS.from_epsg(4326), always_xy=True)
    if not all(in_georgia(*to_wgs.transform(x, y)) for r in rings_utm for x, y in r):
        print(f"  ⚠ {zone}{hemi} ზონით კოორდინატები საქართველოს გარეთ ხვდება — ზონა არასწორია", file=sys.stderr)
    polys = [Polygon(r) for r in rings_utm]
    order = sorted(range(len(polys)), key=lambda i: -polys[i].area)

    # გარე რგოლები და მათში მოხვედრილი ხვრელები
    groups = []
    for i in order:
        host = next((g for g in groups if g["poly"].contains(polys[i].representative_point())), None)
        if host:
            host["holes"].append(rings_utm[i])
        else:
            groups.append(dict(poly=polys[i], outer=rings_utm[i], holes=[]))
    polys_utm = [(g["outer"], g["holes"]) for g in groups]
    area_calc = sum(g["poly"].area - sum(Polygon(h).area for h in g["holes"]) for g in groups)

    polys_ll = []
    for outer, holes in polys_utm:
        conv = lambda ring: [to_wgs.transform(x, y) for x, y in ring] + [to_wgs.transform(*ring[0])]
        polys_ll.append((conv(outer), [conv(h) for h in holes]))

    stem = (code or Path(pdf_path).stem).replace(".", "_")
    out_dir.mkdir(parents=True, exist_ok=True)
    write_kml(out_dir / f"{stem}.kml", code or stem, polys_ll)
    write_shp(out_dir / stem, crs_utm, polys_utm, code, area_pdf, area_calc)

    diff = (area_calc - area_pdf) / area_pdf * 100 if area_pdf else float("nan")
    print(f"{Path(pdf_path).name}: კოდი={code} რგოლი={len(rings_utm)} ვერტექსი={sum(len(r) for r in rings_utm)} "
          f"| ფართობი PDF={area_pdf} გამოთვლილი={area_calc:.1f} სხვაობა={diff:+.2f}% "
          f"| ბადე x/y={tinfo['grid_x']}/{tinfo['grid_y']} "
          f"მასშტაბი x/y={tinfo['scale_x']:.4f}/{abs(tinfo['scale_y']):.4f} მ/pt "
          f"| -> {out_dir / (stem + '.kml')}")
    return diff


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdfs", nargs="+")
    ap.add_argument("-o", "--out", default="out")
    ap.add_argument("--zone", type=int, choices=[37, 38], help="UTM ზონა (თუ PDF-ში არ წერია და ავტომატურად ვერ განისაზღვრება)")
    args = ap.parse_args()
    bad = 0
    for p in args.pdfs:
        try:
            process(p, Path(args.out), args.zone)
        except Exception as e:  # ერთი ცუდი ფაილი ბატჩს არ აჩერებს
            bad += 1
            print(f"{p}: შეცდომა: {e}", file=sys.stderr)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
