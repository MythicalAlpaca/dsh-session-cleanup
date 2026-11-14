/**
 * dsh-session-cleanup — session-record cleanup for DeepSeek Harness.
 *
 * The persistence seam is append-only by design (its provider states that logs
 * accumulate under `root` until an external actor removes them), so this plugin
 * is that external actor: it enumerates the logical session corpus, applies a
 * retention policy, verifies each session directory, deletes the log artifacts,
 * and then clears the derived state that referenced them.
 *
 * Exposed surface:
 *   - the `session_cleanup` tool (preview by default, deletion behind
 *     `mode: "apply"`),
 *   - the `sessionCleanup` service (`plan` / `apply` / `run` / `root`), so a UI
 *     half, a command, or a scheduled job can reuse the same policy engine, and
 *   - when the Web transport is mounted, the browser half's `POST
 *     /api/session-cleanup.delete` route, which drives the `删除会话` row that
 *     `lib/client.js` adds to each Session's `...` menu in the sidebar.
 *
 * Both the tool and the route funnel through {@link runCleanup}, so the policy
 * and its protections are identical whichever surface a caller uses.
 *
 * Optional configuration (read from the Loader row's `config`, no schema is
 * declared so every key is optional and validated in code):
 *
 *   sessionsRoot          override the sessions root (default: the mounted
 *                         persistence backend's root, else $DSH_HOME/sessions)
 *   storagesRoot          override the storages root (default: $DSH_HOME/storages)
 *   autoCleanup           run the retention policy once shortly after boot
 *   autoKeepLatest        keep-set size for the automatic run (default 50)
 *   autoOlderThanDays     age cutoff for the automatic run (optional)
 *   autoDelayMs           delay before the automatic run (default 15000)
 *
 * @module dsh-session-cleanup
 */

import { runCleanup, applyCleanup, planCleanup, resolveSessionsRoot, MAX_TARGETS } from './cleanup.js';

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'session-cleanup';

/** Services whose availability this plugin requires before it applies. */
export const inject = ['tools'];

/** Model-facing name of the cleanup tool. */
const TOOL_NAME = 'session_cleanup';

/**
 * Absolute path the Host registers the sidebar's deletion route under, inside
 * the Connection service's connection-authenticated `/api` prefix. The browser
 * half addresses it document-relative (`api/session-cleanup.delete`).
 */
const WEB_ROUTE = '/api/session-cleanup.delete';

const TOOL_DESCRIPTION = [
  '删除持久化的会话记录（Harness sessions 根目录下的会话日志），以及引用它们的派生状态：投影缓存行、工作区置顶/归档引用、工作区缓存的会话索引。',
  '用于回收磁盘空间或落实留存期限。',
  '',
  '安全模型：默认只预览。`mode: "preview"`（默认）列出候选与可回收字节数，不删除任何内容；只有 `mode: "apply"` 才会删除。',
  '会话处于活跃状态、或它就是发起本次调用的会话时，永不被选中；只有当目录能被证明是该 id 的确切会话目录、且内容仅含会话日志代（与 session.lock）时才会删除。',
  '`keepLatest` 是保留集：按整个语料计数的最新 N 条会在年龄筛选之前获得保护。全文检索索引不处理——它是可丢弃的派生索引，会在下次搜索时对账已删除的来源。',
  '',
  '选择器：`sessionIds`（精确 id）、`olderThanDays`（早于该天数创建的记录）、`keepLatest`（保留最新 N 条），至少给出一个。',
  '`sessionIds` 是显式选择且优先级最高：同时给出时 `keepLatest` 与 `olderThanDays` 会被忽略（保护规则仍然生效）。',
  '`limit` 限制单次调用最多删除多少条（默认 50，上限 500），超限时优先处理最久远的候选。删除不可撤销。',
].join(' ');

const TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: {
      type: 'string',
      enum: ['preview', 'apply'],
      description: 'preview（默认）只列出候选、不删除任何内容；apply 执行删除。删除不可撤销。',
    },
    sessionIds: {
      type: 'array',
      items: { type: 'string' },
      description: '要删除的确切会话 id。给出它即精确选择这些 id：keepLatest 与 olderThanDays 会被忽略。受保护的会话（活跃、或发起本次调用的会话）会在结果中列出并跳过。',
    },
    keepLatest: {
      type: 'integer',
      description: '保留集大小：整个语料中最新的 N 条永不被删；在年龄筛选之前生效。给出 sessionIds 时忽略。',
    },
    olderThanDays: {
      type: 'number',
      description: '只选择创建时间早于该天数的记录。给出 sessionIds 时忽略。',
    },
    limit: {
      type: 'integer',
      description: '单次调用最多删除的条数（默认 50，上限 500）；候选超限时优先删除最久远的记录。',
    },
    allowForeignEntries: {
      type: 'boolean',
      description: '即使会话目录含有日志代与 session.lock 之外的条目也允许删除（默认关闭）。删除未知文件不可恢复，请谨慎使用。',
    },
    pruneEmptyProjects: {
      type: 'boolean',
      description: '删除后把被清空的项目目录一并移除（默认 true）。sessions 根目录本身永不删除。',
    },
    pruneWorkspaceIndex: {
      type: 'boolean',
      description: '同步丢弃工作区注册表缓存的会话索引项，使运行中的侧边栏在下次重启前就不再显示这些会话（默认 true）。',
    },
  },
};

const TARGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'directory', 'bytes', 'files', 'deleted'],
  properties: {
    id: { type: 'string', description: '会话 id。' },
    directory: { type: 'string', description: '被定位到的会话目录（无法证明时为空字符串）。' },
    bytes: { type: 'integer', description: '该目录占用的字节数。' },
    files: { type: 'integer', description: '该目录下的文件数。' },
    deleted: { type: 'boolean', description: '是否已删除（预览模式恒为 false）。' },
    createdAt: { type: 'integer', description: '记录的创建时间（epoch 毫秒），仅当会话头携带该字段时提供。' },
    error: { type: 'string', description: '未删除的原因。' },
    note: { type: 'string', description: '删除时附带完成的清理动作。' },
  },
};

const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'root', 'scanned', 'deleted', 'freedBytes', 'targets', 'protected', 'notes'],
  properties: {
    mode: { type: 'string', enum: ['preview', 'apply'] },
    root: { type: 'string' },
    scanned: { type: 'integer' },
    deleted: { type: 'integer' },
    freedBytes: { type: 'integer' },
    targets: { type: 'array', items: TARGET_SCHEMA },
    protected: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'reason'],
        properties: {
          id: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
};

/** Render a byte count with one decimal place. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? String(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Render a record's creation time. */
function formatTime(createdAt) {
  if (typeof createdAt !== 'number') return '时间未知';
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toISOString().slice(0, 16).replace('T', ' ');
}

