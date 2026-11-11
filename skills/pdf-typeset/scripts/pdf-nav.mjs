#!/usr/bin/env node
// PDF 탐색 정보 후처리 — 열 때 책갈피 창(/PageMode /UseOutlines) · 쪽 번호 표기(/PageLabels) · (선택) 책갈피 트리 · 차례 링크.
// 의존 = pdf-lib 하나(작업 중인 프로젝트의 node_modules 에서 찾는다. 없으면 `npm i -D pdf-lib@1.17.1`).
//
//   node pdf-nav.mjs <pdf> [--labels "0:P:표지,1:r,3:D"] [--nav nav.json]
//
// --labels  쪽 번호 표기 구간. 「시작쪽(0부터):모양[:접두]」 을 쉼표로 잇는다. 모양 = D(1,2,3) · r(i,ii) · R · a · A · P(접두만).
// --nav     { "outline": [{ "title", "page"(1부터), "children": [...] }],
//             "links": [{ "page"(1부터), "rect": [x0,y0,x1,y1](PDF 좌표, 왼쪽 아래 원점), "target"(1부터) }] }
//           outline 을 주면 있던 책갈피를 갈아 끼운다. links 는 이 도구가 단 링크만 갈아 끼운다(다시 돌려도 결과가 같다).
// Chrome printToPDF(generateDocumentOutline)로 만든 PDF 는 책갈피 · 링크가 이미 있다 → --labels 만 주면 된다.
// 여러 PDF 를 합친(pdfunite 등) 결과처럼 링크가 끊긴 PDF 에만 --nav 를 쓴다.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

let lib;
try {
  lib = createRequire(path.join(process.cwd(), 'noop.js'))('pdf-lib');
} catch {
  console.error('pdf-lib 를 찾지 못했다. 프로젝트 루트에서 실행하거나 `npm i -D pdf-lib@1.17.1` 후 다시 실행한다.');
  process.exit(2);
}
const { PDFDocument, PDFName, PDFNumber, PDFHexString, PDFArray, PDFDict } = lib;

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const labels = opt('--labels');
const navFile = opt('--nav');
const pdfPath = argv[0];
if (!pdfPath) {
  console.error('사용: node pdf-nav.mjs <pdf> [--labels "0:P:표지,1:r,3:D"] [--nav nav.json]');
  process.exit(2);
}

const doc = await PDFDocument.load(await readFile(pdfPath), { updateMetadata: false });
const ctx = doc.context;
const pages = doc.getPages();
const clamp = (i) => pages[Math.min(Math.max(i, 0), pages.length - 1)];
const dest = (i) => { const p = clamp(i); return ctx.obj([p.ref, PDFName.of('XYZ'), PDFNumber.of(0), PDFNumber.of(p.getHeight()), PDFNumber.of(0)]); };

function writeOutline(tree) {
  const rootRef = ctx.nextRef();
  const level = (items, parentRef) => {
    const refs = items.map(() => ctx.nextRef());
    let visible = 0;
    items.forEach((it, i) => {
      const d = ctx.obj({});
      d.set(PDFName.of('Title'), PDFHexString.fromText(it.title));
      d.set(PDFName.of('Parent'), parentRef);
      d.set(PDFName.of('Dest'), dest(it.page - 1));
      if (i > 0) d.set(PDFName.of('Prev'), refs[i - 1]);
      if (i < refs.length - 1) d.set(PDFName.of('Next'), refs[i + 1]);
      if (it.children?.length) {
        const [f, l, n] = level(it.children, refs[i]);
        d.set(PDFName.of('First'), f);
        d.set(PDFName.of('Last'), l);
        d.set(PDFName.of('Count'), PDFNumber.of(n)); // 양수 = 펼친 상태
        visible += n;
      }
      visible += 1;
      ctx.assign(refs[i], d);
    });
    return [refs[0], refs[refs.length - 1], visible];
  };
  const root = ctx.obj({ Type: 'Outlines' });
  if (tree.length) {
    const [f, l, n] = level(tree, rootRef);
    root.set(PDFName.of('First'), f);
    root.set(PDFName.of('Last'), l);
    root.set(PDFName.of('Count'), PDFNumber.of(n));
  }
  ctx.assign(rootRef, root);
  doc.catalog.set(PDFName.of('Outlines'), rootRef);
}

function writeLinks(links) {
  const MARK = PDFName.of('PdfTypesetNav');
  for (const p of pages) {
    const annots = p.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (annots) p.node.set(PDFName.of('Annots'), ctx.obj(annots.asArray().filter((a) => !ctx.lookup(a, PDFDict).get(MARK))));
  }
  for (const l of links) {
    const t = clamp(l.target - 1);
    const annot = ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: l.rect, Border: [0, 0, 0],
      Dest: [t.ref, PDFName.of('XYZ'), PDFNumber.of(0), PDFNumber.of(t.getHeight()), PDFNumber.of(0)] });
    annot.set(MARK, ctx.obj(true));
    const ref = ctx.register(annot);
    const page = clamp(l.page - 1);
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    annots ? annots.push(ref) : page.node.set(PDFName.of('Annots'), ctx.obj([ref]));
  }
}

if (navFile) {
  const nav = JSON.parse(await readFile(navFile, 'utf8'));
  if (nav.outline) writeOutline(nav.outline);
  if (nav.links) writeLinks(nav.links);
}
if (labels) {
  const nums = [];
  for (const part of labels.split(',')) {
    const [start, style, prefix] = part.split(':');
    const d = ctx.obj({});
    if (style && style !== 'P') d.set(PDFName.of('S'), PDFName.of(style));
    if (prefix) d.set(PDFName.of('P'), PDFHexString.fromText(prefix));
    nums.push(PDFNumber.of(Number(start)), d);
  }
  doc.catalog.set(PDFName.of('PageLabels'), ctx.obj({ Nums: nums }));
}
doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
await writeFile(pdfPath, await doc.save({ useObjectStreams: false, updateFieldAppearances: false }));
console.log(`${pdfPath}  ${pages.length}쪽 · 책갈피 창 켬${labels ? ' · 쪽 번호 표기' : ''}${navFile ? ' · 책갈피/링크 갈아 끼움' : ''}`);
