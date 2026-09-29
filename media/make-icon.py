#!/usr/bin/env python3
"""Renders the extension icon (media/icon.png) and icon font (media/icon.woff).

The icon is a flat, VS Code-style cat: a rounded-square dark plate with a cat
head on it, kept low-saturation so it sits quietly next to VS Code's own
monochrome chrome. It is drawn from signed distance fields so the shapes stay
analytically anti-aliased at any size and the source stays editable -- tweak
the palette or the coordinates below and re-run:

    python3 media/make-icon.py [palette]

PALETTES lists the choices; DEFAULT_PALETTE is what ships.

All geometry is expressed on a 128x128 design grid regardless of output size.
The WOFF font uses a 1000-unit em square; coordinates are scaled by 1000/128.
"""

from __future__ import annotations

import math
import os
import struct
import sys
import zlib

GRID = 128.0
SIZES = (256, 128)

WHITE = (0xFF, 0xFF, 0xFF)


def rgb(value: int):
    return ((value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF)


# plate_top, plate_bottom, cat_top, cat_bottom, inner_ear, feature, glint alpha
PALETTES = {
    # Desaturated slate: reads as VS Code chrome, near-monochrome.
    "slate": dict(plate=(0x1E2429, 0x151A1E), cat=(0xBFCAD2, 0x97A5AF),
                  inner_ear=0xD8E0E5, feature=0x181D22, glint=0.85, blush=0.10),
    # Muted steel blue, a little cooler and more distinct in a tab strip.
    "steel": dict(plate=(0x1C2228, 0x13181C), cat=(0x86A9C0, 0x5F86A1),
                  inner_ear=0xB2C8D6, feature=0x161B20, glint=0.8, blush=0.10),
    # Dusty terracotta: keeps a hint of the Databricks red, heavily muted.
    "clay": dict(plate=(0x1E2328, 0x14181C), cat=(0xC9857A, 0xA9635A),
                 inner_ear=0xE2B6AC, feature=0x191E22, glint=0.8, blush=0.10),
}
DEFAULT_PALETTE = "slate"


def clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return lo if v < lo else hi if v > hi else v


# --- signed distance fields (all in design-grid units) ----------------------


def sd_round_box(x, y, cx, cy, hx, hy, r):
    qx = abs(x - cx) - (hx - r)
    qy = abs(y - cy) - (hy - r)
    return math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - r


def sd_circle(x, y, cx, cy, r):
    return math.hypot(x - cx, y - cy) - r


def sd_segment(x, y, ax, ay, bx, by, half_width):
    px, py = x - ax, y - ay
    ex, ey = bx - ax, by - ay
    t = clamp((px * ex + py * ey) / (ex * ex + ey * ey))
    return math.hypot(px - ex * t, py - ey * t) - half_width


def sd_triangle(x, y, p0, p1, p2, r=0.0):
    edges = ((p1[0] - p0[0], p1[1] - p0[1]),
             (p2[0] - p1[0], p2[1] - p1[1]),
             (p0[0] - p2[0], p0[1] - p2[1]))
    verts = ((x - p0[0], y - p0[1]), (x - p1[0], y - p1[1]), (x - p2[0], y - p2[1]))
    s = 1.0 if edges[0][0] * edges[2][1] - edges[0][1] * edges[2][0] > 0 else -1.0
    dist = float("inf")
    sign = 1.0
    for v, e in zip(verts, edges):
        t = clamp((v[0] * e[0] + v[1] * e[1]) / (e[0] * e[0] + e[1] * e[1]))
        qx, qy = v[0] - e[0] * t, v[1] - e[1] * t
        d2 = qx * qx + qy * qy
        cross = s * (v[0] * e[1] - v[1] * e[0])
        if d2 < dist:
            dist = d2
        if cross < sign:
            sign = cross
    return -math.sqrt(dist) * (1.0 if sign >= 0 else -1.0) - r


def sd_arc(x, y, cx, cy, r, half_width, aperture_deg):
    """Arc of radius r centred on (cx, cy), symmetric about straight down."""
    px, py = abs(x - cx), y - cy
    sx, sy = math.sin(math.radians(aperture_deg)), math.cos(math.radians(aperture_deg))
    if sy * px > sx * py:
        return math.hypot(px - sx * r, py - sy * r) - half_width
    return abs(math.hypot(px, py) - r) - half_width


def smooth_min(a, b, k):
    h = max(k - abs(a - b), 0.0) / k
    return min(a, b) - h * h * k * 0.25


# --- geometry --------------------------------------------------------------

HEAD = (64.0, 74.0, 36.0, 32.0, 24.0)          # cx, cy, hx, hy, corner radius
EAR_L = ((32.0, 22.5), (28.0, 56.5), (60.0, 45.0))
EAR_INNER_L = ((34.5, 32.0), (33.0, 48.5), (49.5, 44.0))
EYES = ((50.0, 76.0), (78.0, 76.0))
EYE_R = 8.0
GLINT_R = 2.7
BLUSH = ((40.0, 89.0), (88.0, 89.0))
NOSE = ((60.8, 84.0), (67.2, 84.0), (64.0, 88.4))
# Two shallow arcs make the "w" smile; cx, cy, radius, half width, aperture.
MOUTH = ((59.2, 88.6, 4.4, 1.0, 62.0), (68.8, 88.6, 4.4, 1.0, 62.0))
WHISKERS_L = (((31.0, 80.0), (15.0, 75.5)),
              ((30.0, 86.5), (13.0, 87.0)),
              ((31.0, 93.0), (15.0, 98.0)))


def mirror_point(p):
    return (GRID - p[0], p[1])


def mirror_tri(tri):
    return tuple(mirror_point(p) for p in tri)


EAR_R = mirror_tri(EAR_L)
EAR_INNER_R = mirror_tri(EAR_INNER_L)
WHISKERS_R = tuple((mirror_point(a), mirror_point(b)) for a, b in WHISKERS_L)


def head_field(x, y):
    """Head and both ears fused with a smooth union so the ears grow out of it."""
    d = sd_round_box(x, y, *HEAD)
    for ear in (EAR_L, EAR_R):
        d = smooth_min(d, sd_triangle(x, y, *ear, r=4.0), 8.0)
    return d


def vertical_gradient(top, bottom, y0, y1):
    def sample(_x, y):
        t = clamp((y - y0) / (y1 - y0))
        return tuple(a + (b - a) * t for a, b in zip(top, bottom))
    return sample


def solid(color):
    def sample(_x, _y):
        return color
    return sample


def build_layers(name: str):
    """Painter's order: plate, cat, then the features punched on top."""
    pal = PALETTES[name]
    plate_top, plate_bottom = (rgb(c) for c in pal["plate"])
    cat_top, cat_bottom = (rgb(c) for c in pal["cat"])
    inner_ear, feature = rgb(pal["inner_ear"]), rgb(pal["feature"])
    return [
        (lambda x, y: sd_round_box(x, y, 64.0, 64.0, 64.0, 64.0, 26.0),
         vertical_gradient(plate_top, plate_bottom, 0.0, GRID), 1.0),
        (head_field, vertical_gradient(cat_top, cat_bottom, 24.0, 108.0), 1.0),
        (lambda x, y: min(sd_triangle(x, y, *EAR_INNER_L, r=2.2),
                          sd_triangle(x, y, *EAR_INNER_R, r=2.2)),
         solid(inner_ear), 1.0),
        (lambda x, y: min(sd_circle(x, y, *BLUSH[0], 6.5),
                          sd_circle(x, y, *BLUSH[1], 6.5)),
         solid(WHITE), pal["blush"]),
        (lambda x, y: min(sd_circle(x, y, *EYES[0], EYE_R),
                          sd_circle(x, y, *EYES[1], EYE_R)),
         solid(feature), 1.0),
        (lambda x, y: min(sd_circle(x, y, EYES[0][0] + 2.6, EYES[0][1] - 3.2, GLINT_R),
                          sd_circle(x, y, EYES[1][0] + 2.6, EYES[1][1] - 3.2, GLINT_R)),
         solid(WHITE), pal["glint"]),
        (lambda x, y: sd_triangle(x, y, *NOSE, r=1.6), solid(feature), 1.0),
        (lambda x, y: min(sd_arc(x, y, *arc) for arc in MOUTH), solid(feature), 1.0),
        (lambda x, y: min(sd_segment(x, y, *a, *b, 1.15)
                          for a, b in WHISKERS_L + WHISKERS_R),
         solid(cat_top), 1.0),
    ]


def render(size: int, palette: str = DEFAULT_PALETTE) -> bytearray:
    layers = build_layers(palette)
    scale = size / GRID
    buf = bytearray(size * size * 4)
    for py in range(size):
        y = (py + 0.5) / scale
        row = py * size * 4
        for px in range(size):
            x = (px + 0.5) / scale
            r = g = b = 0.0
            a = 0.0
            for field, shade, opacity in layers:
                # Analytic anti-aliasing: convert the SDF to pixel coverage.
                cov = clamp(0.5 - field(x, y) * scale) * opacity
                if cov <= 0.0:
                    continue
                sr, sg, sb = shade(x, y)
                r = sr * cov + r * (1.0 - cov)
                g = sg * cov + g * (1.0 - cov)
                b = sb * cov + b * (1.0 - cov)
                a = cov + a * (1.0 - cov)
            i = row + px * 4
            buf[i] = int(r + 0.5)
            buf[i + 1] = int(g + 0.5)
            buf[i + 2] = int(b + 0.5)
            buf[i + 3] = int(a * 255.0 + 0.5)
    return buf


def write_png(path: str, size: int, pixels: bytearray) -> None:
    stride = size * 4
    raw = b"".join(b"\x00" + bytes(pixels[y * stride:(y + 1) * stride]) for y in range(size))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(png)


# ---------------------------------------------------------------------------
# Status bar glyph: a monochrome WOFF icon font
#
# VS Code's `icons` contribution point only takes a WOFF, so the status bar cat
# is a font glyph rather than the PNG above. The glyph is the bare silhouette:
# no plate and no shading, because the status bar paints it in one theme colour
# at roughly 14px.
#
# The metric conventions are lifted from VS Code's own codicon.ttf so the cat
# lines up with the built-in icons: a square em box, the glyph filling it from
# the baseline up (ascender = em, descender = 0) and an advance of one em.
#
# The design grid above is y-down and TrueType is y-up, so the silhouette is
# flipped, scaled to fill FILL of the em box and centred; `_em` does all three.
# The SVG written alongside the font is built from the same contours, so it is
# a faithful preview of the glyph rather than a second drawing.
# ---------------------------------------------------------------------------

EM = 1000                # em square; codicon uses 300, the exact value is free
FILL = 0.96              # fraction of the em box the silhouette spans
ICON_CODEPOINT = 0xE001  # private use slot the `icons` contribution names
ARC_SEGMENTS = 2         # quadratics per quarter turn; 2 holds the radius to 0.3%


def _silhouette_bounds():
    """Design-grid bounds of the outer shapes (head box plus both ears)."""
    cx, cy, hx, hy, _ = HEAD
    xs = [cx - hx, cx + hx]
    ys = [cy - hy, cy + hy]
    for tri in (EAR_L, EAR_R):
        xs += [p[0] for p in tri]
        ys += [p[1] for p in tri]
    return min(xs), min(ys), max(xs), max(ys)


_BX0, _BY0, _BX1, _BY1 = _silhouette_bounds()
_SCALE = FILL * EM / max(_BX1 - _BX0, _BY1 - _BY0)
_LEFT = (EM - (_BX1 - _BX0) * _SCALE) / 2.0
_BOTTOM = (EM - (_BY1 - _BY0) * _SCALE) / 2.0


def _em(point):
    """Design-grid point (y down) to em units (y up)."""
    x, y, on_curve = point
    return (_LEFT + (x - _BX0) * _SCALE,
            _BOTTOM + (_BY1 - y) * _SCALE,
            on_curve)


# --- contour builders (design-grid units, y down) ---------------------------


def _arc(cx, cy, r, a0, a1, segments):
    """Quadratic approximation of a circular arc.

    Returns the on-curve start point followed by a (control, on-curve) pair per
    segment. The control point sits where the tangents at the segment ends meet.
    """
    pts = [(cx + r * math.cos(a0), cy + r * math.sin(a0), True)]
    for i in range(segments):
        start = a0 + (a1 - a0) * i / segments
        end = a0 + (a1 - a0) * (i + 1) / segments
        mid = (start + end) / 2.0
        reach = r / math.cos((end - start) / 2.0)
        pts.append((cx + reach * math.cos(mid), cy + reach * math.sin(mid), False))
        pts.append((cx + r * math.cos(end), cy + r * math.sin(end), True))
    return pts


def _dedupe(pts, tol=1e-6):
    """Drop points that repeat the one before, and a closing copy of the first."""
    out = []
    for p in pts:
        if out and abs(p[0] - out[-1][0]) < tol and abs(p[1] - out[-1][1]) < tol:
            continue
        out.append(p)
    while len(out) > 1 and abs(out[-1][0] - out[0][0]) < tol and abs(out[-1][1] - out[0][1]) < tol:
        out.pop()
    return out


def _rounded_rect_contour(cx, cy, hx, hy, r):
    """Rounded rectangle: four corner arcs joined by implicit straight edges."""
    x0, y0, x1, y1 = cx - hx, cy - hy, cx + hx, cy + hy
    half = math.pi / 2
    corners = (
        (x0 + r, y0 + r, math.pi, math.pi + half),        # top left
        (x1 - r, y0 + r, math.pi + half, 2 * math.pi),    # top right
        (x1 - r, y1 - r, 0.0, half),                      # bottom right
        (x0 + r, y1 - r, half, math.pi),                  # bottom left
    )
    pts = []
    for ccx, ccy, a0, a1 in corners:
        pts += _arc(ccx, ccy, r, a0, a1, ARC_SEGMENTS)
    return _dedupe(pts)


def _circle_contour(cx, cy, r):
    return _dedupe(_arc(cx, cy, r, 0.0, 2 * math.pi, 4 * ARC_SEGMENTS))


def _polygon_contour(points):
    return [(x, y, True) for x, y in points]


# --- winding ---------------------------------------------------------------


def _signed_area(pts):
    """Shoelace area over the point list; positive is counter-clockwise (y up)."""
    total = 0.0
    for i, (x, y, _) in enumerate(pts):
        nx, ny, _ = pts[(i + 1) % len(pts)]
        total += x * ny - nx * y
    return total / 2.0


def _orient(pts, clockwise):
    """Normalise a contour's direction.

    TrueType fills by non-zero winding with outer contours clockwise in the y-up
    font space and holes counter-clockwise. Reversing also has to leave the
    contour starting on an on-curve point; rasterizers vary on leading controls.
    """
    if (_signed_area(pts) < 0.0) == clockwise:
        return pts
    pts = list(reversed(pts))
    first_on = next(i for i, p in enumerate(pts) if p[2])
    return pts[first_on:] + pts[:first_on]


def glyph_contours():
    """The status bar cat as em-unit contours (y up), outers first then holes.

    The head box and the two ear triangles overlap; same-winding outer contours
    union cleanly under the non-zero rule, so no boolean geometry is needed.

    Only the eyes and the nose are punched out. The PNG's mouth, whiskers, glint
    and blush are all sub-pixel at status bar size and only muddy the outline,
    and the inner ears are dropped too: in the PNG they are a lighter fill, so
    punching them out of a one-colour glyph would leave the ears as hollow
    triangles instead of the solid ones the silhouette reads best with.
    """
    cx, cy, hx, hy, r = HEAD

    outer = [
        _rounded_rect_contour(cx, cy, hx, hy, r),
        _polygon_contour(EAR_L),
        _polygon_contour(EAR_R),
    ]
    holes = [
        _circle_contour(*EYES[0], EYE_R),
        _circle_contour(*EYES[1], EYE_R),
        _polygon_contour(NOSE),
    ]

    def to_em(contour, clockwise):
        return _orient([_em(p) for p in contour], clockwise)

    return ([to_em(c, True) for c in outer]
            + [to_em(c, False) for c in holes])


# --- SVG preview -----------------------------------------------------------


def make_svg_icon() -> str:
    """The glyph as a monochrome SVG (same contours, y flipped back down)."""
    segments = []
    for contour in glyph_contours():
        pts = [(x, EM - y, on) for x, y, on in contour]
        segments.append(f"M {pts[0][0]:.1f},{pts[0][1]:.1f}")
        i = 1
        while i < len(pts):
            x, y, on = pts[i]
            if on:
                segments.append(f"L {x:.1f},{y:.1f}")
                i += 1
            else:
                # Contours alternate control and on-curve points, so the point
                # after a control is always the quadratic's end point.
                ex, ey, _ = pts[(i + 1) % len(pts)]
                segments.append(f"Q {x:.1f},{y:.1f} {ex:.1f},{ey:.1f}")
                i += 2
        segments.append("Z")
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {EM} {EM}" '
        f'width="{EM}" height="{EM}">'
        f'<path d="{" ".join(segments)}"/>'
        f'</svg>'
    )


