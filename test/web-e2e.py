#!/usr/bin/env python3
"""Real-browser e2e for relay/web/index.html (Playwright, Chromium).

Serves the page at /web/ plus a mock desktop remote API under /c/<token>/,
then drives it at a desktop and an iPhone viewport. Run:

    ~/.venv/bin/python relay/test/web-e2e.py [--shots DIR]

Uses fictional data only (see docs/code-standards.md privacy rules).
"""
import json
import pathlib
import queue
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
HTML = (ROOT / "web" / "index.html").read_bytes()
TOKEN = "demo-token"
PREFIX = "/c/" + TOKEN

state = {
    "primary": "",
    "model": "demo-pro",
    "thinking": "medium",
    "mode": "lite",
    "posts": [],
}
subscribers = []
sub_lock = threading.Lock()

MODELS = [
    {"id": "demo-pro", "name": "Demo Pro", "provider": "demo", "thinking": ["low", "medium", "high"]},
    {"id": "demo-mini", "name": "Demo Mini", "provider": "demo", "default": True},
]

REPLY_MD = """Here is the **plan** with `code` and *emphasis*:

## Steps

- first item
  - nested item
- [x] done task

> quoted line

| col a | col b |
| --- | ---: |
| 1 | 22 |

```go
func main() { return }
```

---

<b>raw html dropped</b> and ~~old~~ text, see [docs](https://example.com/docs)."""


def broadcast(ev_type, data):
    data = dict(data, type=ev_type)
    with sub_lock:
        for q in list(subscribers):
            q.put((ev_type, data))


