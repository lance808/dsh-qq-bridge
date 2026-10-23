/**
 * 双通道审批的**集成**测试
 *
 * 前面的单元测试只证明"判定函数对不对"。这里要证明的是装配起来之后
 * 真的按设计跑：桌面面板先收到请求、QQ 同时收到、谁先答谁生效、
 * 桌面先答会把 QQ 那条撤掉。
 *
 * 做法：起一个**真的 HTTP 桥**（假装是 Ling-bot 的 dsh-bridge），
 * 用真的 `apply()` 把插件装到一个最小的假 ctx 上。
 * 假 ctx 只提供事件总线、effect 和 settings —— 这三样是插件真的会用的。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { apply } from '../lib/index.js';

/**
 * 假桥：按 `plan` 决定每次 `/dsh/await` 怎么回。
 *
 * @param {object} plan
 * @param {'answer'|'timeout'|'never'} [plan.awaitMode]
 * @param {string} [plan.outcome]
 * @param {object} [plan.answer]
 * @param {number} [plan.askDelayMs] 让 /dsh/ask 慢一点，用来复现"桌面比登记还快"
 */
async function startFakeBridge(plan = {}) {
  /** @type {any[]} */
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ path: req.url, body, at: Date.now() });
      const send = (obj) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      switch (req.url) {
        case '/dsh/ask':
          if (plan.askDelayMs) {
            await new Promise((r) => setTimeout(r, plan.askDelayMs));
          }
          return send({ ok: true, id: '1' });
        case '/dsh/await': {
          const mode = plan.awaitMode ?? 'answer';
          if (mode === 'timeout') return send({ ok: true, status: 'timeout' });
          if (mode === 'never') return; // 挂着不回
          if (plan.answer) {
            return send({ ok: true, status: 'answered', kind: 'question', answer: plan.answer });
          }
          return send({
            ok: true,
            status: 'answered',
            kind: 'approval',
            outcome: plan.outcome ?? 'rejected',
          });
        }
        case '/dsh/withdraw':
          return send({ ok: true, removed: true });
        case '/dsh/drain':
          return send({ ok: true, items: [] });
        default:
          return send({ ok: true });
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    /**
     * 关掉假桥。
     *
     * `closeAllConnections()` 不能省：`awaitMode: 'never'` 的用例会留下
     * 一条**故意不回**的长连接，`server.close()` 会一直等它，测试就挂住了。
     * （真实桥里那条连接由 120s 超时兜底，测试里等不起。）
     */
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(r);
      }),
  };
}

/**
 * 最小假 ctx。
 *
 * @param {string} bridgeUrl
 * @param {object} [overrides] 覆盖配置（例如 onUnreachable）
 */
function makeCtx(bridgeUrl, overrides = {}) {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  /** @type {any[]} */
  const disposers = [];
  const value = {
    bridgeUrl,
    bridgeToken: 'test-token',
    admins: '10000001',
    relayApprovals: true,
    onUnreachable: '',
    ...overrides,
  };

  return {
    handlers,
    dispose() {
      for (const d of disposers) {
        try {
          d?.();
        } catch {
          /* 清理失败不该让测试报错 */
        }
      }
      disposers.length = 0;
    },
    ctx: {
      // 顺手挂在 ctx 上：测试里拿到的就是传给 apply 的那个对象，
      // 少一层解构，也就少一处"测错了对象"的可能
      handlers,
      on(name, fn) {
        handlers.set(name, fn);
        return () => handlers.delete(name);
      },
      effect(fn) {
        const d = fn();
        disposers.push(d);
        return d;
      },
      settings: {
        describe: () => [{ ns: 'dsh-qq-bridge', value }],
        update: async () => {},
        mutate: async () => {},
      },
      // 不提供 inject：设置页路由会自己跳过，不影响审批
    },
  };
}

/** 造一条审批请求 */
const approvalReq = (over = {}) => ({
  toolName: 'fs_write',
  reason: '要写文件',
  callId: 'call-1',
  agent: { id: 'agent-1' },
  ...over,
});

/** 等"善后"动作落地（撤销是 fire-and-forget） */
const settle = () => new Promise((r) => setTimeout(r, 60));

/* ---------------------------------------------------------------- 用例 */

