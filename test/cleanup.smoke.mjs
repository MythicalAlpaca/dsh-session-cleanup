/**
 * Smoke test for the cleanup engine. Builds a throwaway sessions root that
 * looks like the JSONL backend's output, drives the preview/apply paths with a
 * fake Cordis context, and asserts the safety rules that matter:
 *
 *   - preview never deletes;
 *   - a live session and the calling session are protected;
 *   - keepLatest keeps the newest N and olderThanDays filters by createdAt;
 *   - an explicit sessionIds selection deletes exactly those ids;
 *   - a session directory holding unexpected entries is refused;
 *   - the emptied project directory is pruned, the root is not.
 *
 * Run: node test/cleanup.smoke.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyCleanup, planCleanup, runCleanup, sessionDirectory } from '../lib/cleanup.js';
import { encodeSegment, projectKey } from '../lib/paths.js';
import { filterSessionList } from '../lib/session-list.js';

const CWD_A = process.platform === 'win32' ? 'C:\\project\\alpha' : '/project/alpha';
const CWD_B = process.platform === 'win32' ? 'C:\\project\\beta' : '/project/beta';

const root = mkdtempSync(join(tmpdir(), 'dsh-session-cleanup-'));
const DAY = 86_400_000;
const now = Date.now();

/** Mint one stored session on disk with a chosen age. */
function materialize(id, cwd, ageDays, extraFile, baseRoot = root) {
  const directory = sessionDirectory(baseRoot, cwd, id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'session.v4.jsonl.zstd'), Buffer.alloc(2048, 7));
  writeFileSync(join(directory, 'session.lock'), '');
  if (extraFile !== undefined) writeFileSync(join(directory, extraFile), 'unexpected');
  return { id, cwd, createdAt: now - ageDays * DAY, directory };
}

const records = [
  materialize('session-new-a', CWD_A, 1),
  materialize('session-old-a', CWD_A, 40),
  materialize('session-older-a', CWD_A, 90),
  materialize('session-old-b', CWD_B, 60),
  materialize('session-nocwd', undefined, 75),
  materialize('session-dirty', CWD_A, 95, 'notes.txt'),
  materialize('session-live', CWD_A, 120),
];

/**
 * A fake context carrying only the services the engine resolves lazily.
 *
 * `live` mirrors `ctx.sessions.get(id)` (the Host still holds the Session, which
 * the desktop client causes for every Session it has opened) and `running`
 * mirrors `ctx.agents.get(id).status === 'running'`. Keeping them separate is the
 * point: live-but-idle must be deletable, live-and-running must not. `agentless`
 * is a live Session no driver owns, whose only evidence is the open turn in its
 * own log.
 */
function createContext(overrides = {}) {
  const live = new Set(overrides.live ?? []);
  const running = new Set(overrides.running ?? []);
  const agentless = new Set(overrides.agentless ?? []);
  const openTurn = (id) => running.has(id) || agentless.has(id);
  const sessionStub = (id) => ({
    id,
    /* `seq` is an exclusive end offset, so the newest event sits at seq - 1. */
    seq: 3,
    eventAt: (seq) => (openTurn(id) ? { type: seq === 2 ? 'turn/start' : 'user/message' } : { type: 'turn/end' }),
  });
  const services = {
    sessions: { get: (id) => (live.has(id) ? sessionStub(id) : undefined) },
    agents: { get: (id) => (live.has(id) && !agentless.has(id) ? { id, status: running.has(id) ? 'running' : 'idle' } : undefined) },
    sessionPersistence: { root, list: async () => records.map((record) => ({ header: record })) },
    sessionQuery: {
      listSessions: async () =>
        records.map((record) => ({ header: record, live: live.has(record.id), persisted: true })),
    },
    ...(overrides.services ?? {}),
  };
  return {
    get: (name) => services[name],
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
  };
}

/** The reason a Session whose turn is still open is refused. */
const RUNNING_REASON = '该会话正在运行，当前回合尚未结束';

const ctx = createContext({ live: ['session-live'], running: ['session-live'] });

