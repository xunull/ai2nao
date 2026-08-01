/**
 * The pages shown when we cannot reach a daemon.
 *
 * These matter more than they look. `probeDaemon` distinguishes six reasons a
 * connection can fail precisely so this screen can say something the user can act
 * on. Rendering "daemon not running, run `ai2nao serve`" for all six is the exact
 * dead end the union type was introduced to prevent: the user runs the command,
 * hits the same wall, and has nowhere to go.
 *
 * Deliberately script-free static HTML, loaded from a `data:` URL. The shell's
 * navigation whitelist only admits the probed daemon origin, and a page with no
 * scripts has nothing worth attacking.
 *
 * ## 布局必须在五页之间稳住
 *
 * `main` 用 `width` 而不是 `max-width`,`body` 顶对齐而不是垂直居中 —— 两条都不是
 * 审美选择。在一个 flex 居中的 body 里,`max-width` 会让 `main` 缩到内容宽度,于是
 * 文字左边缘按你撞上哪一种失败在 272 / 423 / 346 / 272 / 386 之间跳(实测,1280 宽
 * 窗口);垂直居中同理,内容高度 319-466 不等,h1 落在 5 个不同的高度上。
 *
 * 这五页是同一个应用同一族失败态,用户可能在几秒内先后看到其中两页(重连一次换一
 * 种错误)。DESIGN.md:「用户切换页面时,应用不应该跳」。
 */

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: flex-start; justify-content: center;
    font: 14px/1.7 -apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", sans-serif;
    background: Canvas; color: CanvasText;
  }
  /* width, 不是 max-width —— 见下方注释。 */
  main { width: 46rem; max-width: 100%; padding: 12vh 2.5rem 3rem; }
  h1 { font-size: 1.35rem; font-weight: 600; margin: 0 0 .6rem; letter-spacing: -0.01em; }
  p  { margin: 0 0 1rem; opacity: .85; }
  pre {
    background: color-mix(in srgb, CanvasText 7%, Canvas);
    padding: .8rem 1rem; border-radius: 8px; overflow-x: auto;
    font: 12.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0 0 1rem;
  }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .35rem 1.2rem; margin: 0 0 1.4rem; }
  dt { opacity: .55; }
  dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .hint { font-size: 12.5px; opacity: .55; }
  .act {
    display: inline-block; margin: .4rem 0 0; padding: .5rem 1.15rem; border-radius: 7px;
    border: 1px solid color-mix(in srgb, CanvasText 24%, Canvas);
    background: color-mix(in srgb, CanvasText 5%, Canvas);
    color: inherit; text-decoration: none; font-weight: 500;
  }
  .act:hover  { background: color-mix(in srgb, CanvasText 11%, Canvas); }
  .act:active { background: color-mix(in srgb, CanvasText 17%, Canvas); }
  .act:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
`;

/**
 * 点「重新连接」时页面导航到的地址。
 *
 * 页面无脚本是刻意的(CSP `default-src 'none'`),但无脚本 ≠ 不能有动作:一个普通
 * `<a href>` 触发 `will-navigate`,主进程在那里 preventDefault 并转成一次
 * `connect()`。整条路径上没有一行页面脚本,CSP 不用放宽。
 *
 * 用 `.invalid`(RFC 2606 保留,永不解析)而不是自定义 scheme:自定义 scheme 在
 * Chromium 里是否触发 will-navigate 取决于注册情况,而 http 一定触发。就算哪天
 * 拦截漏了,这个域名也解析不出去 —— 失败方向是安全的。
 */
export const RETRY_URL = "http://ai2nao.invalid/retry";

/**
 * 动作由 page() 统一追加,而不是各页自己写。
 *
 * 修之前五个页面 clickable=0:它们出现的时机恰好是东西坏掉的时候,而全部内容只是
 * 让用户离开这个窗口、去菜单栏里找一个图标。放在 page() 里意味着以后新增失败态也
 * 不可能忘掉这个动作。措辞和托盘那条菜单一字不差 —— 同一个动作不该有两个名字。
 */
function page(title: string, bodyHtml: string): string {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${title}</title><style>${STYLE}</style></head>
<body><main>${bodyHtml}
<p><a class="act" href="${RETRY_URL}">重新连接</a></p></main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

/**
 * 后台服务起不来。
 *
 * 自动启动接进来之后，这一页的语义变了：它不再是「你忘了启动」，而是「我替你启动
 * 了，但它没起来」。所以文案不能再是「去敲 ai2nao serve」—— 那已经做过了。
 */
export function notRunningPage(): string {
  return page(
    "ai2nao —— 后台服务未能启动",
    `<h1>后台服务没起来</h1>
     <p>ai2nao 的界面只是一个窗口，数据、定时任务和给 Claude Code / Codex 用的 MCP 端点都在后台服务里。刚才已经尝试自动启动它，但它没有在 30 秒内应答。</p>
     <p>看一眼是什么原因：</p>
     <pre>lsof -ti tcp:8787 -sTCP:LISTEN     # 端口有没有被别的东西占着
