/**
 * The cleanup engine: enumerate persisted session records, select candidates by
 * a retention policy, verify every path is an exact session directory, and
 * delete the log artifacts plus the derived state that references them.
 *
 * Deletion is deliberately fail-closed. The persistence seam has no delete
 * interface (`@deepseek-ai/dsh-session-persistence-jsonl` states that logs
 * accumulate until an external actor removes them), so this engine owns the
 * file operation — and therefore re-derives and re-verifies every path instead
 * of trusting a path computed earlier:
 *
 *   1. a session is never a candidate while it is the calling session or while a
 *      turn of it is still running — being *live* in `ctx.sessions` alone is NOT
 *      enough to refuse, because the desktop client keeps a Session live for as
 *      long as it holds any retained generation (i.e. every Session the GUI has
 *      opened), which would make the sidebar action unusable;
 *   2. a session directory is only removed when it sits exactly one project
 *      level under the sessions root, its name decodes to the session id, and
 *      it holds nothing but session log generations (and a POSIX lock file);
 *   3. every caller this engine removes is removed before the bytes go away —
 *      projection cache, workspace pin/archive sets, workspace header index.
 *
 * The full SQLite FTS index is *not* touched: it is a disposable derived index
 * that reconciles deleted sources on its next stable observation.
 *
 * @module dsh-session-cleanup/cleanup
 */

