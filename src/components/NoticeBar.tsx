import { AlertTriangle, X } from "lucide-react";
import { useStore } from "@/store";

/**
 * The sentences the main process says about work it could not do, put on
 * screen.
 *
 * Both of them — the launch that dropped queued events before the window was
 * ready, and the version probe that threw — already existed as `run:log` lines,
 * and both were therefore *only* in the drawer: a 32px strip that starts
 * collapsed, that opens by itself only for lines that look like trouble, and
 * that a reader has no reason to open on a launch where the app otherwise looks
 * fine. A sentence the app writes about its own failure cannot depend on the
 * user going to look for it.
 *
 * So the same line is also rendered here, above the working area, where it is
 * seen without being asked for and closed once it has been read. The drawer is
 * unchanged and still holds every line verbatim; closing a notice does not
 * erase the record (`clearLog` and the dismiss button are separate on purpose).
 *
 * The strip is deliberately outside `<main>`: it describes the app, not the
 * page, and it has to stay put while the user moves between 审查 / 结果 / 历史 —
 * which is exactly when a probe failure is followed up.
 */
export function NoticeBar() {
  const { notices, dismissNotice } = useStore();
  if (!notices.length) return null;

  return (
    // `role="status"` and not `alert`: these lines report something that
    // already happened, not something to act on right now, and an alert would
    // interrupt a screen reader mid-sentence on launch.
    <div role="status" aria-live="polite" className="shrink-0 border-b border-warn/25 bg-warn/10 fade-in">
      {notices.map((text) => (
        <div key={text} className="flex items-start gap-2 px-4 py-1.5">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warn" />
          {/* Wraps instead of truncating: the sentence names a count or an
              exception, and the half that gets ellipsised would be the half
              that matters. `selectable` because the reason is what a reader
              pastes into an issue. */}
          <p className="min-w-0 flex-1 text-body break-words text-ink selectable">{text}</p>
          <button
            onClick={() => dismissNotice(text)}
            aria-label="关闭这条提示"
            title="关闭这条提示（运行日志里仍然保留这一行）"
            className="-mr-1 rounded-sm p-1 text-muted transition-colors hover:bg-warn/15 hover:text-ink"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