tail -50 ~/.ai2nao/*.log             # 如果有日志</pre>
     <p>也可以自己手动起一个，看它到底报什么错：</p>
     <pre>ai2nao serve</pre>
     <p class="hint">起来之后点下面的「重新连接」，菜单栏图标里也有同一条。</p>`
  );
}

/** Someone else owns the port. Name them, or the user has no way to find out. */
export function portTakenPage(args: { host: string; port: number }): string {
  return page(
    "ai2nao —— 端口被占用",
    `<h1>${args.port} 端口上有别的程序</h1>
     <p>有服务在 <code>${escapeHtml(args.host)}:${args.port}</code> 上监听，但它不是 ai2nao。</p>
     <p>看看是谁：</p>
     <pre>lsof -ti tcp:${args.port} -sTCP:LISTEN</pre>
     <p>要么把它停掉，要么让 ai2nao 换一个端口：</p>
     <pre>ai2nao serve --port 8788</pre>`
  );
}

/**
 * It IS ai2nao, but the HTTP contract does not line up. `theirs: 0` means the
 * daemon predates `/api/health` entirely.
 */
export function incompatiblePage(args: { theirs: number; ours: number }): string {
  const old = args.theirs < args.ours;
  return page(
    "ai2nao —— 版本不兼容",
    `<h1>daemon 和这个壳对不上</h1>
     <dl>
       <dt>daemon 的接口版本</dt><dd>${args.theirs === 0 ? "0（太旧，没有 /api/health）" : args.theirs}</dd>
       <dt>这个壳需要</dt><dd>${args.ours}</dd>
     </dl>
     <p>${old ? "升级 daemon：" : "这个壳比 daemon 旧，升级壳，或者降回匹配的 daemon："}</p>
     <pre>${old ? "npm i -g ai2nao@latest" : "下载新版本的桌面壳"}</pre>
     <p class="hint">发布版本号不同是正常的 —— 壳和 daemon 各自升级。只有接口真的破了才会出现这一页。</p>`
  );
}

/** Same contract, different database schema. Usually means a migration in flight. */
export function schemaMismatchPage(args: { theirs: number; ours: number }): string {
  return page(
    "ai2nao —— 数据库版本不一致",
    `<h1>数据库 schema 对不上</h1>
     <dl>
       <dt>daemon 的 schema</dt><dd>${args.theirs}</dd>
       <dt>这个壳预期</dt><dd>${args.ours}</dd>
     </dl>
     <p>通常意味着有一边刚升级过，迁移正在跑或者还没跑。等一会儿重连；如果一直这样，把两边升到同一个版本。</p>
     <p class="hint">这时候不自动连上是故意的：正在迁移的库上做读写，拿到的东西不可信。</p>`
  );
}

/** Listening but not answering. "Stuck", not "gone" — a different action. */
export function timeoutPage(args: { host: string; port: number }): string {
  return page(
    "ai2nao —— daemon 没有响应",
    `<h1>daemon 在，但不回话</h1>
     <p><code>${escapeHtml(args.host)}:${args.port}</code> 接受了连接，却没有在超时时间内回应。</p>
     <p>它可能卡在一个很长的任务里，也可能真的挂住了。看一眼进程：</p>
     <pre>lsof -ti tcp:${args.port} -sTCP:LISTEN</pre>
     <p class="hint">这和「没在跑」不是一回事 —— 重新启动一个不会有帮助，端口还被它占着。</p>`
  );
}
