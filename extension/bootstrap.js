/* Local Zotero integration. No AI4Paper endpoints or credentials are used. */
var addonRoot, machine, chromeHandle, paneId, selectionHandler;
var selectedPassage = null;
var panels = new Set();
var popout = null;
var bridgeLaunchTime = 0;
const HTML = 'http://www.w3.org/1999/xhtml';
const MACHINE_CONFIG = null;

function node(doc, tag, text, style) {
  let element = doc.createElementNS(HTML, tag);
  if (text !== undefined) element.textContent = text;
  if (style) element.style.cssText = style;
  return element;
}

async function runtimeConfig() {
  return JSON.parse(await IOUtils.readUTF8(machine.runtimeConfig));
}

function launchBridge() {
  if (Date.now() - bridgeLaunchTime < 10000) return;
  bridgeLaunchTime = Date.now();
  let executable = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
  executable.initWithPath(machine.python);
  let process = Cc['@mozilla.org/process/util;1'].createInstance(Ci.nsIProcess);
  process.init(executable);
  let args = [machine.bridge, '--config', machine.runtimeConfig];
  process.runwAsync(args, args.length);
}

async function request(path, payload) {
  let config = await runtimeConfig();
  let options = {
    headers: {'X-Zotero-Chat-Token': config.token},
    timeout: 55000,
    responseType: 'json',
    successCodes: [200, 409]
  };
  if (payload !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(payload);
  }
  let response = await Zotero.HTTP.request(payload === undefined ? 'GET' : 'POST',
    'http://127.0.0.1:23125' + path, options);
  let value = response.response;
  if (typeof value === 'string') value = JSON.parse(value);
  if (response.status !== 200) throw new Error(value.error || '连接失败');
  return value;
}

function activeReader(win) {
  try {
    let main = win.Zotero_Tabs ? win : Zotero.getMainWindow();
    return Zotero.Reader.getByTabID(main.Zotero_Tabs.selectedID);
  } catch (_) { return null; }
}

function readerDocuments(reader) {
  let docs = [], seen = new Set();
  function visit(doc, depth) {
    if (!doc || seen.has(doc) || depth > 4) return;
    seen.add(doc);
    docs.push(doc);
    for (let frame of doc.querySelectorAll('iframe')) {
      try { visit(frame.contentDocument, depth + 1); } catch (_) {}
    }
  }
  try { visit(reader._iframeWindow.document, 0); } catch (_) {}
  try { visit(reader._internalReader._primaryView._iframeWindow.document, 0); } catch (_) {}
  return docs;
}

async function captureContext(win, includePage) {
  let reader = activeReader(win);
  if (!reader) return {imageNote: '当前没有打开 PDF 阅读标签。'};
  let item = Zotero.Items.get(reader.itemID);
  let parent = item?.parentItemID ? Zotero.Items.get(item.parentItemID) : item;
  let result = {title: parent?.getField('title') || item?.getField('title') || '', page: '', selection: ''};
  if (selectedPassage?.itemID === reader.itemID) result.selection = selectedPassage.text;
  let docs = readerDocuments(reader), candidate = null, bestArea = 0;
  for (let doc of docs) {
    try {
      let selection = doc.getSelection()?.toString();
      if (selection?.trim()) result.selection = selection.slice(0, 40000);
      for (let page of doc.querySelectorAll('.page[data-page-number]')) {
        let rect = page.getBoundingClientRect();
        let width = Math.max(0, Math.min(rect.right, doc.defaultView.innerWidth) - Math.max(0, rect.left));
        let height = Math.max(0, Math.min(rect.bottom, doc.defaultView.innerHeight) - Math.max(0, rect.top));
        if (width * height > bestArea) { candidate = page; bestArea = width * height; }
      }
    } catch (_) {}
  }
  if (candidate) {
    result.page = candidate.getAttribute('data-page-number');
    if (includePage) {
      result.pageText = Array.from(candidate.querySelectorAll('.textLayer')).map(el => el.textContent).join('\n').slice(0, 40000);
      let canvas = candidate.querySelector('canvas');
      try {
        if (canvas?.width && canvas?.height) {
          let copy = candidate.ownerDocument.createElementNS(HTML, 'canvas');
          let ratio = Math.min(1, 1800 / Math.max(canvas.width, canvas.height));
          copy.width = Math.round(canvas.width * ratio);
          copy.height = Math.round(canvas.height * ratio);
          copy.getContext('2d').drawImage(canvas, 0, 0, copy.width, copy.height);
          result.image = copy.toDataURL('image/png');
        }
      } catch (_) { result.imageNote = '此页面画布不能导出，当前未附带图片。'; }
    }
  }
  if (includePage && !result.image) result.imageNote = result.imageNote || '未读取到当前页图片；请不要假设已经看到了图。';
  return result;
}

