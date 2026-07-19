(() => {
  if (window.__notionQuickNoteInstalled) return;
  window.__notionQuickNoteInstalled = true;

  let host;
  let state = { page: null, settings: null };

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== "TOGGLE_QUICK_NOTE") return;
    state.page = message.page;
    if (host?.isConnected) {
      close();
    } else {
      open();
    }
  });

  async function open() {
    host = document.createElement("div");
    host.id = "notion-quick-note-root";
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:24px;bottom:24px";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = template();
    document.documentElement.append(host);

    state.settings = await chrome.runtime.sendMessage({ type: "GET_QUICK_SETTINGS" });
    wire(root);
    hydrate(root);
    requestAnimationFrame(() => root.querySelector(".card").classList.add("visible"));
  }

  function close() {
    if (!host) return;
    const card = host.shadowRoot.querySelector(".card");
    card.classList.remove("visible");
    setTimeout(() => host?.remove(), 170);
  }

  function hydrate(root) {
    const { page, settings } = state;
    root.querySelector(".destination-name").textContent = settings.destinationName || "Notion Inbox";
    root.querySelector(".source-title").textContent = page.title || new URL(page.url).hostname;
    root.querySelector("#include-source").checked = settings.includeSource !== false;
    root.querySelector(".setup").hidden = settings.configured;

    if (page.selection) {
      root.querySelector(".selection").hidden = false;
      root.querySelector(".selection-text").textContent = page.selection;
    }

    const draftKey = `draft:${page.url}`;
    chrome.storage.session.get(draftKey).then((value) => {
      root.querySelector("textarea").value = value[draftKey] || "";
      updateCount(root);
      root.querySelector("textarea").focus();
    });
  }

  function wire(root) {
    const textarea = root.querySelector("textarea");
    const save = root.querySelector(".save");
    const draftKey = `draft:${state.page.url}`;

    root.querySelector(".close").addEventListener("click", close);
    root.querySelector(".settings").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_SETTINGS" });
    });

    textarea.addEventListener("input", () => {
      updateCount(root);
      chrome.storage.session.set({ [draftKey]: textarea.value });
    });

    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        save.click();
      }
    });

    save.addEventListener("click", async () => {
      if (!state.settings.configured) {
        chrome.runtime.sendMessage({ type: "OPEN_SETTINGS" });
        return;
      }

      const text = textarea.value.trim();
      if (!text && !state.page.selection) {
        showStatus(root, "Add a thought first", "error");
        textarea.focus();
        return;
      }

      save.disabled = true;
      save.innerHTML = '<span class="spinner"></span> Saving';
      showStatus(root, "Saving to Notion…");

      const response = await chrome.runtime.sendMessage({
        type: "SAVE_CAPTURE",
        capture: {
          text,
          selection: state.page.selection,
          pageTitle: state.page.title,
          url: state.page.url,
          includeSource: root.querySelector("#include-source").checked
        }
      });

      if (response.ok) {
        await chrome.storage.session.remove(draftKey);
        showStatus(root, "Saved to Notion", "success");
        save.innerHTML = "Saved ✓";
        setTimeout(close, 900);
      } else {
        showStatus(root, response.error || "Couldn't save", "error");
        save.disabled = false;
        save.innerHTML = "Save note <kbd>⌘↵</kbd>";
      }
    });
  }

  function updateCount(root) {
    root.querySelector(".count").textContent = `${root.querySelector("textarea").value.length}`;
  }

  function showStatus(root, text, tone = "") {
    const status = root.querySelector(".status");
    status.textContent = text;
    status.dataset.tone = tone;
  }

  function template() {
    return `
      <style>${styles()}</style>
      <section class="card" role="dialog" aria-label="Notion Quick Note">
        <header>
          <div class="brand"><span class="mark">N</span><span>Quick Note</span></div>
          <div class="actions">
            <button class="icon settings" aria-label="Open settings">•••</button>
            <button class="icon close" aria-label="Close">×</button>
          </div>
        </header>
        <div class="destination"><span class="pulse"></span> Saving to <strong class="destination-name">Notion Inbox</strong></div>
        <div class="setup" hidden>
          <strong>One minute of setup</strong>
          <span>Connect Notion and choose where notes land.</span>
        </div>
        <div class="selection" hidden>
          <div class="selection-label">Selected text</div>
          <blockquote class="selection-text"></blockquote>
        </div>
        <textarea maxlength="8000" aria-label="Your note" placeholder="What's on your mind?"></textarea>
        <div class="meta-row">
          <label class="source">
            <input id="include-source" type="checkbox" checked>
            <span class="check">✓</span>
            <span class="source-copy"><small>Attach this page</small><b class="source-title"></b></span>
          </label>
          <span class="count">0</span>
        </div>
        <footer>
          <span class="status">Drafts save automatically</span>
          <button class="save">Save note <kbd>⌘↵</kbd></button>
        </footer>
      </section>`;
  }

  function styles() {
    return `
      :host{--ink:#1d1d1f;--muted:#6e6e73;--line:rgba(20,20,20,.09);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;color:var(--ink)}
      *{box-sizing:border-box}.card{width:min(370px,calc(100vw - 32px));max-height:min(620px,calc(100vh - 32px));overflow:auto;background:rgba(250,250,249,.94);border:1px solid rgba(255,255,255,.8);border-radius:22px;box-shadow:0 28px 80px rgba(0,0,0,.22),0 8px 24px rgba(0,0,0,.12);backdrop-filter:blur(28px) saturate(1.35);-webkit-backdrop-filter:blur(28px) saturate(1.35);transform:translateY(12px) scale(.97);opacity:0;transition:transform .18s cubic-bezier(.2,.8,.2,1),opacity .15s ease;overflow:hidden}.card.visible{transform:none;opacity:1}
      header{height:58px;display:flex;align-items:center;justify-content:space-between;padding:0 14px 0 18px;border-bottom:1px solid var(--line)}.brand{display:flex;align-items:center;gap:9px;font-size:14px;font-weight:650;letter-spacing:-.01em}.mark{width:25px;height:25px;display:grid;place-items:center;background:#1d1d1f;color:white;border-radius:7px;font:700 14px Georgia,serif}.actions{display:flex;gap:3px}.icon{border:0;background:transparent;color:#6e6e73;width:31px;height:31px;border-radius:50%;font:600 18px/1 inherit;cursor:pointer}.icon:hover{background:rgba(0,0,0,.06);color:#1d1d1f}.settings{font-size:13px;letter-spacing:1px}
      .destination{margin:15px 18px 0;color:var(--muted);font-size:12px;display:flex;align-items:center;gap:6px}.destination strong{color:#3a3a3c;font-weight:600}.pulse{width:6px;height:6px;border-radius:50%;background:#34c759;box-shadow:0 0 0 3px rgba(52,199,89,.12)}
      .setup{margin:12px 18px 0;padding:12px 14px;border-radius:12px;background:#fff4cf;color:#5e4900;display:flex;flex-direction:column;gap:2px;font-size:12px}.setup strong{font-size:13px}.setup[hidden]{display:none}
      .selection{margin:14px 18px 0;padding:11px 13px;background:rgba(0,0,0,.035);border-radius:12px;border-left:3px solid #b6b6ba}.selection[hidden]{display:none}.selection-label{text-transform:uppercase;letter-spacing:.08em;font-size:9px;font-weight:700;color:#86868b;margin-bottom:5px}.selection blockquote{margin:0;color:#48484a;font:12px/1.45 Georgia,serif;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
      textarea{display:block;width:100%;min-height:172px;max-height:330px;resize:vertical;border:0;outline:0;background:transparent;padding:17px 18px 12px;color:var(--ink);font:16px/1.52 inherit;letter-spacing:-.012em}textarea::placeholder{color:#aeaeb2}
      .meta-row{display:flex;align-items:center;justify-content:space-between;padding:0 18px 15px}.source{display:flex;align-items:center;gap:9px;max-width:285px;cursor:pointer}.source input{position:absolute;opacity:0}.check{display:grid;place-items:center;flex:none;width:18px;height:18px;border-radius:6px;border:1px solid #c7c7cc;color:transparent;font-size:11px}.source input:checked+.check{background:#1d1d1f;border-color:#1d1d1f;color:white}.source-copy{min-width:0;display:flex;flex-direction:column}.source-copy small{font-size:10px;color:#8e8e93}.source-copy b{font-size:11px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#48484a}.count{font-size:10px;color:#aeaeb2}
      footer{min-height:62px;border-top:1px solid var(--line);padding:11px 12px 11px 18px;display:flex;align-items:center;justify-content:space-between;gap:10px}.status{font-size:10px;color:#8e8e93;max-width:150px}.status[data-tone=success]{color:#248a3d}.status[data-tone=error]{color:#d70015}.save{border:0;border-radius:11px;background:#1d1d1f;color:white;padding:10px 13px;font:600 12px inherit;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.16)}.save:hover{background:#353538}.save:disabled{opacity:.7;cursor:default}.save kbd{font:10px inherit;color:#aeb0b4;margin-left:6px}.spinner{display:inline-block;width:10px;height:10px;border:1.5px solid rgba(255,255,255,.35);border-top-color:white;border-radius:50%;animation:spin .7s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
      @media (prefers-color-scheme:dark){:host{--ink:#f5f5f7;--muted:#98989d;--line:rgba(255,255,255,.09)}.card{background:rgba(35,35,37,.94);border-color:rgba(255,255,255,.13)}.mark{background:#f5f5f7;color:#1d1d1f}.icon:hover{background:rgba(255,255,255,.08);color:white}.destination strong,.source-copy b{color:#d1d1d6}.setup{background:#443a16;color:#ffe88c}.selection{background:rgba(255,255,255,.05)}.selection blockquote{color:#c7c7cc}.save{background:#f5f5f7;color:#1d1d1f}.save:hover{background:white}.save kbd{color:#636366}.source input:checked+.check{background:#f5f5f7;border-color:#f5f5f7;color:#1d1d1f}}
      @media (prefers-reduced-motion:reduce){.card{transition:none}.spinner{animation:none}}
    `;
  }
})();
