"""
Sheet music (PDF charts) for the setlist: finds PDFs next to the REAPER
project, ties each one to the REAPER region it's named after, and renders its
pages to PNG so the phone app can just show images — Android's WebView has no
built-in PDF viewer, and a PNG also zooms and scrolls like any other picture.

A song can have several charts, named "{region name} - {sheet type}.pdf" —
"Bowling For Soup - 1985 - Drums.pdf", "... - Bass.pdf" — and each sheet type
becomes its own option under that song. A file named exactly like the region,
with no type, is also accepted (it's just shown as a plain "Sheet").

The file name is split by matching region names against its START, not by
looking for the last dash, because region names are free to contain " - "
themselves ("Sugar We're Going Down - Fall Out Boy"). When more than one region
could claim a file, the longest region name wins.
"""
import io
import os
import re
import threading
import time
import unicodedata

import pypdfium2 as pdfium

# pdfium is not thread-safe, and FastAPI runs plain `def` endpoints on a
# thread pool — two requests rendering at once would crash it.
_pdfium_lock = threading.Lock()

_SCAN_TTL = 15      # seconds a folder listing is reused (Google Drive folders are slow to list)
_PNG_CACHE_MAX = 24

_scan_cache = {}    # folder -> (scanned_at, [pdf paths])
_pages_cache = {}   # (path, mtime) -> page count
_png_cache = {}     # (path, mtime, page, scale) -> bytes, oldest first

# Hyphen-minus plus the look-alike dashes that get pasted into file names.
_DASHES = "-‐‑‒–—"
_TYPE_SEP = re.compile(rf"\s*[{_DASHES}]\s*(\S.*?)\s*")


def _stem(file_name: str) -> str:
    """File name without '.pdf' (however many times it's stacked — "Song.PDF.pdf"
    happens), width/ligature-normalized."""
    stem = unicodedata.normalize("NFKC", file_name or "")
    while stem.lower().endswith(".pdf"):
        stem = stem[:-4]
    return stem.strip()


def _region_pattern(region_name: str):
    """Matches the START of a file name spelling this region's name — case,
    spacing and punctuation between the words don't have to agree ("Sugar,
    We're Going Down" finds "sugar were going down")."""
    words = re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", region_name or ""))
    if not words:
        return None
    return re.compile(r"[\W_]*" + r"[\W_]*".join(re.escape(w) for w in words), re.IGNORECASE)


def match_file(file_name: str, regions: list):
    """(region_names, sheet_type) for the region this PDF belongs to, else None.
    sheet_type is "" when the file is named exactly like the region."""
    stem = _stem(file_name)
    best_end, best = -1, None
    for region in regions:
        name = region.get("name", "")
        pattern = _region_pattern(name)
        found = pattern.match(stem) if pattern else None
        if not found:
            continue
        rest = stem[found.end():]
        if not re.search(r"[^\W_]", rest):        # nothing left but spaces/punctuation
            if re.search(rf"[{_DASHES}]", rest):
                continue          # "Song -.pdf": a dash promising a type that never came
            sheet_type = ""
        else:
            typed = _TYPE_SEP.fullmatch(rest)
            if not typed:
                continue          # "Test 2 - Drums" is not a chart for a region named "Test"
            sheet_type = typed.group(1)
        if found.end() > best_end:
            best_end, best = found.end(), (sheet_type, [name])
        elif found.end() == best_end and best[0].casefold() == sheet_type.casefold() and name not in best[1]:
            best[1].append(name)  # two regions that differ only in case/punctuation
    return (best[1], best[0]) if best else None