// --- preview deletes nothing -------------------------------------------------
const preview = await runCleanup(ctx, {}, { keepLatest: 2 });
assert.equal(preview.mode, 'preview');
assert.equal(preview.deleted, 0);
assert.ok(preview.targets.length > 0, 'preview should list candidates');
assert.ok(existsSync(sessionDirectory(root, CWD_A, 'session-old-a')), 'preview must not delete');
console.log('preview: ok —', preview.targets.map((target) => target.id).join(', '));

// --- keepLatest protects the newest records and live/current are protected ---
const plan = await planCleanup(ctx, {}, { keepLatest: 2, currentSessionId: 'session-old-a' });
const planned = plan.targets.map((target) => target.id).sort();
assert.ok(!planned.includes('session-new-a'), 'keepLatest must protect the newest record');
assert.ok(!planned.includes('session-live'), 'a live session must never be a target');
assert.ok(!planned.includes('session-old-a'), 'the calling session must never be a target');
assert.equal(plan.protected.get('session-live'), RUNNING_REASON);
assert.equal(plan.protected.get('session-old-a'), '发起本次调用的会话');
console.log('selection: ok — candidates', planned.join(', '));

// --- the dirty session directory is refused ---------------------------------
const dirty = plan.targets.find((target) => target.id === 'session-dirty');
assert.equal(dirty.deletable, false);
assert.match(dirty.reason, /包含未知条目/);
assert.ok(existsSync(dirty.directory), 'a refused directory must survive');

// --- age cutoff narrows the pool (a live session stays protected) -----------
const aged = await planCleanup(ctx, {}, { olderThanDays: 50, currentSessionId: 'session-none' });
const agedIds = aged.targets.map((target) => target.id).sort();
assert.deepEqual(agedIds, ['session-dirty', 'session-nocwd', 'session-old-b', 'session-older-a'].sort());
assert.equal(aged.protected.get('session-live'), RUNNING_REASON);
console.log('olderThanDays: ok —', agedIds.join(', '));

// --- a capped call retires the most overdue candidates first ----------------
const capped = await planCleanup(ctx, {}, { olderThanDays: 50, limit: 2, currentSessionId: 'session-none' });
assert.deepEqual(capped.targets.map((target) => target.id), ['session-dirty', 'session-older-a']);
assert.match(capped.notes.join(' '), /已截取最久远的 2 条（共 4 条）/);
console.log('limit: ok — capped to the oldest candidates:', capped.targets.map((target) => target.id).join(', '));

// --- keepLatest counts every record, including untouchable ones -------------
// The live session here is also the newest, so a keep-set computed over
// eligible records only would protect one record too many.
const newestIsLive = createContext({ live: ['session-new-a'], running: ['session-new-a'] });
const corpusKept = await planCleanup(newestIsLive, {}, { keepLatest: 2 });
const keptIds = corpusKept.targets.map((target) => target.id).sort();
assert.deepEqual(keptIds, ['session-dirty', 'session-live', 'session-nocwd', 'session-old-b', 'session-older-a'].sort());
assert.equal(corpusKept.protected.get('session-new-a'), RUNNING_REASON);
console.log('keepLatest across the corpus: ok —', keptIds.join(', '));

// --- apply deletes exactly the selected ids and prunes what it emptied ------
const explicit = await runCleanup(ctx, {}, {
  mode: 'apply',
  sessionIds: ['session-old-b', 'session-nocwd', 'session-live'],
  currentSessionId: 'session-new-a',
});
assert.equal(explicit.deleted, 2, 'the live id must be skipped');
assert.ok(!existsSync(sessionDirectory(root, CWD_B, 'session-old-b')), 'explicit target must be deleted');
assert.ok(!existsSync(sessionDirectory(root, undefined, 'session-nocwd')), 'no-cwd target must be deleted');
assert.ok(!existsSync(join(root, projectKey(CWD_B))), 'the emptied project directory must be pruned');
assert.ok(existsSync(root), 'the sessions root must survive');
assert.ok(existsSync(sessionDirectory(root, CWD_A, 'session-live')));
assert.ok(
  explicit.protected.some((entry) => entry.id === 'session-live' && entry.reason === RUNNING_REASON),
  'the skipped live id must be reported as protected',
);
console.log('apply: ok — freed', explicit.freedBytes, 'bytes; project pruned');

