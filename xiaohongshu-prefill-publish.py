import argparse
import ctypes
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright
from playwright._impl._errors import TargetClosedError


ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("XIAOLONGXIA_DATA_DIR", ROOT / ".wechat-direct-bridge"))
BROWSER_PROFILE_DIR = Path(os.environ.get("XIAOLONGXIA_BROWSER_PROFILE_DIR", ROOT / ".browser-profiles"))
DRAFT_DIR = DATA_DIR / "xiaohongshu-drafts"
PROFILE_DIR = BROWSER_PROFILE_DIR / "chrome-xhs-publisher"
CDP_PROFILE_DIR = BROWSER_PROFILE_DIR / "chrome-xhs-publisher-cdp"
DEBUG_PATH = DATA_DIR / "xiaohongshu-prefill-debug.json"
STATUS_PATH = DATA_DIR / "xiaohongshu-prefill-status.json"
CHROME_PATH = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
EDGE_PATH = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
PUBLISH_URL = "https://creator.xiaohongshu.com/publish/publish?target=image"
CDP_PORT = int(os.environ.get("XIAOLONGXIA_XHS_CDP_PORT", "9333"))


def log(message: str) -> None:
    print(message, flush=True)


def write_status(payload: dict) -> None:
    STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = dict(payload)
    payload["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    STATUS_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def find_latest_package() -> Path:
    candidates = list(DRAFT_DIR.glob("*.json")) + list(DRAFT_DIR.glob("*/package.json"))
    candidates = sorted(candidates, key=lambda p: p.stat().st_mtime, reverse=True)
    if not candidates:
        raise FileNotFoundError(f"未找到发布包 JSON：{DRAFT_DIR}")
    return candidates[0]


def load_package(json_path: Path) -> dict:
    payload = json.loads(json_path.read_text(encoding="utf-8"))
    draft = payload.get("draft") or {}
    image_result = payload.get("images") or {}
    image_files = image_result.get("files") or []
    sorted_images = sorted(
        image_files,
        key=lambda item: (0 if item.get("kind") == "cover" else 1, str(item.get("path") or "")),
    )
    return {
        "json_path": str(json_path),
        "title": str(draft.get("title") or "").strip(),
        "body": str(draft.get("post_text") or "").strip(),
        "hashtags": [str(tag).strip() for tag in (draft.get("hashtags") or []) if str(tag).strip()],
        "image_paths": [str(item.get("path")) for item in sorted_images if str(item.get("path") or "").strip()],
    }


def is_publish_url(url: str) -> bool:
    return "creator.xiaohongshu.com/publish/publish" in url and "login" not in url


def is_login_url(url: str) -> bool:
    return "creator.xiaohongshu.com/login" in url


def pick_browser_path() -> Path:
    if CHROME_PATH.exists():
        return CHROME_PATH
    if EDGE_PATH.exists():
        return EDGE_PATH
    raise FileNotFoundError(f"未找到可用浏览器：{CHROME_PATH} 或 {EDGE_PATH}")


def bring_publish_browser_to_front(page=None) -> None:
    try:
        if page:
            page.bring_to_front()
            try:
                page.evaluate("() => window.focus()")
            except Exception:
                pass
    except Exception:
        pass

    if os.name != "nt":
        return

    try:
        kernel32 = ctypes.windll.kernel32
        user32 = ctypes.windll.user32
        keywords = ["小红书", "发布", "creator.xiaohongshu"]
        matches = []

        def callback(hwnd, _):
            if not user32.IsWindowVisible(hwnd):
                return True
            length = user32.GetWindowTextLengthW(hwnd)
            if length <= 0:
                return True
            title = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, title, length + 1)
            text = title.value or ""
            if any(keyword in text for keyword in keywords):
                matches.append(hwnd)
            return True

        enum_proc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)(callback)
        user32.EnumWindows(enum_proc, 0)
        if not matches:
            return

        hwnd = matches[0]
        try:
            user32.AllowSetForegroundWindow(-1)
        except Exception:
            pass
        foreground = user32.GetForegroundWindow()
        current_thread = kernel32.GetCurrentThreadId()
        target_thread = user32.GetWindowThreadProcessId(hwnd, None)
        foreground_thread = user32.GetWindowThreadProcessId(foreground, None) if foreground else 0
        try:
            user32.AttachThreadInput(current_thread, target_thread, True)
            if foreground_thread:
                user32.AttachThreadInput(foreground_thread, target_thread, True)
        except Exception:
            pass
        user32.ShowWindow(hwnd, 9)
        user32.ShowWindow(hwnd, 3)
        user32.SetWindowPos(hwnd, -1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
        user32.SetActiveWindow(hwnd)
        user32.SetFocus(hwnd)
        user32.SetWindowPos(hwnd, -2, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040)
        try:
            user32.AttachThreadInput(current_thread, target_thread, False)
            if foreground_thread:
                user32.AttachThreadInput(foreground_thread, target_thread, False)
        except Exception:
            pass
    except Exception:
        pass


def wait_for_cdp_browser(playwright, endpoint: str, timeout_seconds: int = 15):
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{endpoint}/json/version", timeout=1):
                browser = playwright.chromium.connect_over_cdp(endpoint, timeout=3000)
                context = browser.contexts[0] if browser.contexts else browser.new_context(no_viewport=True)
                return context, browser
        except Exception:
            time.sleep(0.5)
    return None, None


def start_cdp_browser(browser_path: Path, profile_dir: Path) -> None:
    profile_dir.mkdir(parents=True, exist_ok=True)
    subprocess.Popen(
        [
            str(browser_path),
            f"--remote-debugging-port={CDP_PORT}",
            f"--user-data-dir={profile_dir}",
            "--start-maximized",
            "--new-window",
            "--window-position=80,40",
            "--deny-permission-prompts",
            "--no-first-run",
            "--no-default-browser-check",
            PUBLISH_URL,
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )


def open_publish_context(playwright, browser_path: Path):
    endpoint = f"http://127.0.0.1:{CDP_PORT}"
    try:
        browser = playwright.chromium.connect_over_cdp(endpoint, timeout=3000)
        context = browser.contexts[0] if browser.contexts else browser.new_context(no_viewport=True)
        return context, browser, True
    except Exception:
        pass

    try:
        start_cdp_browser(browser_path, PROFILE_DIR)
    except Exception as exc:
        raise RuntimeError(f"启动小红书专用浏览器失败：{exc}") from exc

    context, browser = wait_for_cdp_browser(playwright, endpoint, 8)
    if context and browser:
        return context, browser, False

    try:
        start_cdp_browser(browser_path, CDP_PROFILE_DIR)
    except Exception as exc:
        raise RuntimeError(f"启动小红书备用专用浏览器失败：{exc}") from exc

    context, browser = wait_for_cdp_browser(playwright, endpoint, 15)
    if context and browser:
        return context, browser, False

    raise RuntimeError("小红书专用浏览器已启动，但调试端口未就绪。请关闭旧的专用 Chrome 窗口后重试。")


def pick_publish_page(context):
    for page in context.pages:
        try:
            if page.url == "about:blank":
                return page
        except Exception:
            continue
    return context.new_page()


def click_first_text(page, texts) -> bool:
    builders = [
        lambda p, t: p.get_by_role("button", name=t),
        lambda p, t: p.get_by_role("link", name=t),
        lambda p, t: p.get_by_text(t, exact=True),
        lambda p, t: p.get_by_text(t),
    ]
    for text in texts:
        for builder in builders:
            try:
                locator = builder(page, text)
                if locator.count():
                    locator.first.click(timeout=2000)
                    page.wait_for_timeout(800)
                    return True
            except Exception:
                continue
    return False


def click_near_text(page, texts) -> bool:
    script = """
    (texts) => {
      const normalize = (value) => (value || "").replace(/\\s+/g, "").trim();
      const candidates = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const el = walker.currentNode;
        const text = normalize(el.innerText || el.textContent || "");
        if (!text || text.length > 100) continue;
        if (!texts.some(t => text.includes(normalize(t)))) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) continue;
        candidates.push(el);
      }
      for (const el of candidates) {
        try {
          el.scrollIntoView({block: "center"});
          el.click();
          return true;
        } catch (err) {}
      }
      return false;
    }
    """
    try:
        if page.evaluate(script, texts):
            page.wait_for_timeout(500)
            return True
    except Exception:
        pass
    return False


def dismiss_browser_overlays(page) -> None:
    for _ in range(3):
        try:
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
        except Exception:
            break


def get_active_element_info(page):
    script = """
    () => {
      const el = document.activeElement;
      if (!el) return null;
      return {
        tag: el.tagName || "",
        role: el.getAttribute?.("role") || "",
        placeholder: el.getAttribute?.("placeholder") || "",
        aria: el.getAttribute?.("aria-label") || "",
        className: el.className || "",
        isEditable: !!el.isContentEditable,
        text: (el.innerText || "").slice(0, 200)
      };
    }
    """
    try:
        return page.evaluate(script)
    except Exception:
        return None


def active_element_matches(page, keywords) -> bool:
    info = get_active_element_info(page) or {}
    haystack = " ".join(
        str(info.get(key) or "") for key in ["tag", "role", "placeholder", "aria", "className", "text"]
    ).lower()
    if info.get("isEditable"):
        return True
    return any(keyword.lower() in haystack for keyword in keywords)


def set_text_on_focused_element(page, value: str) -> bool:
    try:
        page.keyboard.press("Control+A")
        page.keyboard.press("Backspace")
        page.keyboard.insert_text(value)
        page.wait_for_timeout(600)
        return True
    except Exception:
        return False


def keyboard_prefill(page, title: str, body: str) -> bool:
    dismiss_browser_overlays(page)
    click_first_text(page, ["填写标题", "添加标题", "标题", "输入标题"])
    click_near_text(page, ["填写标题", "添加标题", "标题", "输入标题"])
    page.wait_for_timeout(600)

    for _ in range(12):
        if active_element_matches(page, ["标题", "title"]):
            if set_text_on_focused_element(page, title):
                break
        try:
            page.keyboard.press("Tab")
            page.wait_for_timeout(250)
        except Exception:
            break
    else:
        return False

    click_first_text(page, ["添加正文", "输入正文", "正文", "写点什么", "内容", "描述"])
    click_near_text(page, ["添加正文", "输入正文", "正文", "写点什么", "内容", "描述"])
    page.wait_for_timeout(600)

    for _ in range(16):
        if active_element_matches(page, ["正文", "内容", "描述", "textbox"]):
            if set_text_on_focused_element(page, body):
                return True
        try:
            page.keyboard.press("Tab")
            page.wait_for_timeout(250)
        except Exception:
            break
    return False


def find_visible_candidates(page, selector: str):
    handles = []
    contexts = [page] + list(page.frames)
    for context in contexts:
        try:
            element_handles = context.locator(selector).element_handles()
        except Exception:
            continue
        for handle in element_handles:
            try:
                box = handle.bounding_box()
                if box and box["width"] > 10 and box["height"] > 10:
                    handles.append(handle)
            except Exception:
                continue
    return handles


def find_shadow_candidates(page):
    script = """
    () => {
      const results = [];
      const seen = new Set();
      const selectors = [
        "input",
        "textarea",
        "[contenteditable='true']",
        "[role='textbox']",
        "[data-placeholder]",
        ".ql-editor",
        ".public-DraftEditor-content",
        ".ProseMirror",
        "[aria-multiline='true']",
        "[data-slate-editor='true']"
      ];

      const visitRoot = (root) => {
        if (!root || seen.has(root)) return;
        seen.add(root);

        for (const sel of selectors) {
          for (const el of root.querySelectorAll(sel)) {
            const rect = el.getBoundingClientRect();
            if (rect.width < 10 || rect.height < 10) continue;
            results.push({
              tag: el.tagName,
              selector: sel,
              placeholder: el.getAttribute("placeholder") || "",
              aria: el.getAttribute("aria-label") || "",
              className: el.className || "",
              role: el.getAttribute("role") || "",
              text: (el.innerText || "").slice(0, 200)
            });
          }
        }

        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) visitRoot(el.shadowRoot);
        }
      };

      visitRoot(document);
      return results;
    }
    """
    contexts = [page] + list(page.frames)
    items = []
    for idx, context in enumerate(contexts):
        try:
            found = context.evaluate(script)
            for item in found:
                item["contextIndex"] = idx
                item["contextUrl"] = getattr(context, "url", "")
                items.append(item)
        except Exception:
            continue
    return items


def element_score(handle, preferred_keywords):
    try:
        attrs = " ".join(
            filter(
                None,
                [
                    handle.get_attribute("placeholder"),
                    handle.get_attribute("aria-label"),
                    handle.get_attribute("name"),
                    handle.get_attribute("class"),
                ],
            )
        )
        text = handle.inner_text(timeout=1000)
    except Exception:
        attrs = ""
        text = ""
    score = 0
    haystack = f"{attrs} {text}"
    for keyword, weight in preferred_keywords:
        if keyword in haystack:
            score += weight
    try:
        box = handle.bounding_box()
        if box:
            score += int((box["width"] * box["height"]) / 5000)
    except Exception:
        pass
    return score


def find_field_by_anchor(page, anchor_keywords):
    script = """
    (keywords) => {
      const normalize = (value) => (value || "").replace(/\\s+/g, "").trim().toLowerCase();
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 8 && rect.height > 8;
      };
      const editableSelector = [
        "input",
        "textarea",
        "[contenteditable='true']",
        "[role='textbox']",
        "[data-placeholder]",
        "[aria-multiline='true']",
        ".ql-editor",
        ".public-DraftEditor-content",
        ".ProseMirror",
        "[data-slate-editor='true']"
      ].join(",");

      const all = Array.from(document.querySelectorAll("*"));
      const anchors = all.filter((el) => {
        const text = normalize(el.innerText || el.textContent || "");
        if (!text || text.length > 120) return false;
        return keywords.some((keyword) => text.includes(normalize(keyword)));
      });

      const findEditable = (root) => {
        if (!root) return null;
        if (root.matches && root.matches(editableSelector) && isVisible(root)) return root;
        const direct = root.querySelector ? root.querySelector(editableSelector) : null;
        if (direct && isVisible(direct)) return direct;
        return null;
      };

      for (const anchor of anchors) {
        let candidate = findEditable(anchor);
        if (candidate) return candidate;

        let current = anchor;
        for (let i = 0; i < 5 && current; i += 1) {
          candidate = findEditable(current.parentElement);
          if (candidate) return candidate;
          current = current.parentElement;
        }

        const next = anchor.nextElementSibling;
        candidate = findEditable(next);
        if (candidate) return candidate;
      }
      return null;
    }
    """
    try:
        return page.evaluate_handle(script, anchor_keywords)
    except Exception:
        return None


def handle_is_truthy(handle) -> bool:
    try:
        return bool(handle) and handle.evaluate("node => !!node")
    except Exception:
        return False


def pick_title_field(page):
    anchored = find_field_by_anchor(page, ["填写标题", "添加标题", "输入标题", "标题"])
    if handle_is_truthy(anchored):
        try:
            return anchored.as_element()
        except Exception:
            pass

    candidates = find_visible_candidates(
        page,
        "input, textarea, [contenteditable='true'], [role='textbox'], [data-placeholder], [aria-multiline='true'], [data-slate-editor='true']",
    )
    if not candidates:
        return None
    preferred = [("标题", 100), ("输入标题", 80), ("文章标题", 80), ("填写标题", 80), ("title", 20)]
    ranked = sorted(candidates, key=lambda h: element_score(h, preferred), reverse=True)
    return ranked[0]


def pick_body_field(page):
    anchored = find_field_by_anchor(page, ["正文", "输入正文", "添加正文", "写点什么", "内容", "描述"])
    if handle_is_truthy(anchored):
        try:
            return anchored.as_element()
        except Exception:
            pass

    candidates = find_visible_candidates(
        page,
        "textarea, [contenteditable='true'], [role='textbox'], [data-placeholder], .ql-editor, .public-DraftEditor-content, .ProseMirror, [aria-multiline='true'], [data-slate-editor='true']",
    )
    if not candidates:
        return None
    preferred = [("正文", 100), ("内容", 80), ("描述", 50), ("输入正文", 80), ("写点什么", 50), ("添加正文", 80)]
    ranked = sorted(candidates, key=lambda h: element_score(h, preferred), reverse=True)
    return ranked[0]


def set_text(handle, value: str):
    tag = (handle.evaluate("el => el.tagName") or "").lower()
    is_editable = bool(handle.evaluate("el => el.isContentEditable"))
    if tag in {"input", "textarea"}:
        handle.evaluate(
            """(el, nextValue) => {
                const prototype = el.tagName === 'TEXTAREA'
                  ? window.HTMLTextAreaElement.prototype
                  : window.HTMLInputElement.prototype;
                const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
                descriptor.set.call(el, nextValue);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }""",
            value,
        )
        return

    if is_editable:
        handle.evaluate(
            """(el, nextValue) => {
                el.focus();
                el.innerHTML = '';
                const lines = String(nextValue).split(/\\n/);
                lines.forEach((line, idx) => {
                  const p = document.createElement('p');
                  p.textContent = line;
                  el.appendChild(p);
                  if (idx === lines.length - 1 && !line) {
                    p.innerHTML = '<br>';
                  }
                });
                el.dispatchEvent(new InputEvent('input', { bubbles: true, data: nextValue, inputType: 'insertText' }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }""",
            value,
        )


def type_text_visibly(page, handle, value: str, chunk_size: int = 24, delay_ms: int = 70) -> bool:
    try:
        handle.scroll_into_view_if_needed(timeout=3000)
    except Exception:
        pass

    try:
        handle.click(timeout=5000)
    except Exception:
        try:
            handle.focus()
        except Exception:
            return False

    try:
        page.keyboard.press("Control+A")
        page.keyboard.press("Backspace")
        page.wait_for_timeout(250)
        for index in range(0, len(value), chunk_size):
            page.keyboard.insert_text(value[index:index + chunk_size])
            page.wait_for_timeout(delay_ms)
        page.wait_for_timeout(250)
        set_text(handle, value)
        handle.evaluate(
            """(el) => {
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }"""
        )
        return True
    except Exception:
        try:
            set_text(handle, value)
            return True
        except Exception:
            return False


def find_file_input(page):
    contexts = [page] + list(page.frames)
    for context in contexts:
        try:
            candidates = context.locator("input[type='file']")
            if candidates.count():
                return candidates.first
        except Exception:
            continue
    return None


def wait_for_upload_surface(page, timeout_seconds: int = 30) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            if page.locator("input[type='file']").count() > 0:
                return True
        except Exception:
            pass
        try:
            if page.get_by_role("button", name="上传图片").count() > 0:
                return True
        except Exception:
            pass
        try:
            if "上传图片" in page.inner_text("body", timeout=1000):
                return True
        except Exception:
            pass
        page.wait_for_timeout(500)
    return False


def inject_files_into_inputs(page, image_paths) -> bool:
    try:
        page.evaluate(
            """() => {
                for (const input of document.querySelectorAll("input[type='file']")) {
                  input.removeAttribute("hidden");
                  input.style.display = "block";
                  input.style.visibility = "visible";
                  input.style.opacity = "1";
                  input.style.pointerEvents = "auto";
                  input.style.position = "fixed";
                  input.style.left = "12px";
                  input.style.top = "12px";
                  input.style.zIndex = "2147483647";
                  input.style.width = "240px";
                  input.style.height = "40px";
                }
            }"""
        )
        candidates = page.locator("input[type='file']")
        count = candidates.count()
        for index in range(count):
            try:
                candidates.nth(index).set_input_files(image_paths, timeout=10000)
                page.wait_for_timeout(2200)
                if wait_for_uploaded_images(page, 30):
                    return True
            except Exception as exc:
                log(f"图片 input 注入失败：{exc}")
                continue
    except Exception as exc:
        log(f"图片 input 准备失败：{exc}")
    return False


def wait_for_uploaded_images(page, timeout_seconds: int) -> bool:
    script = """
    () => {
      const selectors = [
        "img",
        "[style*='background-image']",
        ".upload-list img",
        ".media-list img",
        ".image-list img"
      ];
      let count = 0;
      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          const rect = el.getBoundingClientRect();
          if (rect.width < 24 || rect.height < 24) continue;
          count += 1;
        }
      }
      return count;
    }
    """
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            count = int(page.evaluate(script) or 0)
            if count > 0:
                return True
        except Exception:
            pass
        page.wait_for_timeout(800)
    return False


def set_windows_clipboard_text(text: str) -> None:
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    GMEM_MOVEABLE = 0x0002
    CF_UNICODETEXT = 13
    data = text.encode("utf-16-le") + b"\x00\x00"
    handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
    if not handle:
        return
    locked = kernel32.GlobalLock(handle)
    if not locked:
        kernel32.GlobalFree(handle)
        return
    ctypes.memmove(locked, data, len(data))
    kernel32.GlobalUnlock(handle)
    if not user32.OpenClipboard(None):
        kernel32.GlobalFree(handle)
        return
    user32.EmptyClipboard()
    user32.SetClipboardData(CF_UNICODETEXT, handle)
    user32.CloseClipboard()


def press_windows_key(vk: int, ctrl: bool = False) -> None:
    user32 = ctypes.windll.user32
    KEYEVENTF_KEYUP = 0x0002
    if ctrl:
        user32.keybd_event(0x11, 0, 0, 0)
    user32.keybd_event(vk, 0, 0, 0)
    user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)
    if ctrl:
        user32.keybd_event(0x11, 0, KEYEVENTF_KEYUP, 0)


def find_windows_file_dialog():
    if os.name != "nt":
        return None
    user32 = ctypes.windll.user32
    matches = []

    def callback(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        class_name = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, class_name, 256)
        if class_name.value != "#32770":
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        title = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, title, length + 1)
        text = title.value or ""
        if any(keyword in text for keyword in ["打开", "Open", "选择", "文件"]):
            matches.append(hwnd)
        return True

    enum_proc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)(callback)
    user32.EnumWindows(enum_proc, 0)
    return matches[0] if matches else None


