/**
 * dsh-qq-bridge 插件侧逻辑
 *
 * 这里测的都是**判定**，不碰 DSH 运行时：
 * 管理员解析、不可达策略、结论词表、桥客户端行为。
 *
 * 为什么不测 `apply()`：它要真实 ctx（事件总线、effect 作用域），
 * 造一个假 ctx 只能证明"假 ctx 能跑"，证明不了真 DSH 里能跑。
 * 那部分靠实测（安装后真跑一轮），单元测试守的是判定逻辑。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = () =>
  readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

import {
  parseAdmins,
  isAdmin,
  unreachableOutcome,
  desktopApprovalDecision,
  bridgeApprovalDecision,
  desktopAnswerDecision,
  bridgeAnswerDecision,
} from '../lib/logic.js';

// index.js 顶部要 import schemastery（只存在于 DSH profile），
// 所以这里用动态导入并容忍失败：
// 环境里没有它就跳过 BridgeClient 相关用例，而不是让整个文件崩掉。
let BridgeClient = null;
let pluginName = '';
let NS = '';
try {
  const mod = await import('../lib/index.js');
  BridgeClient = mod.BridgeClient;
  pluginName = mod.name;
  NS = mod.NS;
} catch {
  // 没装 DSH 依赖：只跑纯判定测试
}

/* ---------------------------------------------------------------- 基本声明 */

test('插件名与命名空间一致（loader entry id 必须等于包名）', { skip: !BridgeClient ? '本机没有 DSH 的 schemastery 依赖' : false }, () => {
  assert.equal(pluginName, 'dsh-qq-bridge');
  assert.equal(NS, 'dsh-qq-bridge');
});

/* ---------------------------------------------------------------- 管理员 */

test('管理员列表容忍各种分隔符', () => {
  assert.deepEqual(parseAdmins('10001'), ['10001']);
  assert.deepEqual(parseAdmins('10001,10002'), ['10001', '10002']);
  assert.deepEqual(parseAdmins('10001，10002'), ['10001', '10002']); // 全角逗号
  assert.deepEqual(parseAdmins('10001、10002'), ['10001', '10002']); // 顿号
  assert.deepEqual(parseAdmins(' 10001  10002 '), ['10001', '10002']); // 空格
});

test('★ 非法内容不会被当成管理员', () => {
  // 空、纯字母、太短、带冒号（防止有人塞 "10001:admin" 这类想绕过的写法）
  assert.deepEqual(parseAdmins(''), []);
  assert.deepEqual(parseAdmins('admin'), []);
  assert.deepEqual(parseAdmins('123'), []);
  assert.deepEqual(parseAdmins('10001:admin'), []);
  assert.deepEqual(parseAdmins('../../etc/passwd'), []);
});

test('管理员判定严格相等，不做前缀/包含匹配', () => {
  const admins = ['10001'];
  assert.equal(isAdmin('10001', admins), true);
  assert.equal(isAdmin('1000', admins), false);
  assert.equal(isAdmin('100011', admins), false);
  // 数字与字符串要能对上（QQ 号来自不同来源时类型可能不同）
  assert.equal(isAdmin(10001, admins), true);
});

/* ---------------------------------------------------------------- 不可达策略 */

test('★ 默认策略是 delegate（交还 DSH），不是拒绝', () => {
  // 这是本插件最重要的一条：QQ 掉线不该让所有任务失败。
  // 返回 null = 调 next() 交回 DSH 自己的策略。
  assert.equal(unreachableOutcome(''), null);
  assert.equal(unreachableOutcome('delegate'), null);
  assert.equal(unreachableOutcome('随便什么'), null);
});

test('显式 deny 才判拒绝', () => {
  assert.equal(unreachableOutcome('deny'), 'rejected');
});

test('★ delegate 与 rejected 是两件不同的事', () => {
  // 这条断言看着啰嗦，但它守的是一个真实的设计陷阱：
  // 如果哪天有人把 delegate 的返回值改成 'rejected'，
  // QQ 一断线所有任务就开始失败，而测试会立刻发现。
  assert.notEqual(unreachableOutcome('delegate'), 'rejected');
});

/* ---------------------------------------------------------------- 配置 schema */

// Config 需要 @deepseek-ai/schemastery，它只存在于 DSH 的 profile 里，
// 不在本仓库的依赖里。所以这里**有条件地**验证：
// 能解析到就测真实 schema，解析不到就只检查声明形状。
// 这样单元测试在两种环境里都有意义，不会因为环境差异整个文件崩掉。