// --- a live session with an idle driver IS deletable -------------------------
// This is the case the sidebar action hit: the desktop client keeps a Session
// live for as long as it holds a retained generation (i.e. anything the GUI has
// opened), so refusing every live session made the action unusable. The guard
// must be the running turn, not the mere presence of a Session object.
const attached = { id: 'session-live' };
const survivor = { id: 'session-new-a' };
const sessionsById = new Map([[attached.id, attached], [survivor.id, survivor]]);
class TestController {
  async list(request, signal) {
    assert.equal(this, controller);
    assert.deepEqual(request, {});
    assert.equal(signal, undefined);
    return { items: Array.from(sessionsById.keys(), (sessionId) => ({ sessionId })), other: 'preserved' };
  }
}
const controller = new TestController();
const events = [];
const memberIds = ['session-live', 'session-new-a'];
const sessionPaths = new Map([['session-live', CWD_A]]);
const workspace = {
  sessionIds: memberIds,
  async detachSession(id) {
    assert.ok(sessionPaths.has(id), 'detach must precede index invalidation');
    assert.equal(id, 'session-live');
    memberIds.splice(memberIds.indexOf(id), 1);
  },
};
const idleLive = createContext({ live: ['session-live'], services: {
  sessions: { get: (id) => sessionsById.get(id) },
  sessionController: { [Symbol.for('cordis.original')]: controller },
  workspaceRegistry: { list: () => [workspace], sessionPaths },
} });
idleLive.emit = (event, id) => {
  assert.ok(!existsSync(sessionDirectory(root, CWD_A, id)), 'publish only after deletion');
  events.push([event, id]);
};
const disposeFilter = filterSessionList(idleLive);
assert.equal((await controller.list({})).items.length, 2);
const idlePlan = await planCleanup(idleLive, {}, { sessionIds: ['session-live'] });
assert.deepEqual(idlePlan.targets.map((target) => target.id), ['session-live']);
assert.equal(idlePlan.protected.size, 0);
assert.match(idlePlan.notes.join(' '), /1 条目标在宿主内存中仍被保留/);
assert.deepEqual(events, [], 'preview must not emit a removal');
const idleApply = await runCleanup(idleLive, {}, { mode: 'apply', sessionIds: ['session-live'] });
assert.equal(idleApply.deleted, 1);
assert.ok(!existsSync(sessionDirectory(root, CWD_A, 'session-live')), 'a live-but-idle session must be deletable');
assert.deepEqual(events, [['api-session/removed', 'session-live']]);
assert.deepEqual(memberIds, ['session-new-a']);
assert.equal(sessionPaths.has('session-live'), false);
assert.deepEqual(await controller.list({}), { items: [{ sessionId: 'session-new-a' }], other: 'preserved' });
sessionsById.set(attached.id, { id: attached.id });
assert.equal((await controller.list({})).items.length, 2, 'a replacement generation with the same id must not be hidden');
disposeFilter();
assert.equal(Object.hasOwn(controller, 'list'), false, 'unload must restore the original method');
console.log('live but idle: ok — deletion published, membership detached, and stale baseline filtered');

// --- a live session without a driver is refused by its own open turn ---------
const agentless = createContext({ live: ['session-new-a'], agentless: ['session-new-a'] });
const agentlessPlan = await planCleanup(agentless, {}, { sessionIds: ['session-new-a'] });
assert.equal(agentlessPlan.targets.length, 0);
assert.equal(agentlessPlan.protected.get('session-new-a'), RUNNING_REASON);
console.log('open turn without a driver: ok — refused by the log tail');

