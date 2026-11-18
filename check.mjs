#!/usr/bin/env node
/**
 * 装完自检：跑 `node check.mjs` 就知道成没成。
 *
 * 只读，不改任何东西。四项：
 *   1 插件在不在 node_modules
 *   2 bundles 里有没有它
 *   3 数据目录生成了没有（说明它真被加载过）
 *   4 core 里有没有内容（空的话注入也没用）
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

const HOME = homedir();
const PROFILES = join(HOME, ".dsh", "profiles");
const DATA = join(HOME, ".dsh", "memory-kit");

let bad = 0;
const ok = (s) => console.log("  [OK]   " + s);
const no = (s) => { bad++; console.log("  [!!]   " + s); };
const info = (s) => console.log("         " + s);

function findProfiles() {
  if (!existsSync(PROFILES)) return [];
  return readdirSync(PROFILES).filter((n) => existsSync(join(PROFILES, n, "package.json")));
}

console.log("dsh-memory-kit 自检\n");

// ---- 0. 判据自检（不需要宿主，纯函数，改了会立刻露） ----
// 2026-11-18 补：出处分 hard / soft 两级 + 光时间戳必拒。
// 起因：白饭馆轻影那条「不许判词冒充依据」—— 不是不能写判词，是不许它长得像依据。
try {
  const mod = await import(pathToFileURL(join(fileURLToPath(new URL(".", import.meta.url)), "lib", "index.js")).href);
  const { srcOk, srcKind } = mod;
  const cases = [
    ["#189 的评论", "hard"],
    ["https://github.com/pianVei/rice-bowl/issues/189", "hard"],
    ["C:/Users/CHENG/aurabot/qq-chats/问题清单/工作.md", "hard"],
    ["第 1720 轮", "hard"],
    ["BV17Vxm6FEqy", "hard"],
    ["转述：老大昨天说过大概这个意思", "soft"],
  ];
  let wrong = 0;
  for (const [src, want] of cases) {
    const got = srcKind(src);
    if (got !== want) { wrong++; no("来源分级错：" + src + " 判成 " + (got || "空") + "，该是 " + want); }
  }
  if (!wrong) ok("来源分级 " + cases.length + " 条全对（hard / soft）");
  // 光时间戳必须拒
  if (srcOk("11-18 21:30")) no("光时间戳居然通过了：「11-18 21:30」");
  else ok("光时间戳被拒（时间戳说明不了这话从哪来）");
} catch (e) {
  no("判据自检跑不起来：" + (e && e.message));
}
console.log();

const profiles = findProfiles();
if (!profiles.length) {
  no("找不到任何 profile：" + PROFILES);
  process.exit(1);
}
info("profile：" + profiles.join(", "));
console.log();

for (const p of profiles) {
  const base = join(PROFILES, p);
  const nm = join(base, "node_modules", "dsh-memory-kit");
  const hasPkg = existsSync(join(nm, "package.json"));
  const hasCode = existsSync(join(nm, "lib", "index.js"));

  if (hasPkg && hasCode) ok(`${p}：插件文件在`);
  else no(`${p}：没找到 ${nm}（复制过去了吗）`);

  let inBundles = false;
  try {
    const j = JSON.parse(readFileSync(join(base, "package.json"), "utf8"));
    const b = j?.dsh?.profile?.bundles;
    inBundles = Array.isArray(b) && b.includes("dsh-memory-kit");
    if (!Array.isArray(b)) no(`${p}：package.json 里找不到 dsh.profile.bundles`);
  } catch (e) {
    no(`${p}：package.json 读不了（${e.message}）——八成一个逗号漏了，DSH 会起不来`);
  }
  if (inBundles) ok(`${p}：bundles 里有 dsh-memory-kit`);
  else if (existsSync(join(base, "package.json"))) no(`${p}：bundles 里没加 "dsh-memory-kit"`);
}

console.log();

if (existsSync(DATA)) {
  ok("数据目录已生成：它被加载过（至少启动时跑到了）");
  const core = join(DATA, "core.md");
  const topics = join(DATA, "topics");
  if (existsSync(core)) {
    const t = readFileSync(core, "utf8");
    const body = t
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith("#") && !l.trim().startsWith(">"))
      .join("");
    if (body.length > 20) ok(`core.md 有内容（${body.length} 字）`);
    else no("core.md 还是空的模板——注入进去了也是空的，先把身份和硬规矩写进去");
  } else no("core.md 没生成");
  if (existsSync(topics)) {
    const n = readdirSync(topics).filter((f) => f.endsWith(".md")).length;
    ok(`topics/ 里有 ${n} 个主题`);
  } else info("topics/ 还没建（第一次写主题时会有）");
} else {
  no("数据目录 " + DATA + " 不存在——插件没被加载，或者还没重启 DSH");
}

// 真跑一遍 apply：用假 ctx 看四个工具能不能 register。
// 这一步验的是「注册」，不是「文件在」——两者差别见上面那段。
console.log("跑一遍 apply（假 ctx）：");
let registered = [];
try {
  // 优先验「装到 profile 的那份」；没有就验脚本自己所在目录（仓库版）。
  // 验的是代码本身能不能跑通 apply，不是它装在哪。
  const scriptDir = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    join(PROFILES, profiles[0], "node_modules", "dsh-memory-kit", "lib", "index.js"),
    join(scriptDir, "lib", "index.js"),
  ];
  const target = candidates.find((p) => existsSync(p));
  if (!target) throw new Error("找不到要验的 index.js");
  info("验的是：" + target);
  const mod = await import(pathToFileURL(target).href);
  const fake = {
    systemPrompt: { add: () => {} },
    tools: { register: (t) => registered.push(t?.name || "?") },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  await mod.apply(fake);
  const fell = (typeof mod.apply === "function" && fake.__fell !== undefined) ? fake.__fell : null;
  if (registered.length === 4) {
    ok("apply 跑完，注册到：" + registered.join(", "));
    // 「注册到 4 个」有两种可能：四个都是真的，或者四个都是回退出来的壳。
    // 这里如果导不到真 defineTool，那就是后者——必须说清楚，不然就是假绿。
    info("注意：这一轮是在假 ctx、没有真 defineTool 的环境里跑的。");
    info("所以这 4 个是「壳」，只能说明 apply 没抛、名字对得上；");
    info("说明不了宿主里真注册成功。那一步只能开新会话真调一次。");
  } else {
    no("apply 跑完但只注册了 " + registered.length + " 个（" + registered.join(", ") + "）");
  }
} catch (e) {
  no("apply 抛了：" + (e && e.message));
}

// 探针：有没有人真的调过 memory_read。
// 这一项跟前四项不一样——前四项验的是「东西在」，这一项验的是「它被用过」。
const probeLog = join(DATA, "probe.log");
if (existsSync(probeLog)) {
  const lines = readFileSync(probeLog, "utf8").trim().split("\n").filter(Boolean);
  const last = lines[lines.length - 1] || "";
  ok(`有人调过 memory_read（${lines.length} 次，最近：${last.slice(0, 19)}）`);
} else {
  info("probe.log 还没有——说明装了到现在还没人调过 memory_read。这是「装上了但没用过」，不是「装错了」。");
}

console.log();
if (bad === 0) {
  console.log("文件层面四项都过了。但它们说明不了「工具真注册上了」——");
  console.log("白饭馆 #217 里 Deepglm 实测过：import 成功、exports 也对，宿主里四个工具仍然一个没注册。");
  console.log("真正算过的只有一步：开一个新会话说「用 memory_read 读一下你的记忆」，看它会不会真调工具。");
  console.log("答不出 → 先看宿主日志有没有 already registered（撞名），再看 apply 里有没有 defineTool 抛错。");
} else {
  console.log(`有 ${bad} 项没过，照着上面 [!!] 那几行改，改完重启 DSH 再跑一次。`);
  process.exitCode = 1;
}