# ---------------------------------------------------------------------------
# Font builder
#
# A two-glyph TrueType font (empty .notdef plus the cat) wrapped in a WOFF, so
# generating the icon needs nothing outside the standard library. Tables: cmap,
# glyf, head, hhea, hmtx, loca, maxp, name, OS/2, post -- the minimum a browser
# font sanitiser accepts.
# ---------------------------------------------------------------------------


def _u16(v): return struct.pack(">H", v & 0xFFFF)
def _i16(v): return struct.pack(">h", v)
def _u32(v): return struct.pack(">I", v & 0xFFFFFFFF)
def _fixed(v): return struct.pack(">I", int(round(v * 65536)))


def _pad4(data: bytes) -> bytes:
    return data + b"\x00" * (-len(data) % 4)


def _checksum(data: bytes) -> int:
    total = 0
    for i in range(0, len(data), 4):
        total += struct.unpack(">I", data[i:i + 4].ljust(4, b"\x00"))[0]
    return total & 0xFFFFFFFF


def _build_glyph(contours):
    """Pack contours into a `glyf` simple-glyph record.

    Flag run-length packing is skipped: the glyph is small enough that it would
    cost more code than bytes.
    """
    points = [p for contour in contours for p in contour]
    ends = []
    seen = 0
    for contour in contours:
        seen += len(contour)
        ends.append(seen - 1)

    xs = [int(round(p[0])) for p in points]
    ys = [int(round(p[1])) for p in points]

    flags, x_data, y_data = bytearray(), bytearray(), bytearray()
    prev_x = prev_y = 0
    for i, point in enumerate(points):
        flag = 0x01 if point[2] else 0x00  # ON_CURVE
        dx, dy = xs[i] - prev_x, ys[i] - prev_y
        prev_x, prev_y = xs[i], ys[i]
        if dx == 0:
            flag |= 0x10  # X_SAME
        elif -255 <= dx <= 255:
            flag |= 0x02 | (0x10 if dx > 0 else 0x00)  # X_SHORT [+ positive]
            x_data.append(abs(dx))
        else:
            x_data += struct.pack(">h", dx)
        if dy == 0:
            flag |= 0x20  # Y_SAME
        elif -255 <= dy <= 255:
            flag |= 0x04 | (0x20 if dy > 0 else 0x00)  # Y_SHORT [+ positive]
            y_data.append(abs(dy))
        else:
            y_data += struct.pack(">h", dy)
        flags.append(flag)

    bbox = (min(xs), min(ys), max(xs), max(ys))
    glyph = struct.pack(">h", len(contours)) + struct.pack(">hhhh", *bbox)
    glyph += b"".join(_u16(e) for e in ends)
    glyph += _u16(0)  # no hinting instructions
    glyph += bytes(flags) + bytes(x_data) + bytes(y_data)
    return _pad4(glyph), bbox, len(points)