function mount(body, sourceWindow) {
  if (body.querySelector('[data-codex-chat]')) return;
  let doc = body.ownerDocument, win = doc.defaultView;
  let readingWindow = sourceWindow || win;
  let root = node(doc, 'div', undefined, 'box-sizing:border-box;padding:12px;display:flex;flex-direction:column;gap:10px;font:13px/1.55 system-ui,sans-serif;color:var(--fill-primary,#242424);min-width:260px;');
  root.dataset.codexChat = 'true';
  let title = node(doc, 'div', 'Codex 伴读', 'font-size:18px;font-weight:650;');
  let subtitle = node(doc, 'div', '文献阅读 · 当前本机会话', 'font-size:12px;opacity:.72;');
  let status = node(doc, 'div', '正在检查本机连接…', 'padding:9px 10px;background:rgba(22,118,108,.09);border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere;');
  let connect = node(doc, 'button', '连接当前会话');
  connect.type = 'button';
  let disconnect = node(doc, 'button', '断开并释放会话');
  disconnect.type = 'button';
  let reading = node(doc, 'div', '', 'font-size:12px;opacity:.75;overflow-wrap:anywhere;');
  let messages = node(doc, 'div', undefined, 'height:310px;min-height:160px;overflow:auto;border:1px solid #d8dedc;border-radius:8px;padding:10px;background:rgba(128,128,128,.035);');
  let label = node(doc, 'label', undefined, 'display:flex;gap:6px;align-items:center;font-size:12px;');
  let includePage = node(doc, 'input'); includePage.type = 'checkbox'; includePage.checked = true;
  label.append(includePage, node(doc, 'span', '随问题附带当前页文字和图片'));
  let question = node(doc, 'textarea', undefined, 'box-sizing:border-box;resize:vertical;width:100%;min-height:85px;padding:9px;border-radius:8px;font:13px/1.5 system-ui,sans-serif;');
  question.placeholder = '哪里看不懂？例如：请解释当前图的 a 子图。';
  question.setAttribute('aria-label', '向 Codex 提问');
  let send = node(doc, 'button', '发送 · Ctrl+Enter', 'border:0;border-radius:8px;padding:9px;background:#16766c;color:white;font-size:13px;cursor:pointer;');
  send.type = 'button';
  let note = node(doc, 'div', '同一段对话一次只能由一端使用。桌面端占用时，请完全退出 Codex 后在这里连接。', 'font-size:11px;opacity:.7;');
  let controls = node(doc, 'div', undefined, 'display:flex;gap:6px;flex-wrap:wrap;');
  controls.append(connect, disconnect);
  root.append(title, subtitle, status, controls, reading, messages, label, question, send, note);
  body.append(root);
  let lastMessages = '', disposed = false, polling = false, submitting = false;

  function paint(state) {
    status.textContent = state.error || (state.connected ? (state.busy ? '正在回答…' : '已连接：' + state.name) : '会话记录可读，尚未接管。点击“连接当前会话”检查。');
    connect.disabled = state.connected || submitting || state.closing;
    connect.textContent = state.connected ? '已连接同一会话' : '连接当前会话';
    send.disabled = !!state.busy || submitting || state.closing;
    let serialized = JSON.stringify(state.messages);
    if (serialized !== lastMessages) {
      let nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
      messages.replaceChildren();
      for (let entry of state.messages || []) {
        let bubble = node(doc, 'div', undefined, 'margin-bottom:12px;');
        bubble.append(node(doc, 'div', entry.role === 'user' ? '你' : 'Codex', 'font-weight:650;font-size:11px;opacity:.65;margin-bottom:3px;'),
          node(doc, 'div', entry.text, 'white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;'));
        messages.append(bubble);
      }
      if (nearBottom || !lastMessages) messages.scrollTop = messages.scrollHeight;
      lastMessages = serialized;
    }
  }

  async function poll() {
    if (disposed || polling) return;
    if (!body.isConnected) { dispose(); return; }
    polling = true;
    try { paint(await request('/state')); }
    catch (_) { status.textContent = '本机服务尚未就绪。点击“连接当前会话”可重试启动。'; }
    finally { polling = false; }
  }

  connect.addEventListener('click', async () => {
    connect.disabled = true;
    try {
      try { await request('/state'); }
      catch (_) { launchBridge(); await Zotero.Promise.delay(2500); }
      paint(await request('/connect', {}));
    } catch (error) { status.textContent = error.message; }
    finally { connect.disabled = false; }
  });
  disconnect.addEventListener('click', async () => {
    try {
      await request('/shutdown', {});
      status.textContent = '已请求断开并释放会话。稍后可回到 Codex 桌面端继续。';
    } catch (error) { status.textContent = error.message; }
  });

  async function submit() {
    if (!question.value.trim() || submitting || send.disabled) return;
    submitting = true; send.disabled = true;
    status.textContent = '正在读取当前页并提交问题…';
    try {
      if (readingWindow.closed) throw new Error('原阅读窗口已关闭，请从当前 Zotero 阅读窗口重新打开伴读。');
      let context = await captureContext(readingWindow, includePage.checked);
      reading.textContent = context.title ? context.title + ' · PDF 页 ' + (context.page || '未知') + (context.image ? ' · 已附页面图片' : ' · 未附页面图片') : context.imageNote;
      let result = await request('/chat', {question: question.value, context});
      question.value = ''; paint(result);
    } catch (error) { status.textContent = error.message; }
    finally { submitting = false; send.disabled = false; }
  }
  send.addEventListener('click', submit);
  question.addEventListener('keydown', event => {
    if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); submit(); }
  });
  let timer = win.setInterval(poll, 1500);
  function dispose() { if (disposed) return; disposed = true; win.clearInterval(timer); panels.delete(dispose); }
  panels.add(dispose);
  win.addEventListener('unload', dispose, {once: true});
  poll();
}