def find_pdfs(folder: str) -> list:
    """PDFs in `folder` and in each of its immediate subfolders — the usual
    layout is a Pdfs/ (or Sheet Music/) folder beside the .rpp."""
    cached = _scan_cache.get(folder)
    if cached and time.time() - cached[0] < _SCAN_TTL:
        return cached[1]
    found = []
    try:
        with os.scandir(folder) as entries:
            for entry in list(entries):
                if entry.is_file() and entry.name.lower().endswith(".pdf"):
                    found.append(entry.path)
                elif entry.is_dir(follow_symlinks=False):
                    try:
                        with os.scandir(entry.path) as sub:
                            found += [e.path for e in sub if e.is_file() and e.name.lower().endswith(".pdf")]
                    except OSError:
                        pass
    except OSError:
        pass
    found.sort(key=str.lower)
    _scan_cache[folder] = (time.time(), found)
    return found


def _mtime(path: str) -> float:
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0.0


def page_count(path: str) -> int:
    key = (path, _mtime(path))
    if key not in _pages_cache:
        with _pdfium_lock:
            pdf = pdfium.PdfDocument(path)
            try:
                _pages_cache[key] = len(pdf)
            finally:
                pdf.close()
    return _pages_cache[key]


def list_sheets(project_path: str, regions: list) -> dict:
    """{"folder", "sheets": [{"file", "name", "type", "pages", "region_names"}], "unmatched": [file names]}.
    `file` is the path relative to the project folder (forward slashes), which
    is all the page endpoint needs to find it again. `type` is the sheet type
    from "{region} - {type}.pdf" ("" for a file named exactly like the region).
    Sheets come back ordered by type, so a song's options always appear in the
    same order. `unmatched` is every PDF that named no region — worth showing,
    since 'why isn't my chart showing up' is almost always a name that doesn't
    line up."""
    folder = os.path.dirname(project_path) if project_path else ""
    if not folder:
        return {"folder": "", "sheets": [], "unmatched": []}
    sheets, unmatched = [], []
    for path in find_pdfs(folder):
        base = os.path.basename(path)
        matched = match_file(base, regions)
        if not matched:
            unmatched.append(base)
            continue
        try:
            pages = page_count(path)
        except Exception:
            unmatched.append(base)   # unreadable / not really a PDF
            continue
        region_names, sheet_type = matched
        sheets.append({
            "file": os.path.relpath(path, folder).replace("\\", "/"),
            "name": base,
            "type": sheet_type,
            "pages": pages,
            "region_names": region_names,
        })
    sheets.sort(key=lambda s: (s["type"].casefold(), s["name"].casefold()))
    return {"folder": folder, "sheets": sheets, "unmatched": unmatched}


def resolve(project_path: str, rel_file: str):
    """The real path for a `file` from list_sheets(), or None. Refuses anything
    that isn't a .pdf inside the project folder — this is reachable from the
    network, so a crafted '../..' must not read arbitrary files."""
    folder = os.path.dirname(project_path) if project_path else ""
    if not folder or not rel_file or not rel_file.lower().endswith(".pdf"):
        return None
    path = os.path.normpath(os.path.join(folder, rel_file))
    try:
        inside = os.path.commonpath([os.path.normcase(folder), os.path.normcase(path)]) == os.path.normcase(os.path.normpath(folder))
    except ValueError:  # different drives
        inside = False
    return path if inside and os.path.isfile(path) else None


def render_page(path: str, page: int, scale: float = 2.0) -> bytes:
    """One page as PNG. `scale` is relative to the PDF's 72-dpi points, so 2.0
    turns a US-letter page into ~1224x1584 — sharp enough to zoom on a phone."""
    key = (path, _mtime(path), page, scale)
    if key in _png_cache:
        return _png_cache[key]
    with _pdfium_lock:
        pdf = pdfium.PdfDocument(path)
        try:
            if not 0 <= page < len(pdf):
                raise IndexError("page out of range")
            image = pdf[page].render(scale=scale).to_pil()
        finally:
            pdf.close()
    buf = io.BytesIO()
    image.save(buf, "PNG")
    data = buf.getvalue()
    _png_cache[key] = data
    while len(_png_cache) > _PNG_CACHE_MAX:
        _png_cache.pop(next(iter(_png_cache)))
    return data
