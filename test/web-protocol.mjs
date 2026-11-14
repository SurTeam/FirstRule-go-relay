#!/usr/bin/env node
// Protocol e2e for relay/web/index.html against a mock desktop remote API.
// Verifies connect, history restore, SSE receive, send→user_message, permissions
// approve body, slash commands, and shell invariant markers.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
};

const posted = { history: 0, resumes: [], requests: [], messages: [], permissions: [], selects: [], creates: [], sessions: [], fs: [], delegates: [] };
const sseClients = new Set();
let primaryId = ''; // unbound until web POSTs /select (mirrors desktop Bridge)

const resumed = new Set();
const bigHistory = { on: false };
function historyFor(id) {
  if (bigHistory.on) {
    const messages = [];
    for (let i = 0; i < 130; i++) messages.push({ role: i % 2 ? 'assistant' : 'user', text: 'bulk ' + i });
    return { id, messages, tasks: [] };
  }
  if (id === 'sess-old') return { id, messages: [{ role: 'user', text: 'old question' }, { role: 'assistant', text: 'old answer' }], tasks: [] };
  return {
    id,
    messages: [
      { role: 'user', text: 'hello history' },
      { role: 'assistant', text: 'hi from history' },
      { role: 'thinking', text: 'ponder' },
      { role: 'tool_call', taskId: 't1' },
    ],
    tasks: [{ id: 't1', name: 'bash', status: 'done', output: 'ok' }],
  };
}

function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

const TOKEN = 'web-e2e-token';
const tunnelPrefix = '/c/' + encodeURIComponent(TOKEN);

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let pathname = url.pathname;
  if (pathname === tunnelPrefix || pathname.startsWith(tunnelPrefix + '/')) {
    pathname = pathname.slice(tunnelPrefix.length) || '/';
  }
  const sendJSON = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type, authorization, accept, cache-control, x-firstrule-session',
    });
    return res.end();
  }
  posted.requests.push(req.method + ' ' + pathname);
  if (pathname === '/healthz') return sendJSON(200, { ok: true, bound: Boolean(primaryId) });
  if (pathname === '/v1/agents' && req.method === 'GET') {
    const agents = posted.creates.length
      ? posted.creates.map((c) => ({ id: c.id, status: 'idle', model: c.model || 'demo', workspace: c.workspace }))
      : [{ id: 'sess-1', status: 'idle', model: 'demo', workspace: '/home/demo' }];
    if (!posted.creates.length) agents[0] = { id: 'sess-1', status: 'idle', model: 'demo', workspace: '/home/demo' };
    // Keep initial agent plus any created ones
    const list = [{ id: 'sess-1', status: 'idle', model: 'demo', workspace: '/home/demo' }, ...[...resumed].map((id) => ({ id, status: 'idle', model: 'demo', workspace: '/home/demo' })), ...posted.creates.map((c) => ({ id: c.id, status: 'active', model: c.model || 'demo', workspace: c.workspace }))];
    // de-dupe by id
    const seen = new Set();
    const uniq = [];
    for (const a of list) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      uniq.push(a);
    }
    return sendJSON(200, { agents: uniq, primaryId });
  }
  if (pathname === '/v1/agents' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (body.resume) {
        posted.resumes.push(body);
        resumed.add(body.sessionId);
        return sendJSON(201, { id: body.sessionId, workspace: body.workspace, model: 'demo', mode: 'off' });
      }
      const id = 'sess-created';
      const created = { id, workspace: body.workspace, model: body.model || 'demo', mode: body.mode || 'off' };
      posted.creates.push(created);
      primaryId = id;
      sendJSON(201, created);
    });
    return;
  }
  if (pathname.startsWith('/v1/agents/') && pathname.endsWith('/select') && req.method === 'POST') {
    const id = decodeURIComponent(pathname.slice('/v1/agents/'.length, -'/select'.length).replace(/\/$/, ''));
    posted.selects.push(id);
    primaryId = id;
    return sendJSON(200, { ok: true, primaryId });
  }
  if (pathname.startsWith('/v1/agents/') && req.method === 'DELETE') {
    const id = decodeURIComponent(pathname.slice('/v1/agents/'.length).replace(/\/$/, ''));
    posted.closes = posted.closes || [];
    posted.closes.push(id);
    if (primaryId === id) primaryId = '';
    return sendJSON(200, { ok: true, id, action: 'close', primaryId });
  }
  if (pathname === '/v1/session' && req.method === 'GET') {
    if (!primaryId) return sendJSON(503, { error: 'no primary agent' });
    const created = posted.creates.find((c) => c.id === primaryId);
    return sendJSON(200, {
      id: primaryId,
      status: 'idle',
      state: 'idle',
      model: (created && created.model) || 'demo',
      mode: (created && created.mode) || 'off',
      workspace: (created && created.workspace) || '/home/demo',
    });
  }
  if (pathname === '/v1/session' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      posted.sessions.push(body);
      if (body.action === 'stop') {
        primaryId = '';
        return sendJSON(200, { ok: true, action: 'stop' });
      }
      if (body.action === 'abort') {
        return sendJSON(200, { ok: true, action: 'abort' });
      }
      if (body.action === 'continue' || body.action === 'compact') {
        return sendJSON(202, { ok: true, action: body.action, message: 'ok' });
      }
      if (body.action === 'settings' && body.parallel == null && body.compactionThreshold == null) {
        return sendJSON(200, { ok: true, action: 'settings', parallel: 2, compactionThreshold: 0.8 });
      }
      return sendJSON(200, { ok: true, ...body });
    });
    return;
  }
  if (pathname === '/v1/models' && req.method === 'GET') {
    return sendJSON(200, { models: [{ id: 'demo', name: 'Demo' }, { id: 'other', name: 'Other' }] });
  }
  if (pathname === '/v1/tasks' && req.method === 'GET') {
    return sendJSON(200, { tasks: [{ id: 't1', name: 'bash', status: 'done', durationMs: 1200 }] });
  }
  if (pathname === '/v1/delegates' && req.method === 'GET') {
    return sendJSON(200, { tasks: [{ id: 'child', status: 'waiting_permission' }] });
  }
  if (pathname === '/v1/delegates' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      posted.delegates.push(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      sendJSON(200, { ok: true });
    });
    return;
  }
  if (pathname === '/v1/fs' && req.method === 'GET') {
    posted.fs.push(url.pathname + url.search);
    const pathArg = url.searchParams.get('path') || '/home/demo';
    const prefix = url.searchParams.get('prefix') || '';
    const dirs = [
      { name: 'Projects', path: '/home/demo/Projects' },
      { name: 'proj', path: '/home/demo/proj' },
    ].filter((d) => !prefix || d.name.startsWith(prefix));
    return sendJSON(200, { path: pathArg === '~' ? '/home/demo' : pathArg, home: '/home/demo', directories: dirs });
  }
