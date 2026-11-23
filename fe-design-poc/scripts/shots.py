#!/usr/bin/env python3
"""Frame-only screenshots of a fe-design-poc HTML file with headless Chrome.

Usage:
  python3 shots.py <poc.html> <out_dir> <shots.json>

shots.json is a list of {"name": str, "js": str, "w": int, "h": int}.
`js` runs right after the POC's `init();` call (e.g. "setWin(768); setOpt('b');").
The page chrome (.intro, .ctrl, .notes, .foot) is hidden so only the app frame shows.
Chrome won't render a window narrower than ~500px; phone shots below that are
taken at 500 and the script prints a warning so you can disclose it.
"""
import json, pathlib, subprocess, sys

CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
HIDE = ('<style>.intro,.ctrl,.notes,.foot{display:none!important}'
        '.page{padding:0!important;max-width:none}.framebox{padding:0;overflow:visible}'
        '.frame{border-radius:0;box-shadow:none;border:0}</style></head>')

def main(src, out, spec):
    html = pathlib.Path(src).read_text()
    if '\ninit();\n' not in html:
        sys.exit('POC must call init(); on its own line so shot JS can run after it.')
    out = pathlib.Path(out); out.mkdir(parents=True, exist_ok=True)
    for s in json.loads(pathlib.Path(spec).read_text()):
        w = max(int(s['w']), 500)
        if w != int(s['w']):
            print(f"warn: {s['name']} requested {s['w']}px, rendered at 500px (Chrome minimum)")
        page = html.replace('</head>', HIDE, 1).replace('\ninit();\n', f"\ninit(); {s.get('js','')}\n", 1)
        tmp = out / f".{s['name']}.html"; tmp.write_text(page)
        png = out / f"{s['name']}.png"
        subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars',
                        f'--window-size={w},{int(s["h"])}', f'--screenshot={png}', f'file://{tmp}'],
                       capture_output=True)
        tmp.unlink()
        print(png if png.exists() else f"FAILED {s['name']}")

if __name__ == '__main__':
    if len(sys.argv) != 4: sys.exit(__doc__)
    main(*sys.argv[1:])
