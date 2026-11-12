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

const posted = { messages: [], permissions: [], selects: [], creates: [], sessions: [], fs: [], delegates: [] };
const sseClients = new Set();
let primaryId = ''; // unbound until web POSTs /select (mirrors desktop Bridge)

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
      'access-control-allow-headers': 'content-type',
    });
    return res.end();
  }
  if (pathname === '/healthz') return sendJSON(200, { ok: true, bound: Boolean(primaryId) });
  if (pathname === '/v1/agents' && req.method === 'GET') {
    const agents = posted.creates.length
      ? posted.creates.map((c) => ({ id: c.id, status: 'idle', model: c.model || 'demo', workspace: c.workspace }))
      : [{ id: 'sess-1', status: 'idle', model: 'demo', workspace: '/home/demo' }];
    if (!posted.creates.length) agents[0] = { id: 'sess-1', status: 'idle', model: 'demo', workspace: '/home/demo' };
    // Keep initial agent plus any created ones
    const list = [{ id: 'sess-1', status: 'idle', model: 'demo', workspace: '/home/demo' }, ...posted.creates.map((c) => ({ id: c.id, status: 'active', model: c.model || 'demo', workspace: c.workspace }))];
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
    if (!primaryId) return sendJSON(503, { error: 'no primary agent' });
    return sendJSON(200, {
      id: primaryId,
      messages: [
        { role: 'user', text: 'hello history' },
        { role: 'assistant', text: 'hi from history' },
        { role: 'thinking', text: 'ponder' },
        { role: 'tool_call', taskId: 't1' },
      ],
      tasks: [{ id: 't1', name: 'bash', status: 'done', output: 'ok' }],
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
  if (pathname === '/v1/messages' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      posted.messages.push(body);
      sendJSON(202, { ok: true });
      setTimeout(() => {
        broadcast('user_message', { type: 'user_message', text: body.text });
        broadcast('text_delta', { type: 'text_delta', text: 'pong:' });
        broadcast('text_delta', { type: 'text_delta', text: body.text });
        broadcast('turn_done', { type: 'turn_done', turn: 'pong:' + body.text });
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
      },
      setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'aria-hidden') this._ariaHidden = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; },
      removeAttribute(k) { delete this.attributes[k]; },
      appendChild(child) { child.parent = this; this.children.push(child); return child; },
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
    'sessionLabel', 'btnNew', 'btnStop', 'btnRefresh', 'transcript', 'composer',
    'hint', 'btnSend', 'sessions', 'permissions', 'btnRefreshAgents', 'btnRefreshPerms',
    'slashMenu', 'createDialog', 'createTitle', 'createWorkspace', 'pathMenu',
    'createModel', 'createMode', 'createHint', 'btnCreateCancel', 'btnCreateConfirm',
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
  const meta = (c.children.find((x) => x.className === 'meta') || {}).textContent || '';
  const body = (c.children.find((x) => x.className === 'body') || {}).textContent || '';
  return `${c.className}|${meta}|${body}`;
}).join('\n');

check('connect succeeds', $('hint').textContent.includes('Connected') || $('statusText').textContent === 'live', $('hint').textContent + ' / ' + $('statusText').textContent);
check('auto-select primary before session', posted.selects[0] === 'sess-1' && primaryId === 'sess-1', JSON.stringify(posted.selects) + ' primary=' + primaryId);
{
  const active = $('sessions').children.find((c) => String(c.className || '').includes('active'));
  const idText = active && active.children.find((c) => c.className === 'id');
  check('selected marker from primaryId', Boolean(active && idText && idText.textContent === 'sess-1'), 'active=' + (active && active.className));
}
check('history restored user+assistant', /user\|.*hello history/.test(transcriptText()) && /assistant\|.*hi from history/.test(transcriptText()), transcriptText());
check('history restored tool card', /tool\|/.test(transcriptText()) && transcriptText().includes('ok'), transcriptText());

const ping = 'ping-e2e';
$('composer').value = ping;
const sendPromise = $('btnSend').onclick();
await sleep(30);
check('optimistic user card before/without waiting for SSE', transcriptText().includes('user|user|' + ping), transcriptText());
await sendPromise;
await sleep(250);
check('POST /v1/messages body', posted.messages.length === 1 && posted.messages[0].text === ping);
const userCards = transcriptText().split('\n').filter((l) => l.includes('user|user|' + ping));
check('user card not duplicated after SSE user_message', userCards.length === 1, transcriptText());
check(
  'SSE text_delta streamed',
  transcriptText().includes('pong:' + ping) || /agent\|.*pong:/.test(transcriptText()) || /assistant\|.*pong:/.test(transcriptText()),
  transcriptText(),
);
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

$('composer').value = '/approve 7';
await $('btnSend').onclick();
await sleep(40);
check('slash /approve works', posted.permissions.some((p) => String(p.id) === '7' && p.body && p.body.approve === true));

$('composer').value = '/revoke child shell';
await $('btnSend').onclick();
await sleep(40);
check('slash /revoke works', posted.delegates.some((d) => d.action === 'revoke' && d.taskId === 'child' && d.capability === 'shell'));

check('slash omits daemon/exit', !/name:\s*"daemon"/.test(script) && !/name:\s*"exit"/.test(script));
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

server.close();
console.log(`\nweb-protocol: ${failures ? failures + ' failed' : 'all passed'}`);
process.exit(failures);