if (pathname === '/v1/history' && req.method === 'GET') {
    posted.history++;
    if (!primaryId) return sendJSON(503, { error: 'no primary agent' });
    return sendJSON(200, historyFor(primaryId));
  }
  if (pathname === '/v1/sessions' && req.method === 'GET') {
    return sendJSON(200, {
      workspace: '/home/demo',
      sessions: [
        { id: 'sess-1', summary: 'current one', running: true, lastUserAt: Date.now() - 60000 },
        { id: 'sess-old', summary: 'older work', running: false, workspace: '/home/demo', lastUserAt: Date.now() - 7200000 },
      ],
    });
  }
  if (pathname === '/v1/permissions' && req.method === 'GET') {
    return sendJSON(200, [{ id: 7, capability: 'shell', reason: 'run ls', taskId: 'child' }]);
  }
  if (pathname.startsWith('/v1/permissions/') && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      posted.permissions.push({ id: pathname.split('/').pop(), body });
      sendJSON(200, { ok: true, approve: body.approve });
    });
    return;
  }
  if (pathname === '/v1/queue' && req.method === 'GET') {
    if (!primaryId) return sendJSON(503, { error: 'no primary agent' });
    return sendJSON(200, { pending: posted.queue || [] });
  }
  if (pathname === '/v1/queue' && req.method === 'DELETE') {
    if (!primaryId) return sendJSON(503, { error: 'no primary agent' });
    const q = posted.queue || [];
    if (!q.length) return sendJSON(200, { ok: false, text: '', pending: [] });
    const text = q.pop();
    posted.queue = q;
    return sendJSON(200, { ok: true, text, pending: q.slice() });
  }
  if (pathname === '/v1/messages' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      posted.messages.push(body);
      if (posted.busy) {
        posted.queue = (posted.queue || []).concat([body.text]);
        return sendJSON(202, { ok: true, queued: true, pending: posted.queue.slice() });
      }
      posted.busy = true;
      sendJSON(202, { ok: true, queued: false, pending: [] });
      setTimeout(() => {
        broadcast('user_message', { type: 'user_message', text: body.text });
        broadcast('text_delta', { type: 'text_delta', text: 'pong:' });
        broadcast('text_delta', { type: 'text_delta', text: body.text });
        broadcast('turn_done', { type: 'turn_done', turn: 'pong:' + body.text });
        posted.busy = false;
      }, 20);
    });
    return;
  }
  if (pathname === '/v1/events' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write(': ok\n\n');
    // Like the desktop: subscribe, then send the persisted snapshot first.
    if (primaryId) res.write(`event: history\ndata: ${JSON.stringify(historyFor(primaryId))}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  sendJSON(404, { error: 'not found ' + pathname });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const origin = `http://127.0.0.1:${port}`;

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.readyState = 0;
    this._res = null;
    this._buf = '';
    this._connect();
  }
  async _connect() {
    try {
      const res = await fetch(this.url);
      this.readyState = 1;
      if (this.onopen) this.onopen();
      this._res = res;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this._buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = this._buf.indexOf('\n\n')) >= 0) {
          const chunk = this._buf.slice(0, idx);
          this._buf = this._buf.slice(idx + 2);
          this._dispatch(chunk);
        }
      }
    } catch (err) {
      if (this.onerror) this.onerror(err);
    }
  }
  _dispatch(chunk) {
    let type = 'message';
    const dataLines = [];
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    const ev = { type, data: dataLines.join('\n') };
    for (const fn of this.listeners.get(type) || []) fn(ev);
    if (type === 'message' && this.onmessage) this.onmessage(ev);
    // named events also hit onmessage only if browser does; we keep named listeners only
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  close() {
    this.readyState = 2;
  }
}