def fill_windows_file_dialog(image_paths, timeout_seconds: int = 8) -> bool:
    if os.name != "nt":
        return False
    deadline = time.time() + timeout_seconds
    value = " ".join(f'"{str(Path(path).resolve())}"' for path in image_paths)
    while time.time() < deadline:
        hwnd = find_windows_file_dialog()
        if hwnd:
            user32 = ctypes.windll.user32
            user32.ShowWindow(hwnd, 9)
            user32.SetForegroundWindow(hwnd)
            time.sleep(0.2)
            set_windows_clipboard_text(value)
            press_windows_key(ord("V"), ctrl=True)
            time.sleep(0.2)
            press_windows_key(0x0D)
            return True
        time.sleep(0.25)
    return False


def start_file_dialog_filler(image_paths) -> Thread | None:
    if os.name != "nt":
        return None
    thread = Thread(target=fill_windows_file_dialog, args=(image_paths,), daemon=True)
    thread.start()
    return thread


def click_upload_image_button(page) -> bool:
    script = """
    () => {
      const normalize = (value) => (value || "").replace(/\\s+/g, "").trim();
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 8 && rect.height > 8 && style.visibility !== "hidden" && style.display !== "none";
      };
      const candidates = Array.from(document.querySelectorAll("button,[role='button']"))
        .filter(isVisible)
        .map((el) => ({ el, text: normalize(el.innerText || el.textContent || el.getAttribute("aria-label") || "") }))
        .filter((item) => item.text === "上传图片" || item.text === "添加图片");
      const exact = candidates[0];
      if (!exact) return false;
      exact.el.scrollIntoView({ block: "center", inline: "center" });
      exact.el.click();
      return true;
    }
    """
    try:
        return bool(page.evaluate(script))
    except Exception:
        return False


