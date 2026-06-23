# -*- coding: utf-8 -*-
# inline_fonts.py — deixa um CSS 100% offline: resolve os @import de fontes
# (Google Fonts etc.) e embute todos os .woff2/.woff como base64 data: URI.
#
# Uso:
#   python inline_fonts.py <entrada.css> <saida.css>
#   python inline_fonts.py --url "<google fonts css2 url>" <saida.css>
#
# Por que existe: o CSS de apps Vite costuma começar com
#   @import "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;...";
# Offline esse @import morre e a tipografia vira fallback (fica diferente).
# Aqui a gente busca o CSS do Google, baixa cada woff2, converte pra base64 e
# substitui o @import pelas regras @font-face já com os bytes embutidos.
#
# GOTCHA importante (já corrigido aqui): a URL do Google TEM ';' dentro
# (wght@400;500;600). Um regex ingênuo tipo @import[^;]*; corta no primeiro ';'
# e deixa lixo no começo do CSS, o que QUEBRA o parse de tudo que vem depois.
# Por isso casamos a STRING ENTRE ASPAS inteira, não "até o primeiro ';'".

import re, sys, base64, urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

def fetch(url, binary=False):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    return data if binary else data.decode("utf-8", "replace")

def inline_font_urls(css):
    """Troca todo url(...woff2|woff|ttf...) por data: URI base64."""
    urls = re.findall(r"url\((https?://[^)]+?\.(?:woff2|woff|ttf))\)", css)
    cache = {}
    for u in dict.fromkeys(urls):
        try:
            raw = fetch(u, binary=True)
            mime = "font/woff2" if u.endswith("woff2") else ("font/woff" if u.endswith("woff") else "font/ttf")
            cache[u] = f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")
            print(f"  fonte {len(raw):>7}B  {u.split('/')[-1]}", file=sys.stderr)
        except Exception as e:
            print(f"  AVISO: falhou {u}: {e}", file=sys.stderr)
    return re.sub(r"url\((https?://[^)]+?\.(?:woff2|woff|ttf))\)",
                  lambda m: f"url({cache.get(m.group(1), m.group(1))})", css)

def main():
    args = sys.argv[1:]
    if "--url" in args:
        i = args.index("--url")
        font_css_url = args[i + 1]
        out_path = args[i + 2]
        css = fetch(font_css_url)              # CSS de fontes -> só @font-face
        result = inline_font_urls(css)
    else:
        in_path, out_path = args[0], args[1]
        css = open(in_path, encoding="utf-8").read()
        # 1) acha os @import de fontes. NB: casa a string entre aspas INTEIRA
        #    (a URL contém ';'), não "até o primeiro ';'".
        imports = re.findall(r'@import\s*(?:url\()?["\']([^"\']+)["\']\)?\s*;', css)
        font_blocks = []
        for imp_url in imports:
            if not imp_url.startswith("http"):
                continue
            print(f"resolvendo @import: {imp_url}", file=sys.stderr)
            font_css = fetch(imp_url)
            font_blocks.append(inline_font_urls(font_css))
        # 2) remove TODOS os @import http(s) do CSS original
        css_wo_import = re.sub(r'@import\s*(?:url\()?["\']https?:[^"\']*["\']\)?\s*;', '', css)
        # 3) prepend dos @font-face resolvidos + também embute woff2 que já
        #    estivessem direto no CSS
        result = "\n".join(font_blocks) + "\n" + inline_font_urls(css_wo_import)
        # sanidade: não pode sobrar @import http nem url() http de fonte
        assert "googleapis" not in result, "ainda há googleapis no resultado"

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(result)
    n_ff = result.count("@font-face")
    n_data = result.count("data:font")
    print(f"\nescrito {out_path}: {len(result):,} chars, {n_ff} @font-face, {n_data} fontes embutidas", file=sys.stderr)

if __name__ == "__main__":
    main()