test('★ 桌面面板先收到请求（不是被 QQ 抢在前面）', async () => {
  const bridge = await startFakeBridge({ outcome: 'rejected' });
  const { ctx, dispose } = makeCtx(bridge.url);
  apply(ctx, {});
  try {
    const order = [];
    const handler = ctx.handlers.get('approval/request');
    assert.equal(typeof handler, 'function', '必须注册审批处理器');

    await handler(approvalReq(), async () => {
      order.push('desktop');
      return 'rejected';
    });
    await settle();
    const askCall = bridge.calls.find((c) => c.path === '/dsh/ask');
    assert.ok(askCall, 'QQ 通道也必须收到请求');
    // next() 是同步进入的，/dsh/ask 是网络往返，所以桌面一定在前
    assert.deepEqual(order, ['desktop']);
  } finally {
    dispose();
    await bridge.close();
  }
});

test('★ 桌面先答 → 采用桌面的结论，并撤销 QQ 那条', async () => {
  const bridge = await startFakeBridge({ awaitMode: 'never' });
  const { ctx, dispose } = makeCtx(bridge.url);
  apply(ctx, {});
  try {
    const handler = ctx.handlers.get('approval/request');
    const outcome = await handler(approvalReq(), async () => 'allowed-once');
    assert.equal(outcome, 'allowed-once');

    await settle();
    const w = bridge.calls.find((c) => c.path === '/dsh/withdraw');
    assert.ok(w, '桌面先答必须撤销 QQ 那条');
    assert.equal(w.body.id, '1');
    assert.equal(w.body.reason, 'desktop');
  } finally {
    dispose();
    await bridge.close();
  }
});

test('★ 桌面没有界面（unavailable）→ QQ 的结论生效', async () => {
  const bridge = await startFakeBridge({ outcome: 'rejected' });
  const { ctx, dispose } = makeCtx(bridge.url);
  apply(ctx, {});
  try {
    const handler = ctx.handlers.get('approval/request');
    const outcome = await handler(approvalReq(), async () => 'unavailable');
    assert.equal(outcome, 'rejected', 'unavailable 不能把 QQ 提前判死');
  } finally {
    dispose();
    await bridge.close();
  }
});

test('★ QQ 超时后桌面才答 → 仍采用桌面（delegate 语义）', async () => {
  const bridge = await startFakeBridge({ awaitMode: 'timeout' });
  const { ctx, dispose } = makeCtx(bridge.url);
  apply(ctx, {});
  try {
    const handler = ctx.handlers.get('approval/request');
    const outcome = await handler(
      approvalReq(),
      () => new Promise((r) => setTimeout(() => r('allowed-once'), 40)),
    );
    assert.equal(outcome, 'allowed-once', 'QQ 超时不该让还在等着的人无法回答');
  } finally {
    dispose();
    await bridge.close();
  }
});

test('★ 两边都没结论 → unavailable（绝不当成同意）', async () => {
  const bridge = await startFakeBridge({ awaitMode: 'timeout' });
  const { ctx, dispose } = makeCtx(bridge.url);
  apply(ctx, {});
  try {
    const handler = ctx.handlers.get('approval/request');
    const outcome = await handler(approvalReq(), async () => 'unavailable');
    assert.equal(outcome, 'unavailable');
    assert.notEqual(outcome, 'allowed-once');
  } finally {
    dispose();
    await bridge.close();
  }
});

test('onUnreachable=deny 时，两边都没结论就拒绝', async () => {
  const bridge = await startFakeBridge({ awaitMode: 'timeout' });
  const { ctx, dispose } = makeCtx(bridge.url, { onUnreachable: 'deny' });
  apply(ctx, {});
  try {
    const handler = ctx.handlers.get('approval/request');
    const outcome = await handler(approvalReq(), async () => 'unavailable');
    assert.equal(outcome, 'rejected');
  } finally {
    dispose();
    await bridge.close();
  }
});

test('★ 桥不可达时不能拖死审批（走 onUnreachable）', async () => {
  // 端口 1 上没有任何服务：请求立刻失败
  const { ctx, dispose } = makeCtx('http://127.0.0.1:1');
  apply(ctx, {});
  try {
    const handler = ctx.handlers.get('approval/request');
    const outcome = await handler(approvalReq(), async () => 'unavailable');
    assert.equal(outcome, 'unavailable');
  } finally {
    dispose();
  }
});