function buildDOM() {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  const byId = new Map();
  const makeEl = (tag = 'div') => {
    const el = {
      tagName: String(tag).toUpperCase(),
      style: {},
      dataset: {},
      attributes: {},
      children: [],
      parent: null,
      value: '',
      disabled: false,
      hidden: false,
      textContent: '',
      innerHTML: '',
      className: '',
      inert: false,
      onclick: null,
      onmousedown: null,
      _listeners: {},
      classList: {
        _set: new Set(),
        contains(c) { return this._set.has(c); },
        add(c) { this._set.add(c); el.className = [...this._set].join(' '); },
        remove(c) { this._set.delete(c); el.className = [...this._set].join(' '); },
        toggle(c, on) { if (on === undefined) on = !this._set.has(c); if (on) this.add(c); else this.remove(c); return on; },
      },
      setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'aria-hidden') this._ariaHidden = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
      removeAttribute(k) { delete this.attributes[k]; },
      appendChild(child) { child.parent = this; this.children.push(child); return child; },
      removeChild(child) { this.children = this.children.filter((c) => c !== child); return child; },
      querySelector(sel) {
        if (sel === '.body') return this.children.find((c) => c.className === 'body') || null;
        if (sel === '.meta') return this.children.find((c) => c.className === 'meta') || null;
        if (sel === '.cmd') return this.children.find((c) => c.className === 'cmd') || null;
        if (sel === '.desc') return this.children.find((c) => c.className === 'desc') || null;
        if (sel === '.id') return this.children.find((c) => c.className === 'id') || null;
        if (sel === '.sub') return this.children.find((c) => c.className === 'sub') || null;
        if (sel.startsWith('[aria-selected="true"]')) return this.children.find((c) => c.getAttribute('aria-selected') === 'true') || null;
        return null;
      },
      querySelectorAll() { return []; },
      focus() {},
      scrollIntoView() {},
      addEventListener(type, fn) {
        if (!this._listeners[type]) this._listeners[type] = [];
        this._listeners[type].push(fn);
      },
      dispatchEvent(type, ev) {
        for (const fn of this._listeners[type] || []) fn(ev);
      },
    };
    Object.defineProperty(el, 'scrollTop', { value: 0, writable: true });
    Object.defineProperty(el, 'scrollHeight', { value: 1000, writable: true });
    return el;
  };

  const ids = [
    'statusDot', 'statusText', 'token', 'relayURL', 'btnConnect', 'btnDisconnect',
    'btnSessions', 'btnCloseSessions', 'drawerBackdrop', 'sidebar', 'chat',
    'sessionLabel', 'btnNew', 'btnRefresh', 'transcript', 'composer',
    'hint', 'btnSend', 'sessions', 'permissions', 'btnRefreshAgents', 'btnRefreshPerms',
    'slashMenu', 'createDialog', 'createTitle', 'createWorkspace', 'pathMenu',
    'createModel', 'createMode', 'createHint', 'btnCreateCancel', 'btnCreateConfirm',
    'btnSettings', 'btnSettingsClose', 'settingsDialog', 'settingsHint', 'autoConnect',
    'btnStopTurn', 'picker', 'statusLine', 'activity', 'phaseTrack', 'chips', 'queue',
    'loading', 'chipModel', 'chipModelV', 'chipThinking', 'chipThinkingV', 'chipMode', 'chipModeV', 'chipUsage', 'chipUsageV',
  ];
  for (const id of ids) {
    const tag = id.startsWith('btn') || id === 'drawerBackdrop' ? 'button'
      : id === 'composer' ? 'textarea'
      : id === 'createModel' || id === 'createMode' ? 'select'
      : id.includes('token') || id === 'relayURL' || id === 'createWorkspace' ? 'input'
      : 'div';
    byId.set(id, makeEl(tag));
  }
  byId.get('createDialog').hidden = true;
  byId.get('settingsDialog').hidden = true;
  byId.get('picker').hidden = true;
  byId.get('loading').hidden = true;
  byId.get('createModel').innerHTML = '<option value="">default</option><option value="demo">demo</option>';
  byId.get('createMode').innerHTML = '<option value="off">off</option><option value="lite">lite</option>';
