import * as vscode from 'vscode';

export type FilterMode = 'deep' | 'macro';

type WebviewInboundMessage =
    | { command: 'next' }
    | { command: 'prev' }
    | { command: 'changeFilter'; filterMode: FilterMode }
    | { command: 'submitQuery'; text: string }
    | { command: 'ready' };

export type WebviewOutboundMessage =
    | { type: 'startStream'; step: number; total: number; filterMode: FilterMode }
    | { type: 'streamToken'; token: string }
    | { type: 'streamFollowupToken'; token: string }
    | { type: 'followupStart' }
    | { type: 'setFilter'; filterMode: FilterMode }
    | { type: 'error'; message: string };

/** Minimal shape of the proposed editorInsets API. */
interface WebviewEditorInset {
    readonly editor: vscode.TextEditor;
    readonly line: number;
    readonly height: number;
    readonly webview: vscode.Webview;
    readonly onDidDispose: vscode.Event<void>;
    dispose(): void;
}

type WindowWithInsets = typeof vscode.window & {
    createWebviewTextEditorInset?: (
        editor: vscode.TextEditor,
        line: number,
        height: number,
        options?: vscode.WebviewOptions
    ) => WebviewEditorInset;
};

/** Lines of editor space reserved for the floating card inset. */
const INSET_HEIGHT_LINES = 16;

/**
 * Glassmorphic Lumen panel, anchored under the active block via editor insets
 * when the proposed API is available; otherwise a panel webview with the same chrome.
 */