import { existsSync, readdirSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import {
  NO_CWD_PROJECT,
  decodeSegment,
  encodeSegment,
  isProjectDirectoryName,
  isSessionLogName,
  projectKey,
} from './paths.js';

/** Hard ceiling on how many sessions one call may delete. */
export const MAX_TARGETS = 500;
/** Default number of sessions one call may delete. */
export const DEFAULT_TARGETS = 50;
/** Milliseconds in one day. */
const DAY_MS = 86_400_000;

const compareNewestFirst = (left, right) =>
  (right.createdAt ?? 0) - (left.createdAt ?? 0) || String(left.id).localeCompare(String(right.id));
/** Oldest first, so a truncated call spends its ceiling on the most overdue records. */
const compareOldestFirst = (left, right) =>
  (left.createdAt ?? 0) - (right.createdAt ?? 0) || String(left.id).localeCompare(String(right.id));

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

/** Compare two paths as the platform's filesystem would. */
function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The Harness home (`$DSH_HOME`, else `~/.dsh`) — the same anchor the shipped
 * bundle patches use for `sessions` and `storages`.
 * @returns the absolute Harness home.
 */
export function dshHome() {
  const configured = process.env.DSH_HOME;
  return typeof configured === 'string' && configured.length > 0 ? resolve(configured) : join(homedir(), '.dsh');
}

/**
 * Resolve the sessions root: the explicit plugin configuration wins, then the
 * mounted persistence backend's own resolved root, then the Harness-home
 * default.
 * @param ctx - plugin context.
 * @param config - plugin configuration (may be empty).
 * @returns the absolute sessions root.
 */
export function resolveSessionsRoot(ctx, config) {
  const configured = config?.sessionsRoot;
  if (typeof configured === 'string' && configured.length > 0) return resolve(configured);
  const root = ctx?.get?.('sessionPersistence')?.root;
  if (typeof root === 'string' && root.length > 0) return resolve(root);
  return join(dshHome(), 'sessions');
}

/**
 * Resolve the storages root that backs the `session_projcache` domain.
 * @param ctx - plugin context.
 * @param config - plugin configuration (may be empty).
 * @returns the absolute storages root.
 */
export function resolveStoragesRoot(ctx, config) {
  const configured = config?.storagesRoot;
  if (typeof configured === 'string' && configured.length > 0) return resolve(configured);
  return join(dshHome(), 'storages');
}

/**
 * List the logical session corpus, preferring the unified query service (it
 * carries live/persisted availability) and falling back to the persistence
 * listing.
 * @param ctx - plugin context.
 * @param signal - optional cancellation.
 * @returns normalized records, newest first.
 */
export async function listSessionRecords(ctx, signal) {
  const query = ctx?.get?.('sessionQuery');
  if (query !== undefined && typeof query.listSessions === 'function') {
    const records = await query.listSessions(signal);
    if (Array.isArray(records)) {
      return records.map((record) => normalize(record?.header, record?.live === true, record?.persisted === true)).filter(Boolean);
    }
  }
  const persistence = ctx?.get?.('sessionPersistence');
  if (persistence !== undefined && typeof persistence.list === 'function') {
    const snapshots = await persistence.list();
    if (Array.isArray(snapshots)) {
      return snapshots.map((snapshot) => normalize(snapshot?.header, false, true)).filter(Boolean);
    }
  }
  throw new Error('会话清理：ctx.sessionQuery.listSessions 与 ctx.sessionPersistence.list 都不可用');
}

/** Project one session header onto the fields the cleanup policy needs. */
function normalize(header, live, persisted) {
  if (header === undefined || header === null || typeof header.id !== 'string' || header.id.length === 0) return undefined;
  return {
    id: header.id,
    cwd: typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined,
    createdAt: typeof header.createdAt === 'number' ? header.createdAt : undefined,
    parentSession: typeof header.parentSession === 'string' ? header.parentSession : undefined,
    origin: typeof header.origin === 'string' ? header.origin : undefined,
    live,
    persisted,
  };
}

/**
 * The session directory the backend would use for one record.
 * @param root - sessions root.
 * @param cwd - the session's project directory, or undefined for `_no-cwd`.
 * @param id - session id.
 * @returns the absolute session directory.
 */
export function sessionDirectory(root, cwd, id) {
  const project = cwd === undefined ? join(root, NO_CWD_PROJECT) : join(root, projectKey(cwd));
  return join(project, encodeSegment(id));
}

/**
 * Whether a directory is provably the session directory of exactly this id:
 * one project level under the root, project name in the recognized shape, and
 * a segment that decodes back to the id.
 * @param root - sessions root.
 * @param id - session id.
 * @param directory - candidate absolute directory.
 * @returns true when deleting this directory is provably scoped to the id.
 */
export function isSessionDirectory(root, id, directory) {
  const sessionName = basename(directory);
  if (decodeSegment(sessionName) !== id) return false;
  const project = dirname(directory);
  if (!samePath(dirname(project), root)) return false;
  return isProjectDirectoryName(basename(project));
}

/**
 * Locate a session's directory. The computed path is tried first; when the
 * header cwd and the on-disk project key disagree (a lossy or truncated
 * project key, a moved project, a renamed root), the root is scanned for a
 * directory whose name decodes to exactly this id. An ambiguous scan (two
 * matches) yields nothing rather than a guess.
 * @param root - sessions root.
 * @param record - normalized session record.
 * @returns the absolute directory, or undefined when it cannot be proven.
 */
export function locateSessionDirectory(root, record) {
  const direct = sessionDirectory(root, record.cwd, record.id);
  if (existsSync(direct)) return direct;
  let projects;
  try {
    projects = readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const matches = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = join(root, project.name);
    let children;
    try {
      children = readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      if (decodeSegment(child.name) === record.id) matches.push(join(projectPath, child.name));
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/** Measure one directory tree: total bytes and file count. */
function measureDirectory(directory) {
  let bytes = 0;
  let files = 0;
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
      } else if (entry.isFile()) {
        files += 1;
        try {
          bytes += statSync(child).size;
        } catch {
          /* an unreadable entry still counts as one file */
        }
      }
    }
  }
  return { bytes, files };
}

/**
 * Entries inside a session directory that are neither a log generation nor the
 * POSIX advisory lock. A non-empty answer means the directory is not the plain
 * artifact the backend writes, so deletion refuses unless the caller opts in.
 * Unexpected directories and symlinks count too, because the recursive removal
 * would take them with it.
 * @param directory - session directory.
 * @returns the unexpected entry names, sorted.
 */
export function foreignEntries(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.name !== 'session.lock' && !isSessionLogName(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** Describe one deletion candidate without touching it. */
function describeTarget(root, record, options) {
  const target = {
    id: record.id,
    cwd: record.cwd,
    createdAt: record.createdAt,
    directory: '',
    bytes: 0,
    files: 0,
    deletable: false,
    reason: undefined,
  };
  const located = locateSessionDirectory(root, record);
  if (located === undefined) {
    target.reason = '无法在 sessions 根下证明该会话的目录位置';
    return target;
  }
  target.directory = located;
  if (!isSessionDirectory(root, record.id, located)) {
    target.reason = '拒绝删除：该路径不是这个会话 id 的确切会话目录';
    return target;
  }
  const measured = measureDirectory(located);
  target.bytes = measured.bytes;
  target.files = measured.files;
  if (options.allowForeignEntries !== true) {
    const foreign = foreignEntries(located);
    if (foreign.length > 0) {
      target.reason = `拒绝删除：会话目录包含未知条目（${foreign.join('、')}）；如确认可删请传 allowForeignEntries 覆盖`;
      return target;
    }
  }
  target.deletable = true;
  return target;
}

/** Normalize the caller's `sessionIds` argument. */
function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0) seen.add(entry);
  }
  return [...seen];
}