test('★ 桌面比桥登记还快时，撤销也不能漏（登记晚到仍要撤）', async () => {
  // 这是真实会发生的顺序：本地面板点一下是微秒级，而 /dsh/ask 是一次
  // HTTP 往返。如果撤销只判断"当前有没有编号"，这个窗口里就会静默跳过，
  // QQ 那条白挂到超时。
  const bridge = await startFakeBridge({ askDelayMs: 80, awaitMode: 'never' });
  const { ctx, dispose } = makeCtx(bridge.url);
  apply(ctx, {});
  try {
    const handler = ctx.handlers.get('approval/request');
    const outcome = await handler(approvalReq(), async () => 'rejected');
    assert.equal(outcome, 'rejected');

    // 撤销是 fire-and-forget，等它把迟到的编号用上
    await new Promise((r) => setTimeout(r, 200));
    const w = bridge.calls.find((c) => c.path === '/dsh/withdraw');
    assert.ok(w, '登记晚到时也必须补上撤销');
    assert.equal(w.body.id, '1');
  } finally {
    dispose();
    await bridge.close();
  }
});

test('relayApprovals 关着时完全不接管', async () => {
  const bridge = await startFakeBridge({ outcome: 'rejected' });
  const { ctx, dispose } = makeCtx(bridge.url, { relayApprovals: false });
  apply(ctx, {});
  try {
    const handler = ctx.handlers.get('approval/request');
    let called = false;
    const outcome = await handler(approvalReq(), async () => {
      called = true;
      return 'allowed-once';
    });
    assert.equal(called, true);
    assert.equal(outcome, 'allowed-once');
    assert.equal(bridge.calls.length, 0, '关着就不该访问桥');
  } finally {
    dispose();
    await bridge.close();
  }
});

test('★ 提问：桌面先答 → 采用桌面答案并撤销 QQ', async () => {
  const bridge = await startFakeBridge({ awaitMode: 'never' });
  const { ctx, dispose } = makeCtx(bridge.url);
  apply(ctx, {});
  try {
    const handler = ctx.handlers.get('user-questions/request');
    const desktopAnswer = { answers: [{ id: 'q1', selected: ['方案A'] }] };
    const got = await handler(
      { questions: [{ id: 'q1', question: '选哪个', options: [{ label: '方案A' }] }] },
      async () => desktopAnswer,
    );
    assert.deepEqual(got, desktopAnswer);

    await settle();
    const w = bridge.calls.find((c) => c.path === '/dsh/withdraw');
    assert.ok(w, '桌面先答也要撤销提问');
  } finally {
    dispose();
    await bridge.close();
  }
});

test('★ 提问：桌面没答时 QQ 的答案生效', async () => {
  const qAnswer = { answers: [{ id: 'q1', selected: ['方案B'] }] };
  const bridge = await startFakeBridge({ answer: qAnswer });
  const { ctx, dispose } = makeCtx(bridge.url);
  apply(ctx, {});
  try {
    const handler = ctx.handlers.get('user-questions/request');
    const got = await handler(
      { questions: [{ id: 'q1', question: '选哪个', options: [{ label: '方案B' }] }] },
      async () => 'unavailable',
    );
    assert.deepEqual(got, qAnswer);
  } finally {
    dispose();
    await bridge.close();
  }
});

test('★ 没有选项的提问不推 QQ（推了也没法回数字）', async () => {
  const bridge = await startFakeBridge({ answer: { answers: [] } });
  const { ctx, dispose } = makeCtx(bridge.url);
  apply(ctx, {});
  try {
    const handler = ctx.handlers.get('user-questions/request');
    const got = await handler(
      { questions: [{ id: 'q1', question: '随便说点什么' }] },
      async () => ({ answers: [{ id: 'q1', custom: '手写答案' }] }),
    );
    assert.deepEqual(got, { answers: [{ id: 'q1', custom: '手写答案' }] });
    assert.equal(bridge.calls.length, 0, '没有选项就不该走 QQ');
  } finally {
    dispose();
    await bridge.close();
  }
});