function showChat(win) {
  if (popout && !popout.closed) { popout.focus(); return; }
  popout = win.openDialog('chrome://zotero-codex-chat/content/chat.xhtml', 'zotero-codex-chat', 'chrome,dialog=no,resizable,width=440,height=760');
  popout.addEventListener('load', () => {
    mount(popout.document.getElementById('codex-chat-root'), win);
    let width = 440;
    let x = Math.min(win.screen.availLeft + win.screen.availWidth - width, win.screenX + win.outerWidth - width);
    popout.moveTo(Math.max(win.screen.availLeft, x), Math.max(win.screen.availTop, win.screenY + 75));
  }, {once: true});
}

function onMainWindowLoad({window: win}) {
  win.document.l10n?.addResourceIds(['zotero-codex-chat.ftl']);
  if (win.document.getElementById('zotero-codex-chat-menu')) return;
  let item = win.document.createXULElement('menuitem');
  item.id = 'zotero-codex-chat-menu'; item.setAttribute('label', 'Codex 伴读（当前会话）');
  item.addEventListener('command', () => showChat(win));
  win.document.getElementById('menu_ToolsPopup')?.append(item);
}

function onMainWindowUnload({window: win}) {
  win.document.getElementById('zotero-codex-chat-menu')?.remove();
}

async function startup({id, rootURI}) {
  addonRoot = rootURI;
  machine = MACHINE_CONFIG;
  if (!machine) throw new Error('请安装 build.py 生成的本机 XPI。');
  let manager = Cc['@mozilla.org/addons/addon-manager-startup;1'].getService(Ci.amIAddonManagerStartup);
  chromeHandle = manager.registerChrome(Services.io.newURI(rootURI + 'manifest.json'), [['content', 'zotero-codex-chat', './']]);
  for (let win of Zotero.getMainWindows()) onMainWindowLoad({window: win});
  paneId = Zotero.ItemPaneManager.registerSection({
    paneID: 'zotero-codex-chat', pluginID: id,
    header: {l10nID: 'zotero-codex-chat-header', icon: rootURI + 'chat.svg'},
    sidenav: {l10nID: 'zotero-codex-chat-header', icon: rootURI + 'chat.svg'},
    onRender: ({body}) => mount(body)
  });
  selectionHandler = ({reader, doc, params, append}) => {
    let button = node(doc, 'button', '问 Codex');
    button.type = 'button';
    button.addEventListener('click', () => {
      selectedPassage = {itemID: reader.itemID, text: params.annotation?.text || ''};
      showChat(Zotero.getMainWindow());
    });
    append(button);
  };
  Zotero.Reader.registerEventListener('renderTextSelectionPopup', selectionHandler, id);
  launchBridge();
}

function shutdown() {
  request('/shutdown', {}).catch(() => {});
  for (let dispose of [...panels]) dispose();
  if (paneId) Zotero.ItemPaneManager.unregisterSection(paneId);
  if (selectionHandler) Zotero.Reader.unregisterEventListener('renderTextSelectionPopup', selectionHandler);
  for (let win of Zotero.getMainWindows()) {
    onMainWindowUnload({window: win});
    win.document.l10n?.removeResourceIds(['zotero-codex-chat.ftl']);
  }
  if (popout && !popout.closed) popout.close();
  chromeHandle?.destruct();
}

function install() {}
function uninstall() {}