/** Compose the model-facing tool result text. */
function renderResult(args, value) {
  const lines = [];
  lines.push(`会话记录清理（${value.mode === 'apply' ? '执行' : '预览'}）— sessions 根：${value.root}`);
  lines.push(
    value.mode === 'apply'
      ? `扫描 ${value.scanned} 条记录；本次处理 ${value.targets.length} 条；已删除 ${value.deleted} 条；释放 ${formatBytes(value.freedBytes)}。`
      : `扫描 ${value.scanned} 条记录；本次候选 ${value.targets.length} 条；可回收 ${formatBytes(value.freedBytes)}；尚未删除任何内容。`,
  );
  for (const target of value.targets) {
    const detail = `${formatBytes(target.bytes)}，${target.files} 个文件`;
    const when = formatTime(target.createdAt);
    if (target.deleted === true) {
      lines.push(`- ${target.id}（${when}）：已删除 ${detail}${target.note === undefined ? '' : `；${target.note}`}`);
    } else if (target.error !== undefined) {
      lines.push(`- ${target.id}：跳过 —— ${target.error}`);
    } else {
      lines.push(`- ${target.id}（${when}）：候选（${detail}）${target.note === undefined ? '' : `；${target.note}`}`);
    }
  }
  if (value.protected.length > 0) {
    lines.push(`受保护 ${value.protected.length} 条：${value.protected.map((entry) => `${entry.id} —— ${entry.reason}`).join('；')}`);
  }
  for (const note of value.notes) lines.push(`说明：${note}`);
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * Build the registry-ready tool definition (raw JSON Schema, no DSH imports —
 * the registry projects `parameters` verbatim onto the model-facing schema and
 * validates this definition's `output.schema` against the returned value).
 * @param ctx - plugin context carrying the services the engine resolves lazily.
 * @param config - Loader row configuration.
 * @returns the tool definition handed to `ctx.tools.register`.
 */
function createToolDefinition(ctx, config) {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: renderResult,
    },
    execute(args, exec) {
      const request = {
        mode: args?.mode === 'apply' ? 'apply' : 'preview',
        sessionIds: args?.sessionIds,
        keepLatest: args?.keepLatest,
        olderThanDays: args?.olderThanDays,
        limit: args?.limit,
        allowForeignEntries: args?.allowForeignEntries === true,
        pruneEmptyProjects: args?.pruneEmptyProjects !== false,
        pruneWorkspaceIndex: args?.pruneWorkspaceIndex !== false,
        currentSessionId: exec?.agent?.session?.id,
        signal: exec?.signal,
      };
      return runCleanup(ctx, config, request);
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args?.mode === 'apply' ? '删除会话记录' : '预览会话记录清理',
      kind: 'other',
      rawInput: args?.sessionIds ?? args?.keepLatest ?? args?.olderThanDays ?? null,
    }),
  };
}

/**
 * Install the cleanup tool, the `sessionCleanup` service, and the optional
 * automatic retention run.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - Loader row configuration (every key optional).
 */
export function apply(ctx, config = {}) {
  const settings = config ?? {};

  ctx.effect(() => {
    const dispose = ctx.tools.register(createToolDefinition(ctx, settings));
    return () => {
      try {
        dispose();
      } catch {
        /* the registry may already have disposed the layer with its fiber */
      }
    };
  }, 'session-cleanup.tool');

  const service = {
    /** The sessions root in effect, for callers that need to display it. */
    get root() {
      return resolveSessionsRoot(ctx, settings);
    },
    /** Select candidates without deleting anything. */
    plan(request = {}) {
      return planCleanup(ctx, settings, request);
    },
    /** Delete a plan produced by {@link planCleanup}. */
    apply(root, targets, options = {}) {
      return applyCleanup(ctx, settings, root, targets, options);
    },
    /** Plan (and optionally apply) in one call; returns the tool-shaped value. */
    run(request = {}) {
      return runCleanup(ctx, settings, request);
    },
  };
  ctx.provide('sessionCleanup', service);

  installWebRoute(ctx, settings);

  if (settings.autoCleanup === true) installAutoCleanup(ctx, settings);
}

/**
 * Register the browser half's deletion route when the Web transport is present.
 *
 * `connection.fetch.register` lands the route on THIS plugin's fiber (the
 * Connection service resolves its owner from the traced calling context), so
 * unloading the plugin removes the route together with the menu row that calls
 * it. A profile without the Web transport never installs it.
 * @param ctx - plugin context.
 * @param settings - Loader row configuration.
 */