// --- foreign entries are deletable only with the explicit override ----------
const overridden = await applyCleanup(ctx, {}, root, (await planCleanup(ctx, {}, { sessionIds: ['session-dirty'], allowForeignEntries: true })).targets, {});
assert.equal(overridden[0].deleted, true);
assert.ok(!existsSync(sessionDirectory(root, CWD_A, 'session-dirty')));
console.log('override: ok — refused directory deleted with allowForeignEntries');

// --- no selector means no candidates ---------------------------------------
const none = await planCleanup(ctx, {});
assert.equal(none.targets.length, 0);
assert.match(none.notes.join(' '), /未给出选择器/);

// --- a path outside the exact session-directory shape is refused ------------
const escaped = await applyCleanup(ctx, {}, root, [{ id: 'session-new-a', directory: root, bytes: 0, files: 0, deletable: true }], {});
assert.equal(escaped[0].deleted, false);
assert.match(escaped[0].error, /拒绝删除/);
assert.ok(readdirSync(root).length > 0, 'the sessions root must survive a forged target');

rmSync(root, { recursive: true, force: true });

// --- the plugin wrapper registers a conforming tool -------------------------
// Minimal stand-in for the registry's enforced JSON Schema subset, so the value
// the tool returns is checked against its own declared output schema here
// instead of only inside a running Harness.
function validate(value, schema, path = 'value', violations = []) {
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return violations.concat(`${path} must be an object`);
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) violations.push(`${path}.${key} is required`);
    for (const [key, entry] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties ?? {}, key)) {
        if (schema.additionalProperties === false) violations.push(`${path}.${key} is not allowed`);
        continue;
      }
      validate(entry, schema.properties[key], `${path}.${key}`, violations);
    }
    return violations;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return violations.concat(`${path} must be an array`);
    value.forEach((entry, index) => validate(entry, schema.items, `${path}[${index}]`, violations));
    return violations;
  }
  if (schema.type === 'integer' && !Number.isInteger(value)) violations.push(`${path} must be an integer`);
  if (schema.type === 'string') {
    if (typeof value !== 'string') violations.push(`${path} must be a string`);
    else if (Array.isArray(schema.enum) && !schema.enum.includes(value)) violations.push(`${path} must be one of ${schema.enum.join('/')}`);
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') violations.push(`${path} must be a boolean`);
  return violations;
}

const pluginRoot = mkdtempSync(join(tmpdir(), 'dsh-session-cleanup-plugin-'));
const pluginTarget = materialize('session-target', CWD_A, 30, undefined, pluginRoot);
const pluginRecords = [{ id: 'session-target', cwd: CWD_A, createdAt: now - 30 * DAY }];
let registered;
const provided = {};
const pluginCtx = {
  get: (serviceName) => {
    if (serviceName === 'sessionPersistence') {
      return { root: pluginRoot, list: async () => pluginRecords.map((header) => ({ header })) };
    }
    if (serviceName === 'sessionQuery') {
      return { listSessions: async () => pluginRecords.map((header) => ({ header, live: false, persisted: true })) };
    }
    return undefined;
  },
  logger: { info: () => {}, warn: () => {}, debug: () => {} },
  effect: (execute) => execute(),
  /* No Web transport in this fixture: the deferred injection never fires, so the
     plugin must still install its tool. */
  inject: () => {},
  provide: (serviceName, serviceValue) => {
    provided[serviceName] = serviceValue;
  },
  tools: {
    register: (definition) => {
      registered = definition;
      return () => {};
    },
  },
};

const plugin = await import('../lib/index.js');
plugin.apply(pluginCtx, {});
assert.equal(plugin.name, 'session-cleanup');
assert.deepEqual(plugin.inject, ['tools']);
assert.equal(registered.name, 'session_cleanup');
assert.ok(typeof registered.execute === 'function');
assert.ok(typeof registered.output.render === 'function');
assert.ok(typeof provided.sessionCleanup?.run === 'function', 'the sessionCleanup service must be provided');
// The plugin's user-facing text is Chinese: the model sees the description and
// parameter help, the reader sees the rendered result.
assert.match(registered.description, /会话/, 'the tool description must be Chinese');
assert.doesNotMatch(registered.description, /^Delete persisted/, 'the English description must be gone');
// API values stay ASCII: only the prose is translated.
assert.deepEqual(registered.parameters.properties.mode.enum, ['preview', 'apply']);
for (const [key, schema] of Object.entries(registered.parameters.properties)) {
  assert.match(schema.description ?? '', /[\u4e00-\u9fff]/, `parameter "${key}" help must be Chinese`);
}

