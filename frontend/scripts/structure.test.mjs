import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 用系统临时目录，避免硬编码 "/tmp" 在 Windows 上被解析成 C:\tmp
const workDir = mkdtempSync(join(tmpdir(), "oe-structure-"));
const bundlePath = join(workDir, "structure.bundle.mjs");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}\n  got ${a}\n  exp ${e}`); }
}
function apply(from, ops) {
  const ids = [...from];
  for (const op of ops) {
    if (op.type.endsWith("delete")) {
      const i = ids.indexOf(op.element_id);
      if (i >= 0) ids.splice(i, 1);
    } else {
      if (ids.includes(op.element_id)) continue;
      const at = Math.max(0, Math.min(ids.length, op.at));
      ids.splice(at, 0, op.element_id);
    }
  }
  return ids;
}
function roundtrip(name, from, to, axis) {
  const ops = structureDeltas(from, to, axis);
  check(`${name} -> 迁移结果一致`, apply(from, ops), to);
  const firstDel = ops.findIndex(o => o.type.endsWith("delete"));
  const firstIns = ops.findIndex(o => o.type.endsWith("insert"));
  check(`${name} -> 删除先于插入`, firstDel === -1 || firstIns === -1 || firstDel < firstIns, true);
}

let structureDeltas;
try {
  await build({
    entryPoints: ["src/lib/structure.ts"],
    bundle: true,
    format: "esm",
    outfile: bundlePath,
    logLevel: "silent",
  });
  ({ structureDeltas } = await import(pathToFileURL(bundlePath).href));

  console.log("structureDeltas 单元测试");
  roundtrip("无变化", ["r1","r2","r3"], ["r1","r2","r3"], "row");
  roundtrip("删两行", ["r1","r2","r3","r4"], ["r1","r4"], "row");
  roundtrip("中间插行", ["r1","r2"], ["r1","r9","r2"], "row");
  roundtrip("头部插行", ["r1","r2"], ["r9","r1","r2"], "row");
  roundtrip("尾部插行", ["r1","r2"], ["r1","r2","r9"], "row");
  roundtrip("先删后插", ["r1","r2","r3"], ["r1","r3","r9"], "row");
  roundtrip("多列混合", ["c1","c2","c3","c4"], ["c1","c8","c4"], "col");
  roundtrip("撤销插行(删回)", ["r1","r9","r2"], ["r1","r2"], "row");
  roundtrip("撤销删行(插回)", ["r1","r2"], ["r1","r9","r2"], "row");
  roundtrip("连续插入两个", ["r1"], ["r8","r1","r9"], "row");

  const ops = structureDeltas(["r1","r2"], ["r1","r5","r2"], "row");
  check("插入携带目标 ID", ops.filter(o => o.type.endsWith("insert")).map(o => o.element_id), ["r5"]);

  console.log(`\n${pass} 通过, ${fail} 失败`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(fail ? 1 : 0);