def scripted_turn(text):
    time.sleep(0.05)
    broadcast("user_message", {"text": text})
    broadcast("reasoning_delta", {"text": "Thinking about the request…"})
    broadcast("reasoning_end", {})
    task = {"ID": "call-1", "Name": "bash", "Arguments": json.dumps({"command": "ls -la /home/demo"}), "Status": "running"}
    broadcast("tool_start", {"task": task})
    time.sleep(0.05)
    out = "\n".join(f"line {i}" for i in range(1, 16))
    broadcast("tool_done", {"task": dict(task, Status="success", Output=out, Duration=1_200_000_000)})
    edit = {"ID": "call-2", "Name": "edit", "Status": "success", "Output": "edited",
            "Arguments": json.dumps({"file_path": "a.go", "old_string": "x := 1", "new_string": "x := 2\ny := 3"})}
    broadcast("tool_done", {"task": edit})
    for chunk in [REPLY_MD[:40], REPLY_MD[40:]]:
        broadcast("text_delta", {"text": chunk})
        time.sleep(0.02)
    broadcast("stream_done", {})
    broadcast("turn_done", {
        "turn": REPLY_MD,
        "usage": {"InputTokens": 1200, "OutputTokens": 345, "CacheReadTokens": 800, "CacheWriteTokens": 10, "Cost": 0.0123},
        "toolOk": 2, "toolTotal": 2,
    })


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("content-length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def route(self):
        p = urlparse(self.path).path
        if p in ("/web", "/web/"):
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.send_header("content-length", str(len(HTML)))
            self.end_headers()
            self.wfile.write(HTML)
            return None
        if not p.startswith(PREFIX):
            return self.send_json(404, {"error": "not found"})
        return p[len(PREFIX):] or "/"

    def do_GET(self):
        p = self.route()
        if p is None:
            return
        if p == "/healthz":
            return self.send_json(200, {"ok": True})
        if p == "/v1/agents":
            return self.send_json(200, {"primaryId": state["primary"], "agents": [
                {"id": "sess-1", "workspace": "/home/demo/proj", "model": state["model"], "mode": state["mode"], "status": "idle"},
                {"id": "sess-2", "workspace": "/home/demo/other", "model": "demo-mini", "mode": "off", "status": "idle"},
            ]})
        if p == "/v1/session":
            if not state["primary"]:
                return self.send_json(503, {"error": "no primary agent"})
            return self.send_json(200, {
                "id": state["primary"], "workspace": "/home/demo/proj", "model": state["model"],
                "thinking": state["thinking"], "mode": state["mode"], "status": "idle", "state": "idle", "busy": False,
                "workflow": {"phases": ["define", "synthesize", "execute"], "current": "synthesize", "index": 1, "complete": False, "blocked": False},
            })
        if p == "/v1/models":
            return self.send_json(200, {"models": MODELS})
        if p == "/v1/history":
            return self.send_json(200, {"id": state["primary"], "messages": [
                {"role": "user", "text": "hello **history**"},
                {"role": "assistant", "text": "restored *reply*"},
            ], "tasks": []})
        if p == "/v1/permissions":
            return self.send_json(200, [])
        if p == "/v1/fs":
            dirs = [{"name": f"very-long-directory-name-number-{i:02d}-for-overflow", "path": f"/home/demo/very-long-directory-name-number-{i:02d}-for-overflow"} for i in range(60)]
            return self.send_json(200, {"path": "/home/demo", "home": "/home/demo", "directories": dirs})
        if p == "/v1/delegates":
            return self.send_json(200, {"tasks": [{"id": "child-1", "status": "running", "model": "demo-mini", "workspace": "/home/demo/proj"}]})
        if p == "/v1/events":
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.send_header("cache-control", "no-cache")
            self.end_headers()
            q = queue.Queue()
            with sub_lock:
                subscribers.append(q)
            try:
                self.wfile.write(b": ok\n\n")
                self.wfile.flush()
                while True:
                    try:
                        t, d = q.get(timeout=1)
                        self.wfile.write(f"event: {t}\ndata: {json.dumps(d)}\n\n".encode())
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                with sub_lock:
                    subscribers.remove(q)
            return
        return self.send_json(404, {"error": "not found " + p})

    def do_POST(self):
        p = self.route()
        if p is None:
            return
        b = self.body()
        state["posts"].append((p, b))
        if p.startswith("/v1/agents/") and p.endswith("/select"):
            state["primary"] = p.split("/")[3]
            return self.send_json(200, {"ok": True, "primaryId": state["primary"]})
        if p == "/v1/session":
            if b.get("action") == "model":
                state["model"] = b["model"]
                state["thinking"] = b.get("thinking", "")
            if b.get("action") == "principle":
                state["mode"] = b["mode"]
            return self.send_json(200, {"ok": True})
        if p == "/v1/messages" and b.get("text") == "plain reply":
            def plain():
                time.sleep(0.05)
                broadcast("user_message", {"text": "plain reply"})
                broadcast("turn_done", {"turn": "non-streamed **answer**", "usage": {"InputTokens": 10, "OutputTokens": 5}})
            threading.Thread(target=plain, daemon=True).start()
            return self.send_json(202, {"ok": True})
        if p == "/v1/messages":
            threading.Thread(target=scripted_turn, args=(b.get("text", ""),), daemon=True).start()
            return self.send_json(202, {"ok": True})
        return self.send_json(404, {"error": "not found"})


failures = 0


def check(name, ok, detail=""):
    global failures
    print(("  ✓ " if ok else "  ✗ ") + name + ("" if ok or not detail else " — " + str(detail)))
    if not ok:
        failures += 1


def run(page, base, label, mobile, shots):
    state.update(primary="", model="demo-pro", thinking="", mode="lite")
    print(f"[{label}]")
    page.goto(base + "/web/")
    # First visit: settings page opens instead of a top-bar token row.
    check("settings page shown on first visit", page.locator("#settingsDialog").is_visible())
    check("top bar has no server/token inputs", page.locator("header input").count() == 0)
    page.fill("#relayURL", base)
    page.fill("#token", TOKEN)
    page.click("#btnConnect")
    page.wait_for_function("document.getElementById('statusText').textContent === 'live'", timeout=5000)
    check("settings closes after connect", not page.locator("#settingsDialog").is_visible())
    ls = page.evaluate("[localStorage.getItem('firstrule.relayURL'), localStorage.getItem('firstrule.relay.token')]")
    check("server/token cached in localStorage", ls == [base, TOKEN], ls)

    check("history user bubble renders markdown", page.locator(".msg.user strong", has_text="history").count() == 1)
    check("history agent bubble renders markdown", page.locator(".msg.agent em", has_text="reply").count() == 1)

    # Chips + workflow around the composer.
    check("model chip", page.inner_text("#chipModelV") == "demo-pro")
    check("thinking chip defaults to lowest level like TUI", page.inner_text("#chipThinkingV") == "low", page.inner_text("#chipThinkingV"))
    check("flow chip", page.inner_text("#chipModeV") == "lite")
    check("workflow phase track", page.locator("#phaseTrack .phase.cur", has_text="synthesize").count() == 1
          and page.locator("#phaseTrack .phase.done", has_text="define").count() == 1)
    page.click("#chipThinking")
    check("thinking picker lists levels", page.locator("#picker button").all_inner_texts() == ["low", "medium", "high"],
          page.locator("#picker button").all_inner_texts())
    check("thinking picker marks effective level", page.locator("#picker button.cur").inner_text() == "low")
    page.click("#picker button[data-value=high]")
    page.wait_for_function("document.getElementById('chipThinkingV').textContent === 'high'", timeout=3000)
    check("thinking change posted", ("/v1/session", {"action": "model", "model": "demo-pro", "thinking": "high"}) in state["posts"])
    page.click("#chipMode")
    page.click("#picker button[data-value=full]")
    page.wait_for_function("document.getElementById('chipModeV').textContent === 'full'", timeout=3000)
    check("flow mode change posted", ("/v1/session", {"action": "principle", "mode": "full"}) in state["posts"])

    # Mobile zoom: focusing the composer must not change the visual viewport scale.
    scale0 = page.evaluate("window.visualViewport ? visualViewport.scale : 1")
    page.click("#composer")
    page.keyboard.type("hi ")
    scale1 = page.evaluate("window.visualViewport ? visualViewport.scale : 1")
    fs = page.evaluate("parseFloat(getComputedStyle(document.getElementById('composer')).fontSize)")
    vp = page.get_attribute("meta[name=viewport]", "content")
    small = page.evaluate("[...document.querySelectorAll('input,textarea,select')].filter(e => e.type !== 'checkbox' && parseFloat(getComputedStyle(e).fontSize) < 16).map(e => e.id)")
    check("all form controls >= 16px", small == [], small)
    check("no zoom on input focus", scale0 == scale1 == 1 and fs >= 16 and "maximum-scale=1" in vp, (scale0, scale1, fs, vp))

    page.fill("#composer", "")
    page.click("#composer")
    page.keyboard.type("run the")
    page.keyboard.press("Enter")
    page.keyboard.type("plan")
    n_user = page.locator(".msg.user").count()
    check("Enter inserts newline, does not send", page.input_value("#composer") == "run the\nplan" and page.locator(".msg.user").count() == n_user)
    page.fill("#composer", "run the plan")
    page.keyboard.press("Meta+Enter")
    page.wait_for_selector(".msg.summary", timeout=5000)
    page.wait_for_timeout(150)

    users = page.locator(".msg.user .body", has_text="run the plan").count()
    check("single user bubble (dedupe)", users == 1, users)
    ub = page.locator(".msg.user").last.bounding_box()
    ab = page.locator(".msg.agent").last.bounding_box()
    tb = page.locator("#transcript").bounding_box()
    check("user bubble right, agent bubble left", ub["x"] + ub["width"] > tb["x"] + tb["width"] - 30 and ab["x"] < tb["x"] + 30, (ub, ab, tb))
    ubg = page.evaluate("getComputedStyle(document.querySelector('.msg.user .body')).backgroundColor")
    abg = page.evaluate("getComputedStyle(document.querySelector('.msg.agent .body')).backgroundColor")
    check("user/agent bubble colors differ", ubg != abg, (ubg, abg))

    think = page.locator(".msg.think").last
    check("thinking collapsed after answer", "collapsed" in think.get_attribute("class") and "▸ Thinking" in think.inner_text())

    # Tool cards: collapsed with header + ↳ summary, expand on tap.
    bash = page.locator(".msg.tool").nth(0)
    check("tool header like TUI", "✓" in bash.inner_text() and "Bash" in bash.inner_text() and "ls -la /home/demo" in bash.inner_text() and "1.2s" in bash.inner_text(), bash.inner_text())
    check("tool collapsed summary", "↳ 15 lines returned" in bash.locator(".summary").inner_text())
    check("tool collapsed hides output", not bash.locator(".expanded").is_visible())
    bash.locator(".head").click()
    check("tool expands Input/Output", bash.locator(".expanded").is_visible() and "├ Input" in bash.inner_text() and "command: ls -la /home/demo" in bash.inner_text())
    check("tool output truncated at 10 lines", "line 10" in bash.inner_text() and "line 11" not in bash.inner_text() and "+5 more lines" in bash.inner_text())
    bash.locator(".more").click()
    check("more lines reveal", "line 15" in bash.inner_text())
    edit = page.locator(".msg.tool").nth(1)
    check("edit diff summary", "↳ diff · +2 · -1" in edit.inner_text(), edit.inner_text())

    # Markdown rules (TUI parity).
    a = page.locator(".msg.agent").last
    check("md bold/italic/code", a.locator("strong", has_text="plan").count() == 1 and a.locator("em", has_text="emphasis").count() == 1 and a.locator("code.span", has_text="code").count() == 1)
    check("md heading", a.locator(".h", has_text="Steps").count() == 1)
    check("md bullets •, nested, task box", a.locator("li > .bullet").count() >= 3 and a.locator("ul.md-list ul.md-list").count() == 1 and "[x] done task" in a.inner_text())
    check("md blockquote", a.locator("blockquote", has_text="quoted line").count() == 1)
    check("md table", a.locator("table.md-table th", has_text="col a").count() == 1 and a.locator("td[style*=right]", has_text="22").count() == 1)
    check("md fenced code with lang", a.locator("pre.code[data-lang=go] .tok-k", has_text="func").count() == 1)
    check("md hr", a.locator("hr").count() == 1)
    check("md raw html dropped", a.locator("b").count() == 0 and "raw html dropped" in a.inner_text(), (a.locator("b").count(), a.inner_text()[-200:]))
    check("md strike + link", a.locator("del", has_text="old").count() == 1 and a.locator("a[href='https://example.com/docs']").count() == 1)

    # turn_done → Summary only, no duplicate agent message.
    s = page.locator(".msg.summary").last.inner_text()
    check("turn summary like TUI", s.startswith("Summary · ") and "1,545 tokens" in s and "in 1,200 / out 345" in s and "est. cost $0.0123" in s and "cache read 800 / write 10" in s and "tools 2/2 succeeded" in s, s)
    check("no duplicated agent text", page.locator(".msg.agent", has_text="Here is the").count() == 1)
    check("status shown under composer", "turn finished" in page.inner_text("#hint"))

    # Non-streamed reply (only in turn_done.turn) must still appear once.
    n_sum = page.locator(".msg.summary").count()
    page.fill("#composer", "plain reply")
    page.keyboard.press("Control+Enter")
    page.wait_for_function(f"document.querySelectorAll('.msg.summary').length > {n_sum}", timeout=5000)
    check("non-streamed reply shown once", page.locator(".msg.agent strong", has_text="answer").count() == 1)
    check("streamed reply still not duplicated", page.locator(".msg.agent", has_text="Here is the").count() == 1)

    # No raw JSON in the main area.
    page.fill("#composer", "/agents")
    page.keyboard.press("Escape")
    page.click("#btnSend")
    page.wait_for_selector("table.md-table td code:has-text('child-1')", timeout=3000)
    txt = page.inner_text("#transcript")
    check("no raw JSON in transcript", '{"' not in txt and '"status"' not in txt)

    # Active session: background tint, no outline ring.
    act = page.locator("#sessions .item.active")
    oc = page.evaluate("(() => { const e = document.querySelector('#sessions .item.active'); const c = getComputedStyle(e); return [c.outlineStyle, c.outlineWidth, c.boxShadow]; })()")
    check("active session has no outline ring", oc[0] == "none" or oc[1] == "0px", oc)

    # Create dialog: long directory list stays inside the viewport.
    if mobile:
        page.click("#btnSessions")
        page.wait_for_timeout(250)
    page.click("#btnNew")
    page.wait_for_selector("#pathMenu.open .item", timeout=5000)
    vh = page.viewport_size["height"]
    pb = page.locator("#createDialog .panel").bounding_box()
    mb = page.locator("#pathMenu").bounding_box()
    check("create panel fits viewport", pb["y"] >= 0 and pb["y"] + pb["height"] <= vh + 1, (pb, vh))
    check("directory list is bounded and scrolls", mb["height"] <= 201 and page.evaluate("document.getElementById('pathMenu').scrollHeight > document.getElementById('pathMenu').clientHeight"), mb)
    check("create defaults: TUI model + auto flow", page.input_value("#createModel") == "demo-mini" and page.input_value("#createMode") == "auto",
          (page.input_value("#createModel"), page.input_value("#createMode")))
    cb = page.locator("#btnCreateConfirm").bounding_box()
    check("create buttons reachable on screen", cb["y"] + cb["height"] <= vh + 1, cb)
    create_btn = page.evaluate("(() => { const c = getComputedStyle(document.getElementById('btnCreateCancel')); return [c.backgroundColor, c.borderRadius, c.minHeight, c.fontSize]; })()")
    page.click("#btnCreateCancel")
    page.click("#btnSettings")
    settings_btn = page.evaluate("(() => { const c = getComputedStyle(document.getElementById('btnSettingsClose')); return [c.backgroundColor, c.borderRadius, c.minHeight, c.fontSize]; })()")
    same_row = page.evaluate("document.getElementById('btnSettingsClose').parentElement.className === document.getElementById('btnCreateCancel').parentElement.className")
    check("settings and create buttons share one style", create_btn == settings_btn and same_row, (create_btn, settings_btn))
    page.click("#btnSettingsClose")
    page.wait_for_timeout(300)  # drawer slide-out transition after New

    # Sidebar: drawer on mobile, static on desktop.
    if mobile:
        check("sidebar hidden off-canvas", page.evaluate("document.getElementById('sidebar').getBoundingClientRect().right <= 0"))
        page.click("#btnSessions")
        page.wait_for_timeout(300)
        check("drawer opens from top-left", page.evaluate("document.getElementById('sidebar').getBoundingClientRect().left >= 0") and page.locator("#sessions .item").count() == 2)
        if shots:
            page.screenshot(path=str(pathlib.Path(shots) / f"{label}-drawer.png"))
        page.click("#btnCloseSessions")
        page.wait_for_timeout(300)
        hh = page.locator("header").bounding_box()["height"]
        check("thin top bar on mobile", hh <= 56, hh)
        tr = page.locator("#transcript").bounding_box()["height"]
        check("transcript dominates viewport", tr > page.viewport_size["height"] * 0.5, tr)
        # Simulated keyboard: visual viewport loses 300px.
        hy0 = page.locator("header").bounding_box()["y"]
        cy0 = page.locator(".composer-wrap").bounding_box()
        page.evaluate("""() => {
          const h = innerHeight - 300;
          Object.defineProperty(window, 'visualViewport', { configurable: true, value: Object.assign(new EventTarget(), { height: h, width: innerWidth, scale: 1, offsetTop: 0 }) });
          document.documentElement.style.setProperty('--vvh', h + 'px');
          window.dispatchEvent(new Event('resize'));
        }""")
        page.wait_for_timeout(100)
        hy1 = page.locator("header").bounding_box()["y"]
        tr1 = page.locator("#transcript").bounding_box()["height"]
        cb1 = page.locator(".composer-wrap").bounding_box()
        vh1 = page.viewport_size["height"] - 300
        check("keyboard: top bar stays, transcript shrinks", hy1 == hy0 and tr1 < tr - 250 and cb1["y"] + cb1["height"] <= vh1 + 2, (hy0, hy1, tr, tr1, cb1, vh1))
        check("keyboard: page not shifted", page.evaluate("scrollY") == 0)
        sb = page.locator("#btnSend").bounding_box()
        check("keyboard: send button visible above keyboard", sb is not None and sb["y"] >= 0 and sb["y"] + sb["height"] <= vh1 + 2, (sb, vh1))
        n_u = page.locator(".msg.user").count()
        page.fill("#composer", "tap send")
        page.locator("#btnSend").tap()
        page.wait_for_function(f"document.querySelectorAll('.msg.user').length > {n_u}", timeout=5000)
        check("keyboard: tapping send sends", page.locator(".msg.user .body", has_text="tap send").count() == 1)
        page.wait_for_function("document.getElementById('btnStopTurn').hidden", timeout=5000)
        page.evaluate("""() => { document.documentElement.style.setProperty('--vvh', innerHeight + 'px'); }""")
    else:
        check("sidebar visible on desktop", page.locator("#sidebar").is_visible() and page.locator("#sessions .item.active").count() == 1)
    check("page itself does not scroll", page.evaluate("document.scrollingElement.scrollHeight <= innerHeight + 1"))
    if shots:
        page.screenshot(path=str(pathlib.Path(shots) / f"{label}.png"))
        bash.screenshot(path=str(pathlib.Path(shots) / f"{label}-tool.png"))

    # Reload: cached settings auto-connect, settings stay out of the way.
    page.reload()
    page.wait_for_function("document.getElementById('statusText').textContent === 'live'", timeout=5000)
    check("reload reconnects from cache without settings page", not page.locator("#settingsDialog").is_visible())
    page.click("#btnSettings")
    check("settings reachable via ⚙", page.locator("#settingsDialog").is_visible() and page.input_value("#token") == TOKEN)
    page.click("#btnSettingsClose")
    hb = page.evaluate("getComputedStyle(document.querySelector('header')).backgroundColor")
    tw = page.evaluate("getComputedStyle(document.getElementById('transcript')).willChange")
    check("header opaque, no layer promotion on scroller", hb not in ("rgba(0, 0, 0, 0)", "transparent") and tw == "auto", (hb, tw))


def main():
    shots = None
    if "--shots" in sys.argv:
        shots = sys.argv[sys.argv.index("--shots") + 1]
        pathlib.Path(shots).mkdir(parents=True, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    with sync_playwright() as p:
        browser = p.chromium.launch()
        desktop = browser.new_context(viewport={"width": 1280, "height": 860})
        run(desktop.new_page(), base, "desktop", False, shots)
        desktop.close()
        iphone = browser.new_context(**p.devices["iPhone 13"])
        run(iphone.new_page(), base, "iphone", True, shots)
        iphone.close()
        browser.close()
    srv.shutdown()
    print("\nweb-e2e: " + (f"{failures} failed" if failures else "all passed"))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