byId.get('relayURL').value = origin;
  byId.get('token').value = 'web-e2e-token';

  const header = makeEl('header');
  const body = {
    classList: {
      _set: new Set(),
      contains(c) { return this._set.has(c); },
      add(c) { this._set.add(c); this._sync(); },
      remove(c) { this._set.delete(c); this._sync(); },
      _sync() { body.className = [...this._set].join(' '); },
    },
    className: '',
    style: {},
  };

  const document = {
    body,
    getElementById: (id) => byId.get(id) || null,
    createElement: (tag) => makeEl(tag),
    querySelector: (sel) => (sel === 'header' ? header : null),
    addEventListener() {},
  };

  const matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
  return { document, localStorage, matchMedia, byId, header };
}

const style = HTML.match(/<style>([\s\S]*?)<\/style>/)[1];
const script = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
check('overflow-hidden shell', /html, body \{[\s\S]*?overflow:\s*hidden/.test(style) && /#app \{[\s\S]*?overflow:\s*hidden/.test(style));
check('mobile drawer markers', style.includes('drawer-open') && HTML.includes('id="btnSessions"'));
check('slash menu marker', HTML.includes('id="slashMenu"'));
check('relayURL field', HTML.includes('id="relayURL"') && HTML.includes('firstrule.relayURL'));
check('correct SSE event names', ['user_message', 'text_delta', 'system_notice', 'tool_done', 'turn_done', 'agent_error'].every((t) => script.includes(`"${t}"`)));
check('no legacy assistant_delta listener', !script.includes('assistant_delta'));
check('permissions approve body', script.includes('JSON.stringify({ approve })'));
check('history uses messages/tasks', script.includes('hist.messages') && script.includes('hist.tasks'));
check('omits model-only system transcript', script.includes('omitSystemTranscript') && script.includes('[shell side-effect review]') && script.includes('[FirstRule workflow snapshot]'));
check('phase track marks multi-principle runs', script.includes('wf.principles > 1') && script.includes('principle " + n + " of'));
check('status line single row', /#statusLine \{[^}]*flex-wrap:\s*nowrap[^}]*overflow-x:\s*auto/.test(style) && /#phaseTrack \{[^}]*flex-wrap:\s*nowrap/.test(style));
check('loading spinner markup', HTML.includes('id="loading"') && /@keyframes spin/.test(style));
check('native-only assets', ![...HTML.matchAll(/<(?:link|script)[^>]*(?:href|src)=["']([^"']+)["']/g)].length);

const dom = buildDOM();
const context = {
  document: dom.document,
  localStorage: dom.localStorage,
  location: { origin, protocol: 'http:', pathname: '/web/', href: origin + '/web/' },
  EventSource: FakeEventSource,
  fetch: globalThis.fetch.bind(globalThis),
  matchMedia: dom.matchMedia,
  URL,
  URLSearchParams,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  console,
};
context.window = context;
context.globalThis = context;
context.self = context;
vm.createContext(context);
vm.runInContext(script, context);

const $ = (id) => dom.byId.get(id);
await sleep(20);
await $('btnConnect').onclick();
await sleep(250);

const transcriptText = () => $('transcript').children.map((c) => {
  const meta = (c._meta && c._meta.textContent) || '';
  return `${c.dataset.kind}|${meta}|${c.dataset.text || ''}`;
}).join('\n');

check('connect succeeds', $('hint').textContent.includes('Connected') || $('statusText').textContent === 'live', $('hint').textContent + ' / ' + $('statusText').textContent);
check('auto-select primary before session', posted.selects[0] === 'sess-1' && primaryId === 'sess-1', JSON.stringify(posted.selects) + ' primary=' + primaryId);
{
  const active = $('sessions').children.find((c) => String(c.className || '').includes('active'));
  const main = active && active.children && active.children[0];
  const idText = main && main.children && main.children.find((c) => c.className === 'id');
  check('selected marker from primaryId', Boolean(active && idText && idText.textContent === 'sess-1'), 'active=' + (active && active.className) + ' id=' + (idText && idText.textContent));
}
check('history restored user+assistant', /user\|You\|hello history/.test(transcriptText()) && /agent\|FirstRule\|hi from history/.test(transcriptText()), transcriptText());
check('history restored tool card', /tool\|\|Bash/.test(transcriptText()) && transcriptText().includes('↳ 1 line returned'), transcriptText());

const ping = 'ping-e2e';
$('composer').value = ping;
const sendPromise = $('btnSend').onclick();
await sleep(30);
check('optimistic user card before/without waiting for SSE', transcriptText().includes('user|You|' + ping), transcriptText());
await sendPromise;
await sleep(250);
check('POST /v1/messages body', posted.messages.length === 1 && posted.messages[0].text === ping);
const userCards = transcriptText().split('\n').filter((l) => l.includes('user|You|' + ping));
check('user card not duplicated after SSE user_message', userCards.length === 1, transcriptText());
check(
  'SSE text_delta streamed',
  transcriptText().includes('pong:' + ping) || /agent\|.*pong:/.test(transcriptText()) || /assistant\|.*pong:/.test(transcriptText()),
  transcriptText(),
);
check('turn_done renders Summary, not agent text', /summary\|\|Summary · /.test(transcriptText()) && !/system\|[^\n]*pong:/.test(transcriptText()), transcriptText());
check(
  'connect/select reopen SSE after bind',
  /ensurePrimarySelected\(\)[\s\S]{0,400}if \(bound\) openEvents\(\)/.test(script)
    && /selectAgent[\s\S]{0,800}openEvents\(\)/.test(script)
    && script.includes('Subscribe only after BindPrimary'),
);
check(
  'refresh/create reopen after bind without connected gate',
  /confirmCreateSession[\s\S]{0,2000}if \(bound\) openEvents\(\)/.test(script)
    && /btnRefresh[\s\S]{0,500}if \(bound\) openEvents\(\)/.test(script)
    && !/if \(bound && state\.connected\) openEvents\(\)/.test(script),
);

$('composer').value = '/help';
await $('btnSend').onclick();
await sleep(30);
check('slash /help works', transcriptText().includes('Commands:'));

// Trigger permission button path via rendered list
await $('btnRefreshPerms').onclick();
await sleep(40);
const permItem = $('permissions').children.find((c) => c.className === 'item');
check('permissions rendered', Boolean(permItem));
if (permItem) {
  const approveBtn = permItem.children.find((c) => c.className === 'row')?.children?.[0];
  if (approveBtn && approveBtn.onclick) await approveBtn.onclick();
  await sleep(40);
}
check('permission posts approve:true', posted.permissions.some((p) => p.body && p.body.approve === true));


check('slash catalog includes remote commands', ['continue','model','principle','tasks','agents','permissions','approve','deny','revoke','settings','compact','pwd'].every((n) => script.includes('name: "' + n + '"')));
check('create dialog markers', HTML.includes('id="createDialog"') && script.includes('/v1/fs') && script.includes('confirmCreateSession'));

$('composer').value = '/pwd';
await $('btnSend').onclick();
await sleep(30);
check('slash /pwd works', transcriptText().includes('workspace:'));

$('composer').value = '/tasks';
await $('btnSend').onclick();
await sleep(40);
check('slash /tasks works', transcriptText().includes('bash'));

$('composer').value = '/settings';
await $('btnSend').onclick();
await sleep(40);
check('slash /settings works', transcriptText().includes('parallel=') && posted.sessions.some((s) => s.action === 'settings'));

$('composer').value = '/continue';
await $('btnSend').onclick();
await sleep(40);
check('slash /continue works', posted.sessions.some((s) => s.action === 'continue') && transcriptText().includes('Continue requested'));

$('composer').value = '/model';
await $('btnSend').onclick();
await sleep(40);
check('slash /model lists', transcriptText().includes('Models:') && transcriptText().includes('demo'));

$('composer').value = '/compact';
await $('btnSend').onclick();
await sleep(40);
check('slash /compact works', posted.sessions.some((s) => s.action === 'compact'));

$('composer').value = '/agents';
await $('btnSend').onclick();
await sleep(40);
check('slash /agents works', transcriptText().includes('waiting_permission') || transcriptText().includes('child'));
check('slash /agents renders table not JSON', /\| `child` \| waiting_permission/.test(transcriptText()) && !transcriptText().includes('"status"'), transcriptText());


$('composer').value = '/approve 7';
await $('btnSend').onclick();
await sleep(40);
check('slash /approve works', posted.permissions.some((p) => String(p.id) === '7' && p.body && p.body.approve === true));

$('composer').value = '/revoke child shell';
await $('btnSend').onclick();
await sleep(40);
check('slash /revoke works', posted.delegates.some((d) => d.action === 'revoke' && d.taskId === 'child' && d.capability === 'shell'));

check('slash omits daemon/exit', !/name:\s*"daemon"/.test(script) && !/name:\s*"exit"/.test(script));
check('slash close replaces stop', /name:\s*"close"/.test(script) && !HTML.includes('Stop session'));
check('interrupt uses abort not stop', /action:\s*\"abort\"/.test(script) && /btnStopTurn[\s\S]{0,120}interruptTurn/.test(script));
check('queue + Option↑ recall markers', script.includes('/v1/queue') && /Alt|altKey|metaKey/.test(script) && HTML.includes('id="queue"'));
check('slash prefix filter retained', /filterSlash[\s\S]{0,200}startsWith\(prefix\)/.test(script) && /updateSlashFromComposer[\s\S]{0,300}filterSlash\(prefix\)/.test(script));

// Create dialog path completion + confirm
await $('btnNew').onclick();
await sleep(200);
check('create dialog opens', context.document.body.className.includes('create-open') || !$('createDialog').hidden);
check('fs list called for path completion', posted.fs.length > 0, JSON.stringify(posted.fs));
$('createWorkspace').value = '/home/demo/Pro';
$('createWorkspace').dispatchEvent('input');
await sleep(100);
$('createWorkspace').value = '/home/demo/Projects';
$('createModel').value = 'demo';
$('createMode').value = 'lite';
await $('btnCreateConfirm').onclick();
await sleep(250);
check('POST /v1/agents create body', posted.creates.length === 1 && posted.creates[0].workspace === '/home/demo/Projects' && posted.creates[0].mode === 'lite', JSON.stringify(posted.creates));
check('create selects new primary', primaryId === 'sess-created' && posted.selects.includes('sess-created'), JSON.stringify(posted.selects) + ' primary=' + primaryId);
check('session label after create', ($('sessionLabel').textContent || '').includes('sess-created'), $('sessionLabel').textContent);

// /resume lists saved sessions and resumes a non-running one in the daemon.
posted.history = 0;
$('composer').value = '/resume';
await $('btnSend').onclick();
await sleep(80);
const pickerButtons = $('picker').children.filter((c) => c.dataset && c.dataset.value);
check('/resume picker lists saved sessions', !$('picker').hidden && pickerButtons.map((b) => b.dataset.value).join(',') === 'sess-1,sess-old', pickerButtons.map((b) => b.dataset.value).join(','));
const reqBefore = posted.requests.length;
const resumeDone = pickerButtons.find((b) => b.dataset.value === 'sess-old').onclick();
await sleep(1);
check('loading shown during switch', !$('loading').hidden);
await resumeDone;
await sleep(300);
check('resume POSTs daemon resume', posted.resumes.length === 1 && posted.resumes[0].sessionId === 'sess-old' && posted.resumes[0].resume === true, JSON.stringify(posted.resumes));
check('resume selects session', primaryId === 'sess-old', primaryId);
check('switch renders history from SSE frame', transcriptText().includes('old answer') && !transcriptText().includes('hello history'), transcriptText());
check('switch makes no /v1/history request', posted.history === 0, String(posted.history));
check('loading hidden after history', $('loading').hidden);
{
  const after = posted.requests.slice(reqBefore);
  const sel = after.findIndex((r) => r.endsWith('/select'));
  const ev = after.findIndex((r) => r === 'GET /v1/events');
  check('events opened right after select', sel >= 0 && ev === sel + 1, JSON.stringify(after));
}

// Live events during chunked history render are applied after it, in order;
// a tool_done repeated across the overlap updates the same card.
bigHistory.on = true;
$('btnRefresh').onclick();
for (let i = 0; i < 100 && !sseClients.size; i++) await sleep(2);
await sleep(15);
broadcast('tool_done', { type: 'tool_done', task: { id: 't-live', name: 'bash', status: 'success', output: 'x' } });
broadcast('tool_done', { type: 'tool_done', task: { id: 't-live', name: 'bash', status: 'success', output: 'x' } });
broadcast('system_notice', { type: 'system_notice', text: 'after-history' });
await sleep(500);
{
  const lines = transcriptText().split('\n');
  const lastBulk = lines.findIndex((l) => l.includes('bulk 129'));
  const live = lines.findIndex((l) => l.includes('after-history'));
  const tools = $('transcript').children.filter((c) => c._task && c._task.id === 't-live').length;
  check('chunked history fully rendered', lines.filter((l) => /bulk \d+$/.test(l)).length === 130, String(lines.length));
  check('live event after snapshot', lastBulk >= 0 && live > lastBulk, `bulk=${lastBulk} live=${live}`);
  check('duplicate tool_done renders once', tools === 1, String(tools));
}
bigHistory.on = false;

// Interrupt aborts the turn without unloading the primary.
await selectViaSessions('sess-1');
await sleep(120);
$('btnStopTurn').hidden = false;
await $('btnStopTurn').onclick();
await sleep(40);
check('interrupt posts abort', posted.sessions.some((s) => s.action === 'abort'), JSON.stringify(posted.sessions.slice(-3)));
check('interrupt keeps primary bound', primaryId === 'sess-1', primaryId);

// Close session clears the bound view and disables the composer.
{
  const closeBtn = $('sessions').children
    .map((row) => row.children.find((c) => c.className === 'close'))
    .find(Boolean);
  check('session row has close control', Boolean(closeBtn));
  if (closeBtn) {
    await closeBtn.onclick({ preventDefault() {}, stopPropagation() {} });
    await sleep(80);
  }
  check('close unloads primary', Array.isArray(posted.closes) && posted.closes.length > 0 && primaryId === '', JSON.stringify(posted.closes) + ' primary=' + primaryId);
  check('composer disabled without session', $('composer').disabled === true);

  // After close, a later refresh must not invent a binding even though other
  // sessions remain listed (mock still exposes sess-1 / creates).
  const selectsBeforeRefresh = posted.selects.length;
  await $('btnRefreshAgents').onclick();
  await sleep(80);
  check('refresh after close keeps unbound', primaryId === '' && posted.selects.length === selectsBeforeRefresh, 'primary=' + primaryId + ' selects=' + JSON.stringify(posted.selects));
  check('refresh after close keeps composer disabled', Boolean($('composer').disabled), 'disabled=' + $('composer').disabled);
  check('closed session prompts reopen', transcriptText().includes('Session closed') || ($('hint').textContent || '').includes('No active session'), $('hint').textContent);
}

async function selectViaSessions(id) {
  const row = $('sessions').children.find((c) => {
    const main = c.children && c.children[0];
    const idEl = main && main.children && main.children.find((x) => x.className === 'id');
    return idEl && idEl.textContent === id;
  });
  if (!row) throw new Error('missing session row ' + id);
  await row.children[0].onclick();
}

server.close();
console.log(`\nweb-protocol: ${failures ? failures + ' failed' : 'all passed'}`);
process.exit(failures);