def dump_debug_candidates(page):
    data = {"url": page.url, "title": page.title(), "contexts": [], "shadowCandidates": [], "activeElement": None}
    contexts = [page] + list(page.frames)
    for idx, context in enumerate(contexts):
        entry = {"index": idx, "url": getattr(context, "url", ""), "inputs": [], "textareas": [], "editables": []}
        for selector, key in [("input", "inputs"), ("textarea", "textareas"), ("[contenteditable='true']", "editables")]:
            try:
                for handle in context.locator(selector).element_handles()[:20]:
                    try:
                        box = handle.bounding_box()
                        entry[key].append(
                            {
                                "visible": bool(box),
                                "placeholder": handle.get_attribute("placeholder"),
                                "aria": handle.get_attribute("aria-label"),
                                "class": handle.get_attribute("class"),
                                "text": (handle.inner_text(timeout=500) or "")[:100],
                            }
                        )
                    except Exception:
                        continue
            except Exception:
                continue
        data["contexts"].append(entry)
    data["shadowCandidates"] = find_shadow_candidates(page)
    data["activeElement"] = get_active_element_info(page)
    DEBUG_PATH.parent.mkdir(parents=True, exist_ok=True)
    DEBUG_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return DEBUG_PATH


def wait_for_publish_page(page, timeout_seconds: int) -> None:
    deadline = time.time() + timeout_seconds
    prompted = False

    while time.time() < deadline:
        url = page.url
        if is_publish_url(url):
            return

        if is_login_url(url):
            if not prompted:
                log("检测到当前还在小红书创作平台登录页。")
                log("请直接在刚打开的 Chrome 窗口里完成登录，我会自动等待你进入发布页。")
                log("登录成功并跳到发布页后，脚本会自动继续，不需要回终端按键。")
                prompted = True
            try:
                page.goto(PUBLISH_URL, wait_until="domcontentloaded", timeout=120000)
            except Exception:
                pass

        page.wait_for_timeout(1000)

    raise TimeoutError("等待进入小红书发布页超时，请确认已在自动化打开的浏览器里完成登录。")


