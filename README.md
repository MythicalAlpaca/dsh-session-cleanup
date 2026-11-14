# dsh-session-cleanup

DeepSeek Harness 的**会话记录清理插件**：按保留策略删除持久化的会话日志，并清理引用它们的派生状态，用于回收磁盘空间或落实留存期限。

它同时提供两个入口：模型侧的 `session_cleanup` 工具，以及**会话列表里的「删除会话」功能项**（侧边栏每个会话行的 `...` 菜单最后一项）。两者走同一套策略引擎与同一套安全规则。

会话持久化在设计上是只追加的（`@deepseek-ai/dsh-session-persistence-jsonl` 明确写着「日志在 `root` 下累积，直到外部移除；seam 无删除接口」），本插件就是那个「外部移除者」。

## 交付内容

| 路径 | 作用 |
|---|---|
| [`lib/index.js`](lib/index.js) | Host 半边入口：注册 `session_cleanup` 工具、`sessionCleanup` 服务、Web 删除路由，以及可选的自动保留策略 |
| [`lib/client.js`](lib/client.js) | 浏览器半边：向会话列表的 `...` 菜单注册「删除会话」功能项（纯 JavaScript，无需构建） |
| [`lib/cleanup.js`](lib/cleanup.js) | 清理引擎：枚举记录、挑选候选、校验路径、删除文件与派生状态 |
| [`lib/paths.js`](lib/paths.js) | 复刻 JSONL 后端的目录布局规则（`projectKey` / `encodeSegment` / 反解校验） |
| [`cordis.patch.yml`](cordis.patch.yml) | 组合包补丁：向 profile 树插入 `session-cleanup` 行 |
| [`test/cleanup.smoke.mjs`](test/cleanup.smoke.mjs) | 冒烟测试：覆盖预览/应用、保护规则、路径拒绝、目录剪除、输出 schema、Web 路由与浏览器半边 |

零运行时依赖（只使用 `node:fs` / `node:path` / `node:os` 内建模块），因此安装不需要网络，也不会与 DSH 的模块解析拦截产生耦合。仓库另附 [`LICENSE`](LICENSE)（MIT，作者一栏待填）与 [`.gitignore`](.gitignore)。

## 安装

已安装到 `desktop` profile（见 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles`）。手动安装：

```powershell
# 通过 profile 包管理器（等价于 Web 侧边栏「插件」页的安装）
# 或在 dsh 中调用 plugin_manager 工具：install_bundle(target = 本目录绝对路径)
pnpm add "file:<本目录的绝对路径>"
```

组合包补丁会在 `dsh-base`、`dsh-web-app` 之后、profile 自身的 `cordis.patch.yml` 之前应用，因此仍可按 id 覆盖该行。

## 同步到 git 与发布

本目录就是一个可直接提交的仓库（约 60 KB 源码，零构建、零运行时依赖、无 install 脚本）：

```powershell
git init -b main
git add -A
git commit -m "dsh-session-cleanup：会话记录清理插件（session_cleanup 工具 + 会话列表删除功能项）"
git remote add origin <你的仓库地址>
git push -u origin main
```

别人拿到这个仓库后，三种装法都走插件管理器（spec 必须能定位到本包）：

| 方式 | 安装端 |
|---|---|
| git 仓库 | `install_bundle(target: "github:<user>/<repo>")`，或 `git+https://…` |
| 本地目录 / tgz | `install_bundle(target: "<本目录或 .tgz 的绝对路径>")`（目录会记成 `link:` 依赖） |
| registry | 先按下面的清单改名并发布，再 `install_bundle(target: "@<scope>/<name>")` |

**发布到 registry 前的清单**（三件事，缺一不可）：

