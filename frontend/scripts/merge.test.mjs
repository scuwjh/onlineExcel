import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 用系统临时目录，避免硬编码 "/tmp" 在 Windows 上被解析成 C:\tmp
const workDir = mkdtempSync(join(tmpdir(), "oe-merge-"));
const bundlePath = join(workDir, "merge.bundle.mjs");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}\n  got ${a}\n  exp ${e}`); }
}
const set = (s) => [...s].sort();

let normalizeRegion, regionKey, regionCellCount, regionContains, regionIntersects, regionEqual;
let regionFromIds, regionToIds, findRegionAt, mergeRegions, unmergeRegions, diffMerges;
let hiddenCells, anchorCell, clampRegion, regionLabel, sortRegions, mergesEqual;

const A1B2 = { r0: 0, c0: 0, r1: 1, c1: 1 };
const B2C3 = { r0: 1, c0: 1, r1: 2, c1: 2 };
const single = { r0: 4, c0: 4, r1: 4, c1: 4 };

try {
  await build({
    entryPoints: ["src/lib/merge.ts"],
    bundle: true,
    format: "esm",
    outfile: bundlePath,
    logLevel: "silent",
  });
  ({
    normalizeRegion, regionKey, regionCellCount, regionContains, regionIntersects, regionEqual,
    regionFromIds, regionToIds, findRegionAt, mergeRegions, unmergeRegions, diffMerges,
    hiddenCells, anchorCell, clampRegion, regionLabel, sortRegions, mergesEqual,
  } = await import(pathToFileURL(bundlePath).href));

  console.log("merge 单元测试");

  // normalizeRegion
  check("normalize 交换端点", normalizeRegion({ r0: 3, c0: 2, r1: 1, c1: 0 }), { r0: 1, c0: 0, r1: 3, c1: 2 });
  check("normalize 已规范时保持不变", normalizeRegion({ r0: 1, c0: 0, r1: 3, c1: 2 }), { r0: 1, c0: 0, r1: 3, c1: 2 });
  check("normalize 返回新对象", normalizeRegion(A1B2) === A1B2, false);

  // regionKey / regionCellCount
  check("regionKey 格式 r0:c0:r1:c1", regionKey({ r0: 0, c0: 1, r1: 2, c1: 3 }), "0:1:2:3");
  check("regionKey 端点交换后一致", regionKey({ r0: 2, c0: 3, r1: 0, c1: 1 }), "0:1:2:3");
  check("regionCellCount 2x2 为 4", regionCellCount(A1B2), 4);
  check("regionCellCount 单格为 1", regionCellCount(single), 1);

  // regionContains / regionIntersects / regionEqual / anchorCell
  check("regionContains 命中内部格", regionContains(A1B2, 1, 1), true);
  check("regionContains 命中端点", regionContains(A1B2, 0, 1), true);
  check("regionContains 未命中", regionContains(A1B2, 1, 2), false);
  check("regionIntersects 共角相交", regionIntersects(A1B2, B2C3), true);
  check("regionIntersects 相邻不相交", regionIntersects({ r0: 0, c0: 0, r1: 0, c1: 0 }, { r0: 0, c0: 2, r1: 0, c1: 2 }), false);
  check("regionEqual 端点交换视为相同", regionEqual(A1B2, { r0: 1, c0: 1, r1: 0, c1: 0 }), true);
  check("regionEqual 不同区域为假", regionEqual(A1B2, B2C3), false);
  check("anchorCell 取归一化左上角", anchorCell({ r0: 3, c0: 5, r1: 1, c1: 0 }), { row: 1, col: 0 });

  // findRegionAt
  check("findRegionAt 返回首个包含区域", findRegionAt([B2C3, A1B2], 1, 1), B2C3);
  check("findRegionAt 未命中返回 null", findRegionAt([A1B2], 9, 9), null);

  // mergeRegions
  const base = [A1B2];
  check("单格合并是 no-op", mergeRegions(base, single), base);
  check("单格合并返回入参引用", mergeRegions(base, single) === base, true);
  check("重复合并幂等返回入参引用", mergeRegions(base, A1B2) === base, true);
  check("重复合并在结果中只出现一次", mergeRegions(mergeRegions([], A1B2), A1B2), [A1B2]);
  check("相交区域被替换（A1:B2 后并 B2:C3 只剩 B2:C3）", mergeRegions([A1B2], B2C3), [B2C3]);
  check("mergeRegions 不修改入参", base, [A1B2]);
  check("不相交区域保留且新区在末尾", mergeRegions([{ r0: 0, c0: 3, r1: 0, c1: 4 }], A1B2), [{ r0: 0, c0: 3, r1: 0, c1: 4 }, A1B2]);
  check("被吞并区域多于一个时全部移除", mergeRegions([{ r0: 0, c0: 0, r1: 0, c1: 0 }, { r0: 1, c0: 1, r1: 1, c1: 1 }], A1B2), [A1B2]);

  // unmergeRegions
  check("unmerge 用区域中间格也能取消", unmergeRegions([{ r0: 0, c0: 0, r1: 2, c1: 2 }], 1, 1), []);
  check("unmerge 用区域角格也能取消", unmergeRegions([A1B2], 1, 1), []);
  check("unmerge 只移除包含该格的区域", unmergeRegions([A1B2, { r0: 5, c0: 5, r1: 6, c1: 6 }], 0, 0), [{ r0: 5, c0: 5, r1: 6, c1: 6 }]);
  check("unmerge 无变化时返回入参引用", unmergeRegions(base, 9, 9) === base, true);

  // diffMerges
  check("diffMerges 空到非空", diffMerges([], [A1B2]), { toMerge: [A1B2], toUnmerge: [] });
  check("diffMerges 非空到空", diffMerges([A1B2], []), { toMerge: [], toUnmerge: [A1B2] });
  check("diffMerges 空到空", diffMerges([], []), { toMerge: [], toUnmerge: [] });
  check("diffMerges 完全相同时无差异", diffMerges([A1B2], [A1B2]), { toMerge: [], toUnmerge: [] });
  check("diffMerges 双向差异", diffMerges([B2C3], [A1B2]), { toMerge: [A1B2], toUnmerge: [B2C3] });
  check("diffMerges toMerge 按 sortRegions 排序", diffMerges([], [B2C3, A1B2]).toMerge, [A1B2, B2C3]);
  check("diffMerges toUnmerge 按 sortRegions 排序", diffMerges([B2C3, A1B2], []).toUnmerge, [A1B2, B2C3]);
  check("diffMerges 忽略顺序视为相同", diffMerges([A1B2, B2C3], [B2C3, A1B2]), { toMerge: [], toUnmerge: [] });
  const from = [B2C3, A1B2], to = [A1B2];
  diffMerges(from, to);
  check("diffMerges 不修改入参", [from, to], [[B2C3, A1B2], [A1B2]]);

  // hiddenCells
  check("hiddenCells 不含左上角", set(hiddenCells([A1B2])), ["0:1", "1:0", "1:1"]);
  check("hiddenCells 越界单元格被跳过", set(hiddenCells([{ r0: 0, c0: 0, r1: 2, c1: 2 }], 2, 2)), ["0:1", "1:0", "1:1"]);
  check("hiddenCells 只给 rows 时按行跳过", set(hiddenCells([{ r0: 0, c0: 0, r1: 2, c1: 1 }], 2)), ["0:1", "1:0", "1:1"]);
  check("hiddenCells 重叠时先出现区域的左上角保持可见",
    set(hiddenCells([{ r0: 1, c0: 1, r1: 2, c1: 2 }, A1B2])),
    ["0:1", "1:0", "1:2", "2:1", "2:2"]);
  check("hiddenCells 无区域时为空集合", set(hiddenCells([])), []);

  // clampRegion
  check("clampRegion 裁剪越界端点", clampRegion({ r0: -2, c0: -1, r1: 9, c1: 9 }, 5, 4), { r0: 0, c0: 0, r1: 4, c1: 3 });
  check("clampRegion 部分越界时保留重叠部分", clampRegion({ r0: 2, c0: 2, r1: 9, c1: 9 }, 5, 5), { r0: 2, c0: 2, r1: 4, c1: 4 });
  check("clampRegion 下界越界返回 null", clampRegion({ r0: 10, c0: 0, r1: 11, c1: 3 }, 5, 5), null);
  check("clampRegion 裁剪后不足 2 格返回 null", clampRegion({ r0: 4, c0: 4, r1: 9, c1: 9 }, 5, 5), null);
  check("clampRegion 单格输入返回 null", clampRegion(single, 9, 9), null);
  check("clampRegion 空表返回 null", clampRegion(A1B2, 0, 0), null);
  check("clampRegion 无需裁剪时原样返回", clampRegion(A1B2, 9, 9), A1B2);

  // regionFromIds / regionToIds
  const rowIds = ["ra", "rb", "rc"];
  const colIds = ["ca", "cb", "cc"];
  check("regionFromIds 解析出下标", regionFromIds({ r0: "ra", c0: "cb", r1: "rc", c1: "cc" }, rowIds, colIds), { r0: 0, c0: 1, r1: 2, c1: 2 });
  check("regionFromIds 缺 ID 返回 null", regionFromIds({ r0: "ra", c0: "cb", r1: "rX", c1: "cc" }, rowIds, colIds), null);
  check("regionFromIds 缺列 ID 返回 null", regionFromIds({ r0: "ra", c0: "cX", r1: "rc", c1: "cc" }, rowIds, colIds), null);
  check("regionFromIds 端点反序已归一", regionFromIds({ r0: "rc", c0: "cc", r1: "ra", c1: "ca" }, rowIds, colIds), { r0: 0, c0: 0, r1: 2, c1: 2 });
  check("regionToIds 下标越界返回 null", regionToIds({ r0: 0, c0: 0, r1: 3, c1: 0 }, rowIds, colIds), null);
  check("regionToIds 列下标越界返回 null", regionToIds({ r0: 0, c0: 0, r1: 1, c1: 3 }, rowIds, colIds), null);
  check("regionToIds 正常解析", regionToIds({ r0: 0, c0: 1, r1: 2, c1: 2 }, rowIds, colIds), { r0: "ra", c0: "cb", r1: "rc", c1: "cc" });
  check("ids 往返一致（ids->下标->ids）",
    regionToIds(regionFromIds({ r0: "ra", c0: "cb", r1: "rc", c1: "cc" }, rowIds, colIds), rowIds, colIds),
    { r0: "ra", c0: "cb", r1: "rc", c1: "cc" });
  check("ids 往返一致（下标->ids->下标）",
    regionFromIds(regionToIds(A1B2, rowIds, colIds), rowIds, colIds),
    A1B2);

  // regionLabel
  check("regionLabel 矩形 A1:B2", regionLabel({ r0: 0, c0: 0, r1: 1, c1: 1 }), "A1:B2");
  check("regionLabel 单格 A1", regionLabel({ r0: 0, c0: 0, r1: 0, c1: 0 }), "A1");
  check("regionLabel 第 27 列 AA1:AB1", regionLabel({ r0: 0, c0: 26, r1: 0, c1: 27 }), "AA1:AB1");
  check("regionLabel 跨 Z/AA 边界", regionLabel({ r0: 0, c0: 25, r1: 0, c1: 26 }), "Z1:AA1");
  check("regionLabel 第 28 列 AB1", regionLabel({ r0: 0, c0: 27, r1: 0, c1: 27 }), "AB1");
  check("regionLabel 大列号 AAA1", regionLabel({ r0: 0, c0: 702, r1: 0, c1: 702 }), "AAA1");

  // sortRegions / mergesEqual
  check("sortRegions 按 r0,c0,r1,c1 升序", sortRegions([B2C3, A1B2]), [A1B2, B2C3]);
  check("sortRegions 先比 r0 再比 c0", sortRegions([{ r0: 1, c0: 0, r1: 1, c1: 0 }, { r0: 0, c0: 2, r1: 0, c1: 3 }]), [{ r0: 0, c0: 2, r1: 0, c1: 3 }, { r0: 1, c0: 0, r1: 1, c1: 0 }]);
  const unsorted = [B2C3, A1B2];
  sortRegions(unsorted);
  check("sortRegions 不修改入参", unsorted, [B2C3, A1B2]);
  check("mergesEqual 顺序不同但集合相同为真", mergesEqual([B2C3, A1B2], [A1B2, B2C3]), true);
  check("mergesEqual 长度不同为假", mergesEqual([A1B2], []), false);
  check("mergesEqual 元素不同为假", mergesEqual([A1B2], [B2C3]), false);
  check("mergesEqual 空数组相等", mergesEqual([], []), true);
  const left = [B2C3, A1B2], right = [A1B2, B2C3];
  mergesEqual(left, right);
  check("mergesEqual 不修改入参", [left, right], [[B2C3, A1B2], [A1B2, B2C3]]);

  console.log(`\n${pass} 通过, ${fail} 失败`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(fail ? 1 : 0);