def wait_for_editor_ready(page, timeout_seconds: int) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        dismiss_browser_overlays(page)
        try:
            page.mouse.wheel(0, 1200)
            page.wait_for_timeout(300)
            page.mouse.wheel(0, -1200)
        except Exception:
            pass
        click_near_text(page, ["填写标题", "添加标题", "输入标题", "标题"])
        click_near_text(page, ["输入正文", "添加正文", "正文", "内容", "描述", "写点什么"])
        if pick_title_field(page) and pick_body_field(page):
            return True
        page.wait_for_timeout(1500)
    return False


def upload_images(page, image_paths):
    if not image_paths:
        return False

    image_paths = [str(Path(path)) for path in image_paths if Path(path).exists()]
    if not image_paths:
        return False

    if not wait_for_upload_surface(page, 30):
        log("未等待到小红书上传区域。")
        return False

    if inject_files_into_inputs(page, image_paths):
        return True

    file_input = find_file_input(page)
    if file_input:
        try:
            file_input.set_input_files(image_paths)
            page.wait_for_timeout(1500)
            return wait_for_uploaded_images(page, 20)
        except Exception:
            pass

    filler = start_file_dialog_filler(image_paths)
    try:
        if click_upload_image_button(page):
            if filler:
                filler.join(timeout=10)
            page.wait_for_timeout(1800)
            return wait_for_uploaded_images(page, 24)
    except Exception:
        pass

    return False