1. **改名**：`dsh-session-cleanup` 这个名字在 npmjs 上已被他人占用，需要换成自己的 scope（例如 `@you/dsh-session-cleanup`）。改名时**必须同步改 [`lib/client.js`](lib/client.js) 里 `window.__ModuleLoader__.load({ id })` 的取值**——客户端模块表按包名索引这个 id，两者不一致时浏览器会报 `require(...) missed the module table`。
2. **删 `private: true`**：它只拦 registry 发布；从目录 / git / tgz 安装都不受影响，所以保留它可以防误发布。
3. **升 `version`** 并（scoped 包）加 `publishConfig: { "access": "public" }`；公共发布建议补 `repository` / `author` 字段。

然后 `pnpm pack --pack-destination <临时目录>` 复核包内容（必须含 `lib/client.js`、不含 `test/`）→ `pnpm publish --access public`。私有 registry 用 `pnpm publish --registry=<url>`，并先在 `.npmrc` 里配好 `//<host>/:_authToken=…`；插件管理器安装时会按「调用方指定 → profile 的 pnpm registry 配置 → 配置的回退源」顺序解析。

## 界面侧用法：会话列表的「删除会话」功能项

侧边栏里每个会话行都有一个 `...` 菜单（置顶 / 重命名 / 派生 / 归档）。装好本插件后，菜单末尾会多出一项带垃圾桶图标的**「删除会话」**（`order: 500`，排在归档 `400` 之后、以分隔线分组）。

- **两段确认**：第一次点击只是「上膛」，行文字变成「再次点击确认删除」，8 秒不点会自动解除；再点一次才真正删除。删除成功后菜单关闭、该行从列表消失；失败（例如会话正在运行）时菜单保持打开，并**直接在该行显示原因**，例如「删除会话：未删除：该会话正在运行，当前回合尚未结束」。
- **先由浏览器半边拦一次**：正在面板中打开的那个会话、正在运行的会话、还有待发送消息的会话，在第一次点击时就地给出原因（而不是等第二次点击后才被 Host 拒绝）——分别提示「该会话正在面板中打开，请先切换到其他会话」「该会话正在运行，请等它结束后再删除」「该会话还有待发送的消息，请先处理或清空」。
- **它删的是整条会话记录**：会话日志目录 + 投影缓存 + 工作区置顶/归档引用 + 工作区缓存的会话索引，与工具 `apply` 的行为完全一致。
- **安全规则不打折**：仍然拒绝正在运行的会话、拒绝删除当前发起清理的会话、拒绝目录里出现未知条目的会话，也仍然只删「能反解回该 id 的确切会话目录」。

## 它是怎么接进去的（插件生命周期）

| 环节 | 机制 | 卸载时 |
|---|---|---|
| 声明浏览器半边 | `package.json`：`dsh.client = { "platform": "web" }` + `exports["./client"] = "./lib/client.js"`；Host 的 `dsh-client-modules` 把该文件作为插件模块服务于 `/plugins/<包名>/…`，并写进 `window.__DSH_BOOT__` | Loader 行被移除后，模块从启动图与模块表中一并消失 |
| 注册功能项 | 浏览器半边的 `ctx.slots.register({ name: "sidebar.workspaces.session.menu.item", id: "session-cleanup", order: 500, locale: "session-cleanup" }, 组件)`（先 `ctx.slots.inject(槽位, …)` 等槽位出现） | 注册绑在本插件 fiber 上，随插件卸载自动注销 |
| 执行删除 | 浏览器半边 `POST api/session-cleanup.delete`（文档相对路径）→ Host 半边用 `ctx.connection.fetch.register({ path: "/api/session-cleanup.delete", methods: ["POST"], requestBody: "buffered" })` 注册的路由 → 复用 `runCleanup` | 路由注册同样落在本插件 fiber 上，随插件卸载注销，`/api` 前缀仍由 Connection 服务做 Host/Origin 与浏览器鉴权 |
| 文案 | 浏览器半边 `ctx.locale.register("session-cleanup", { zh, en })` | 字典随插件注销 |

请求 / 响应契约（浏览器半边就是照这个调的）：

