/**
 * dsh-session-cleanup — browser half (plain JavaScript, no build step).
 *
 * The Host Loader serves this file to the Web client for the package row that
 * declares `dsh.client` in `package.json`; the client module loader evaluates it
 * as a classic script, so it must only `require` platform seed modules (`react`,
 * the shipped UI atoms) and must return a mountable plugin from its factory.
 *
 * What it adds to the UI: one row in the `...` menu of every Session in the
 * sidebar (`sidebar.workspaces.session.menu.item`, order 500 — after the shipped
 * archive row at 400). Selecting it asks for a second click before it deletes,
 * then calls this package's Host route, which runs the same policy engine as the
 * `session_cleanup` tool — so every Host-side invariant still applies: a live
 * session is never deleted, and a tenant directory that holds unexpected files
 * is refused instead of being wiped.
 *
 * Lifecycle: the slot registration is bound to this plugin's fiber, so unloading
 * the plugin removes the row again; see `lib/index.js` for the Host half.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-cleanup',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    /** React runtime supplied by the shell as a platform seed module. */
    const React = require('react');
    /** Shipped UI atoms: the menu row container and the trash glyph. */
    const { MenuItemButton, IconTrashOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives');

    /** Locale namespace owned by this plugin's browser feedback. */
    const NS = 'session-cleanup';
    /** Slot this action joins: the rows of one Session's `...` menu. */
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item';
    /** Host route in the document-relative form the browser addresses. */
    const DELETE_ROUTE = 'api/session-cleanup.delete';
    /** How long an armed row waits for its confirming click. */
    const CONFIRM_WINDOW_MS = 8000;

    /** Simplified-Chinese strings. */
    const zh = {
      'menu.delete': '删除会话',
      'menu.confirm': '再次点击确认删除',
      'menu.busy': '正在删除…',
      'refuse.opened': '该会话正在面板中打开，请先切换到其他会话',
      'refuse.running': '该会话正在运行，请等它结束后再删除',
      'refuse.pending': '该会话还有待发送的消息，请先处理或清空',
      'error.routeMissing': 'Host 路由未就绪，请重启 Harness 后重试',
    };
    /** English strings. */
    const en = {
      'menu.delete': 'Delete session',
      'menu.confirm': 'Click again to confirm delete',
      'menu.busy': 'Deleting…',
      'refuse.opened': 'This session is open in the panel; switch to another session first',
      'refuse.running': 'This session is running; wait for it to finish',
      'refuse.pending': 'This session still has unsent messages; handle them first',
      'error.routeMissing': 'The Host route is not loaded yet; restart the Harness and try again',
    };

    /**
     * Ask the Host half to delete one session through the package's route.
     * @param sessionId - the Session the menu row belongs to.
     * @returns the Host response, whose `message` explains a refusal.
     * @throws {Error} with the Host's explanation when nothing was deleted.
     */
    async function deleteSession(sessionId) {
      const response = await fetch(DELETE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionIds: [sessionId] }),
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      if (payload?.ok === true) return payload;
      if (response.status === 404) {
        /* The Host half that owns this route is not the loaded one: a source
           change needs a Harness restart, and this names the fix instead of
           reporting a bare HTTP failure. */
        const missing = new Error('Host route not loaded');
        missing.code = 'route-missing';
        throw missing;
      }
      throw new Error(payload?.message ?? `删除请求失败（HTTP ${response.status}）`);
    }

    /**
     * One `...` menu row: `删除会话` (-> `再次点击确认删除` -> delete). A refusal
     * from the Host is shown in place, so the menu stays open on the reason.
     * @param props - owner share (`sessionId`), the injected caller, the menu
     *   open-state hook, and the locale translator bound to {@link NS}.
     * @returns the menu row.
     */
    function DeleteSessionMenuItem({ sessionId, useMenuOpenState, deleteSession: remove, localRefusal, t }) {
      const [, setMenuOpen] = useMenuOpenState();
      const [phase, setPhase] = React.useState('idle');
      const [refusal, setRefusal] = React.useState('');

      React.useEffect(() => {
        if (phase !== 'confirm') return undefined;
        /* Disarm on its own: an armed row must not stay destructive while the
           menu sits open unnoticed. */
        const timer = setTimeout(() => setPhase('idle'), CONFIRM_WINDOW_MS);
        return () => clearTimeout(timer);
      }, [phase]);

      const activate = () => {
        if (phase === 'busy') return;
        if (phase !== 'confirm') {
          /* Ask the client first: the Session shown in the panel, one mid-turn,
             or one holding queued messages must never be armed — the Host would
             only refuse it after the second click, which reads as a dead action. */
          const local = typeof localRefusal === 'function' ? localRefusal(sessionId) : undefined;
          setRefusal(local === undefined ? '' : t(local));
          setPhase(local === undefined ? 'confirm' : 'idle');
          return;
        }
        setPhase('busy');
        void remove(sessionId)
          .then(() => {
            setPhase('idle');
            setMenuOpen(false);
          })
          .catch((error) => {
            const code = error?.code;
            setRefusal(code === 'route-missing' ? t('error.routeMissing') : error instanceof Error ? error.message : String(error));
            setPhase('idle');
          });
      };

      const label = phase === 'busy' ? t('menu.busy') : phase === 'confirm' ? t('menu.confirm') : refusal === '' ? t('menu.delete') : `${t('menu.delete')}：${refusal}`;

      return React.createElement(MenuItemButton, {
        icon: React.createElement(IconTrashOutlineRegular, { size: 14 }),
        danger: true,
        separatorBefore: true,
        onSelect: activate,
        children: label,
      });
    }

    /** Services this browser half needs before it applies. */
    const inject = ['slots', 'locale'];

    /**
     * Why the browser itself refuses to delete this Session right now.
     *
     * `sessions.retainInfo` reports which consumer still holds a generation and
     * `mainView` is the Conversation the panel displays, so deleting that one
     * would tear the open view out from under the user. The Session snapshot adds
     * the mid-turn and queued-message cases the Host also enforces; asking here
     * keeps the refusal in the row instead of surfacing after a second click.
     * @param ctx - browser context.
     * @param sessionId - the Session the row belongs to.
     * @returns a dictionary key to display, or undefined when the row may proceed.
     */
    function makeLocalRefusal(ctx) {
      return (sessionId) => {
        let sessions;
        try {
          sessions = ctx.get?.('sessions');
        } catch {
          sessions = undefined;
        }
        if (sessions === undefined || sessions === null) return undefined;
        const retained = sessions.retainInfo?.(sessionId)?.getSnapshot?.();
        if ((retained?.retainedBy?.mainView ?? 0) > 0) return 'refuse.opened';
        const snapshot = sessions.binding?.(sessionId)?.session?.getSnapshot?.();
        if (snapshot?.running === true) return 'refuse.running';
        if ((snapshot?.pendingSubmissions?.length ?? 0) > 0) return 'refuse.pending';
        return undefined;
      };
    }

    /**
     * Register the deletion row into the Session list's `...` menu.
     * @param ctx - browser context carrying the slot registry and locale service.
     */
    function apply(ctx) {
      const localRefusal = makeLocalRefusal(ctx);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-cleanup: browser dictionaries');
      ctx.effect(
        () =>
          ctx.slots.inject(MENU_SLOT, () =>
            ctx.slots.register(
              {
                name: MENU_SLOT,
                id: 'session-cleanup',
                order: 500,
                locale: NS,
                inject: () => ({ deleteSession, localRefusal }),
              },
              DeleteSessionMenuItem,
            ),
          ),
        'session-cleanup: session list delete row',
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
