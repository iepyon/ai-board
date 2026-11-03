// ============================================================
// HTML に文字を埋め込むときの扱い（status --html とそのグラフで共有する）
// ============================================================

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** 本文・属性のどちらに埋め込んでも安全な形にする */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}