```jsonc
// POST /api/session-cleanup.delete
{ "sessionIds": ["session-…"] }
// 200 已删除 / 409 未删除（受保护、目录被拒等）/ 400 请求不合法 / 500 执行异常
{ "ok": true, "mode": "apply", "deleted": 1, "freedBytes": 170,
  "message": "已删除 1 条会话记录，释放 170 B。",
  "targets": [{ "id": "session-…", "deleted": true, "bytes": 170, "files": 1 }],
  "protected": [], "notes": [] }
```

> 只把浏览器半边接进来是不够的：Host 半边必须也加载了新代码。已加载过的插件模块会被 Node 的 ESM 缓存复用（本插件目录不在 HMR 模块根内），因此**改过源码后需要重启 Harness**，重启后再刷新页面即可看到功能项并正常使用。

## 模型侧用法：`session_cleanup` 工具

**默认只预览，不删除**；只有显式传 `mode: "apply"` 才会真正删除，且删除不可撤销。

工具自身的**说明、每个参数的说明、以及执行结果的渲染文本，全部是中文**（`mode` / `sessionIds` / `allowForeignEntries` 等**取值**仍是英文标识符，不会翻译）。在对话里直接说需求即可，例如「保留最近 20 个会话，把更早的清理掉」，模型会先调 `preview` 给你过目，再调 `apply`。

### 三步使用

1. **看**：`{"mode":"preview","keepLatest":20}` —— 列出会被删除的候选、各自大小与可回收总量，什么都不动。
2. **确认**：对照返回的 `targets` 与 `protected`（受保护原因写着「该会话正在运行，当前回合尚未结束」或「发起本次调用的会话」）核对无误。
3. **删**：把同样的选择器加上 `{"mode":"apply"}` —— 删除日志目录，并清理引用它的投影缓存与工作区索引。

### 调用示例

```
session_cleanup { "mode": "preview", "keepLatest": 20 }            # 保留最新 20 条，列出其余候选
session_cleanup { "mode": "apply",   "keepLatest": 20 }            # 真正删除
session_cleanup { "mode": "apply",   "olderThanDays": 30 }         # 删除 30 天前创建的记录
session_cleanup { "mode": "apply",   "sessionIds": ["session-…"] } # 只删除指定 id
session_cleanup { "mode": "apply",   "keepLatest": 10, "limit": 5 }# 每次最多删 5 条
```

### 返回长什么样

```
会话记录清理（执行）— sessions 根：C:\Users\<你>\.dsh\sessions
扫描 12 条记录；本次处理 3 条；已删除 3 条；释放 4.6 MB。
- session-7e4b9991-…（2026-08-02 14:31）：已删除 1.5 MB，2 个文件；已移除被清空的项目目录；同时清理了 投影缓存行、工作区会话索引
- session-e7440fcc-…（2026-08-19 09:07）：已删除 1.6 MB，2 个文件
- session-91b0c4a2-…（2026-08-25 17:52）：跳过 —— 拒绝删除：会话目录包含未知条目（notes.txt）；如确认可删请传 allowForeignEntries 覆盖
受保护 2 条：session-1a252df3-… —— 发起本次调用的会话；session-2b63e630-… —— 该会话正在运行，当前回合尚未结束
说明：1 条未能删除，详见每条记录的 error 字段
```

| 参数 | 默认 | 含义 |
|---|---|---|
| `mode` | `preview` | `preview` 只列出候选与可回收字节数；`apply` 执行删除 |
| `sessionIds` | — | 精确指定要删除的会话 id（仍受保护规则约束） |
| `keepLatest` | — | **保留集**：最新 N 条永不被删；按整个语料计数（正在运行的会话也占名额），先于年龄筛选生效 |
| `olderThanDays` | — | 只选择创建时间早于该天数的记录 |
| `limit` | 50 | 单次调用最多删除的条数（上限 500）；候选超限时**优先删除最久远的记录**，其余留待下次 |
| `allowForeignEntries` | `false` | 允许删除含未知文件的会话目录（默认拒绝） |
| `pruneEmptyProjects` | `true` | 删除后被清空的项目目录一并移除（不会删除 sessions 根目录） |
| `pruneWorkspaceIndex` | `true` | 同步丢弃工作区注册表缓存的会话索引项，使运行中的侧边栏立即不再显示 |

