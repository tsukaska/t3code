// @effect-diagnostics globalTimers:off globalDate:off - The tracker runs in atom subscriptions, outside an Effect runtime.
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { parseThreadKey, threadKey } from "./entities.ts";
import { type AtomCommand, runAtomCommand } from "./runtime.ts";
import { claimThreadOpen } from "./threadSearch.ts";
import type { VisitThreadInput } from "./threadCommands.ts";

// During an active turn the thread's updatedAt advances several times per
// second, and every server-side visit is a full command dispatch plus a
// broadcast to all shell subscribers.
export const VISIT_DISPATCH_THROTTLE_MS = 10_000;

interface VisitedShell {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly updatedAt: string;
  readonly lastVisitedAt?: string | null | undefined;
  readonly latestRun: { readonly completedAt: string | null } | null;
}

export interface ThreadVisitTrackerOptions {
  readonly threadShellAtom: (ref: ScopedThreadRef) => Atom.Atom<VisitedShell | null>;
  readonly visit: AtomCommand<
    { readonly environmentId: EnvironmentId; readonly input: VisitThreadInput },
    unknown,
    unknown
  >;
  /**
   * Servers without visit tracking leave `lastVisitedAt` undefined; a client
   * that keeps its own watermark for them records the visit here instead.
   */
  readonly markLocalVisit?: (ref: ScopedThreadRef, visitedAt: string) => void;
}

/**
 * While mounted, a tracker counts as the user viewing the thread: mounting it
 * records one open (which also feeds search ranking), and every shell update
 * after that advances the visit watermark, throttled while a run streams.
 */
export function createThreadVisitTracker(options: ThreadVisitTrackerOptions) {
  const family = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    return Atom.make((get) => {
      const registry = get.registry;
      let openRecorded = false;
      // Dedupe per watermark: the shell updates again before the command's echo
      // lands. It also keeps a mark-unread on the open thread sticky, since the
      // rewind leaves updatedAt untouched.
      let lastDispatchedUpdatedAt: string | null = null;
      let lastDispatchAt = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clearTimer = () => {
        if (timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
      };
      get.addFinalizer(clearTimer);

      const dispatch = (shell: VisitedShell, opened: boolean) => {
        clearTimer();
        lastDispatchedUpdatedAt = shell.updatedAt;
        lastDispatchAt = Date.now();
        void runAtomCommand(
          registry,
          options.visit,
          {
            environmentId: shell.environmentId,
            input: {
              threadId: shell.id,
              visitedAt: shell.updatedAt,
              ...(opened ? { opened: true } : {}),
            },
          },
          { reportFailure: false },
        );
      };

      const onShell = (shell: VisitedShell | null) => {
        clearTimer();
        if (shell === null) return;
        if (!openRecorded) {
          openRecorded = true;
          // Recorded even when the server cannot take opens, so recents follow
          // it. A palette pick already sent the open with its query.
          const claimed = claimThreadOpen(shell.environmentId, shell.id, Date.now());
          if (claimed && shell.lastVisitedAt !== undefined) dispatch(shell, true);
        }

        const updatedAtMs = Date.parse(shell.updatedAt);
        if (Number.isNaN(updatedAtMs)) return;
        if (shell.lastVisitedAt === undefined) {
          options.markLocalVisit?.(ref, shell.updatedAt);
          return;
        }
        const lastVisitedAtMs = shell.lastVisitedAt ? Date.parse(shell.lastVisitedAt) : NaN;
        if (!Number.isNaN(lastVisitedAtMs) && lastVisitedAtMs >= updatedAtMs) return;
        if (lastDispatchedUpdatedAt === shell.updatedAt) return;

        const completedAtMs = shell.latestRun?.completedAt
          ? Date.parse(shell.latestRun.completedAt)
          : NaN;
        const hasUnseenCompletion =
          !Number.isNaN(completedAtMs) &&
          (Number.isNaN(lastVisitedAtMs) || completedAtMs > lastVisitedAtMs);
        const elapsed = Date.now() - lastDispatchAt;
        if (hasUnseenCompletion || elapsed >= VISIT_DISPATCH_THROTTLE_MS) {
          dispatch(shell, false);
          return;
        }
        timer = setTimeout(() => dispatch(shell, false), VISIT_DISPATCH_THROTTLE_MS - elapsed);
      };

      // `subscribe`, not `get`: a rebuild would reset the open and throttle
      // state on every streaming tick.
      get.subscribe(options.threadShellAtom(ref), onShell, { immediate: true });
    }).pipe(Atom.withLabel(`thread-visit-tracker:${key}`));
  });
  return (ref: ScopedThreadRef) => family(threadKey(ref));
}