export class WalkthroughProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'walkthroughWindow';

    private _view?: vscode.WebviewView;
    private _inset?: WebviewEditorInset;
    private _activeWebview?: vscode.Webview;
    private _webviewReady = false;
    private _pendingMessages: WebviewOutboundMessage[] = [];
    private _hostMode: 'inset' | 'panel' | 'none' = 'none';
    private _filterMode: FilterMode = 'deep';

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public dispose(): void {
        this._inset?.dispose();
        this._inset = undefined;
        this._activeWebview = undefined;
        this._webviewReady = false;
        this._hostMode = 'none';
    }

    public resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };
        webviewView.webview.html = this._getHtmlForWebview();
        this._wireWebview(webviewView.webview);

        // If we're already in panel-fallback mode, this becomes the live surface.
        if (this._hostMode === 'panel' || this._hostMode === 'none') {
            this._activeWebview = webviewView.webview;
            this._hostMode = 'panel';
        }
    }

    /**
     * Opens the glass panel under the block. Prefers a true editor inset;
     * falls back to the Lumen panel view. Fails loudly if neither can host UI.
     */
    public async openOnBlock(
        editor: vscode.TextEditor,
        range: vscode.Range,
        step: number,
        total: number,
        filterMode: FilterMode
    ): Promise<void> {
        this._filterMode = filterMode;

        const insetOk = await this._tryOpenInset(editor, range);
        if (insetOk) {
            this.beginStream(step, total);
            return;
        }

        const panelOk = await this._tryOpenPanelFallback();
        if (panelOk) {
            void vscode.window.showWarningMessage(
                'Lumen: Editor floating inset unavailable in this host — using the Lumen panel. Enable the editorInsets proposed API for an in-editor glass card.'
            );
            this.beginStream(step, total);
            return;
        }

        this.failLoudly(
            'Could not open the glass walkthrough panel (editor inset and panel view both unavailable).'
        );
    }

    public beginStream(step: number, total: number): void {
        this.requireWebview('Cannot start streaming — walkthrough panel is not open.');
        this.postMessageToUI({
            type: 'startStream',
            step,
            total,
            filterMode: this._filterMode,
        });
    }

    public appendExplanationToken(token: string): void {
        this.requireWebview('Cannot stream explanation — walkthrough panel is not open.');
        this.postMessageToUI({ type: 'streamToken', token });
    }

    public beginFollowup(): void {
        this.requireWebview('Cannot answer follow-up — walkthrough panel is not open.');
        this.postMessageToUI({ type: 'followupStart' });
    }

    public appendFollowupToken(token: string): void {
        this.requireWebview('Cannot stream follow-up — walkthrough panel is not open.');
        this.postMessageToUI({ type: 'streamFollowupToken', token });
    }

    public setFilterMode(mode: FilterMode): void {
        this._filterMode = mode;
        if (this._activeWebview) {
            this.postMessageToUI({ type: 'setFilter', filterMode: mode });
        }
    }

    public showError(message: string): void {
        if (this._activeWebview) {
            this.postMessageToUI({ type: 'error', message });
        } else {
            void vscode.window.showErrorMessage(`Lumen: ${message}`);
        }
    }

    public postMessageToUI(message: WebviewOutboundMessage): void {
        if (!this._activeWebview || !this._webviewReady) {
            this._pendingMessages.push(message);
            return;
        }
        void this._activeWebview.postMessage(message);
    }

    private requireWebview(message: string): vscode.Webview {
        if (!this._activeWebview) {
            this.failLoudly(message);
        }
        return this._activeWebview!;
    }

    private failLoudly(message: string, cause?: unknown): never {
        const detail = cause instanceof Error ? ` (${cause.message})` : '';
        void vscode.window.showErrorMessage(`Lumen: ${message}${detail}`);
        throw new Error(`Lumen: ${message}${detail}`);
    }

    private async _tryOpenInset(editor: vscode.TextEditor, range: vscode.Range): Promise<boolean> {
        const createInset = (vscode.window as WindowWithInsets).createWebviewTextEditorInset;
        if (typeof createInset !== 'function') {
            return false;
        }

        this._inset?.dispose();
        this._inset = undefined;
        this._webviewReady = false;
        this._pendingMessages = [];

        // Sit just under the block so the card's arrow reads as pointing at it.
        const line = Math.min(range.end.line, Math.max(0, editor.document.lineCount - 1));

        try {
            const inset = createInset(editor, line, INSET_HEIGHT_LINES, {
                enableScripts: true,
                localResourceRoots: [this._extensionUri],
            });
            this._inset = inset;
            this._hostMode = 'inset';
            this._activeWebview = inset.webview;
            inset.webview.html = this._getHtmlForWebview();
            this._wireWebview(inset.webview);

            inset.onDidDispose(() => {
                if (this._inset === inset) {
                    this._inset = undefined;
                    if (this._hostMode === 'inset') {
                        this._activeWebview = this._view?.webview;
                        this._hostMode = this._view ? 'panel' : 'none';
                        this._webviewReady = false;
                    }
                }
            });

            // Give the iframe a beat to boot before we declare success.
            await new Promise((r) => setTimeout(r, 50));
            return true;
        } catch (err) {
            this._inset = undefined;
            this._activeWebview = undefined;
            this._hostMode = 'none';
            console.warn('Lumen: createWebviewTextEditorInset failed', err);
            return false;
        }
    }

    private async _tryOpenPanelFallback(): Promise<boolean> {
        this._hostMode = 'panel';

        try {
            await vscode.commands.executeCommand(`${WalkthroughProvider.viewType}.focus`);
        } catch {
            // focus command may not exist until the view has resolved once
        }

        // Nudge the panel container open, then focus our view.
        try {
            await vscode.commands.executeCommand('workbench.action.focusPanel');
            await vscode.commands.executeCommand(`${WalkthroughProvider.viewType}.focus`);
        } catch {
            // continue — resolveWebviewView may still wire us up
        }

        const attachPanel = (view: vscode.WebviewView): true => {
            view.show?.(true);
            this._activeWebview = view.webview;
            if (!view.webview.html) {
                view.webview.html = this._getHtmlForWebview();
            }
            return true;
        };

        if (this._view) {
            return attachPanel(this._view);
        }

        // View not resolved yet — wait briefly for the provider to be asked.
        for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 50));
            const view = this._view;
            if (view) {
                return attachPanel(view);
            }
        }

        return false;
    }

    private _wireWebview(webview: vscode.Webview): void {
        webview.onDidReceiveMessage((data: WebviewInboundMessage) => {
            if (data.command === 'ready') {
                if (webview !== this._activeWebview) {
                    return;
                }
                this._webviewReady = true;
                const queued = this._pendingMessages;
                this._pendingMessages = [];
                for (const msg of queued) {
                    void webview.postMessage(msg);
                }
                return;
            }

            switch (data.command) {
                case 'next':
                    void vscode.commands.executeCommand('walkthrough.next');
                    break;
                case 'prev':
                    void vscode.commands.executeCommand('walkthrough.prev');
                    break;
                case 'changeFilter':
                    void vscode.commands.executeCommand('walkthrough.setFilter', data.filterMode);
                    break;
                case 'submitQuery':
                    void vscode.commands.executeCommand('walkthrough.askFollowUp', data.text);
                    break;
            }
        });
    }

    private _getHtmlForWebview(): string {
        // Glass is "read as glass" — webviews usually can't backdrop-blur the editor behind them.
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
  <style>
    :root {
      --lumen-radius: 14px;
      --lumen-blue: rgba(90, 170, 255, 0.85);
      --lumen-blue-soft: rgba(90, 170, 255, 0.35);
      --lumen-highlight: rgba(255, 255, 255, 0.55);
      --lumen-edge: rgba(255, 255, 255, 0.14);
      --lumen-shadow: 0 18px 48px rgba(0, 0, 0, 0.38);
      --transition: 160ms cubic-bezier(0.4, 0, 0.2, 1);
    }

    * { box-sizing: border-box; }

    html, body {
      margin: 0;
      padding: 0;
      background: transparent;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      font-size: 12.5px;
    }

    body {
      padding: 10px 12px 12px;
      overflow: hidden;
    }

    .float-root {
      position: relative;
      max-width: 520px;
      margin: 0; /* left-anchored under the block, not centered */
      filter: drop-shadow(0 14px 28px rgba(0, 0, 0, 0.32));
      animation: rise 280ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }

    @keyframes rise {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Anchor arrow — left-biased, points up at the illuminated block */
    .anchor {
      position: relative;
      width: 18px;
      height: 10px;
      margin: 0 0 -1px 22px;
      z-index: 2;
    }

    .anchor::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      width: 14px;
      height: 14px;
      transform: rotate(45deg);
      border-radius: 3px 0 0 0;
      /* Match glass fill + catch light on the top-left edge of the diamond */
      background:
        linear-gradient(135deg, var(--lumen-highlight) 0%, transparent 42%),
        linear-gradient(180deg,
          color-mix(in srgb, var(--vscode-editor-background) 42%, transparent),
          color-mix(in srgb, var(--vscode-sideBar-background) 70%, rgba(20, 28, 40, 0.55))
        );
      border-top: 1px solid var(--lumen-highlight);
      border-left: 1px solid var(--lumen-blue-soft);
      box-shadow: -1px -1px 0 rgba(90, 170, 255, 0.15);
    }

    .glass {
      position: relative;
      border-radius: var(--lumen-radius);
      padding: 14px 14px 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      /* Dual-layer fill + gradient border; top edge reads as a light catch */
      background:
        linear-gradient(
          165deg,
          color-mix(in srgb, var(--vscode-editor-background) 38%, rgba(255,255,255,0.08)) 0%,
          color-mix(in srgb, var(--vscode-sideBar-background) 72%, rgba(12, 18, 28, 0.55)) 100%
        );
      border: 1px solid transparent;
      background-image:
        linear-gradient(
          165deg,
          color-mix(in srgb, var(--vscode-editor-background) 38%, rgba(255,255,255,0.08)) 0%,
          color-mix(in srgb, var(--vscode-sideBar-background) 72%, rgba(12, 18, 28, 0.55)) 100%
        );
      background-origin: border-box;
      background-clip: padding-box, border-box;
      box-shadow:
        var(--lumen-shadow),
        inset 0 1px 0 rgba(255, 255, 255, 0.18),
        inset 0 -1px 0 rgba(0, 0, 0, 0.15);
      backdrop-filter: blur(18px) saturate(1.25);
      -webkit-backdrop-filter: blur(18px) saturate(1.25);
    }

    .glass::before {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: inherit;
      pointer-events: none;
      background: linear-gradient(
        180deg,
        rgba(255, 255, 255, 0.1) 0%,
        transparent 28%
      );
    }

    .filter-container {
      display: flex;
      padding: 3px;
      border-radius: 8px;
      background: color-mix(in srgb, var(--vscode-editor-background) 55%, transparent);
      border: 1px solid var(--lumen-edge);
    }

    .filter-btn {
      flex: 1;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      padding: 5px 6px;
      border: none;
      border-radius: 6px;
      font-weight: 550;
      cursor: pointer;
      transition: background var(--transition), color var(--transition);
    }

    .filter-btn.active {
      background: color-mix(in srgb, var(--vscode-button-background) 88%, white);
      color: var(--vscode-button-foreground);
      box-shadow: 0 0 0 1px var(--lumen-blue-soft);
    }

    .header-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .ai-badge {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 3px 9px;
      border-radius: 999px;
      color: #eaf4ff;
      background: linear-gradient(135deg, rgba(40, 120, 220, 0.95), rgba(70, 170, 255, 0.75));
      box-shadow: 0 0 12px rgba(80, 160, 255, 0.25);
    }

    .progress-text {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
    }

    .explanation-box {
      font-size: 13px;
      line-height: 1.55;
      min-height: 52px;
      max-height: 120px;
      overflow: auto;
      word-break: break-word;
      white-space: pre-wrap;
    }

    .followup-box {
      display: none;
      font-size: 12.5px;
      line-height: 1.5;
      border-top: 1px dashed var(--lumen-edge);
      padding-top: 10px;
      word-break: break-word;
      white-space: pre-wrap;
    }

    .followup-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--lumen-blue);
    }

    .thinking {
      color: var(--vscode-descriptionForeground);
      animation: pulse 1.5s infinite ease-in-out;
    }

    @keyframes pulse {
      0%, 100% { opacity: 0.45; }
      50% { opacity: 1; }
    }

    .nav-row { display: flex; gap: 8px; }

    button.nav-action {
      flex: 1;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 7px 12px;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 550;
      font-size: 12px;
      transition: background var(--transition), transform var(--transition);
    }

    button.nav-action:hover { background: var(--vscode-button-hoverBackground); }
    button.nav-action:active { transform: translateY(1px); }
    button.nav-action:disabled { opacity: 0.35; cursor: not-allowed; }

    .input-container {
      display: flex;
      gap: 6px;
      border-top: 1px solid var(--lumen-edge);
      padding-top: 10px;
    }

    input[type="text"] {
      flex: 1;
      background: color-mix(in srgb, var(--vscode-input-background) 80%, transparent);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--lumen-edge);
      padding: 7px 10px;
      border-radius: 8px;
      font-size: 12px;
    }

    input:focus {
      outline: none;
      border-color: var(--lumen-blue-soft);
      box-shadow: 0 0 0 1px var(--lumen-blue-soft);
    }

    .btn-send {
      background: color-mix(in srgb, var(--vscode-button-secondaryBackground, #3a3a3c) 90%, transparent);
      color: var(--vscode-button-secondaryForeground, #fff);
      border: 1px solid var(--lumen-edge);
      padding: 7px 12px;
      border-radius: 8px;
      font-size: 12px;
      cursor: pointer;
    }

    .btn-send:hover {
      background: var(--vscode-button-secondaryHoverBackground, #4a4a4c);
    }

    .error-text { color: var(--vscode-errorForeground, #f44747); }
  </style>
</head>
<body>
  <div class="float-root">
    <div class="anchor" aria-hidden="true"></div>
    <div class="glass" role="dialog" aria-label="Lumen walkthrough">
      <div class="filter-container">
        <button id="f-deep" class="filter-btn active" onclick="setFilterMode('deep')">Deep Scan</button>
        <button id="f-macro" class="filter-btn" onclick="setFilterMode('macro')">Macro Scan</button>
      </div>

      <div class="header-meta">
        <span class="ai-badge">✦ Lumen</span>
        <span class="progress-text" id="step-counter">Step 0 / 0</span>
      </div>

      <div class="explanation-box" id="explanation-text">
        <span class="thinking">Run "Lumen: Illuminate Active File" to begin.</span>
      </div>

      <div class="followup-box" id="followup-window">
        <div class="followup-label">Follow-up</div>
        <div id="followup-text" style="margin-top:4px;"></div>
      </div>

      <div class="nav-row">
        <button id="btn-prev" class="nav-action" onclick="sendAction('prev')" disabled>Back</button>
        <button id="btn-next" class="nav-action" onclick="sendAction('next')" disabled>Next</button>
      </div>

      <div class="input-container">
        <input type="text" id="chat-query" placeholder="Ask Lumen about this block…" onkeydown="handleKey(event)" disabled />
        <button id="btn-ask" class="btn-send" onclick="submitQuery()" disabled>Ask</button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const textContainer = document.getElementById('explanation-text');
    const followupWindow = document.getElementById('followup-window');
    const followupText = document.getElementById('followup-text');
    const counter = document.getElementById('step-counter');
    const btnPrev = document.getElementById('btn-prev');
    const btnNext = document.getElementById('btn-next');
    const chatInput = document.getElementById('chat-query');
    const btnAsk = document.getElementById('btn-ask');

    function sendAction(action) {
      vscode.postMessage({ command: action });
    }

    function setFilterMode(mode) {
      document.getElementById('f-deep').classList.toggle('active', mode === 'deep');
      document.getElementById('f-macro').classList.toggle('active', mode === 'macro');
      vscode.postMessage({ command: 'changeFilter', filterMode: mode });
    }

    function handleKey(e) {
      if (e.key === 'Enter') submitQuery();
    }

    function submitQuery() {
      const text = chatInput.value.trim();
      if (!text) return;
      followupWindow.style.display = 'block';
      followupText.innerHTML = '<span class="thinking">Lumen processing question…</span>';
      vscode.postMessage({ command: 'submitQuery', text });
      chatInput.value = '';
    }

    function applyFilter(mode) {
      document.getElementById('f-deep').classList.toggle('active', mode === 'deep');
      document.getElementById('f-macro').classList.toggle('active', mode === 'macro');
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.type === 'setFilter') {
        applyFilter(msg.filterMode);
      }

      if (msg.type === 'startStream') {
        textContainer.innerHTML = '<span class="thinking">Illuminating code block…</span>';
        followupWindow.style.display = 'none';
        followupText.innerHTML = '';
        counter.innerText = 'Step ' + msg.step + ' / ' + msg.total;
        btnPrev.disabled = msg.step === 1;
        btnNext.disabled = msg.step === msg.total;
        chatInput.disabled = false;
        btnAsk.disabled = false;
        if (msg.filterMode) applyFilter(msg.filterMode);
      }

      if (msg.type === 'streamToken') {
        if (textContainer.querySelector('.thinking') || textContainer.querySelector('.error-text')) {
          textContainer.textContent = '';
        }
        textContainer.textContent += msg.token;
      }

      if (msg.type === 'followupStart') {
        followupWindow.style.display = 'block';
        followupText.innerHTML = '<span class="thinking">Lumen processing question…</span>';
      }

      if (msg.type === 'streamFollowupToken') {
        if (followupText.querySelector('.thinking')) {
          followupText.textContent = '';
        }
        followupText.textContent += msg.token;
      }

      if (msg.type === 'error') {
        textContainer.innerHTML = '';
        const el = document.createElement('span');
        el.className = 'error-text';
        el.textContent = msg.message;
        textContainer.appendChild(el);
      }
    });

    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
    }
}