必须给出 `sessionIds`、`keepLatest`、`olderThanDays` 三者之一，否则不会选中任何目标。其中 `sessionIds` 是**显式选择**，优先级最高：同时给出时 `keepLatest` 与 `olderThanDays` 会被忽略（保护规则仍然生效）。

## 安全模型

1. **正在运行的会话永不删除**：判据是**这个会话是否真的在跑**，而不是它是否还在宿主内存里——
   - `ctx.agents.get(id).status !== 'idle'` → 拒绝，原因「该会话正在运行，当前回合尚未结束」；
   - 没有驱动但仍是 `live` 的会话，回退读它自己的日志尾部：最新的 `turn/start` 之后没有 `turn/end` → 同样拒绝；
   - 调用工具的那个会话（`currentSessionId`）→ 永远拒绝。
   此外，**图形界面正在显示的那个会话**由浏览器半边就地拦下（`sessions.retainInfo(id).retainedBy.mainView > 0`），因为它就在用户眼前。

   > 为什么不能拿「是否 live」当判据：`ctx.sessions` 是**内存会话存储**，桌面客户端只要持有某个会话的一代引用（也就是在界面里打开过），它就一直是 live。用它做判据会让侧边栏的删除功能对几乎每个会话都失败（实测：语料共 4 条，4 条全被拒，其中 3 条判为「活跃会话」）；而 JSONL 后端是「追加时开、写完关」，空闲会话的日志文件并没有被占用（实测可对每个文件独占打开），删得掉。所以「空闲 live」不该被保护。
2. **路径可证明才删除**：只删除形如 `<sessions 根>/--<规范化 cwd>--/<编码 id>` 的目录，且目录名必须能反解回该会话 id；伪造的 target 会被 `isSessionDirectory` 拒绝。若 cwd 规范化不匹配（目录被移动、项目键被截断），会退回全根扫描，仅在**恰好命中一个**时才认为可删。
3. **目录内容白名单（fail-closed）**：会话目录内只允许 `session.jsonl` / `session.vN.jsonl`（含 `.zstd`）与 POSIX 的 `session.lock`；出现任何其他条目——包括未知文件、子目录、符号链接，以及后端写入新日志时短暂存在的 `<日志名>.<hex>.tmp` 中间文件——即拒绝删除，除非显式 `allowForeignEntries`。因此在极少数与写入竞争的瞬间，工具会宁可拒绝而不会误删。
4. **先删数据、后清引用**：日志文件删除成功后，才清理投影缓存、工作区置顶/归档集合与工作区索引。

## 删除范围

| 对象 | 处理 |
|---|---|
| 会话日志目录 `<root>/--cwd--/<id>/` | 递归删除 |
| 投影缓存 `storages/session_projcache/sessions/<id>.json` | 经 `ctx.storageDomain` 的 `session_projcache` 域删除（保持内存与介质一致），并兜底清理残留文件 |
| 工作区 `pinnedSessionIds` / `archivedSessionIds` | 调用 `unpinSession` / `unarchiveSession` 移除引用（二者对已不存在的 id 是幂等的） |
| 工作区注册表缓存的 `sessionPaths` / `headers` | 丢弃该 id 的索引项，使运行中的 GUI 立即停显 |
| SQLite FTS 全文索引 | **不动**。它是可丢弃的派生索引，会在下一次稳定观察时对账掉已删除的来源 |
| `workspace.json` 里持久化的 `sessionIds` 顺序 | **不直接改写**：`sessionIds` 在读取时按索引过滤，下一次变更持久化时剪除无效项（DSH 既有语义） |