test('Config 声明了所有 volatile 字段（否则设置写不进去）', async () => {
  const src = await import('node:fs/promises').then((m) =>
    m.readFile(new URL('../lib/index.js', import.meta.url), 'utf8'),
  );
  // 每个配置字段都要有 extra('volatile', true)，否则 DSH 的设置写入会抛
  // "Plugin entry ... has no volatile fields"
  for (const field of ['bridgeUrl', 'bridgeToken', 'admins', 'relayApprovals', 'onUnreachable']) {
    const re = new RegExp(String.raw`${field}:[\s\S]{0,400}?extra\('volatile', true\)`);
    assert.match(src, re, `字段 ${field} 缺 extra('volatile', true)`);
  }
});

test('★ 不写 .volatile()（本仓库钉的 schemastery 版本没有这个方法）', async () => {
  const src = await import('node:fs/promises').then((m) =>
    m.readFile(new URL('../lib/index.js', import.meta.url), 'utf8'),
  );
  // .volatile() 是 DSH 自带那份 schemastery 的语法糖，
  // ^3.18.1 解析出来的那份没有，写了会直接 TypeError。
  //
  // 只看**代码行**，不看注释：注释里提到 ".volatile()" 是说明性的，
  // 不该被当成真的调用了它。
  const codeLines = src
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join('\n');
  assert.equal(/\.volatile\(\)/.test(codeLines), false, '不要用 .volatile()，用 .extra(volatile, true)');
});

/* ---------------------------------------------------------------- 桥客户端 */

test('桥未配置时 enabled 为 false，且请求直接失败不抛', { skip: !BridgeClient ? '本机没有 DSH 的 schemastery 依赖' : false }, async () => {
  const b = new BridgeClient({ url: '', token: '' });
  assert.equal(b.enabled, false);
  const r = await b.ping();
  assert.equal(r.ok, false);
  assert.match(r.error, /未配置/);
});

test('只有 url 没有 token 也不算启用', { skip: !BridgeClient ? '本机没有 DSH 的 schemastery 依赖' : false }, () => {
  assert.equal(new BridgeClient({ url: 'http://x', token: '' }).enabled, false);
  assert.equal(new BridgeClient({ url: '', token: 't' }).enabled, false);
});

test('★ 桥返回词表外的结论时不猜，按失败处理', { skip: !BridgeClient ? '本机没有 DSH 的 schemastery 依赖' : false }, async () => {
  // 造一个假 fetch 返回非法结论
  const orig = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true, outcome: '随便放行' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  try {
    const b = new BridgeClient({ url: 'http://x', token: 't' });
    const r = await b.ask({ toolName: 'fs_write' });
    assert.equal(r.ok, false, '非法结论必须当成失败，不能当同意');
    assert.match(r.error, /无法识别/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('桥返回合法结论时才接受', { skip: !BridgeClient ? '本机没有 DSH 的 schemastery 依赖' : false }, async () => {
  const orig = globalThis.fetch;
  for (const want of ['allowed-once', 'rejected', 'cancelled', 'unavailable']) {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: true, outcome: want }), { status: 200 });
    try {
      const b = new BridgeClient({ url: 'http://x', token: 't' });
      const r = await b.ask({ toolName: 'fs_write' });
      assert.equal(r.ok, true);
      assert.equal(r.outcome, want);
    } finally {
      globalThis.fetch = orig;
    }
  }
});

test('HTTP 401 时 ask 返回失败而不是抛异常', { skip: !BridgeClient ? '本机没有 DSH 的 schemastery 依赖' : false }, async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"ok":false}', { status: 401 });
  try {
    const b = new BridgeClient({ url: 'http://x', token: 'bad' });
    const r = await b.ask({ toolName: 'fs_write' });
    assert.equal(r.ok, false);
  } finally {
    globalThis.fetch = orig;
  }
});

test('请求头里带 Bearer 令牌', { skip: !BridgeClient ? '本机没有 DSH 的 schemastery 依赖' : false }, async () => {
  let seen = '';
  const orig = globalThis.fetch;
  globalThis.fetch = async (_u, init) => {
    seen = init.headers.authorization;
    return new Response('{"ok":true}', { status: 200 });
  };
  try {
    const b = new BridgeClient({ url: 'http://x', token: 'secret-tk' });
    await b.ping();
    assert.equal(seen, 'Bearer secret-tk');
  } finally {
    globalThis.fetch = orig;
  }
});

