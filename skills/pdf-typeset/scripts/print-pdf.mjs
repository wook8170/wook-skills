#!/usr/bin/env node
// HTML → PDF(헤드리스 Chrome CDP Page.printToPDF). 의존 없음(Node 22 이상의 내장 WebSocket · fetch).
//
//   node print-pdf.mjs <입력.html> <출력.pdf> [--wait-expr "window.__paged === true"] [--timeout 120]
//
// - 책갈피: generateDocumentOutline 이 제목 요소(h1~h6, 또는 role=heading + aria-level)로 만든다.
// - 차례 링크: 문서 안 <a href="#앵커"> 가 그대로 PDF 내부 링크가 된다.
// - 쪽 크기 · 여백은 문서 CSS(@page)가 정한다(preferCSSPageSize). 여기서는 여백 0 으로 넘긴다.
// - --wait-expr: 문서 안 조판 스크립트가 끝났음을 알리는 식. 주지 않으면 document.fonts.ready 만 기다린다.
// - 창을 띄우지 않는다(--headless=new). 띄운 Chrome 은 이 프로세스가 PID 로 끈다.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const waitExpr = opt('--wait-expr', '');
const timeoutSec = Number(opt('--timeout', '120'));
const [input, output] = argv;
if (!input || !output) {
  console.error('사용: node print-pdf.mjs <입력.html> <출력.pdf> [--wait-expr "<식>"] [--timeout 초]');
  process.exit(2);
}
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const profile = await mkdtemp(path.join(os.tmpdir(), 'print-pdf-'));
const port = 9500 + Math.floor(Math.random() * 300);
const proc = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let ws;
  for (const end = Date.now() + 20000; Date.now() < end; await sleep(150)) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      if (j.webSocketDebuggerUrl) { ws = new WebSocket(j.webSocketDebuggerUrl); break; }
    } catch {}
  }
  if (!ws) throw new Error('Chrome DevTools 에 붙지 못했다');
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP 연결 실패')); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    const p = m.id && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (m, p) => send(m, p, sessionId);
  await call('Page.enable');
  await call('Page.navigate', { url: pathToFileURL(path.resolve(input)).href });
  const deadline = Date.now() + timeoutSec * 1000;
  const expr = waitExpr ? `(document.readyState === 'complete') && (${waitExpr})` : `document.readyState === 'complete'`;
  for (;;) {
    const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.result.value === true) break;
    if (Date.now() > deadline) throw new Error(`문서가 ${timeoutSec}초 안에 준비되지 않았다: ${expr}`);
    await sleep(200);
  }
  await call('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true });

  // 큰 PDF 는 한 프레임으로 받으면 응답이 오지 않을 수 있어 스트림으로 받는다.
  const { stream } = await call('Page.printToPDF', {
    printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false,
    marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
    generateDocumentOutline: true, transferMode: 'ReturnAsStream',
  });
  const chunks = [];
  for (;;) {
    const r = await call('IO.read', { handle: stream, size: 512 * 1024 });
    if (r.data) chunks.push(Buffer.from(r.data, r.base64Encoded ? 'base64' : 'utf8'));
    if (r.eof) break;
  }
  await call('IO.close', { handle: stream });
  const pdf = Buffer.concat(chunks);
  await writeFile(output, pdf);
  console.log(`${output}  ${(pdf.length / 1024 / 1024).toFixed(2)} MB`);
  ws.close();
} finally {
  proc.kill('SIGKILL');
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
