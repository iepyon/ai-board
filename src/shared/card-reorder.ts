// ============================================================
// 列内の並べ替え — web とテストの両方から使う純関数
// ============================================================

/** 移動先で直前・直後に来るカードの ID。`null` はその側が列の端 */
export interface MoveTarget {
  readonly after: string | null;
  readonly before: string | null;
}

/**
 * 列のカード ID の並び `ids` の中で、`draggedId` を挿入位置 `dropIndex` へ落としたときの隣。
 *
 * `dropIndex` は動かす前の並びでの挿入位置（0 = 先頭の前、`ids.length` = 末尾の後）。
 * 元の位置の直前・直後へ落としても並びは変わらないので `null` を返す。
 */
export function moveTargetFor(
  ids: readonly string[],
  draggedId: string,
  dropIndex: number
): MoveTarget | null {
  const from = ids.indexOf(draggedId);
  if (from === -1) return null;
  if (dropIndex === from || dropIndex === from + 1) return null;

  const rest = ids.filter((id) => id !== draggedId);
  const at = dropIndex > from ? dropIndex - 1 : dropIndex;

  return { after: rest[at - 1] ?? null, before: rest[at] ?? null };
}

/**
 * 全体の並び `items` の中で `id` を `target` の位置へ動かした並び。
 * サーバの応答を待たずに表示を先に並べ替えるために使う。
 */
export function applyMove<T extends { readonly id: string }>(
  items: readonly T[],
  id: string,
  target: MoveTarget
): T[] {
  const moving = items.find((item) => item.id === id);
  if (moving === undefined) return [...items];

  const rest = items.filter((item) => item.id !== id);
  const anchor = target.after ?? target.before;
  const found = rest.findIndex((item) => item.id === anchor);
  if (found < 0) return [...items];

  const index = target.after !== null ? found + 1 : found;
  return [...rest.slice(0, index), moving, ...rest.slice(index)];
}

/**
 * アイデアの表の区切り線を、並べ替えの中でカードと同じ 1 項目として指す ID。
 * `:` はカード ID（kebab-case）に使えない文字なので、どのカードとも衝突しない。
 */
export const DIVIDER_ID = ':divider';