def _name_table():
    """Windows-platform name records (UTF-16BE), sorted by name id."""
    family = "Databricks AI Gateway Icons"
    strings = {
        1: family,
        2: "Regular",
        3: f"{family} 1.0",
        4: family,
        5: "Version 1.0",
        6: family.replace(" ", "") + "-Regular",
    }
    blob = bytearray()
    records = b""
    for name_id in sorted(strings):
        encoded = strings[name_id].encode("utf-16-be")
        records += struct.pack(">HHHHHH", 3, 1, 0x0409, name_id, len(encoded), len(blob))
        blob += encoded
    header = struct.pack(">HHH", 0, len(strings), 6 + len(strings) * 12)
    return _pad4(header + records + bytes(blob))


def _cmap_table():
    """Format 4 subtable mapping the icon codepoint to glyph 1."""
    # One real segment plus the mandatory 0xFFFF sentinel.
    seg_count = 2
    entry_selector = int(math.log2(seg_count))
    search_range = 2 * 2 ** entry_selector
    subtable = (
        _u16(seg_count * 2) + _u16(search_range) + _u16(entry_selector)
        + _u16(seg_count * 2 - search_range)
        + _u16(ICON_CODEPOINT) + _u16(0xFFFF)       # endCode
        + _u16(0)                                    # reservedPad
        + _u16(ICON_CODEPOINT) + _u16(0xFFFF)       # startCode
        # idDelta is int16 arithmetic modulo 65536, so the large negative delta
        # that lands the icon on glyph 1 is packed by masking, not by ">h".
        + _u16(1 - ICON_CODEPOINT) + _u16(1)        # idDelta
        + _u16(0) + _u16(0)                          # idRangeOffset
    )
    subtable = _u16(4) + _u16(6 + len(subtable)) + _u16(0) + subtable
    header = _u16(0) + _u16(1) + struct.pack(">HHI", 3, 1, 4 + 8)
    return _pad4(header + subtable)


