/**
 * dsh-memory-kit —— 分层记忆：core + topics + 实体别名 + 事实层。
 *
 * 设计只有一句：**每轮只注入 core（几百字），其余全靠它自己按需读。**
 * 不做向量、不做自动摘要、不写云端——这三样是「装不上」和「装上了不敢信」的主要来源。
 *
 * 数据目录（默认 ~/.dsh/memory-kit/）：
 *   core.md          身份和硬规矩，每轮注入
 *   topics/*.md      一件一件事，第一个 # 标题当标题、第一个正文行当摘要
 *   entities.json    {"entities":[{id,name,aliases[],props{}}]}
 *   facts.jsonl      一行一条事实，来源必须能指回具体东西
 *   corpus.md        可选的原文（memory_past 在里面搜）
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/**
 * 拿 defineTool，拿不到就用本地替身。
 *
 * 为什么要有这一步：`@deepseek-ai/dsh-tools` 在有些宿主里解析不到（白饭馆 #217 里
 * dafeiyu-lamp、Deepglm 都实测过 ERR_MODULE_NOT_FOUND），插件本身没问题、是包不在
 * 解析路径上。原来写成顶层静态 import，一解析不到整个插件就死，连 core 注入都没了。
 * 替身只做一件事：原样返回传入的对象。dsh 的 defineTool 本来就主要用来给类型和注册
 * 信息，工具真正注册走的是 ctx.tools.register()，所以替身够用。
 */
let defineTool;
let defineToolReal = false;
try {
  ({ defineTool } = await import("@deepseek-ai/dsh-tools"));
  defineToolReal = true;
} catch {
  defineTool = (spec) => spec;
}

/** 真 defineTool 抛错（比如 spec 缺字段）时退回原样返回，别让整段 apply 死掉。 */
let defineToolFell = 0; // 回退了几次。0 = 四个都是真的。

function safeDefineTool(spec) {
  if (!defineToolReal) {
    defineToolFell++;
    return spec;
  }
  try {
    return defineTool(spec);
  } catch (e) {
    // 不能只是吞掉。吞掉的话「回退成原样」和「真注册成功」长得一模一样，
    // 自检会报「四个都注上了」——那就是白饭馆里说的假绿。
    defineToolFell++;
    console.error('[memory-kit] defineTool 抛错（这个工具没真正注册）：'
      + (spec && spec.name) + ' -> ' + (e && e.message));
    return spec;
  }
}

/** Cordis 插件名。 */
const name = "memory-kit";
/** 需要的宿主服务。 */
const inject = ["systemPrompt", "tools"];

const DEFAULT_ROOT = join(homedir(), ".dsh", "memory-kit");
const MAX_INJECT = 4000; // core 注入预算（字符）。按段装，超预算的段整段不进。
const MAX_CORE_SEGS = 24; // core 段数上限。超了从末尾挤掉，挤谁写进 core-trim.log。
const MAX_READ = 20000;
const MAX_PAST_HITS = 5;

/* ------------------------------ 文件层 ------------------------------ */

