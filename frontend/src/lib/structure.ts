/**
 * 结构迁移工具：把行/列元素序列从当前状态迁移到目标状态所需的最小操作序列。
 *
 * 撤销/重做结构操作（插入/删除行列）时，不能按索引回放（并发下索引会漂移），
 * 必须按稳定元素 ID 精确回放。本模块计算"先删后插"的操作序列。
 */

export type StructureOp =
  | { type: "row_insert" | "col_insert"; at: number; element_id: string }
  | { type: "row_delete" | "col_delete"; element_id: string };

/**
 * 计算从 ``from`` 元素序列迁移到 ``to`` 所需的操作序列（先删后插，保持相对顺序）。
 * 删除按元素 ID 精确匹配；插入按最终顺序计算位置，并携带目标元素 ID
 * （服务端接受显式 ID，重复插入幂等跳过）。
 */
export function structureDeltas(from: string[], to: string[], axis: "row" | "col"): StructureOp[] {
  const prefix = axis === "row" ? "row_" : "col_";
  const ops: StructureOp[] = [];
  const working = from.filter((id) => to.includes(id));
  for (const id of from) {
    if (!to.includes(id)) ops.push({ type: `${prefix}delete`, element_id: id });
  }
  for (const id of to) {
    if (from.includes(id)) continue;
    // 最终顺序里排在它前面、且当前已存在于工作集里的元素个数 = 它的插入位置
    const at = to.slice(0, to.indexOf(id)).filter((x) => working.includes(x)).length;
    ops.push({ type: `${prefix}insert`, at, element_id: id });
    working.splice(at, 0, id);
  }
  return ops;
}