def _build_tables(glyph: bytes, bbox, n_points: int, n_contours: int):
    """Every sfnt table, with head's checkSumAdjustment still zero."""
    x_min, y_min, x_max, y_max = bbox

    glyf = _pad4(glyph)  # glyph 0 (.notdef) is empty, so glyf starts at the cat
    # Short loca stores halved offsets; entries 0 and 1 both point at the start
    # because .notdef has no outline.
    loca = b"".join(_u16(o) for o in (0, 0, len(glyf) // 2))

    head = (
        _fixed(1.0) + _fixed(1.0) + _u32(0) + _u32(0x5F0F3CF5)
        + _u16(0x000B)      # flags: baseline at 0, lsb at x=0, integer ppem
        + _u16(EM)
        + b"\x00" * 16      # created + modified
        + _i16(x_min) + _i16(y_min) + _i16(x_max) + _i16(y_max)
        + _u16(0)           # macStyle
        + _u16(8)           # lowestRecPPEM
        + _i16(2)           # fontDirectionHint
        + _i16(0)           # indexToLocFormat: short
        + _i16(0)           # glyphDataFormat
    )

    hhea = (
        _fixed(1.0)
        + _i16(EM) + _i16(0) + _i16(0)   # ascender, descender, lineGap
        + _u16(EM)                        # advanceWidthMax
        + _i16(x_min)                     # minLeftSideBearing
        + _i16(EM - x_max)                # minRightSideBearing
        + _i16(x_max)                     # xMaxExtent
        + _i16(1) + _i16(0) + _i16(0)    # caret slope rise / run / offset
        + _i16(0) * 4                     # reserved
        + _i16(0)                         # metricDataFormat
        + _u16(2)                         # numberOfHMetrics
    )

    hmtx = _u16(EM) + _i16(0) + _u16(EM) + _i16(x_min)

    maxp = (
        _fixed(1.0)
        + _u16(2)             # numGlyphs
        + _u16(n_points) + _u16(n_contours)
        + _u16(0) + _u16(0)   # max composite points / contours
        + _u16(2)             # maxZones
        + _u16(0)             # maxTwilightPoints
        + _u16(0) + _u16(0) + _u16(0)   # maxStorage, function defs, instr defs
        + _u16(0)             # maxStackElements
        + _u16(0)             # maxSizeOfInstructions
        + _u16(0) + _u16(0)   # maxComponentElements, maxComponentDepth
    )

    os2 = (
        _u16(4)                      # version
        + _i16(EM)                   # xAvgCharWidth
        + _u16(400) + _u16(5)        # usWeightClass (normal), usWidthClass
        + _u16(0)                    # fsType: installable
        + _i16(0) * 10               # sub/superscript and strikeout metrics
        + _i16(0)                    # sFamilyClass
        + b"\x00" * 10               # panose
        + _u32(0) + _u32(1 << 28)    # ulUnicodeRange1-2: bit 60, private use
        + _u32(0) + _u32(0)          # ulUnicodeRange3-4
        + b"NONE"                    # achVendID
        + _u16(0x0040)               # fsSelection: regular
        + _u16(ICON_CODEPOINT) + _u16(ICON_CODEPOINT)
        + _i16(EM) + _i16(0) + _i16(0)   # sTypo ascender / descender / lineGap
        + _u16(EM) + _u16(0)             # usWinAscent, usWinDescent
        + _u32(0) + _u32(0)              # ulCodePageRange1-2
        + _i16(EM) + _i16(EM)            # sxHeight, sCapHeight
        + _u16(0) + _u16(0x0020) + _u16(0)  # default char, break char, max context
    )

    post = (
        _fixed(3.0) + _fixed(0.0)
        + _i16(0) + _i16(0)   # underline position, thickness
        + _u32(0)             # isFixedPitch
        + _u32(0) * 4         # min/max VM usage
    )

    tables = {
        b"OS/2": os2, b"cmap": _cmap_table(), b"glyf": glyf, b"head": head,
        b"hhea": hhea, b"hmtx": hmtx, b"loca": loca, b"maxp": maxp,
        b"name": _name_table(), b"post": post,
    }
    # Font sanitisers reject a table whose recorded length is not the exact one
    # the spec fixes, so the tables stay unpadded here; only the file layout pads.
    for tag, size in ((b"OS/2", 96), (b"head", 54), (b"hhea", 36),
                      (b"maxp", 32), (b"post", 32), (b"hmtx", 8), (b"loca", 6)):
        if len(tables[tag]) != size:
            raise AssertionError(f"{tag.decode()} is {len(tables[tag])} bytes, want {size}")
    return tables


def _build_sfnt(tables):
    """Lay the tables out as a TrueType file; returns the bytes and the offsets.

    Per the usual convention the directory checksums -- and so the ones the WOFF
    repeats -- are taken with head's checkSumAdjustment still zero, even though
    the stored head has it filled in.
    """
    tags = sorted(tables)
    count = len(tags)
    entry_selector = int(math.log2(count))
    search_range = 16 * 2 ** entry_selector
    header = struct.pack(">IHHHH", 0x00010000, count, search_range, entry_selector,
                         count * 16 - search_range)

    offsets, position = {}, 12 + count * 16
    for tag in tags:
        offsets[tag] = position
        position += len(_pad4(tables[tag]))

    # A table's checksum covers it zero-padded to four bytes, which `_checksum`
    # already does, so the recorded length stays the unpadded one.
    checksums = {tag: _checksum(tables[tag]) for tag in tags}
    directory = b"".join(
        struct.pack(">4sIII", tag, checksums[tag], offsets[tag], len(tables[tag]))
        for tag in tags)
    sfnt = header + directory + b"".join(_pad4(tables[tag]) for tag in tags)

    adjustment = (0xB1B0AFBA - _checksum(sfnt)) & 0xFFFFFFFF
    head_at = offsets[b"head"]
    sfnt = sfnt[:head_at + 8] + _u32(adjustment) + sfnt[head_at + 12:]
    tables[b"head"] = tables[b"head"][:8] + _u32(adjustment) + tables[b"head"][12:]
    return sfnt, checksums


def build_woff(tables, sfnt_size: int, checksums) -> bytes:
    """Wrap the sfnt tables in a WOFF, zlib-compressing the ones that shrink."""
    tags = sorted(tables)
    payload = []
    for tag in tags:
        raw = tables[tag]
        squeezed = zlib.compress(raw, 9)
        payload.append((tag, raw, squeezed if len(squeezed) < len(raw) else raw))

    offsets, position = {}, 44 + len(tags) * 20
    for tag, _, stored in payload:
        offsets[tag] = position
        position += len(stored) + (-len(stored) % 4)

    header = struct.pack(
        ">IIIHHIHHIIIII",
        0x774F4646,   # 'wOFF'
        0x00010000,   # flavor: TrueType
        position,     # total file length
        len(tags), 0, sfnt_size,
        1, 0,         # font version major / minor
        0, 0, 0,      # metadata offset / length / original length
        0, 0)         # private block offset / length
    directory = b"".join(
        struct.pack(">4sIIII", tag, offsets[tag], len(stored), len(raw), checksums[tag])
        for tag, raw, stored in payload)

    body = bytearray(header + directory)
    for _, _, stored in payload:
        body += stored + b"\x00" * (-len(stored) % 4)
    return bytes(body)


def make_woff() -> bytes:
    contours = glyph_contours()
    glyph, bbox, n_points = _build_glyph(contours)
    tables = _build_tables(glyph, bbox, n_points, len(contours))
    sfnt, checksums = _build_sfnt(tables)
    return build_woff(tables, len(sfnt), checksums)


def write_woff(path: str) -> None:
    with open(path, "wb") as fh:
        fh.write(make_woff())


def write_svg_icon(path: str) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(make_svg_icon() + "\n")


def main() -> None:
    palette = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PALETTE
    if palette not in PALETTES:
        raise SystemExit(f"unknown palette {palette!r}; pick one of {sorted(PALETTES)}")
    here = os.path.dirname(os.path.abspath(__file__))
    for size in SIZES:
        name = "icon.png" if size == SIZES[0] else f"icon-{size}.png"
        path = os.path.join(here, name)
        write_png(path, size, render(size, palette))
        print(f"wrote {path} ({size}x{size}, {palette})")
    woff_path = os.path.join(here, "icon.woff")
    write_woff(woff_path)
    print(f"wrote {woff_path}")
    svg_path = os.path.join(here, "icon.svg")
    write_svg_icon(svg_path)
    print(f"wrote {svg_path}")


if __name__ == "__main__":
    main()