def normalize_for_match(value: str) -> str:
    return "".join(str(value or "").split()).lower()


def title_appears_on_page(page, title: str) -> bool:
    expected = normalize_for_match(title)
    if not expected:
        return False
    probes = [expected]
    if len(expected) > 14:
        probes.append(expected[:14])
    if len(expected) > 8:
        probes.append(expected[:8])
    try:
        page_text = normalize_for_match(page.inner_text("body", timeout=5000))
    except Exception:
        page_text = ""
    return any(probe and probe in page_text for probe in probes)


def verify_draft_saved_by_title(page, title: str, timeout_seconds: int = 25) -> bool:
    """Verify draft save by opening the creator note/draft area and finding the title.

    Xiaohongshu's save button/toast can be misleading, so this check is the
    source of truth for whether the draft really exists.
    """
    if not title:
        return False

    deadline = time.time() + timeout_seconds

    def wait_title(seconds: int = 4) -> bool:
        end = time.time() + seconds
        while time.time() < end:
            dismiss_browser_overlays(page)
            if title_appears_on_page(page, title):
                return True
            page.wait_for_timeout(700)
        return False

    # First try the in-app navigation that is most likely to preserve session state.
    nav_attempts = [
        (["笔记管理", "作品管理", "内容管理"], ["草稿", "草稿箱", "未发布", "暂存"]),
        (["草稿箱", "草稿"], []),
    ]
    for first_texts, second_texts in nav_attempts:
        if time.time() >= deadline:
            break
        dismiss_browser_overlays(page)
        clicked = click_first_text(page, first_texts) or click_near_text(page, first_texts) or click_draft_candidate_by_dom(page, first_texts)
        if clicked:
            page.wait_for_timeout(2000)
            if second_texts:
                click_first_text(page, second_texts) or click_near_text(page, second_texts) or click_draft_candidate_by_dom(page, second_texts)
                page.wait_for_timeout(2000)
            if wait_title(5):
                return True

    # Then try a few known creator-management URLs. These may vary by account,
    # so failure here should not close the browser; it just means "not confirmed".
    candidate_urls = [
        "https://creator.xiaohongshu.com/creator/notes",
        "https://creator.xiaohongshu.com/creator/notes?tab=draft",
        "https://creator.xiaohongshu.com/creator/notes?type=draft",
        "https://creator.xiaohongshu.com/creator/notes?status=draft",
    ]
    for url in candidate_urls:
        if time.time() >= deadline:
            break
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            page.wait_for_timeout(2500)
            click_first_text(page, ["草稿", "草稿箱", "未发布", "暂存"]) or click_near_text(page, ["草稿", "草稿箱", "未发布", "暂存"])
            page.wait_for_timeout(1500)
            if wait_title(4):
                return True
        except Exception:
            continue

    dump_clickable_debug(page)
    return False


