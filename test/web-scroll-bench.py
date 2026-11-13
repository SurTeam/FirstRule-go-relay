#!/usr/bin/env python3
"""Scroll/stream jank benchmark for relay/web/index.html (Playwright).

Reuses the mock desktop from web-e2e.py, fills the transcript with a long
history, then streams many text deltas while scrolling the transcript up and
down. Reports long frames (>50 ms gaps between rAF ticks), CDP main-thread
TaskDuration and LayoutCount. Run:

    ~/.venv/bin/python relay/test/web-scroll-bench.py [path/to/index.html]
"""
import importlib.util
import json
import pathlib
import sys
import threading
import time

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("webe2e", HERE / "web-e2e.py")
e2e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e2e)
if len(sys.argv) > 1:
    e2e.HTML = pathlib.Path(sys.argv[1]).read_bytes()

LONG_MD = e2e.REPLY_MD
HISTORY = []
for i in range(120):
    HISTORY.append({"role": "user", "text": f"question {i} with **bold** and `code`"})
    HISTORY.append({"role": "assistant", "text": f"Answer {i}.\n\n" + LONG_MD})


def history_get(self):
    p = self.route()
    if p == "/v1/history":
        return self.send_json(200, {"id": e2e.state["primary"], "messages": HISTORY, "tasks": []})
    return ORIG_GET(self, p)


ORIG_GET = e2e.H.do_GET


def patched_get(self):
    p = __import__("urllib.parse").parse.urlparse(self.path).path
    if p == e2e.PREFIX + "/v1/history":
        body = json.dumps({"id": e2e.state["primary"], "messages": HISTORY, "tasks": []}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return
    return ORIG_GET(self)


e2e.H.do_GET = patched_get


def stream_turn():
    time.sleep(0.05)
    e2e.broadcast("user_message", {"text": "bench"})
    text = (LONG_MD + "\n\n") * 3
    step = 12
    for i in range(0, len(text), step):
        e2e.broadcast("text_delta", {"text": text[i:i + step]})
        time.sleep(0.004)
    e2e.broadcast("turn_done", {"usage": {"InputTokens": 1, "OutputTokens": 1}})


def main():
    srv = e2e.ThreadingHTTPServer(("127.0.0.1", 0), e2e.H)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(**p.devices["iPhone 13"])
        page = ctx.new_page()
        cdp = ctx.new_cdp_session(page)
        cdp.send("Performance.enable")
        cdp.send("Emulation.setCPUThrottlingRate", {"rate": 4})
        page.goto(base + "/web/")
        page.fill("#relayURL", base)
        page.fill("#token", e2e.TOKEN)
        page.click("#btnConnect")
        page.wait_for_function("document.getElementById('statusText').textContent === 'live'", timeout=20000)
        page.wait_for_function("document.querySelectorAll('.msg.agent').length >= 120", timeout=30000)
        page.wait_for_timeout(500)
        page.evaluate("""() => {
          window.__gaps = [];
          let last = performance.now();
          const tick = (t) => { window.__gaps.push(t - last); last = t; if (!window.__stop) requestAnimationFrame(tick); };
          requestAnimationFrame(tick);
        }""")
        m0 = {x["name"]: x["value"] for x in cdp.send("Performance.getMetrics")["metrics"]}
        t0 = time.time()
        threading.Thread(target=stream_turn, daemon=True).start()
        box = page.locator("#transcript").bounding_box()
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        for i in range(40):
            page.mouse.wheel(0, -400 if (i // 10) % 2 == 0 else 400)
            page.wait_for_timeout(40)
        page.wait_for_selector(".msg.summary", timeout=60000)
        wall = time.time() - t0
        page.evaluate("window.__stop = true")
        m1 = {x["name"]: x["value"] for x in cdp.send("Performance.getMetrics")["metrics"]}
        gaps = page.evaluate("window.__gaps")
        browser.close()
    srv.shutdown()
    long = [g for g in gaps if g > 50]
    res = {
        "wall_s": round(wall, 2),
        "frames": len(gaps),
        "long_frames_gt50ms": len(long),
        "worst_frame_ms": round(max(gaps), 1),
        "task_ms": round((m1["TaskDuration"] - m0["TaskDuration"]) * 1000),
        "layout_count": int(m1["LayoutCount"] - m0["LayoutCount"]),
        "recalc_style": int(m1["RecalcStyleCount"] - m0["RecalcStyleCount"]),
    }
    print(json.dumps(res))


if __name__ == "__main__":
    main()