function ensure(root) {
  for (const d of [root, join(root, "topics")]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
  const core = join(root, "core.md");
  if (!existsSync(core)) {
    writeFileSync(
      core,
      [
        "# 核心记忆",
        "",
        "> 这里放身份、称呼、硬规矩、常去的路径。几百字就够——每轮都会注入，写长了是白花钱。",
        "> 一件一件事写进 topics/<key>.md，用 memory_read(topic) 读。",
        "",
        "## 我",
        "",
        "- 我的名字：",
        "- 对方怎么称呼我：",
        "",
        "## 硬规矩",
        "",
        "- ",
        "",
      ].join("\n"),
      "utf8",
    );
  }
  const ent = join(root, "entities.json");
  if (!existsSync(ent)) writeTextAtomic(ent, JSON.stringify({ entities: [] }, null, 2));
  for (const f of ["facts.jsonl", "corpus.md"]) {
    const p = join(root, f);
    if (!existsSync(p)) writeFileSync(p, "", "utf8");
  }
}

function readText(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/** 探针：只有这个工具真被人调到了，才会写这一行。

    为什么要有它：白饭馆 #217 里 Noir-Whale 那条判据——「造一个只有它
    正常工作时才会响的动作」。文件在、bundles 里有、apply 没抛，这些都
    可能在「没注册上」的情况下同时成立（Deepglm 实测过）。真正算过的只有
    一次真的调用。所以每次 memory_read 被调到，就在 probe.log 留一行。
    装了但没人调过 → 文件不存在。跑通了 → 有时间戳和 pid。
 */
function probe(root) {
  try {
    const line = `${new Date().toISOString()} pid=${process.pid} memory_read\n`;
    appendFileSync(join(root, "probe.log"), line, "utf8");
  } catch {
    /* 探针写不进去不能影响读记忆 */
  }
}

/** 先写 .tmp 再改名。断电/崩溃时坏的是 .tmp，不是正在用的那份。 */
function writeTextAtomic(p, s) {
  const tmp = p + ".tmp";
  writeFileSync(tmp, s, "utf8");
  renameSync(tmp, p);
}

/** topic 文件：第一个 # 当标题，第一个非标题非注释行当摘要。 */
function topicMeta(text, key) {
  const lines = text.split(/\r?\n/);
  let title = key;
  let summary = "";
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith("#")) {
      if (title === key) title = l.replace(/^#+\s*/, "").trim() || key;
      continue;
    }
    if (l.startsWith(">")) continue;
    summary = l.replace(/[*`]/g, "").slice(0, 160);
    break;
  }
  return { title, summary };
}

function topicIndex(root) {
  const dir = join(root, "topics");
  if (!existsSync(dir)) return "";
  const keys = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  if (!keys.length) return "";
  const rows = keys.map((f) => {
    const key = f.replace(/\.md$/, "");
    const { title, summary } = topicMeta(readText(join(dir, f)), key);
    return `- \`${key}\` — ${title}${summary ? "：" + summary : ""}`;
  });
  return ["## 主题记忆索引", "用 memory_read(topic) 读全文。", "", ...rows].join("\n");
}

/** core 按空行切段。段是记忆的单位，切半个段比少一段更容易骗人。 */
function splitSegs(md) {
  return String(md || "")
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * core 也要有出口。
 * 只进不出的 core 迟早把最早的段挤掉，而挤掉的时候没人知道。
 * 这里：段数超上限就从末尾丢（前面是身份和硬规矩），丢谁写进 core-trim.log。
 */
function trimCore(root, segs) {
  if (segs.length <= MAX_CORE_SEGS) return segs;
  // 保首尾、挤中间。
  // 只从末尾丢是个坑（鲸鱼娘指出的）：丢掉的正好是最新的那几段——
  // 保住了「我是谁」，保不住「我最近干了什么」。头两段是身份和硬规矩，末两段是最近的。
  const HEAD = 2;
  const TAIL = 2;
  const keepHead = segs.slice(0, HEAD);
  const keepTail = segs.slice(-TAIL);
  const middle = segs.slice(HEAD, segs.length - TAIL);
  const room = Math.max(0, MAX_CORE_SEGS - HEAD - TAIL);
  const dropped = middle.slice(room);
  const keep = [...keepHead, ...middle.slice(0, room), ...keepTail];
  const head = (s) => s.split("\n")[0].replace(/^#+\s*/, "").slice(0, 30);
  const lines = dropped.map(
    (s) => `${new Date().toISOString().slice(0, 16).replace("T", " ")} 挤掉一段：${head(s)}`
  );
  try {
    appendFileSync(join(root, "core-trim.log"), lines.join("\n") + "\n", "utf8");
  } catch {
    /* 日志写不进去不影响注入 */
  }
  return keep;
}

/** 最近记的三条事实。core 从末尾丢时先丢的是「最近」，这段不参加挤出。 */
function recentFacts(root, n) {
  const p = join(root, "facts.jsonl");
  if (!existsSync(p)) return "";
  let lines = [];
  try {
    lines = readText(p).split("\n").filter((x) => x.trim()).slice(-n * 2);
  } catch {
    return "";
  }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    try {
      const f = JSON.parse(lines[i]);
      const s = f.s || f.subject || "";
      const a = f.a || f.action || "";
      const o = f.o || f.object || "";
      const at = String(f.at || "").slice(0, 10);
      if (s || o) out.push(`- ${at} ${s} ${a} ${o}`.trim());
    } catch {
      /* 坏行跳过 */
    }
  }
  if (!out.length) return "";
  return ["## 最近记的（不参加挤出）", ...out].join("\n");
}

function coreText(root) {
  const segs = trimCore(root, splitSegs(readText(join(root, "core.md"))));
  const idx = topicIndex(root);

  // 按段装，超预算的段整段不进，不切半段。
  // 但第一段必须留：那是身份和硬规矩。它自己超预算时也留（宁可超），
  // 因为「空的 core」比「半段」更坏——看着像这台机器没配置，没人会去查是没配还是被丢光了。
  const picked = [];
  let used = 0;
  let skipped = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const pinned = i === 0;
    if (pinned || used + seg.length + 2 <= MAX_INJECT) {
      picked.push(seg);
      used += seg.length + 2;
    } else {
      skipped++;
    }
  }
  if (idx && used + idx.length + 2 <= MAX_INJECT) {
    picked.push(idx);
    used += idx.length + 2;
  }

  // 「最近」区：core 从末尾丢的时候，丢掉的正好是最新的那些。
  // 这一段不参加挤出，只补三条最近的事实进来，让「我最近干了什么」不至于先没。
  const recent = recentFacts(root, 3);
  if (recent && used + recent.length + 2 <= MAX_INJECT + 600) {
    picked.push(recent);
    used += recent.length + 2;
  }

  const body = picked.join("\n\n");
  if (!body.trim()) return "";
  if (skipped === 0 && segs.length === picked.length) return body;
  return (
    body +
    `\n\n（core 有 ${skipped} 段没装进来，主题索引${idx && !picked.includes(idx) ? "也没" : "已"}在。要读全用 memory_read()。）`
  );
}

function loadEntities(root) {
  try {
    const j = JSON.parse(readText(join(root, "entities.json")) || "{}");
    return Array.isArray(j.entities) ? j.entities : [];
  } catch {
    return [];
  }
}

function saveEntities(root, list) {
  writeTextAtomic(join(root, "entities.json"), JSON.stringify({ entities: list }, null, 2));
}

/**
 * 实体网的写入入口。
 *
 * 原来 entities.json 只能读、只能给已存在的实体加别名——装完就是空的，
 * 得手写。白饭馆 Deepglm 说这跟「实体网」这个说法有出入，说得对。
 *
 * 但不能见一个名字就建一个：流水账里每个只出现一次的名字都会变成实体，
 * 网就变成垃圾桶了。所以分两步：
 *   第一次见到 → 记进 entity-candidates.jsonl，算一票
 *   攒够 MIN_MENTIONS 票 → 才真的建成实体
 * 票数是幂等的：同一个名字在一次运行里问几遍都只算一票（按天去重）。
 */
const MIN_MENTIONS = 3;

function growEntities(root, names) {
  const list = loadEntities(root);
  const candPath = join(root, "entity-candidates.jsonl");
  const today = new Date().toISOString().slice(0, 10);

  // 读候选：{ name: { count, days: [..], first } }
  const cand = {};
  try {
    for (const ln of readText(candPath).split("\n")) {
      if (!ln.trim()) continue;
      const o = JSON.parse(ln);
      if (o && o.name) cand[String(o.name).toLowerCase()] = { name: o.name, count: o.count || 1, days: o.days || [] };
    }
  } catch {
    /* 坏行跳过 */
  }

  const born = [];
  for (const raw of names) {
    const name = String(raw || "").trim();
    if (!name || name.length < 2 || name.length > 24) continue;
    if (resolveEntity(list, name)) continue; // 已经认识
    const key = name.toLowerCase();
    const c = cand[key] || { name, count: 0, days: [] };
    // 按天计票（一天最多一票），攒够 3 天才转正。
    // 原来我写成「同一天重复提到也只算一票」，测出来要三天才长出一个实体——太慢。
    // 改回每天一票、同一天不重复计：一次性的名字永远攒不到 3，真的会反复出现的才长得出来。
    if (!c.days.includes(today)) c.days.push(today);
    c.count = c.days.length;
    c.name = name;
    cand[key] = c;
    if (c.count >= MIN_MENTIONS) {
      list.push({ id: key.replace(/\s+/g, "-"), name, kind: "person", aliases: [], auto: true });
      born.push(name);
      delete cand[key];
    }
  }

  // 落盘：新实体 + 候选（候选整体重写，只留没转正的）
  if (born.length) saveEntities(root, list);
  const lines = Object.values(cand)
    .map((c) => JSON.stringify({ name: c.name, count: c.count, days: c.days.slice(-5) }))
    .join("\n");
  writeTextAtomic(candPath, lines ? lines + "\n" : "");

  return { born, pending: Object.keys(cand).length };
}

/** 名字 → 实体。长别名优先，避免 pizza 被 piz 吃掉。 */function resolveEntity(list, q) {
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) return null;
  let best = null;
  let bestLen = 0;
  for (const e of list) {
    const names = [e.id, e.name, ...(e.aliases || [])].filter(Boolean).map((x) => String(x).toLowerCase());
    for (const n of names) {
      if (!n) continue;
      if (needle === n || needle.includes(n) || n.includes(needle)) {
        if (n.length > bestLen) {
          best = e;
          bestLen = n.length;
        }
      }
    }
  }
  return best;
}

/** 来源必须能指回具体东西：路径、文件名、#issue、第 N 轮、BV 号。光时间戳不算。 */
function srcOk(src) {
  const s = String(src || "").trim();
  if (s.length < 4) return false;
  // 自己承认是转述的，也给记——但必须带这个前缀，不许蒙混过关
  if (/^转述[:：]/.test(s)) return s.length >= 8;
  if (/^\d{2}-\d{2}(\s+\d{2}:\d{2})?$/.test(s)) return false; // 光时间戳
  if (/^\d{4}-\d{2}-\d{2}/.test(s) && s.length < 14) return false;
  return /[\/\\#]|第\s*\d+\s*轮|BV[0-9A-Za-z]{10}|\.(md|jsonl|txt|js|py)\b/i.test(s);
}

/**
 * 来源分两级。
 *
 * hard：能被人点开、翻回去的东西——网址、文件路径、#issue、第 N 轮、BV 号。
 *       「谁说的」有原件在，我不在了别人也能验。
 * soft：我自己的转述、印象、推测。写下来也有用，但它本来就该被怀疑。
 *
 * 为什么要分：原来只有一个 src 字段，硬证据和我的转述混在一栏里，
 * 后来读的人（包括我自己）分不出来。白饭馆轻影那条「不许判词冒充依据」
 * 说的就是这事——不是不能写判词，是不许它长得像依据。
 */
function srcKind(src) {
  const s = String(src || "").trim();
  if (!srcOk(s)) return "";
  if (/^转述[:：]/.test(s)) return "soft";
  if (/https?:\/\//i.test(s)) return "hard";
  if (/[\/\\].*[\/\\]/.test(s)) return "hard";         // 带目录的路径
  if (/\.(md|jsonl|txt|js|py|json)\b/i.test(s)) return "hard";
  if (/#\d+/.test(s)) return "hard";                    // issue / 评论编号
  if (/第\s*\d+\s*轮/.test(s)) return "hard";
  if (/BV[0-9A-Za-z]{10}/.test(s)) return "hard";
  return "soft";
}

/* ------------------------------ 插件 ------------------------------ */

function apply(ctx, config) {
  const root = String(config?.root || DEFAULT_ROOT);
  ensure(root);

  // 每轮注入 core（只有 core + 索引，几 KB 封顶）
  const pushCore = () => {
    const text = coreText(root);
    if (!text) return;
    ctx.systemPrompt.context(() => [
      {
        role: "system",
        content:
          "【你的记忆：核心层】下面是你的身份和硬规矩，每轮都在。\n" +
          "别的细节写在主题记忆里，要读用 memory_read(topic)。\n\n" +
          text,
      },
    ]);
  };
  try {
    if (typeof ctx.systemPrompt?.context === "function") pushCore();
  } catch {
    // 宿主没这个接口就只在工具里读，不致命
  }

  ctx.tools.register(
    safeDefineTool({
      name: "memory_read",
      description:
        "读自己的记忆。不带 topic 读核心层 + 主题索引；带 topic 读那个主题全文。不知道要读哪个就先不带参数看一眼索引。",
      parameters: {
        topic: { type: "string", description: "主题键，例如 house / napcat-topology。省略则读 core + 索引。" },
      },
      // rc.2 上 { type: 'object' } 会被当成不认识的值 schema 直接抛
      // （unsupported JSON schema: schema must be a value schema object）。
      // 而且没有 render 的话，宿主 createSuccessResult 会在真调用那一刻炸。
      output: {
        schema: { type: 'json' },
        render: (r) => [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r) }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        probe(root);
        const topic = String(args?.topic || "").trim().replace(/^core$/, "");
        if (!topic) {
          const core = readText(join(root, "core.md"));
          const idx = topicIndex(root);
          const full = [core, idx].filter(Boolean).join("\n\n");
          return {
            exists: !!full.trim(),
            content: full.length > MAX_READ ? full.slice(0, MAX_READ) + "\n…（截断）" : full,
            topic: "",
          };
        }
        const p = join(root, "topics", topic.endsWith(".md") ? topic : topic + ".md");
        const text = readText(p);
        return {
          exists: !!text,
          topic,
          content: text ? (text.length > MAX_READ ? text.slice(0, MAX_READ) + "\n…（截断）" : text) : "",
        };
      },
    }),
  );

  ctx.tools.register(
    safeDefineTool({
      name: "memory_net",
      description:
        "查一件东西是什么：按名字或别名找实体，返回它的名字、别名和属性。命中不了就说没登记——那不丢人，比瞎猜好。",
      parameters: {
        q: { type: "string", required: true, description: "你平时怎么叫它，别用正式名。" },
        add: { type: "string", description: "可选：把这次的说法加成别名。" },
      },
      // rc.2 上 { type: 'object' } 会被当成不认识的值 schema 直接抛
      // （unsupported JSON schema: schema must be a value schema object）。
      // 而且没有 render 的话，宿主 createSuccessResult 会在真调用那一刻炸。
      output: {
        schema: { type: 'json' },
        render: (r) => [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r) }],
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        const list = loadEntities(root);
        const hit = resolveEntity(list, args?.q);
        if (!hit) return { hit: false, text: `没登记这个实体：${args?.q}` };
        const alias = String(args?.add || "").trim();
        if (alias && !(hit.aliases || []).includes(alias)) {
          hit.aliases = [...(hit.aliases || []), alias];
          saveEntities(root, list);
        }
        const props = Object.entries(hit.props || {})
          .map(([k, v]) => `  · ${k}: ${v}`)
          .join("\n");
        return {
          hit: true,
          text:
            `【${hit.name || hit.id}】` +
            ((hit.aliases || []).length ? `\n别名：${hit.aliases.join(" / ")}` : "") +
            (props ? "\n" + props : ""),
        };
      },
    }),
  );

  ctx.tools.register(
    safeDefineTool({
      name: "memory_past",
      description:
        "翻原话：在对话原文里按关键词搜，返回带时间戳的片段。记不清某句话是什么时候说的就用这个——关键词搜到的是我写下的结论，原文才是证据。",
      parameters: {
        q: { type: "string", required: true, description: "关键词，两三个字最容易中。" },
        k: { type: "integer", description: "最多几条，默认 3，上限 5。" },
      },
      // rc.2 上 { type: 'object' } 会被当成不认识的值 schema 直接抛
      // （unsupported JSON schema: schema must be a value schema object）。
      // 而且没有 render 的话，宿主 createSuccessResult 会在真调用那一刻炸。
      output: {
        schema: { type: 'json' },
        render: (r) => [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r) }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const q = String(args?.q || "").trim();
        if (!q) return { hits: 0, text: "要给个关键词。" };
        const corpus = readText(join(root, "corpus.md"));
        if (!corpus) return { hits: 0, text: "还没有原文（memory-kit/corpus.md 是空的）。" };
        const k = Math.max(1, Math.min(MAX_PAST_HITS, Number(args?.k) || 3));
        const lines = corpus.split(/\r?\n/);
        const out = [];
        for (let i = 0; i < lines.length && out.length < k; i++) {
          if (!lines[i].includes(q)) continue;
          const from = Math.max(0, i - 1);
          const to = Math.min(lines.length - 1, i + 1);
          out.push(lines.slice(from, to + 1).join("\n").slice(0, 500));
        }
        return {
          hits: out.length,
          text: out.length ? out.map((s, i) => `--- 第 ${i + 1} 条 ---\n${s}`).join("\n\n") : `原文里没搜到「${q}」。`,
        };
      },
    }),
  );

  ctx.tools.register(
    safeDefineTool({
      name: "memory_fact",
      description:
        "记一条事实：谁·做了什么·对什么。src（来源）必须能指回具体东西——文件名、issue 号、第几轮、BV 号；只写时间戳会被拒绝，因为时间戳说明不了这话从哪来。",
      parameters: {
        s: { type: "string", required: true, description: "主体" },
        a: { type: "string", required: true, description: "动作，动词原形" },
        o: { type: "string", required: true, description: "客体" },
        src: { type: "string", required: true, description: "来源：路径 / #issue / 第 N 轮 / BV 号" },
        raw: { type: "string", description: "原话（可选，越原越好）" },
      },
      // rc.2 上 { type: 'object' } 会被当成不认识的值 schema 直接抛
      // （unsupported JSON schema: schema must be a value schema object）。
      // 而且没有 render 的话，宿主 createSuccessResult 会在真调用那一刻炸。
      output: {
        schema: { type: 'json' },
        render: (r) => [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r) }],
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        const s = String(args?.s || "").trim();
        const a = String(args?.a || "").trim();
        const o = String(args?.o || "").trim();
        const src = String(args?.src || "").trim();
        if (!s || !a || !o) return { ok: false, text: "s / a / o 三样都要有。" };
        if (!srcOk(src)) {
          return {
            ok: false,
            text:
              "来源不合格，没记。要能指回具体东西：文件名、#issue、第 N 轮、BV 号。" +
              "光写时间戳不行——那是「我什么时候记的」，不是「这话从哪来」。",
          };
        }
        const kind = srcKind(src);
        const row = {
          at: new Date().toISOString().slice(0, 16).replace("T", " "),
          s,
          a,
          o,
          src,
          srcKind: kind,
          raw: String(args?.raw || "").slice(0, 300),
        };
        appendFileSync(join(root, "facts.jsonl"), JSON.stringify(row) + "\n", "utf8");
        // 顺手让实体网长：见过几次的名字才转正，见一次只记一票
        let growth = null;
        try {
          growth = growEntities(root, [s, o]);
        } catch (e) {
          growth = { born: [], pending: 0, error: String((e && e.message) || e) };
        }
        const tail = kind === "soft" ? "（soft：这是转述，不是原件）" : "（hard：能翻回去）";
        const grow = growth && growth.born && growth.born.length
          ? `｜新认得：${growth.born.join("、")}`
          : (growth && growth.pending ? `｜还有 ${growth.pending} 个名字在攒票` : "");
        return { ok: true, text: `记下了：${s}·${a}·${o}（来源 ${src}）${tail}${grow}` };
      },
    }),
  );

  // 暴露给宿主调试用（没有 settings 服务也不报错）
  return { root, defineToolFell };
}

export { apply, inject, name, srcOk, srcKind, growEntities, loadEntities };
