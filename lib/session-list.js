/** Keep successful deletes out of the Host's live-preferred Session list. */
const hiddenLiveSessions = new WeakSet();
// Cordis gives Services different contextual views. For the method patch and
// the generation comparison, use the underlying object when there is a view.
const original = (value) => value?.[Symbol.for('cordis.original')] ?? value;

/** The same event the built-in Session Controller forwards to connected clients. */
export function publishSessionDeletion(ctx, id) {
  try {
    const session = original(ctx?.get?.('sessions')?.get?.(id));
    if (session != null) hiddenLiveSessions.add(session);
  } catch (error) {
    ctx?.logger?.warn?.('session-cleanup：无法记录内存会话的列表状态：%s', error);
  }
  try {
    ctx?.emit?.('api-session/removed', id);
  } catch (error) {
    ctx?.logger?.warn?.('session-cleanup：无法推送会话移除通知：%s', error);
  }
}

/**
 * DSH 0.2.2-rc.5 has no list filter or public foreign-session disposal API.
 * Decorate only the list response, after the built-in auth and sorting; do not
 * close an Agent we do not own or alter its capabilities, or change the RPC
 * prototype (which Typert inspects). Cold sessions disappear from persistence
 * naturally. Track the exact attached object so a new session with the same
 * id does not inherit its predecessor's hidden state.
 */
export function filterSessionList(ctx) {
  const controller = original(ctx.get('sessionController'));
  if (typeof controller?.list !== 'function') return;
  const previous = Object.getOwnPropertyDescriptor(controller, 'list');
  const list = controller.list;
  async function filteredList(...args) {
    const result = await Reflect.apply(list, this, args);
    const sessions = ctx.get('sessions');
    if (typeof sessions?.get !== 'function' || !Array.isArray(result?.items)) return result;
    return {
      ...result,
      items: result.items.filter(({ sessionId }) => !hiddenLiveSessions.has(original(sessions.get(sessionId)))),
    };
  }
  Object.defineProperty(controller, 'list', { value: filteredList, configurable: true, writable: true });
  return () => {
    if (controller.list !== filteredList) return;
    if (previous === undefined) delete controller.list;
    else Object.defineProperty(controller, 'list', previous);
  };
}
