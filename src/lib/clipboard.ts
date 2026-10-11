import { toast } from "sonner";

/**
 * `navigator.clipboard.writeText` rejects when the document isn't focused (and
 * on some permission configurations), so every copy site needs the same
 * handling. Before this, a refused copy simply did nothing and the user was left
 * clicking a button that appeared broken.
 */
export async function copyText(text: string, what: string, hint?: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`已复制${what}`, hint ? { description: hint } : undefined);
    return true;
  } catch (err) {
    toast.error("复制失败", { description: String((err as Error)?.message || err) });
    return false;
  }
}