删除后，`sessionIds` 中的残留 id 不会让会话重新出现；其日志与缓存都已不存在。

## 可选配置（自动保留策略）

配置写在 profile 的 `cordis.patch.yml` 中（本插件不导出 Config schema，所有键都可选、在代码中校验）：

```yaml
- id: session-cleanup
  config:
    autoCleanup: true        # 启动后自动执行一次保留策略（默认关闭）
    autoKeepLatest: 50       # 保留最新 50 条
    autoOlderThanDays: 90    # 且只删除 90 天前的记录（可选）
    autoDelayMs: 15000       # 延迟 15 秒执行，避开启动高峰
    sessionsRoot: C:\custom\sessions   # 覆盖 sessions 根（默认取已挂载后端解析出的 root）
    storagesRoot: C:\custom\storages   # 覆盖 storages 根
```

`sessionsRoot` 的默认解析顺序：配置值 → `ctx.sessionPersistence.root`（JSONL 后端解析后的真实根）→ `$DSH_HOME/sessions`。

## 跨插件 API：`sessionCleanup` 服务

```js
const plan = await ctx.get('sessionCleanup').plan({ keepLatest: 20 });   // 只挑选
await ctx.get('sessionCleanup').apply(plan.root, plan.targets);          // 执行
const value = await ctx.get('sessionCleanup').run({ mode: 'preview' });  // 一步到位，返回工具同构值
ctx.get('sessionCleanup').root;                                          // 当前生效的 sessions 根
```

## 测试

```powershell
node test/cleanup.smoke.mjs
```

覆盖：预览不删除、`keepLatest` 保留集、正在运行/当前会话保护、**活跃但空闲的会话可删**、无驱动但回合未结束的会话按日志尾部拒绝、`olderThanDays` 筛选、显式 id 删除、含未知文件目录的拒绝与覆盖、空项目目录剪除、伪造 target 拒绝、工具返回值对自身输出 schema 的一致性；以及**浏览器半边**（模块工厂只注册一次、只 `require` 平台种子模块、槽位/id/order/locale/字典正确、两段确认不会提前调用 Host、成功后关闭菜单、前端守卫对「面板中打开 / 正在运行 / 有待发送消息」就地拒绝且不触达 Host、Host 拒绝时把原因显示在行内）与 **Web 路由**（成功删除 / 正在运行的会话 409 且不删 / 未知 id 409 / 缺 id 与坏 JSON 400，以及随插件 fiber 注销后路由消失）。

## 安装与验证记录