def save_draft(page, title: str, timeout_seconds: int = 20) -> bool:
    deadline = time.time() + timeout_seconds
    button_texts = [
        "暂存离开",
        "暂存并离开",
        "暂存",
        "保存草稿",
        "存草稿",
        "保存到草稿箱",
        "存入草稿箱",
        "保存至草稿箱",
        "保存",
    ]
    confirm_texts = ["确认", "确定", "暂存", "暂存离开", "离开", "保存"]
    success_texts = ["草稿已保存", "已保存草稿", "保存成功", "已存为草稿", "已暂存", "暂存成功"]
    original_url = page.url

    while time.time() < deadline:
        dismiss_browser_overlays(page)
        try:
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            page.wait_for_timeout(500)
        except Exception:
            pass
        clicked = click_first_text(page, button_texts) or click_near_text(page, button_texts)
        if not clicked:
            clicked = click_draft_candidate_by_dom(page, button_texts)
        if clicked:
            page.wait_for_timeout(800)
            click_first_text(page, confirm_texts) or click_near_text(page, confirm_texts) or click_draft_candidate_by_dom(page, confirm_texts)
            verify_deadline = time.time() + 8
            while time.time() < verify_deadline:
                page.wait_for_timeout(800)
                try:
                    page_text = page.inner_text("body", timeout=2000)
                except Exception:
                    page_text = ""
                if any(text in page_text for text in success_texts):
                    return verify_draft_saved_by_title(page, title)
                # Xiaohongshu usually leaves the edit page after a real draft save.
                current_url = page.url
                if current_url and current_url != original_url and "/publish/publish" not in current_url:
                    return verify_draft_saved_by_title(page, title)
            dump_clickable_debug(page)
            return False
        page.wait_for_timeout(800)
    dump_clickable_debug(page)
    return False