/* ---------------------------------------------------------------- 命名空间 */

test('★ 命名空间要能认出带 include: 前缀的 entry', async () => {
  const fs2 = await import("node:fs/promises");
  const src = await fs2.readFile(new URL('../lib/index.js', import.meta.url), "utf8");
  // 关键：不能只用 === NS 精确比对，否则 include:dsh-qq-bridge 会漏掉
  assert.ok(src.includes("include:"), '必须处理 include: 前缀');
  assert.ok(/includes\(NS\)/.test(src), '要有"包含包名"的宽松匹配');
});

test('★ 写配置不能写死命名空间（否则抛 No configurable plugin entry）', async () => {
  const fs2 = await import("node:fs/promises");
  const src = await fs2.readFile(new URL('../lib/index.js', import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*(\*|\/\/)/.test(l)).join("\n");
  // update/mutate 的第一个参数必须是解析出来的，不能是常量 NS
  assert.equal(/settings\.update\(NS,/.test(code), false, "update 不能写死 NS");
  assert.equal(/settings\.mutate\(NS,/.test(code), false, "mutate 不能写死 NS");
  assert.ok(/resolveNs\(ctx\)/.test(code), "必须用 resolveNs");
});

test('★ 订阅 settings/document-updated 做热更新', async () => {
  // 守的坑：保存设置之后 DSH **不会**重建插件实例，
  // 运行中的实例继续拿旧配置。诊断日志实测：保存完只有一行"配置已更新"，
  // 再没有任何 apply。表现是"设置里开着，功能就是不工作"。
  const fs2 = await import("node:fs/promises");
  const src = await fs2.readFile(new URL('../lib/index.js', import.meta.url), "utf8");
  assert.ok(src.includes("settings/document-updated"), "必须订阅配置变更事件");
  assert.ok(src.includes("ctx.effect"), "订阅要挂在 effect 上，插件卸载时一起释放");
});

test('★ relay/admins 不能从闭包旧值读，要走 live 对象', async () => {
  const fs2 = await import("node:fs/promises");
  const src = await fs2.readFile(new URL('../lib/index.js', import.meta.url), "utf8");
  const lines = src.split("\n");
  // 只允许 live 初始化那几行出现 cfg.relayApprovals 等
  const offenders = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /cfg\.(relayApprovals|onUnreachable|admins)/.test(l))
    .filter(({ l }) => !/^\s*(relayApprovals|onUnreachable|admins): cfg\./.test(l));
  assert.deepEqual(
    offenders.map((o) => `${o.i + 1}: ${o.l.trim()}`),
    [],
    "下游必须读 live.*，否则热更新不生效",
  );
});

/* -------------------------------------------------- 双通道判定（纯逻辑） */

test('★ 桌面端 unavailable 不算决定（否则 QQ 还没推就被判"没人答"）', () => {
  // 这是双通道最关键的判定：没有浏览器时 next() 会立刻返回 unavailable，
  // 如果把它当决定，QQ 那条审批根本不会发出去。
  assert.equal(desktopApprovalDecision('unavailable'), null);
  assert.equal(desktopApprovalDecision(undefined), null);
  assert.equal(desktopApprovalDecision(null), null);
  assert.equal(desktopApprovalDecision('allowed-once'), 'allowed-once');
  assert.equal(desktopApprovalDecision('rejected'), 'rejected');
  assert.equal(desktopApprovalDecision('cancelled'), 'cancelled');
});

test('★ 桥的 timeout 不是拒绝，withdrawn 不是回答', () => {
  assert.equal(bridgeApprovalDecision({ ok: true, status: 'timeout' }), null);
  assert.equal(bridgeApprovalDecision({ ok: true, status: 'withdrawn' }), null);
  assert.equal(bridgeApprovalDecision({ ok: true, status: 'unknown' }), null);
  assert.equal(bridgeApprovalDecision({ ok: false }), null);
  assert.equal(
    bridgeApprovalDecision({ ok: true, status: 'answered', outcome: 'rejected' }),
    'rejected',
  );
  // cancelled 是"问题被撤回"，要收场，不能继续等
  assert.equal(bridgeApprovalDecision({ ok: true, status: 'cancelled' }), 'cancelled');
  // 词表外的结论一律不认
  assert.equal(
    bridgeApprovalDecision({ ok: true, status: 'answered', outcome: '随便放行' }),
    null,
  );
});

test('提问答案的空值与对象必须区分', () => {
  assert.equal(desktopAnswerDecision(undefined), null);
  assert.equal(desktopAnswerDecision(null), null);
  assert.deepEqual(desktopAnswerDecision({ answers: [] }), { answers: [] });

  assert.equal(bridgeAnswerDecision({ ok: true, status: 'answered', kind: 'question', answer: null }), null);
  assert.equal(bridgeAnswerDecision({ ok: true, status: 'timeout' }), null);
  assert.deepEqual(
    bridgeAnswerDecision({ ok: true, status: 'answered', kind: 'question', answer: { answers: [1] } }),
    { answers: [1] },
  );
});

test('★ 审批处理器必须先调 next() 再推 QQ（面板不能消失）', () => {
  const src = readSource();
  const i = src.indexOf("ctx.on('approval/request'");
  assert.ok(i > 0, '找不到审批处理器');
  const block = src.slice(i, i + 5200);
  assert.match(block, /desktop: \(\) => next\(\)/, '必须先调 next()，让桌面审批面板出现');
  assert.match(block, /prepend: true/, '要以 prepend 注册，排在浏览器 forwarder 之前');
  assert.match(block, /withdraw/, '桌面先答要撤销 QQ 那条');
  assert.match(block, /bridgeApprovalDecision/, '结论判定要用纯函数');
});

test('★ 地址未定时能靠发现文件补上（DSH 先启动的场景）', { skip: !BridgeClient ? '本机没有 DSH 的 schemastery 依赖' : false }, async () => {
  // 两个程序谁先起不确定。DSH 先起时发现文件还不存在，
  // 如果只在 apply 时读一次，之后永远补不上——表现是"两边都开着就是不推"。
  //
  // ## 这个测试不能依赖本机状态
  //
  // 早先它直接断言 `b.enabled === false`，隐含假设"本机没有发现文件"。
  // 但只要开发机上 Ling-bot 正好开着（它就会写这个文件），
  // 断言立刻失败——测试红的是环境，不是代码。
  //
  // 所以这里**临时把发现文件挪开**，用完还原：测"没有发现文件时安静返回 false"
  // 这条分支，就必须真的制造出"没有"这个前提。
  const { DISCOVERY_FILE } = await import('../lib/discovery.js');
  const fsp = await import('node:fs/promises');
  const backup = `${DISCOVERY_FILE}.test-bak`;

  let had = false;
  try {
    await fsp.rename(DISCOVERY_FILE, backup);
    had = true;
  } catch {
    /* 本来就没有，正好 */
  }

  try {
    const b = new BridgeClient({ url: '', token: 't' });
    assert.equal(b.enabled, false, '一开始没地址');

    // 没有发现文件时 discover 应该安静返回 false
    const first = b.discover();
    assert.equal(typeof first, 'boolean');
    assert.equal(first, false, '没有发现文件时不应发现成功');
    assert.equal(b.enabled, false);
  } finally {
    if (had) await fsp.rename(backup, DISCOVERY_FILE).catch(() => {});
  }
});

test('★ 没有令牌时 discover 不去猜地址', { skip: !BridgeClient ? '本机没有 DSH 的 schemastery 依赖' : false }, () => {
  const b = new BridgeClient({ url: '', token: '' });
  assert.equal(b.discover(), false);
  assert.equal(b.enabled, false);
});

test('★ 审批处理器在使用桥之前会补一次地址发现', () => {
  const src = readSource();
  const i = src.indexOf("ctx.on('approval/request'");
  const block = src.slice(i, i + 1200);
  assert.match(block, /bridge\.discover\(\)/, '要用之前补一次，不能只靠 apply 那次');
  assert.match(block, /if \(!bridge\.enabled\)/, '补不到就走桌面端');
});

test('★ 指令轮询也会补地址（Ling-bot 后启动时自动接上）', () => {
  const src = readSource();
  const i = src.indexOf('function startCommandPoller');
  const block = src.slice(i, i + 900);
  assert.match(block, /bridge\.discover\(\)/, '轮询要能自己接上');
});

/* -------------------------------------------------- 提问转推 */

test('★ 要接管 user-questions/request', async () => {
  const src = readSource();
  assert.match(src, /ctx\.on\('user-questions\/request'/, '提问必须能推到 QQ');
});

test('★ 提问没有选项时要交还界面，不能硬转', async () => {
  // 纯自由输入的问题在 QQ 端没有编号可回，硬转只会让人无从下手。
  const src = readSource();
  const i = src.indexOf("ctx.on('user-questions/request'");
  const block = src.slice(i, i + 2600);
  assert.match(block, /hasOptions/, '要检查有没有选项');
  assert.match(block, /return answer\(\)/, '没选项要交还界面');
});

test('★ 提问失败必须交还界面，不能把 DSH 卡死', async () => {
  const src = readSource();
  const i = src.indexOf("ctx.on('user-questions/request'");
  const block = src.slice(i, i + 3200);
  assert.match(block, /catch[\s\S]{0,300}answer\(\)/, '异常路径也要交还界面');
});

test('★ 两边都没答案时交还桌面结果（不能把 null 当成默认项）', async () => {
  const src = readSource();
  const i = src.indexOf("ctx.on('user-questions/request'");
  const block = src.slice(i, i + 3200);
  assert.match(block, /return desktopValue/, '没有答案要把桌面端的返回值交回去');
  assert.equal(/if \(!res\.answer\)/.test(block), false, '新协议没有 res 这个变量');
});

/* -------------------------------------------------- v2 两段式客户端 */

test('★ v2：askStart 拿编号，awaitResult 等结论', { skip: !BridgeClient ? '本机没有 DSH 的 schemastery 依赖' : false }, async () => {
  /** @type {any[]} */
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, body: JSON.parse(init.body) });
    if (u.endsWith('/dsh/ask')) {
      return new Response(JSON.stringify({ ok: true, id: '7' }), { status: 200 });
    }
    if (u.endsWith('/dsh/await')) {
      return new Response(
        JSON.stringify({ ok: true, status: 'answered', kind: 'approval', outcome: 'rejected' }),
        { status: 200 },
      );
    }
    return new Response('{"ok":true}', { status: 200 });
  };
  try {
    const b = new BridgeClient({ url: 'http://x', token: 't' });
    const s = await b.askStart({ toolName: 'fs_write' });
    assert.equal(s.ok, true);
    assert.equal(s.id, '7');
    assert.equal(calls[0].body.kind, 'approval', '要显式声明 kind');
    const r = await b.awaitResult('7');
    assert.equal(r.status, 'answered');
    assert.equal(r.outcome, 'rejected');
  } finally {
    globalThis.fetch = orig;
  }
});

