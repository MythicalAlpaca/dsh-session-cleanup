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
      'error.routeMissing': '宿主插件未就绪，请检查插件是否已启用，再刷新页面重试',
    };
    /** English strings. */
    const en = {
      'menu.delete': 'Delete session',
      'menu.confirm': 'Click again to confirm delete',
      'menu.busy': 'Deleting…',
      'refuse.opened': 'This session is open in the panel; switch to another session first',
      'refuse.running': 'This session is running; wait for it to finish',
      'refuse.pending': 'This session still has unsent messages; handle them first',
      'error.routeMissing': 'The Host plugin is not loaded; check that it is enabled and refresh the page',
    };

    /**
     * Ask the Host half to delete one session through the package's route.
     * @param ctx - browser context carrying the optional Session list service.
     * @param sessionId - the Session the menu row belongs to.
     * @returns the Host response, whose `message` explains a refusal.
     * @throws {Error} with the Host's explanation when nothing was deleted.
     */
    async function deleteSession(ctx, sessionId) {
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
      if (response.ok && payload?.ok === true && Array.isArray(payload.targets) &&
          payload.targets.some((target) => target?.id === sessionId && target.deleted === true)) {
        // The Host broadcasts the removal; revalidate as a fallback if this
        // browser missed the event. A refresh failure is not a delete failure.
        void reconcileDeletedRow(ctx, sessionId);
        return payload;
      }
      if (response.status === 404) {
        // Distinguish an unmounted Host plugin from a refused deletion.
        const missing = new Error('Host route not loaded');
        missing.code = 'route-missing';
        throw missing;
      }
      throw new Error(payload?.ok === false && payload.message ? payload.message : `删除未得到宿主确认（HTTP ${response.status}）`);
    }

    /** Revalidate without blocking menu dismissal or retrying the deletion. */
    async function reconcileDeletedRow(ctx, id) {
      try {
        const sessions = ctx.get?.('sessions');
        if (typeof sessions?.refresh !== 'function' || !sessions.list?.getSnapshot?.()?.ids?.includes(id)) return;
        await sessions.refresh();
        // The first result could be from a single-flight read started before
        // deletion. Retry once only if the row is still present.
        if (sessions.list.getSnapshot()?.ids?.includes(id)) await sessions.refresh();
      } catch (error) {
        console.warn('[session-cleanup] could not revalidate the session list:', error);
      }
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
        // Recheck on confirmation in case the target became active meanwhile.
        const local = localRefusal?.(sessionId);
        setRefusal(local === undefined ? '' : t(local));
        if (local !== undefined || phase !== 'confirm') {
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
                inject: () => ({ deleteSession: (id) => deleteSession(ctx, id), localRefusal }),
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