def click_draft_candidate_by_dom(page, texts) -> bool:
    script = """
    (texts) => {
      const normalize = (value) => (value || "").replace(/\\s+/g, "").trim();
      const wanted = texts.map(normalize).filter(Boolean);
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
      };
      const isClickable = (el) => {
        const role = el.getAttribute("role") || "";
        const tag = el.tagName || "";
        return ["BUTTON", "A"].includes(tag) || role === "button" || el.onclick || el.tabIndex >= 0;
      };
      const nodes = Array.from(document.querySelectorAll("button,a,[role='button'],[tabindex],div,span"));
      const candidates = nodes
        .map((el) => ({ el, text: normalize(el.innerText || el.textContent || el.getAttribute("aria-label") || "") }))
        .filter((item) => item.text && item.text.length <= 80 && wanted.some((text) => item.text.includes(text)))
        .filter((item) => isVisible(item.el))
        .sort((a, b) => {
          const ab = isClickable(a.el) ? 0 : 1;
          const bb = isClickable(b.el) ? 0 : 1;
          return ab - bb;
        });
      for (const item of candidates) {
        try {
          item.el.scrollIntoView({ block: "center", inline: "center" });
          item.el.click();
          return true;
        } catch (err) {}
      }
      return false;
    }
    """
    try:
        if page.evaluate(script, texts):
            page.wait_for_timeout(800)
            return True
    except Exception:
        pass
    return False


def dump_clickable_debug(page) -> Path:
    try:
        payload = json.loads(DEBUG_PATH.read_text(encoding="utf-8")) if DEBUG_PATH.exists() else {}
    except Exception:
        payload = {}
    try:
        payload["clickables"] = page.evaluate(
            """
            () => {
              const normalize = (value) => (value || "").replace(/\\s+/g, " ").trim();
              const isVisible = (el) => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 4 && rect.height > 4 && style.visibility !== "hidden" && style.display !== "none";
              };
              return Array.from(document.querySelectorAll("button,a,[role='button'],[tabindex]"))
                .filter(isVisible)
                .map((el) => ({
                  tag: el.tagName || "",
                  role: el.getAttribute("role") || "",
                  text: normalize(el.innerText || el.textContent || ""),
                  aria: el.getAttribute("aria-label") || "",
                  className: String(el.className || "").slice(0, 200)
                }))
                .filter((item) => item.text || item.aria)
                .slice(0, 120);
            }
            """
        )
        payload["url"] = page.url
        DEBUG_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass
    return DEBUG_PATH