const toolValue = await registered.execute({ mode: 'preview' }, { agent: { session: { id: 'session-target' } } });
const violations = validate(toolValue, registered.output.schema);
assert.deepEqual(violations, [], `the tool value must satisfy its output schema: ${violations.join('; ')}`);
assert.equal(toolValue.deleted, 0);
assert.match(registered.output.render({}, toolValue)[0].text, /预览/);

const applied = await registered.execute({ mode: 'apply', olderThanDays: 1 }, { agent: { session: { id: 'session-other' } } });
assert.deepEqual(validate(applied, registered.output.schema), []);
assert.equal(applied.deleted, 1);
assert.ok(!existsSync(pluginTarget.directory), 'apply through the tool must delete the record');
assert.equal(applied.targets[0].id, 'session-target');
assert.equal(typeof applied.targets[0].createdAt, 'number', 'the applied target must carry its creation time');
assert.equal(applied.targets[0].createdAt, pluginRecords[0].createdAt);

const appliedText = registered.output.render({}, applied)[0].text;
assert.match(appliedText, /已删除 1 条/);
assert.match(appliedText, /已删除 \d+(\.\d+)? (B|KB)，2 个文件/, `the deleted line must report the freed size: ${appliedText}`);
assert.doesNotMatch(appliedText, /时间未知/, 'a record with a creation time must not render as unknown time');
assert.match(appliedText, /sessions 根：/);
console.log('plugin wrapper: ok — tool registered, output schema satisfied, apply deleted the record');
console.log('\nrendered apply output:\n' + appliedText.split('\n').map((line) => `  ${line}`).join('\n'));

rmSync(pluginRoot, { recursive: true, force: true });

// --- the browser half's route deletes through the same engine ---------------
// The route is a plain Fetch-shaped handler over Connection's authenticated
// `/api` prefix; this drives it exactly as the sidebar row does.
const webRoot = mkdtempSync(join(tmpdir(), 'dsh-session-cleanup-web-'));
const webVictim = materialize('session-web-victim', CWD_A, 30, undefined, webRoot);
const webLive = materialize('session-web-live', CWD_A, 5, undefined, webRoot);
const webRecords = [
  { id: 'session-web-victim', cwd: CWD_A, createdAt: now - 30 * DAY },
  { id: 'session-web-live', cwd: CWD_A, createdAt: now - 5 * DAY },
];

const activeRoutes = [];
const webEvents = [];
const fiberDisposers = [];
const connectionService = {
  fetch: {
    register: (route) => {
      activeRoutes.push(route);
      const dispose = () => {
        const index = activeRoutes.indexOf(route);
        if (index !== -1) activeRoutes.splice(index, 1);
      };
      /* The real service wraps the registration in `owner.effect(...)` where the
         owner is the traced calling context, so the route dies with the plugin. */
      fiberDisposers.push(dispose);
      return dispose;
    },
  },
};
const routeCtx = {
  emit: (...args) => webEvents.push(args),
  get(serviceName) {
    if (serviceName === 'connection') return connectionService;
    if (serviceName === 'agents') {
      /* Only the running Session is refused now; see the engine's rule. */
      return { get: (id) => (id === 'session-web-live' ? { id, status: 'running' } : undefined) };
    }
    if (serviceName === 'sessionPersistence') {
      return { root: webRoot, list: async () => webRecords.map((header) => ({ header })) };
    }
    if (serviceName === 'sessionQuery') {
      return { listSessions: async () => webRecords.map((header) => ({ header, live: header.id === 'session-web-live', persisted: true })) };
    }
    return undefined;
  },
  logger: { info: () => {}, warn: () => {}, debug: () => {} },
  effect: (execute) => {
    const dispose = execute();
    fiberDisposers.push(dispose);
    return dispose;
  },
  provide: () => {},
  tools: { register: () => () => {} },
  inject: (dependencies, callback) => {
    if (dependencies[0] === 'sessionController') return;
    assert.deepEqual(dependencies, ['connection'], 'the route must be installed only when the Web transport is present');
    callback({ connection: connectionService, get: (name) => routeCtx.get(name) });
  },
};