/** Normalize a non-negative integer argument. */
function normalizeCount(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

/** Normalize a positive number-of-days argument. */
function normalizeDays(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

/** Normalize the per-call deletion ceiling. */
function normalizeLimit(value) {
  const limit = normalizeCount(value);
  if (limit === undefined || limit === 0) return DEFAULT_TARGETS;
  return Math.min(limit, MAX_TARGETS);
}

/** Bound on the tail walk that decides whether a live Session sits inside an open turn. */
const OPEN_TURN_LOOKBACK = 2000;

/**
 * Whether a live Session is still inside an open turn.
 *
 * A driven Session answers this through `ctx.agents.get(id).status`; this is the
 * fallback for a live Session that no driver owns, whose only evidence is its own
 * log: the newest `turn/start` without a matching `turn/end` means a turn is in
 * flight. `Session.seq` is an exclusive end offset, so the walk starts there and
 * skips the undefined slot rather than assuming which convention applies.
 * @param session - the live Session from `ctx.sessions`, when there is one.
 * @returns true when the tail sits inside an open turn.
 */
function hasOpenTurn(session) {
  if (session === undefined || session === null || typeof session.eventAt !== 'function') return false;
  const head = Number(session.seq);
  if (!Number.isSafeInteger(head)) return false;
  for (let seq = head; seq >= 0 && seq > head - OPEN_TURN_LOOKBACK; seq -= 1) {
    const event = session.eventAt(seq);
    if (event === undefined || event === null) continue;
    if (event.type === 'turn/end') return false;
    if (event.type === 'turn/start') return true;
  }
  return false;
}

/**
 * Select deletion candidates and describe them, without deleting anything.
 * @param ctx - plugin context.
 * @param config - plugin configuration.
 * @param request - tool arguments (sessionIds / keepLatest / olderThanDays / limit / currentSessionId).
 * @returns the plan: root, scanned count, targets, protected ids, and notes.
 */
export async function planCleanup(ctx, config, request = {}) {
  const root = resolveSessionsRoot(ctx, config);
  const records = await listSessionRecords(ctx, request.signal);
  const notes = [];
  const protectedById = new Map();
  const protect = (id, reason) => {
    if (!protectedById.has(id)) protectedById.set(id, reason);
  };

  const currentSessionId = typeof request.currentSessionId === 'string' ? request.currentSessionId : undefined;
  const sessions = ctx?.get?.('sessions');
  const agents = ctx?.get?.('agents');
  /* "Live" only means the Host still holds a Session object for this id, which
     includes every Session the client has opened and not released — it is not
     proof of use. The driver's own status is the precise signal, and the log
     tail covers a live Session that no driver owns. */
  const isEligible = (record) => {
    if (currentSessionId !== undefined && record.id === currentSessionId) {
      protect(record.id, '发起本次调用的会话');
      return false;
    }
    const agent = typeof agents?.get === 'function' ? agents.get(record.id) : undefined;
    if (agent !== undefined) {
      if (agent.status !== 'idle') {
        protect(record.id, '该会话正在运行，当前回合尚未结束');
        return false;
      }
      return true;
    }
    if (record.live) {
      const session = typeof sessions?.get === 'function' ? sessions.get(record.id) : undefined;
      if (hasOpenTurn(session)) {
        protect(record.id, '该会话正在运行，当前回合尚未结束');
        return false;
      }
    }
    return true;
  };

  const requestedIds = normalizeIdList(request.sessionIds);
  const keepLatest = normalizeCount(request.keepLatest);
  const olderThanDays = normalizeDays(request.olderThanDays);
  let candidates;

  if (requestedIds.length > 0) {
    const byId = new Map(records.map((record) => [record.id, record]));
    candidates = [];
    for (const id of requestedIds) {
      const record = byId.get(id);
      if (record === undefined) {
        protect(id, '不存在对应记录（既非持久化记录，也非活跃会话）');
        continue;
      }
      if (isEligible(record)) candidates.push(record);
    }
  } else if (keepLatest !== undefined || olderThanDays !== undefined) {
    /* The keep-set is a property of the whole corpus, not of the eligible
       subset: "keep the newest N session records" must protect N records even
       when some of them are live, and the live ones are untouchable anyway. */
    const kept = keepLatest === undefined
      ? undefined
      : new Set([...records].sort(compareNewestFirst).slice(0, keepLatest).map((record) => record.id));
    let pool = records.filter(isEligible);
    if (kept !== undefined) pool = pool.filter((record) => !kept.has(record.id));
    if (olderThanDays !== undefined) {
      const cutoff = Date.now() - olderThanDays * DAY_MS;
      pool = pool.filter((record) => typeof record.createdAt === 'number' && record.createdAt < cutoff);
    }
    candidates = pool;
  } else {
    notes.push('未给出选择器：请提供 sessionIds、keepLatest 或 olderThanDays —— 本次未选中任何记录');
    candidates = [];
  }

  if (!existsSync(root)) notes.push(`sessions 根尚不存在：${root}`);

  const limit = normalizeLimit(request.limit);
  /* Oldest first means a capped call retires the most overdue records and leaves
     the rest for the next call, which is what a retention policy implies. */
  candidates.sort(compareOldestFirst);
  if (candidates.length > limit) {
    notes.push(`候选超出上限：已截取最久远的 ${limit} 条（共 ${candidates.length} 条）；再次运行可继续处理（上限 ${MAX_TARGETS}）`);
    candidates = candidates.slice(0, limit);
  }

  const retainedLive = candidates.filter((record) => record.live).length;
  if (retainedLive > 0) {
    notes.push(`${retainedLive} 条目标在宿主内存中仍被保留（图形界面打开过，但当前没有回合在运行）：已按"未在运行"放行；删除后请先刷新页面，且不要再向这些会话发送消息`);
  }

  const targets = candidates.map((record) => describeTarget(root, record, request));
  return {
    root,
    scanned: records.length,
    targets,
    protected: protectedById,
    notes,
  };
}

/**
 * Remove every caller that references one session id before its bytes go away.
 * Both workspace setters tolerate an id whose session is already gone, and the
 * projection cache is disposable derived data served by an open storage domain.
 * @param ctx - plugin context.
 * @param config - plugin configuration.
 * @param id - the deleted session id.
 * @param options - apply options.
 * @returns the labels of what was cleaned.
 */
async function cleanupDerivedState(ctx, config, id, options) {
  const cleaned = [];

  try {
    const table = ctx?.get?.('storageDomain')?.get?.('session_projcache')?.table?.('sessions');
    if (table !== undefined && typeof table.delete === 'function') {
      if ((await table.delete(id)) === true) cleaned.push('投影缓存行');
    }
  } catch {
    /* derived and disposable: the file sweep below is the fallback */
  }

  try {
    const file = join(resolveStoragesRoot(ctx, config), 'session_projcache', 'sessions', `${id}.json`);
    if (existsSync(file)) {
      rmSync(file, { force: true });
      cleaned.push('投影缓存文件');
    }
  } catch {
    /* a locked or unreadable cache file never fails the deletion */
  }

  const registry = ctx?.get?.('workspaceRegistry');
  if (registry !== undefined) {
    for (const method of ['unpinSession', 'unarchiveSession']) {
      const remove = registry[method];
      if (typeof remove !== 'function') continue;
      try {
        await remove.call(registry, id);
      } catch {
        /* the setters are fail-soft; a missing session is not an error here */
      }
    }
    if (options.pruneWorkspaceIndex !== false) {
      /* Membership is filtered at read time through the registry's cached
         session→cwd index, and that index is only rebuilt on boot. Dropping the
         entry removes the row from a running sidebar instead of at restart. */
      for (const [field, label] of [
        ['sessionPaths', '工作区会话索引'],
        ['headers', '工作区会话头索引'],
        ['invalidSessionPaths', '工作区诊断索引'],
      ]) {
        try {
          const map = registry[field];
          if (map !== undefined && typeof map.delete === 'function' && map.has?.(id) === true) {
            map.delete(id);
            cleaned.push(label);
          }
        } catch {
          /* private cache shapes are best-effort */
        }
      }
    }
  }

  return cleaned;
}

/** Remove an emptied project directory, leaving the root and non-empty projects alone. */
function pruneEmptyProject(root, sessionDirectoryPath) {
  const project = dirname(sessionDirectoryPath);
  if (!isProjectDirectoryName(basename(project)) || !samePath(dirname(project), root)) return false;
  try {
    if (readdirSync(project).length > 0) return false;
    /* `rmdir` is the empty-directory call: `rm` refuses a directory without
       `recursive` on Windows, and recursing here would delete a project that a
       concurrent writer just populated. */
    rmdirSync(project);
    return !existsSync(project);
  } catch {
    return false;
  }
}

/**
 * Delete a planned target list. Every target is re-verified immediately before
 * the destructive call, and derived state is cleaned only after the bytes are
 * gone.
 * @param ctx - plugin context.
 * @param config - plugin configuration.
 * @param root - sessions root the plan was built against.
 * @param targets - planned targets from {@link planCleanup}.
 * @param options - apply options (`pruneEmptyProjects`, `pruneWorkspaceIndex`).
 * @returns one result per target.
 */
export async function applyCleanup(ctx, config, root, targets, options = {}) {
  const results = [];
  for (const target of targets) {
    const result = {
      id: target.id,
      directory: target.directory ?? '',
      bytes: typeof target.bytes === 'number' ? target.bytes : 0,
      files: typeof target.files === 'number' ? target.files : 0,
      deleted: false,
      ...typeof target.createdAt === 'number' ? { createdAt: target.createdAt } : {},
    };
    if (target.deletable !== true) {
      result.error = target.reason ?? '不可删除';
      results.push(result);
      continue;
    }
    try {
      const measured = measureDirectory(target.directory);
      result.bytes = measured.bytes;
      result.files = measured.files;
      if (!isSessionDirectory(root, target.id, target.directory)) {
        throw new Error('拒绝删除：该路径已不再是这个会话 id 的确切会话目录');
      }
      rmSync(target.directory, { recursive: true, force: true });
      if (existsSync(target.directory)) throw new Error('会话目录删除后仍然存在');
      result.deleted = true;
      if (options.pruneEmptyProjects !== false && pruneEmptyProject(root, target.directory)) {
        result.note = '已移除被清空的项目目录';
      }
      const cleaned = await cleanupDerivedState(ctx, config, target.id, options);
      if (cleaned.length > 0) result.note = [result.note, `同时清理了 ${cleaned.join('、')}`].filter(Boolean).join('；');
    } catch (error) {
      result.error = errorMessage(error);
    }
    results.push(result);
  }
  return results;
}

/**
 * Plan, optionally apply, and assemble the tool's return value.
 * @param ctx - plugin context.
 * @param config - plugin configuration.
 * @param request - tool arguments plus `currentSessionId`.
 * @returns the tool value (see the `session_cleanup` output schema).
 */
export async function runCleanup(ctx, config, request = {}) {
  const mode = request.mode === 'apply' ? 'apply' : 'preview';
  const plan = await planCleanup(ctx, config, request);
  const notes = [...plan.notes];

  let targets;
  let deleted = 0;
  let freedBytes = 0;
  if (mode === 'apply') {
    const results = await applyCleanup(ctx, config, plan.root, plan.targets, request);
    targets = results;
    deleted = results.filter((result) => result.deleted === true).length;
    freedBytes = results.filter((result) => result.deleted === true).reduce((sum, result) => sum + result.bytes, 0);
    const failed = results.filter((result) => result.deleted !== true).length;
    if (failed > 0) notes.push(`${failed} 条未能删除，详见每条记录的 error 字段`);
  } else {
    targets = plan.targets.map((target) => ({
      id: target.id,
      directory: target.directory,
      bytes: target.bytes,
      files: target.files,
      deleted: false,
      ...typeof target.createdAt === 'number' ? { createdAt: target.createdAt } : {},
      ...target.reason === undefined ? {} : { error: target.reason },
    }));
    notes.push('仅预览：未删除任何内容 —— 如需真正删除，请以 mode: "apply" 重新运行');
    freedBytes = targets.reduce((sum, target) => sum + target.bytes, 0);
  }

  const protectedEntries = [...plan.protected.entries()].map(([id, reason]) => ({ id, reason }));
  const protectedLimit = 20;
  if (protectedEntries.length > protectedLimit) {
    notes.push(`共保护 ${protectedEntries.length} 条会话（此处显示前 ${protectedLimit} 条）`);
  }

  return {
    mode,
    root: plan.root,
    scanned: plan.scanned,
    deleted,
    freedBytes,
    targets,
    protected: protectedEntries.slice(0, protectedLimit),
    notes,
  };
}
