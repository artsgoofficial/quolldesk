#!/usr/bin/env python3
"""Rasterize the QuollDesk app icons from public/icon.svg.

Outputs public/icon.png (macOS HIG margin), public/icon-win.png (full-bleed),
and the single runtime icon public/icons/variants/original.png plus its
full-canvas macOS twin public/icons/variants/macos/original.png.
Run: python3 scripts/generate-app-icons.py
Requires: the repo's electron binary (offscreen window via
scripts/render-icon-electron.cjs) for Chromium-accurate rasterization of
gradients; falls back to ImageMagick with degraded gradient fidelity.
"""
from __future__ import annotations

import base64
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_SVG = ROOT / "public" / "icon.svg"
OUT_DIR = ROOT / "public" / "icons" / "variants"
MACOS_OUT_DIR = OUT_DIR / "macos"


def build_render_unit(svg: str, outs: list[tuple[str, str | None]]) -> str:
    """One self-contained render page: each out is (name, viewBox|None) with
    the viewBox baked into the SVG and a precomputed base64 data URL, so the
    page does zero string processing."""
    jobs: list[dict] = []
    urls: dict[str, str] = {}
    for idx, (out, viewBox) in enumerate(outs):
        text = svg
        if viewBox:
            text = re.sub(r'viewBox="[^"]+"', f'viewBox="{viewBox}"', text, count=1)
        data_url = "data:image/svg+xml;base64," + base64.b64encode(text.encode()).decode()
        urls[f"u{idx}"] = data_url
        jobs.append({"id": f"u{idx}", "out": out, "size": 1024})
    return (
        "window.__QD_URLS = " + json.dumps(urls) + ";\n"
        "window.__QD_JOBS = " + json.dumps(jobs) + ";\n"
        "window.RENDER = async () => {\n"
        "  const out = {};\n"
        "  for (const j of window.__QD_JOBS) {\n"
        "    const img = new Image();\n"
        "    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('img load: ' + j.out)); img.src = window.__QD_URLS[j.id]; });\n"
        "    const c = document.createElement('canvas');\n"
        "    c.width = c.height = j.size;\n"
        "    c.getContext('2d').drawImage(img, 0, 0, j.size, j.size);\n"
        "    out[j.out] = c.toDataURL('image/png').split(',')[1];\n"
        "  }\n"
        "  return out;\n"
        "};\n"
        "'unit ready';"
    )


def render_icons(base: str) -> list[str]:
    """Render one icon pair per offscreen electron run. Chaining many large
    canvas renders inside a single offscreen page makes the software
    rasterizer paint gradients black under memory pressure; one tiny page
    per run is deterministic."""
    electron_bin = ROOT / "node_modules" / ".bin" / "electron"
    renderer = ROOT / "scripts" / "render-icon-electron.cjs"
    written: list[str] = []

    def run(svg: str, outs: list[tuple[str, str | None]]) -> None:
        with tempfile.TemporaryDirectory() as td:
            html_path = Path(td) / "render.html"
            html_path.write_text('<!doctype html><meta charset="utf-8"><body><script>'
                                 + build_render_unit(svg, outs)
                                 + '</script></body>')
            out_json = Path(td) / "out.json"
            subprocess.run([str(electron_bin), str(renderer), str(html_path), str(out_json)],
                           check=True, cwd=ROOT)
            for out, b64 in json.loads(out_json.read_text()).items():
                path = ROOT / "public" / (out + ".png")
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(base64.b64decode(b64))
                written.append(str(path.relative_to(ROOT)))

    run(base, [("icon.png", None), ("icon-win.png", "100 100 824 824")])
    run(base, [
        ("icons/variants/original", None),
        ("icons/variants/macos/original", "0 0 1024 1024"),
    ])
    return written


def magick_fallback(base: str) -> list[str]:
    """Degrade gracefully when no CDP is available: rasterize with ImageMagick
    (its MSVG renderer ignores gradients, so backgrounds come out flat)."""
    converter = ["magick"] if shutil.which("magick") else (["convert"] if shutil.which("convert") else None)
    if not converter:
        raise SystemExit("error: no CDP target and no ImageMagick for fallback")
    written: list[str] = []

    def render(svg: str, out: Path) -> None:
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "x.svg"
            p.write_text(svg)
            subprocess.run([*converter, "-background", "none", str(p),
                            "-resize", "1024x1024", "-depth", "8", str(out)], check=True)

    render(base, ROOT / "public" / "icon.png")
    tight = base.replace('viewBox="44 44 936 936"', 'viewBox="100 100 824 824"')
    render(tight, ROOT / "public" / "icon-win.png")
    render(base, OUT_DIR / "original.png")
    render(base.replace('viewBox="44 44 936 936"', 'viewBox="0 0 1024 1024"'), MACOS_OUT_DIR / "original.png")
    written.extend(["public/icon.png", "public/icon-win.png",
                    "public/icons/variants/original.png", "public/icons/variants/macos/original.png"])
    return written


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    MACOS_OUT_DIR.mkdir(parents=True, exist_ok=True)
    base = SOURCE_SVG.read_text()
    try:
        written = render_icons(base)
        print(f"offscreen-electron-rendered {len(written)} PNGs")
    except Exception as err:
        print(f"offscreen electron rendering unavailable ({err}); falling back to ImageMagick "
              "(gradients rasterize flat)", file=sys.stderr)
        written = magick_fallback(base)
        print(f"magick-rendered {len(written)} PNGs")
    print("wrote icon.png, icon-win.png and the original runtime icon x2")


if __name__ == "__main__":
    main()