plugin.apply(routeCtx, {});
assert.equal(activeRoutes.length, 1, 'applying with a connection service must register exactly one route');
const route = activeRoutes[0];
assert.equal(route.path, '/api/session-cleanup.delete');
assert.deepEqual(route.methods, ['POST']);
assert.equal(route.requestBody, 'buffered');

/** Drive the route like the browser does. */
async function post(body, raw) {
  const request = new Request('http://127.0.0.1:19387/api/session-cleanup.delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
  const response = await route.fetch(request);
  return { status: response.status, body: await response.json() };
}

const missing = await post({});
assert.equal(missing.status, 400);
assert.equal(missing.body.ok, false);
assert.match(missing.body.message, /未给出要删除的会话 id/);

const broken = await post(undefined, '{ not json');
assert.equal(broken.status, 400);
assert.match(broken.body.message, /不是合法 JSON/);

const removed = await post({ sessionIds: ['session-web-victim'] });
assert.equal(removed.status, 200);
assert.equal(removed.body.ok, true);
assert.equal(removed.body.deleted, 1);
assert.match(removed.body.message, /已删除 1 条会话记录/);
assert.ok(!existsSync(webVictim.directory), 'the route must delete the selected session directory');

const liveRefusal = await post({ sessionIds: ['session-web-live'] });
assert.equal(liveRefusal.status, 409);
assert.equal(liveRefusal.body.ok, false);
assert.match(liveRefusal.body.message, /未删除：该会话正在运行/);
assert.ok(existsSync(webLive.directory), 'the route must never delete a live session');

const unknownRefusal = await post({ sessionIds: ['session-web-gone'] });
assert.equal(unknownRefusal.status, 409);
assert.match(unknownRefusal.body.message, /不存在对应记录/);
assert.deepEqual(webEvents, [['api-session/removed', 'session-web-victim']], 'failed deletes must never emit removal');
console.log('web route: ok — deleted and notified only the successful selection');

// --- unloading the plugin removes the route ---------------------------------
// The Connection service lands a registered route on the calling fiber; the
// fake mirrors that by collecting the disposers the plugin's effects own.
for (const dispose of fiberDisposers.reverse()) dispose?.();
assert.equal(activeRoutes.length, 0, 'the route must disappear with its plugin');
rmSync(webRoot, { recursive: true, force: true });

// --- the browser half registers one sidebar menu row ------------------------
/** Minimal React stand-in: enough hooks to drive the row through its states. */
function createReactStub() {
  let cursor = 0;
  const states = [];
  return {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.length === 0 ? props?.children : children } }),
    useState: (initial) => {
      const index = cursor;
      cursor += 1;
      if (!(index in states)) states[index] = initial;
      return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
    },
    useEffect: () => {},
    reset: () => {
      states.length = 0;
      cursor = 0;
    },
    render: (component, props) => {
      cursor = 0;
      return component(props);
    },
  };
}

const moduleEntries = [];
globalThis.window = { __ModuleLoader__: { load: (entry) => moduleEntries.push(entry) } };
await import('../lib/client.js');
assert.equal(moduleEntries.length, 1, 'the browser half must register exactly one module factory');
assert.equal(moduleEntries[0].id, 'dsh-session-cleanup', 'the module id must be the package name');

