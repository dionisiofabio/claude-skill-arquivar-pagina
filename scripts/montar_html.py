# -*- coding: utf-8 -*-
# montar_html.py — junta tudo num ÚNICO arquivo .html auto-suficiente.
#
# Uso:
#   python montar_html.py --out PAGINA.html --title "Titulo" \
#       --css fonts_inlined.css --css app.css \
#       --js app.patched.js \
#       [--assets-dir assets/] [--lang pt-BR] [--js-classic]
#
# - Concatena os --css na ordem dada dentro de um <style> (ponha as fontes 1º).
# - Inlina os --js dentro de <script type="module"> (ordem dada). Use
#   --js-classic se o bundle NÃO for um módulo ES.
# - Se --assets-dir for dado, embute cada arquivo como data: URI num mapa
#   window.__ASSETS__ = { "nome.ext": "data:...;base64,..." } prependado ao JS,
#   pra você ter trocado os href de download por window.__ASSETS__["nome"] antes.
#
# Checagens que evitam dores de cabeça:
#   - bundle NÃO pode conter "</script>" (quebra o inline). Idem "</style>" no CSS.
#     (truque seguro: a gente escapa "</script>" -> "<\/script>", que é idêntico
#      dentro de strings/regex de JS.)
#   - avisa se sobrou referência a /assets/ não-resolvida no JS.

import argparse, base64, os, sys, mimetypes, re

def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()

ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True)
ap.add_argument("--title", default="Página arquivada")
ap.add_argument("--lang", default="pt-BR")
ap.add_argument("--css", action="append", default=[], help="arquivo CSS (repetível, em ordem)")
ap.add_argument("--js", action="append", default=[], help="arquivo JS (repetível, em ordem)")
ap.add_argument("--assets-dir", default=None)
ap.add_argument("--js-classic", action="store_true", help="usa <script> em vez de type=module")
ap.add_argument("--body", default='<div id="app"></div>', help="HTML do body antes do <script>")
args = ap.parse_args()

combined_css = "\n".join(read(p) for p in args.css)
combined_js = "\n".join(read(p) for p in args.js)

# mapa de assets -> data URI (pro JS referenciar via window.__ASSETS__[nome])
if args.assets_dir:
    entries = []
    for fn in sorted(os.listdir(args.assets_dir)):
        full = os.path.join(args.assets_dir, fn)
        if not os.path.isfile(full):
            continue
        with open(full, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")
        mime = mimetypes.guess_type(fn)[0] or "application/octet-stream"
        entries.append(f'"{fn}":"data:{mime};base64,{b64}"')
    asset_map = "window.__ASSETS__={" + ",".join(entries) + "};\n"
    combined_js = asset_map + combined_js
    print(f"embutidos {len(entries)} assets em window.__ASSETS__", file=sys.stderr)

# checagens de segurança de embed
if "</script" in combined_js.lower():
    combined_js = re.sub(r"</script", "<\\/script", combined_js, flags=re.I)
    print("AVISO: escapei </script no JS (esperado se houver strings com isso)", file=sys.stderr)
assert "</style" not in combined_css.lower(), "CSS contém </style> — não dá pra inlinar num <style>"

# avisa sobre /assets/ não resolvido (best-effort: ignora dentro de base64)
leftover = re.findall(r'(?:href|src)\s*[:=]\s*[`"\']\.?/assets/[A-Za-z0-9._${}\-]+', combined_js)
if leftover:
    print(f"AVISO: {len(leftover)} referência(s) a /assets/ ainda no JS (vão dar 404 offline): {leftover[:3]}", file=sys.stderr)

script_open = "<script>" if args.js_classic else '<script type="module">'

html = f"""<!doctype html>
<html lang="{args.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>{args.title}</title>
<!-- Arquivo offline auto-suficiente, gerado pela skill arquivar-pagina. -->
<style>
{combined_css}
</style>
</head>
<body>
{args.body}
{script_open}
{combined_js}
</script>
</body>
</html>
"""

with open(args.out, "w", encoding="utf-8") as f:
    f.write(html)

size = len(html.encode("utf-8"))
print(f"escrito {args.out}: {size:,} bytes ({size/1048576:.1f} MB), "
      f"{combined_css.count('@font-face')} fontes, CSS {len(combined_css):,} ch, JS {len(combined_js):,} ch", file=sys.stderr)