function installWebRoute(ctx, settings) {
  ctx.inject(['connection'], (webCtx) => {
    const connection = webCtx.connection;
    if (connection?.fetch?.register === undefined) return;
    try {
      connection.fetch.register(createWebRoute(ctx, settings));
    } catch (error) {
      ctx.logger?.warn?.(`session-cleanup：无法注册 Web 删除路由：${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/**
 * The fetch-shaped handler behind the sidebar action: it accepts one or more
 * session ids, runs the same engine as the tool in `apply` mode, and answers
 * with a human-readable Chinese `message` the menu row shows in place.
 * @param ctx - plugin context.
 * @param settings - Loader row configuration.
 * @returns the exact Fetch route definition `connection.fetch.register` accepts.
 */
function createWebRoute(ctx, settings) {
  return {
    path: WEB_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body;
      try {
        body = await request.json();
      } catch {
        return webResponse({ ok: false, message: '请求体不是合法 JSON。' }, 400);
      }

      const sessionIds = normalizeWebIds(body?.sessionIds ?? body?.sessionId);
      if (sessionIds.length === 0) {
        return webResponse({ ok: false, message: '未给出要删除的会话 id。' }, 400);
      }

      const selected = sessionIds.slice(0, MAX_TARGETS);
      let value;
      try {
        value = await runCleanup(ctx, settings, {
          mode: 'apply',
          sessionIds: selected,
          limit: selected.length,
          currentSessionId: typeof body?.currentSessionId === 'string' ? body.currentSessionId : undefined,
        });
      } catch (error) {
        return webResponse({ ok: false, message: `删除失败：${error instanceof Error ? error.message : String(error)}` }, 500);
      }

      const succeeded = value.deleted > 0;
      const notes = value.targets.filter((target) => target.deleted === true && typeof target.note === 'string').map((target) => target.note);
      const message = succeeded
        ? `已删除 ${value.deleted} 条会话记录，释放 ${formatBytes(value.freedBytes)}。${notes.length === 0 ? '' : `（${notes.join('；')}）`}`
        : `未删除：${refusalReason(value, selected)}`;

      return webResponse({
        ok: succeeded,
        mode: value.mode,
        deleted: value.deleted,
        freedBytes: value.freedBytes,
        message,
        targets: value.targets.map((target) => ({
          id: target.id,
          deleted: target.deleted,
          bytes: target.bytes,
          files: target.files,
          ...target.error === undefined ? {} : { error: target.error },
          ...target.note === undefined ? {} : { note: target.note },
        })),
        protected: value.protected,
        notes: value.notes,
      }, succeeded ? 200 : 409);
    },
  };
}

/** JSON response helper for the browser route. */
function webResponse(body, status) {
  return new Response(JSON.stringify({ mode: 'apply', deleted: 0, freedBytes: 0, targets: [], protected: [], notes: [], ...body }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Accept `sessionIds: string[]` or a single `sessionId`, de-duplicated. */
function normalizeWebIds(input) {
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? [input] : [];
  const ids = [];
  for (const id of raw) {
    if (typeof id !== 'string' || id.trim() === '' || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

/** Explain why a request deleted nothing: the first refusal the engine reported. */
function refusalReason(value, sessionIds) {
  for (const target of value.targets) {
    if (target.deleted !== true && typeof target.error === 'string' && target.error !== '') return target.error;
  }
  for (const entry of value.protected) {
    if (sessionIds.includes(entry.id)) return entry.reason;
  }
  return '会话记录不存在，或当前没有可删除的会话目录';
}

/** Run the configured retention policy once, shortly after boot. */
function installAutoCleanup(ctx, settings) {
  const keepLatest = Number.isSafeInteger(settings.autoKeepLatest) && settings.autoKeepLatest >= 0 ? settings.autoKeepLatest : 50;
  const olderThanDays = typeof settings.autoOlderThanDays === 'number' && settings.autoOlderThanDays > 0 ? settings.autoOlderThanDays : undefined;
  const delayMs = Number.isFinite(settings.autoDelayMs) && settings.autoDelayMs >= 0 ? settings.autoDelayMs : 15_000;

  ctx.effect(() => {
    const timer = setTimeout(() => {
      ctx.logger?.info?.(`session-cleanup：启动自动保留策略（keepLatest=${keepLatest}${olderThanDays === undefined ? '' : `，olderThanDays=${olderThanDays}`}）`);
      runCleanup(ctx, settings, { mode: 'apply', keepLatest, olderThanDays })
        .then((value) => {
          ctx.logger?.info?.(`session-cleanup：自动清理完成，删除 ${value.deleted}/${value.targets.length} 条，释放 ${formatBytes(value.freedBytes)}`);
          for (const note of value.notes) ctx.logger?.debug?.(`session-cleanup：${note}`);
        })
        .catch((error) => {
          ctx.logger?.warn?.(`session-cleanup：自动保留策略执行失败：${error instanceof Error ? error.message : String(error)}`);
        });
    }, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  }, 'session-cleanup.autoCleanup');
}