- **安装**：`~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 已包含 `dsh-session-cleanup`，依赖以 `link:` 指向本目录；Loader 行 `include:session-cleanup`（patchId `session-cleanup`）处于 `active`。
- **工具可见性**：Host 工具清单中可见 `session_cleanup`，其参数 schema 与本文一致（`mode` 默认 `preview`）。
- **端到端**：在真实 sessions 根下放置一个临时 fixture 会话（合法的 v4 zstd 日志头），`session_cleanup{"mode":"preview","sessionIds":[…]}` 枚举到 5 条记录并把它列为候选（170 B / 1 文件）；`{"mode":"apply",…}` 精确删除该目录，返回 `已删除 1 条；释放 170 B`。4 个真实会话目录、`session_projcache` 的 4 个缓存文件、`workspace.json` 的 4 个 sessionIds 均保持完好。
- **装卸路径**：用 `plugin_manager set_plugin(enabled=false → true)` 实测过一次：停用时 `session_cleanup` 从工具清单消失、启用后重新出现且可正常调用，说明 `ctx.effect` 里的注册注销是干净的（不会残留重复注册）。这次操作在 profile 的 `cordis.patch.yml` 里留下的 `disabled` 覆盖项已按原字节还原（SHA-256 校验一致）。
- **中文说明**：插件管理页显示的包描述已改为中文，且是**实时生效**（每次列表都重新读取 `package.json`）。工具说明、参数说明与结果渲染文本同样是中文，但要等 Harness 重启后才在界面上可见。
- **冒烟测试**：`node test/cleanup.smoke.mjs` 全部通过（含「工具说明必须是中文、API 取值必须保持英文」的断言，以及上面新增的 Web 路由与浏览器半边用例）。
- **缺陷修复：侧边栏删除任意会话都报「活跃会话」**。现象：点删除后返回「未删除：活跃会话」，几乎所有会话都删不掉。定位：让一个**新开的 agent** 调 `session_cleanup{"mode":"preview","keepLatest":100}`（新 agent 的工具集是现组装的，能拿到该工具）——语料共 4 条记录，**4 条全部受保护**（1 条是调用方会话，3 条判为「活跃会话」，其中包含本会话本身）。原因：`ctx.sessionQuery.listSessions()` 的 `live` 只表示**宿主内存里还持有这个会话对象**，而桌面客户端只要在界面里打开过某个会话、就会一直持有它的一代引用；旧规则 `record.live → 拒绝` 因此退化成「凡是能在侧边栏点到的会话都不能删」。反证：直接用独占方式打开这 4 个会话的日志文件全部成功，说明它们并没有被写入方占用，删除在文件系统层面完全可行。修复：判据换成**运行状态**（`ctx.agents.get(id).status`，无驱动时回退读日志尾部的 `turn/start`/`turn/end`），并把「图形界面正在显示的那个会话」交给浏览器半边就地拦截；活跃但空闲的会话现在可以正常删除，结果里会附一条提示。
- **界面功能项（已上线）**：`dsh.client` 声明、`lib/client.js`、槽位 `sidebar.workspaces.session.menu.item`（`id: session-cleanup`、`order: 500`）与 Host 路由 `/api/session-cleanup.delete` 均已按上述契约实现并通过单测；已在真实 GUI 上跑通（菜单里出现「删除会话」，且能走到 Host 并收到 Host 侧的中文拒绝文案）。**注意：`set_plugin` 只重跑 `apply`、不会重新读取源码**（Node ESM 按解析后的 URL 缓存模块；本插件目录也不在 HMR 模块根内），所以每次改源码后都要**重启 Harness** 才生效；而新开的 agent 的工具集是现组装的，可以用一个新 subagent 调 `session_cleanup` 来复核 Host 侧规则。

> 提示：插件源码改动后需要重启 Harness 才会生效——本插件目录不在 HMR 监视的模块根（`hmr.root` 为空）内，而且 Node 的 ESM 模块缓存会按解析后的 URL 复用已加载的模块（实测：停用再启用只会重新执行 `apply`，不会重新读取源码）。

## 已知限制

- **不触碰全文索引**：若部署把 `session-query-sqlite` 的 `openAt` 设为 `startup` 并持久化了索引路径，被删会话仍会出现在索引里，直到下一次搜索触发对账。
- **删除不可恢复**：没有回收站、没有导出；需要先备份时请使用 DSH 的会话日志导出能力。
- **运行中的会话行**：`pruneWorkspaceIndex` 依赖工作区注册表的缓存字段名（`sessionPaths` / `headers`）。若未来该实现改名，仅这一步静默跳过，会话行会在下次重启或索引重建后消失。
- **子会话**：删除父会话不会连带删除其子代理会话记录，它们会作为独立记录留在 `corpus` 中（可再用 `sessionIds` 指定删除）。
- **单进程**：与持久化写入方没有跨进程协调；引擎拒绝**正在运行回合**的会话，因此正常使用下不会与写句柄竞争（JSONL 后端只在追加时打开文件）。但被删的会话若仍被客户端保留（界面里打开过），它的会话对象会继续留在宿主内存中直到被释放：请刷新页面，并且不要再向已删除的会话发送消息。
