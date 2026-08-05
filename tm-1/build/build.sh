#!/usr/bin/env bash
# Rebuild app/tl1-tape-lab.html from app/tl1-tape-lab.jsx.
#
# This pipeline is DEPRECATED BY DESIGN — see docs/REVIEW.md finding F3. It is
# here so the current build is reproducible, not because it should survive.
# Phase 0 replaces it with two esbuild entries over a real module tree.
#
# Usage:  cd build && ./build.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
APP="$ROOT/app"
WORK="$HERE/.work"

command -v npx >/dev/null || { echo "need node + npx"; exit 1; }

mkdir -p "$WORK"
cd "$HERE"
[ -d node_modules ] || npm install

# tailwind scans the source for class names, so point it at the real file
cat > "$WORK/tailwind.config.js" <<EOF
module.exports = { content: ["$APP/tl1-tape-lab.jsx"], theme: { extend: {} }, plugins: [] };
EOF

cp "$APP/tl1-tape-lab.jsx" "$WORK/app.jsx"
cp entry.jsx "$WORK/entry.jsx"
cp tw.css "$WORK/tw.css"

npx tailwindcss -c "$WORK/tailwind.config.js" -i "$WORK/tw.css" -o "$WORK/app.css" --minify
npx esbuild "$WORK/entry.jsx" --bundle --loader:.jsx=jsx --jsx=automatic \
  --format=iife --minify --define:process.env.NODE_ENV='"production"' \
  --outfile="$WORK/bundle.js"

python3 - "$WORK" "$APP" <<'PY'
import sys, pathlib
work, app = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
js  = (work/"bundle.js").read_text()
css = (work/"app.css").read_text()
(app/"tl1-tape-lab.html").write_text("""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TL-1 Tape Lab</title><style>
%s
html,body{margin:0;background:#1E2225;}
input[type=range]{height:14px;width:100%%;}
select{appearance:none;}
</style></head><body>
<div id="root"></div>
<pre id="err" style="display:none;color:#E8A79A;font:12px ui-monospace,monospace;padding:16px;white-space:pre-wrap"></pre>
<script>window.addEventListener('error',function(e){var p=document.getElementById('err');
p.style.display='block';p.textContent='Startup error:\\n'+(e.error&&e.error.stack?e.error.stack:e.message);});</script>
<script>
%s
</script></body></html>
""" % (css, js))
print("wrote", app/"tl1-tape-lab.html")
PY

echo "--- verifying ---"
node "$ROOT/tests/reel-policy-test.js" | tail -2
node -e "
const fs=require('fs');
const src=fs.readFileSync('$APP/tl1-tape-lab.jsx','utf8');
const a=src.indexOf('function engineFactory()'),b=src.indexOf('const TapeEngine = engineFactory();');
const TE=eval('('+src.slice(a,b)+')')();
const e=new TE(48000);
// PARAMS COMPLETENESS: every p.<field> render() reads must exist in defaults.
// A missing one kills an AudioWorklet processor silently. See REVIEW.md F1.
const used=new Set([...src.slice(a,b).matchAll(/p\.([A-Za-z][A-Za-z0-9]*)/g)].map(m=>m[1]));
const missing=[...used].filter(k=>!(k in e.p));
if(missing.length){ console.error('FAIL params completeness:', missing); process.exit(1); }
console.log('ok  params completeness');
// DEFAULTS-ONLY RENDER: the worklet renders before the first params message.
const n=48000,t=new Int16Array(n);
for(let i=0;i<n;i++)t[i]=Math.sin(2*Math.PI*300*i/48000)*0.5*32767;
e.setTape(0,t); e.setTape(1,new Int16Array(n));
e.running=true; e.play=[true,false];
const L=new Float32Array(128),R=new Float32Array(128);
for(let i=0;i<60;i++)e.render(L,R,128,null,null);
console.log('ok  defaults-only render');
"
echo "done."