const react = createReactStub();
const primitives = {
  MenuItemButton: 'MenuItemButton',
  IconTrashOutlineRegular: 'IconTrashOutlineRegular',
};
const browserPlugin = moduleEntries[0].factory((specifier) => {
  if (specifier === 'react') return react;
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
  throw new Error(`the browser half may only require platform seed modules, got ${specifier}`);
});
assert.deepEqual(browserPlugin.inject, ['slots', 'locale']);

const registrations = [];
const dictionaries = [];
const clientCtx = {
  effect: (execute) => execute(),
  locale: { register: (namespace, dicts) => { dictionaries.push({ namespace, dicts }); return () => {}; } },
  slots: {
    inject: (slot, callback) => {
      assert.equal(slot, 'sidebar.workspaces.session.menu.item');
      callback();
      return () => {};
    },
    register: (definition, component) => {
      registrations.push({ definition, component });
      return () => {};
    },
  },
};
browserPlugin.apply(clientCtx);
assert.equal(registrations.length, 1);
const { definition, component } = registrations[0];
assert.equal(definition.name, 'sidebar.workspaces.session.menu.item');
assert.equal(definition.id, 'session-cleanup');
assert.equal(definition.order, 500, 'the delete row must sit after the shipped archive row (400)');
assert.equal(definition.locale, 'session-cleanup');
assert.equal(dictionaries[0].namespace, 'session-cleanup');
assert.equal(dictionaries[0].dicts.zh['menu.delete'], '删除会话');
assert.match(dictionaries[0].dicts.zh['menu.confirm'], /确认/);

const injected = definition.inject();
assert.equal(typeof injected.deleteSession, 'function');
assert.equal(typeof injected.localRefusal, 'function', 'the row needs the client-side guard too');

const fetchCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init });
  const id = JSON.parse(init.body).sessionIds[0];
  if (id === 'session-route-missing') {
    return new Response('not found', { status: 404 });
  }
  const refused = id === 'session-web-live';
  return new Response(JSON.stringify(refused ? { ok: false, message: '未删除：该会话正在运行，当前回合尚未结束' } : { ok: true, message: '已删除 1 条会话记录', targets: [{ id: id === 'session-unconfirmed' ? 'another-session' : id, deleted: true }] }), {
    status: refused ? 409 : 200,
    headers: { 'content-type': 'application/json' },
  });
};

await injected.deleteSession('session-web-victim');
assert.equal(fetchCalls[0].url, 'api/session-cleanup.delete', 'the row must call the package route');
assert.deepEqual(JSON.parse(fetchCalls[0].init.body), { sessionIds: ['session-web-victim'] });
assert.equal(fetchCalls[0].init.method, 'POST');
await assert.rejects(() => injected.deleteSession('session-web-live'), /未删除：该会话正在运行/);
// A 404 means the Host half that owns the route is not the loaded one; the row
// must name that instead of showing a bare HTTP status.
await assert.rejects(() => injected.deleteSession('session-route-missing'), (error) => error.code === 'route-missing');

let refreshCalls = 0;
let ids = ['session-web-victim', 'session-web-live'];
browserPlugin.apply({ ...clientCtx, get: (name) => name === 'sessions' ? {
  list: { getSnapshot: () => ({ ids }) },
  async refresh() {
    refreshCalls += 1;
    if (refreshCalls === 2) ids = ids.filter((id) => id !== 'session-web-victim');
  },
} : undefined });
const refreshingDelete = registrations.at(-1).definition.inject().deleteSession;
await assert.rejects(() => refreshingDelete('session-unconfirmed'), /未得到宿主确认/);
await assert.rejects(() => refreshingDelete('session-web-live'), /正在运行/);
assert.equal(refreshCalls, 0);
await refreshingDelete('session-web-victim');
assert.equal(refreshCalls, 2, 'retry once after a stale in-flight list refresh');
assert.deepEqual(ids, ['session-web-live']);
await refreshingDelete('session-web-victim');
assert.equal(refreshCalls, 2, 'do not pull again when already removed by the Host event');

