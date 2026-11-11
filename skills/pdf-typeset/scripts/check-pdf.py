#!/usr/bin/env python3
"""완성 PDF 점검 — 쪽 수 · 가로 쪽 수 · 책갈피(단계별) · 내부 링크 수 · 책갈피 창 · 쪽 번호 표기 · 글꼴(Type 3 여부) · 크기.

  python3 check-pdf.py <pdf>... [--min-outline 1] [--min-links 1]

의존 = pypdf(`pip install pypdf`). 기준에 못 미치면 exit 1.
"""
import os
import sys

try:
    from pypdf import PdfReader
except ImportError:
    sys.exit('pypdf 가 없다. `pip install pypdf` 후 다시 실행한다.')


def walk(items, depth, counts):
    for it in items:
        if isinstance(it, list):
            walk(it, depth + 1, counts)
        else:
            counts[depth] = counts.get(depth, 0) + 1


def check(path, min_outline, min_links):
    r = PdfReader(path)
    root = r.trailer['/Root']
    counts = {}
    walk(r.outline, 1, counts)
    links = land = 0
    type3 = set()
    for p in r.pages:
        w, h = float(p.mediabox.width), float(p.mediabox.height)
        if w > h:
            land += 1
        for a in p.get('/Annots') or []:
            a = a.get_object()
            if a.get('/Subtype') == '/Link' and ('/Dest' in a or a.get('/A', {}).get('/S') == '/GoTo'):
                links += 1
        fonts = (p.get('/Resources') or {}).get('/Font') or {}
        for name, f in fonts.items():
            if f.get_object().get('/Subtype') == '/Type3':
                type3.add(name)
    outline_total = sum(counts.values())
    mode = root.get('/PageMode')
    print(f'{path}')
    print(f'  쪽 {len(r.pages)} (가로 {land}) · 크기 {os.path.getsize(path) / 1024 / 1024:.2f} MB')
    print(f'  책갈피 {outline_total} — 단계별 ' + ', '.join(f'{d}단계 {n}' for d, n in sorted(counts.items())))
    print(f'  내부 링크 {links} · 열 때 책갈피 창 {"예" if mode == "/UseOutlines" else "아니오"} · 쪽 번호 표기 {"있음" if "/PageLabels" in root else "없음"}')
    if type3:
        print(f'  경고: Type 3 글꼴이 있다 — 내장하지 않은 시스템 글꼴(예: Apple SD Gothic Neo)을 썼거나 글자에 stroke 효과를 준 경우다. '
              f'PDF 가 커지고 글자 검색 · 복사가 깨질 수 있다: {sorted(type3)[:5]}')
    bad = []
    if outline_total < min_outline:
        bad.append(f'책갈피 {outline_total} < {min_outline}')
    if links < min_links:
        bad.append(f'내부 링크 {links} < {min_links}')
    if mode != '/UseOutlines':
        bad.append('열 때 책갈피 창이 꺼져 있다(/PageMode /UseOutlines 없음)')
    for b in bad:
        print(f'  실패: {b}')
    return not bad


def main():
    args = sys.argv[1:]
    def opt(name, dflt):
        if name in args:
            i = args.index(name)
            v = args[i + 1]
            del args[i:i + 2]
            return int(v)
        return dflt
    min_outline = opt('--min-outline', 1)
    min_links = opt('--min-links', 1)
    if not args:
        sys.exit(__doc__)
    ok = all([check(p, min_outline, min_links) for p in args])
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