def run_prefill(package_path: Path, timeout_seconds: int, save_draft_enabled: bool = False):
    package = load_package(package_path)
    write_status({
        "ok": None,
        "stage": "starting",
        "packagePath": str(package_path),
        "message": "正在打开小红书发布页",
    })
    title = package["title"]
    body = package["body"]
    if package["hashtags"]:
        body = f"{body}\n\n{' '.join('#' + tag for tag in package['hashtags'])}"

    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    browser_path = pick_browser_path()

    with sync_playwright() as p:
        context, connected_browser, reused_browser = open_publish_context(p, browser_path)
        page = pick_publish_page(context)
        bring_publish_browser_to_front(page)
        page.goto(PUBLISH_URL, wait_until="domcontentloaded", timeout=120000)
        bring_publish_browser_to_front(page)
        wait_for_publish_page(page, timeout_seconds)
        bring_publish_browser_to_front(page)
        write_status({
            "ok": None,
            "stage": "publish_page",
            "packagePath": str(package_path),
            "message": "已进入小红书发布页，正在上传图片",
            "url": page.url,
        })

        uploaded = upload_images(page, package["image_paths"])
        write_status({
            "ok": None,
            "stage": "images_uploaded" if uploaded else "image_upload_skipped",
            "packagePath": str(package_path),
            "message": "图片上传完成，正在填写标题和正文" if uploaded else "未确认图片上传成功，继续尝试填写标题和正文",
            "uploaded": uploaded,
            "imageCount": len(package["image_paths"]),
            "url": page.url,
        })
        editor_ready = wait_for_editor_ready(page, timeout_seconds)

        title_field = pick_title_field(page)
        body_field = pick_body_field(page)
        if editor_ready and title_field and body_field:
            write_status({
                "ok": None,
                "stage": "filling_title",
                "packagePath": str(package_path),
                "message": "正在填写标题",
                "uploaded": uploaded,
                "url": page.url,
            })
            bring_publish_browser_to_front(page)
            if not type_text_visibly(page, title_field, title, chunk_size=10, delay_ms=95):
                raise RuntimeError("已进入发布页，但标题填写失败。")
            page.wait_for_timeout(500)
            write_status({
                "ok": None,
                "stage": "filling_body",
                "packagePath": str(package_path),
                "message": "正在填写正文",
                "uploaded": uploaded,
                "url": page.url,
            })
            if not type_text_visibly(page, body_field, body, chunk_size=22, delay_ms=85):
                raise RuntimeError("已进入发布页，但正文填写失败。")
            page.wait_for_timeout(900)
        else:
            log("未稳定识别到标题/正文编辑器，正在尝试键盘接管预填。")
            if not keyboard_prefill(page, title, body):
                debug_path = dump_debug_candidates(page)
                raise RuntimeError(f"已进入发布页，但没找到可编辑的标题/正文区域。调试信息已保存：{debug_path}")

        draft_saved = False
        if save_draft_enabled:
            draft_saved = save_draft(page, title, 20)
        write_status({
            "ok": True,
            "stage": "completed",
            "packagePath": str(package_path),
            "message": "小红书发布页预填完成，已停留在发布编辑页",
            "uploaded": uploaded,
            "draftSaved": draft_saved,
            "saveDraftEnabled": save_draft_enabled,
            "imageCount": len(package["image_paths"]),
            "title": title,
            "url": page.url,
        })
        log("小红书发布页预填完成，已停留在发布编辑页。")
        log(f"- 浏览器：{browser_path}")
        log(f"- 标题：{title}")
        log(f"- 正文长度：{len(body)}")
        log(f"- 图片数量：{len(package['image_paths'])}（上传结果：{'成功' if uploaded else '未找到上传控件'}）")
        log(f"- 草稿保存：{'成功' if draft_saved else '未执行'}")
        log(f"- 发布包：{package['json_path']}")
        if save_draft_enabled and draft_saved:
            log("草稿已在草稿列表中验证到同标题记录。浏览器会暂时保留，方便你现场确认。")
        elif save_draft_enabled:
            log("草稿未在草稿列表中验证到同标题记录，浏览器会停留，方便你手动检查或保存。")
        else:
            log("已按配置跳过保存草稿。请在当前发布页检查内容后，手动发布或手动保存。")
        log("专用 Chrome 窗口会保留在桌面；下一次预填会复用该窗口并打开新的发布标签页。")


def main():
    parser = argparse.ArgumentParser(description="打开小红书创作平台，并预填最近生成的发布包。")
    parser.add_argument("--package", dest="package_path", help="指定发布包 JSON 路径")
    parser.add_argument("--timeout", dest="timeout_seconds", type=int, default=300, help="等待登录/进入发布页的秒数")
    parser.add_argument("--save-draft", dest="save_draft", action="store_true", help="预填完成后尝试保存草稿；默认不保存，停留在发布编辑页")
    args = parser.parse_args()

    package_path = Path(args.package_path) if args.package_path else find_latest_package()
    try:
        run_prefill(package_path, args.timeout_seconds, save_draft_enabled=args.save_draft)
    except Exception as exc:
        write_status({
            "ok": False,
            "stage": "failed",
            "packagePath": str(package_path),
            "message": str(exc),
        })
        raise


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