let menuOpen = true;
const menuProps = {
  sessionId: 'session-web-victim',
  displayTitle: '示例会话',
  useMenuOpenState: () => [null, (value) => { menuOpen = value; }],
  t: (key) => dictionaries[0].dicts.zh[key] ?? key,
  deleteSession: injected.deleteSession,
};
const idleRow = react.render(component, menuProps);
assert.equal(idleRow.type, primitives.MenuItemButton);
assert.equal(idleRow.props.children, '删除会话');
assert.equal(idleRow.props.separatorBefore, true);
assert.equal(idleRow.props.danger, true, 'a destructive row must use the danger styling');
assert.equal(idleRow.props.icon.type, primitives.IconTrashOutlineRegular);
assert.equal(idleRow.props.icon.props.size, 14);

const before = fetchCalls.length;
idleRow.props.onSelect();
const armedRow = react.render(component, menuProps);
assert.equal(armedRow.props.children, '再次点击确认删除', 'the first click must only arm the row');
assert.equal(fetchCalls.length, before, 'arming must not call the Host');

armedRow.props.onSelect();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(fetchCalls.length, before + 1, 'the confirming click must call the Host');
assert.equal(menuOpen, false, 'a successful deletion must close the menu');

// A refusal from the Host (a running session) is surfaced in the row itself, so
// the menu stays open on the reason instead of silently doing nothing.
react.reset();
menuOpen = true;
const liveProps = { ...menuProps, sessionId: 'session-web-live' };
const liveIdle = react.render(component, liveProps);
assert.equal(liveIdle.props.children, '删除会话');
liveIdle.props.onSelect();
const liveArmed = react.render(component, liveProps);
assert.equal(liveArmed.props.children, '再次点击确认删除');
liveArmed.props.onSelect();
await new Promise((resolve) => setTimeout(resolve, 0));
const liveRefused = react.render(component, liveProps);
assert.match(liveRefused.props.children, /未删除：该会话正在运行/);
assert.equal(menuOpen, true, 'a refused deletion must leave the menu open');

// --- the client-side guard answers first -------------------------------------
// The Session the panel displays, one mid-turn, and one with queued messages are
// refused in the row itself, so the row never arms a deletion the Host would only
// refuse after the second click.
const guardSessions = {
  retainInfo: (id) => ({
    getSnapshot: () => ({
      referenceCount: id === 'session-displayed' ? 1 : 0,
      retainedBy: id === 'session-displayed' ? { mainView: 1 } : {},
    }),
  }),
  binding: (id) => (id === 'session-running' || id === 'session-queued'
    ? {
      session: {
        getSnapshot: () => ({
          running: id === 'session-running',
          pendingSubmissions: id === 'session-queued' ? [{ requestId: 'req-1' }] : [],
        }),
      },
    }
    : undefined),
};
browserPlugin.apply({ ...clientCtx, get: (name) => (name === 'sessions' ? guardSessions : undefined) });
const guarded = registrations.at(-1);
const guardedInjected = guarded.definition.inject();
const guardedProps = { ...menuProps, deleteSession: guardedInjected.deleteSession, localRefusal: guardedInjected.localRefusal };

for (const [id, pattern] of [
  ['session-displayed', /正在面板中打开/],
  ['session-running', /正在运行/],
  ['session-queued', /待发送的消息/],
]) {
  react.reset();
  const props = { ...guardedProps, sessionId: id };
  const beforeGuard = fetchCalls.length;
  react.render(guarded.component, props).props.onSelect();
  const refusedRow = react.render(guarded.component, props);
  assert.match(refusedRow.props.children, pattern, `${id} must be refused by the client`);
  assert.equal(fetchCalls.length, beforeGuard, `${id} must not reach the Host`);
}

react.reset();
const cleanProps = { ...guardedProps, sessionId: 'session-clean' };
react.render(guarded.component, cleanProps).props.onSelect();
assert.equal(react.render(guarded.component, cleanProps).props.children, '再次点击确认删除', 'a plain session must still arm');
react.reset();

globalThis.fetch = realFetch;
console.log('browser half: ok — menu row registered, two-click confirm, client guard and Host refusals surfaced in place');

console.log('\nall cleanup smoke assertions passed');