test('★ v2：免打扰时 askStart 直接给结论、没有编号', { skip: !BridgeClient ? '本机没有 DSH 的 schemastery 依赖' : false }, async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true, id: null, outcome: 'allowed-once' }), { status: 200 });
  try {
    const b = new BridgeClient({ url: 'http://x', token: 't' });
    const s = await b.askStart({ toolName: 'fs_write' });
    assert.equal(s.ok, true);
    assert.equal(s.id, null);
    assert.equal(s.outcome, 'allowed-once');
  } finally {
    globalThis.fetch = orig;
  }
});

test('★ v2：withdraw 带编号与原因', { skip: !BridgeClient ? '本机没有 DSH 的 schemastery 依赖' : false }, async () => {
  /** @type {any} */
  let seen = null;
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ ok: true, removed: true }), { status: 200 });
  };
  try {
    const b = new BridgeClient({ url: 'http://x', token: 't' });
    const r = await b.withdraw('7', 'desktop');
    assert.equal(r.ok, true);
    assert.equal(r.removed, true);
    assert.match(seen.url, /\/dsh\/withdraw$/);
    assert.deepEqual(seen.body, { id: '7', reason: 'desktop' });
  } finally {
    globalThis.fetch = orig;
  }
});

test('★ v2：await 返回 withdrawn 不算拒绝', { skip: !BridgeClient ? '本机没有 DSH 的 schemastery 依赖' : false }, async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true, status: 'withdrawn', reason: 'desktop' }), {
      status: 200,
    });
  try {
    const b = new BridgeClient({ url: 'http://x', token: 't' });
    const r = await b.awaitResult('7');
    assert.equal(r.ok, true);
    assert.equal(r.status, 'withdrawn');
    assert.equal(r.outcome, undefined);
  } finally {
    globalThis.fetch = orig;
  }
});

test('★ v2：await 状态词表外时按失败处理', { skip: !BridgeClient ? '本机没有 DSH 的 schemastery 依赖' : false }, async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true, status: '胡说八道' }), { status: 200 });
  try {
    const b = new BridgeClient({ url: 'http://x', token: 't' });
    const r = await b.awaitResult('7');
    assert.equal(r.ok, false);
    assert.match(r.error, /无法识别/);
  } finally {
    globalThis.fetch = orig;
  }
});
