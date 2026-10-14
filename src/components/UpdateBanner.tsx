import { Download, RefreshCw, XCircle, ExternalLink, Info } from "lucide-react";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";

/**
 * Slim strip shown only while an update actually needs the user's attention.
 * A launch check that finds nothing stays silent by design.
 */
export function UpdateBanner() {
  const { update, installUpdate, ignoreUpdate, openReleases } = useStore();
  if (!update) return null;

  const { phase, version } = update;
  if (phase !== "downloading" && phase !== "ready" && phase !== "manual") return null;
  if (phase === "manual" && !update.message && !version) return null;

  const copy =
    phase === "downloading"
      ? `正在下载 v${version}… ${update.percent ?? 0}%（${update.transferred ?? 0} / ${update.total ?? 0} MB）`
      : phase === "ready"
        ? `v${version} 已下载完成，重启后生效`
        : `这个版本无法自动更新${version ? `（v${version}）` : ""}，请到下载页取安装包`;

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-accent/25 bg-accent-soft px-4 py-2 text-body text-ink fade-in">
      {phase === "downloading" ? <Download className="size-3.5 text-accent" /> : <RefreshCw className="size-3.5 text-accent" />}
      <span className="tnum min-w-0 flex-1 truncate">{copy}</span>
      {phase === "ready" && (
        <>
          <Button variant="primary" size="sm" onClick={() => void installUpdate()}>
            重启并更新
          </Button>
          {/* "稍后" was the label, but the choice is written to settings and
              survives restarts — the version is skipped, not deferred. Say so. */}
          <Button variant="ghost" size="sm" onClick={() => void ignoreUpdate()}>
            忽略此版本
          </Button>
        </>
      )}
      {phase === "manual" && (
        <Button variant="outline" size="sm" onClick={() => void openReleases()}>
          <ExternalLink className="size-3.5" />
          打开下载页
        </Button>
      )}
    </div>
  );
}

export function UpdateStatusLine() {
  const { update, openReleases } = useStore();
  const phase = update?.phase ?? "idle";
  if (phase === "no-release") {
    return (
      <span className="flex items-center gap-1.5 text-meta text-warn">
        <Info className="size-3.5" />
        更新渠道尚无任何发布
        <button className="link text-accent" onClick={() => void openReleases()}>
          打开下载页
        </button>
      </span>
    );
  }
  if (phase === "error") {
    return (
      <span className="flex items-center gap-1.5 text-meta text-bad">
        <XCircle className="size-3.5" />
        检查失败：{update?.message?.slice(0, 70) || "未知错误"}
        <button className="link text-accent" onClick={() => void openReleases()}>
          打开下载页
        </button>
      </span>
    );
  }
  // `suppressed` carries its own sentence. Appending "（该版本已忽略）" to the
  // phase text produced "还没检查过更新（该版本已忽略）" — the opposite of what
  // happened, and a state that was unreachable until the ignore path was fixed.
  if (update?.suppressed) {
    return (
      <span className="text-meta text-muted">
        已忽略 v{update.version ?? ""}，不再提示这个版本
      </span>
    );
  }
  const map: Record<string, string> = {
    idle: "还没检查过更新",
    checking: "正在检查…",
    downloading: `正在下载 v${update?.version ?? ""} ${update?.percent ?? 0}%`,
    ready: `v${update?.version ?? ""} 已就绪，重启生效`,
    "up-to-date": `已是最新版（v${update?.version ?? ""}）`,
    manual: "当前形态不支持自动更新",
    "no-release": "更新渠道尚无任何发布",
    unsupported: "开发模式下不检查更新",
  };
  return <span className="text-meta text-muted">{map[phase] ?? "—"}</span>;
}
