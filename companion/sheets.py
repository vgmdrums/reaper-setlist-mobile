"""
Sheet music (PDF charts) for the setlist: finds PDFs next to the REAPER
project, ties each one to the REAPER region it's named after, and renders its
pages to PNG so the phone app can just show images — Android's WebView has no
built-in PDF viewer, and a PNG also zooms and scrolls like any other picture.

A chart belongs to a region when the file's name (minus ".pdf", however many
times it's stacked — "Song.PDF.pdf" happens) matches the region's name,
ignoring case, spacing and punctuation.
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


def name_key(name: str) -> str:
    """Comparable form of a region name or PDF file name: '.pdf' stripped
    (repeatedly), then only letters/digits kept, case-folded — so
    "Bowling For Soup - 1985.PDF.pdf" and "bowling for soup – 1985" agree."""
    stem = name or ""
    while stem.lower().endswith(".pdf"):
        stem = stem[:-4]
    return re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", stem).casefold())


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
    """{"folder", "sheets": [{"file", "name", "pages", "region_names"}], "unmatched": [file names]}.
    `file` is the path relative to the project folder (forward slashes), which
    is all the page endpoint needs to find it again. `unmatched` is every PDF
    that named no region — worth showing, since 'why isn't my chart showing up'
    is almost always a name that doesn't line up with a region."""
    folder = os.path.dirname(project_path) if project_path else ""
    if not folder:
        return {"folder": "", "sheets": [], "unmatched": []}
    names_by_key = {}
    for region in regions:
        key = name_key(region.get("name", ""))
        if key:
            names_by_key.setdefault(key, []).append(region.get("name", ""))
    sheets, unmatched = [], []
    for path in find_pdfs(folder):
        base = os.path.basename(path)
        region_names = names_by_key.get(name_key(base))
        if not region_names:
            unmatched.append(base)
            continue
        try:
            pages = page_count(path)
        except Exception:
            unmatched.append(base)   # unreadable / not really a PDF
            continue
        sheets.append({
            "file": os.path.relpath(path, folder).replace("\\", "/"),
            "name": base,
            "pages": pages,
            "region_names": region_names,
        })
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
