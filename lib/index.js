/**
 * dsh-qq-bridge —— 把 DSH 的工具审批与会话控制暴露到 QQ
 *
 * ## 它解决什么
 *
 * DSH 跑起来后，危险工具（写文件、跑命令）默认要在界面里点"同意"。
 * 人不在电脑前时，任务就卡在那里。这个插件把审批请求推到 QQ，
 * 你在手机上回一句"同意 3"就继续了。反过来，也能从 QQ 发指令让 DSH 干活。
 *
 * ## 一个必须说清的取舍：DSH 侧不存 QQ 的连接
 *
 * 桥进程（Ling-bot 那边的 `scripts/dsh-bridge.mjs`）是**独立进程**，
 * 它自己连 QQ。插件不碰 QQ 的 API，只跟桥进程用一个 HTTP 端口说话。
 *
 * 这样做的好处：DSH 崩了不影响 QQ，QQ 崩了不影响 DSH，
 * 任一重启都不需要另一个跟着重启。
 *
 * ## fail-closed 还是 fail-open
 *
 * 这里的方向和 Ling-bot 的其他地方**相反**，而且是故意的：
 *
 *   - Ling-bot 的发送闸门是 fail-closed：拿不准就不发（宁可少说，不能乱说）
 *   - 这里的审批在 QQ 不可达时默认 **delegate**：调 next() 交还 DSH 自己的策略
 *
 * 理由：审批是"卡住别人干活"的操作。如果 QQ 掉线就直接判拒绝，
 * 一次网络抖动会让你所有任务全部失败，而 DSH 本来的界面审批明明是好的。
 * 交还默认处理是最不坏的选择——它不会放宽任何权限，
 * 因为 DSH 自己的策略仍然要过。
 *
 * 配置项 `onUnreachable: 'deny'` 可以改成严格模式。
 *
 * ## 时钟与超时
 *
 * 审批请求带 `signal`，DSH 那边可能提前取消。这里所有等待都监听它，
 * 一旦 abort 立刻返回 'cancelled'，绝不让一个已经没人等的请求挂着。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';

/* ------------------------------------------------------------------ 诊断 */

/**
 * 诊断日志写系统临时目录。
 *
 * **不要**按相对层级往上爬：插件是以 `link:<DSH_HOME>/plugins/<name>`
 * 装进 profile 的，往上会落到 <DSH_HOME>/.. ——
 * 那会在用户主目录旁凭空造出目录，且只在作者机器上"看起来正常"。
 *
 * 可用 QQ_BRIDGE_DIAG 覆盖（空字符串 = 关闭）。
 */
const DIAG = process.env.QQ_BRIDGE_DIAG ?? path.join(os.tmpdir(), 'dsh-qq-bridge.log');

/** @param {string} msg */
function diag(msg) {
  if (!DIAG) return;
  try {
    fs.mkdirSync(path.dirname(DIAG), { recursive: true });
    fs.appendFileSync(DIAG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* 写不了日志不能影响主流程 */
  }
}

/* ------------------------------------------------------------------ 常量 */

export const name = 'dsh-qq-bridge';

/**
 * 命名空间属于 settings seam：声明依赖让 entry 等 settings 就绪后再 activate。
 * 没这个声明，apply 可能在 settings 还没挂上时被调用。
 */
export const inject = ['settings'];

/** settings 命名空间名（必须与 cordis.patch.yml 里 entry 的 id 一致）。 */
export const NS = 'dsh-qq-bridge';

/** 审批等待上限。超过就按 onUnreachable 策略处理，不让 DSH 无限等。 */
const APPROVAL_TIMEOUT_MS = 120_000;

/**
 * 等 QQ 的那条 HTTP 请求本身的上限。
 *
 * 必须**大于**桥内队列的 120s：桥到点会回 `status:'timeout'`，那是
 * 有意义的结论；如果客户端先到点，请求被 abort，结论就退化成一个
 * 普通的网络错误，`onUnreachable` 也拿不到"确实超时了"这个信息。
 */
const REMOTE_WAIT_MS = APPROVAL_TIMEOUT_MS + 5_000;

/** 单次 HTTP 调用的超时（问桥进程"有人在吗"之类） */
const HTTP_TIMEOUT_MS = 5_000;

/** 桥只允许返回这几个词。其它值一律当"没结论"，不猜。 */
const APPROVAL_OUTCOMES = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable']);

/** 桥 /dsh/await 允许返回的状态 */
const AWAIT_STATUSES = new Set(['answered', 'timeout', 'withdrawn', 'cancelled', 'unknown']);

/* ------------------------------------------------------------------ 配置 */

/**
 * 作为 loader entry 的 `Config` 暴露出去的配置。
 *
 * 每个字段都要 `volatile`（`.extra('volatile', true)`）：
 * 那是 DSH 的"可热改、不重挂载"标记，也是命名空间能被**写入**的必要条件
 * （volatileForm 只保留带该标记的字段，否则抛
 * "Plugin entry ... has no volatile fields"）。
 *
 * ⚠️ 刻意**不写 `.volatile()`**：那只是 DSH 自带那份 schemastery 的语法糖，
 * 本仓库钉的 `^3.18.1` 解析出来的那份没有这个方法，写了会直接
 * `TypeError: .volatile is not a function`。`.extra` 两边都有，行为一致。
 */
export const Config = z.object({
  bridgeUrl: z
    .string()
    .default('')
    .description('桥进程 HTTP 地址，例如 http://127.0.0.1:3458 ；留空表示不启用')
    .extra('volatile', true),
  bridgeToken: z
    .string()
    .default('')
    .description('与桥进程约定的共享令牌；留空表示不启用')
    .extra('volatile', true),
  admins: z
    .string()
    .default('')
    .description('允许控制 DSH 的管理员 QQ 号（逗号分隔）；留空表示一个都不允许')
    .extra('volatile', true),
  relayApprovals: z
    .boolean()
    .default(false)
    .description('是否把工具审批请求推到 QQ')
    .extra('volatile', true),
  onUnreachable: z
    .string()
    .default('')
    .description("QQ 不可达时的处理：'delegate' 交还 DSH 默认策略（推荐）；'deny' 直接拒绝")
    .extra('volatile', true),
});


/**
 * 解析本插件在 settings 里的**真实命名空间**。
 *
 * ## 为什么不能写死
 *
 * `settings.update(ns, ...)` 要的 ns 是 loader entry 的 **id**，
 * 而通过 bundle 装进来的条目，id 会被加上 `include:` 前缀
 * （实测是 `include:dsh-qq-bridge`，不是我以为的 `dsh-qq-bridge`）。
 *
 * 写死的后果是 `settings.update` 抛 "No configurable plugin entry"，
 * 而前端的表现只是一句"保存失败"。
 *
 * 所以：先 `describe()` 查一遍，找出**名字对得上**的那行的 ns。
 * 查不到才退回硬编码值——fail 的方向是"至少还有一个能用的猜测"。
 *
 * @param {any} ctx
 * @returns {string}
 */
function resolveNs(ctx) {
  try {
    // **不要** redactSecrets：那是给远程调用方的。
    // 插件自己必须拿到真实令牌才能连桥；脱敏后拿到的是 { path, set }，
    // 归一化时被当成"没有值"，于是 enabled 变 false、什么也发不出去。
    const list = ctx.settings?.describe?.();
    if (Array.isArray(list)) {
      // 顺序很重要：**先找不带前缀的那个**。
      //
      // 实证：image-tool 的 entry id 在 inspect 里显示为 `include:image-tool`，
      // 但它的代码直接用 `'image-tool'` 调 settings.update 且工作正常。
      // 说明 settings 这一层认的是 entry 的 options.id（不带 include: 前缀），
      // 而 describe() 返回的 ns 大概也是这个形式。
      const exact = list.find((d) => String(d?.ns) === NS);
      if (exact) return String(exact.ns);

      // 其次才容忍前缀形式（换了加载方式时仍能对上）
      const prefixed = list.find((d) => String(d?.ns) === `include:${NS}`);
      if (prefixed) return String(prefixed.ns);

      // 最后：ns 里包含包名
      const loose = list.find((d) => String(d?.ns ?? '').includes(NS));
      if (loose) return String(loose.ns);
    }
  } catch {
    /* 查不到就退回默认 */
  }
  return NS;
}

/* ------------------------------------------------------------------ 设置页路由 */

/**
 * 挂上设置页的数据接口。
 *
 * 每一步都独立容错：路由挂不上不该拖垮审批和指令这两个真功能。
 * 平台会把 apply 里任何未捕获异常呈现为"插件启动失败"，
 * 而我们这一行挂了三四件互相独立的事，让一件拖垮全部既难查也没必要。
 *
 * @param {any} ctx
 * @param {any} cfg 当前配置
 */
function mountRoutes(ctx, cfg) {
  try {
    if (typeof ctx.inject !== 'function') {
      diag('ctx.inject 不可用 —— 设置页接口未挂载（审批与指令不受影响）');
      return;
    }

    ctx.inject(['connection', 'webServer'], (routeCtx) => {
      try {
        const webServer = routeCtx.get?.('webServer') ?? routeCtx.webServer;
        if (!webServer?.register) {
          diag('没有 webServer —— 设置页接口未挂载');
          return;
        }
        const connection = routeCtx.get?.('connection') ?? routeCtx.connection;

        const dispose = registerBridgeRoutes(webServer, {
          /**
           * 每次现读，不缓存：设置页刚保存就要能看到新值，
           * 缓存会导致"保存成功但界面还是旧的"。
           */
          readConfig: () => readEffectiveConfig(ctx, cfg),
          // 服务方法签名是**位置参数** update(ns, patch)，
          // 与 RPC 的 {ns, patch} 信封不是一回事，混了会静默写到别处
          updateConfig: (patch) => ctx.settings.update(resolveNs(ctx), patch),
          // 清 secret 只能走 unset：写空串在 secret 字段上等于"没改"
          clearToken: () =>
            ctx.settings.mutate(resolveNs(ctx), [{ op: 'unset', path: ['bridgeToken'] }]),
          connection,
          log: diag,
        });

        if (typeof routeCtx.effect === 'function') routeCtx.effect(() => dispose);
      } catch (err) {
        diag(`设置页接口挂载失败：${String(err?.message ?? err)}`);
      }
    });
  } catch (err) {
    diag(`设置页接口挂载异常：${String(err?.message ?? err)}`);
  }
}

/**
 * 读当前**生效**的配置。
 *
 * 优先从 settings 的实时值读，拿不到再退回 apply 时那份。
 * 这样设置页保存后立刻能看到新值，而不用等重启。
 *
 * @param {any} ctx
 * @param {any} fallback
 */
function readEffectiveConfig(ctx, fallback) {
  try {
    const list = ctx.settings?.describe?.();
    if (Array.isArray(list)) {
      // 用和写入同一套匹配规则：entry id 可能带 include: 前缀，
      // 只按包名精确比对会漏掉它（那样"保存成功但界面还是旧的"）
      const ns = resolveNs(ctx);
      const row = list.find((d) => String(d?.ns) === ns);
      if (row?.value && typeof row.value === 'object') {
        // 不脱敏取值，所以这里能拿到真实的 bridgeToken。
        // 仍保留"对象即无值"的兜底：万一宿主换了行为，
        // 归一化会把对象当空串，而不是 "[object Object]"。
        return { ...fallback, ...row.value };
      }
    }
  } catch {
    /* 读不到就用 fallback */
  }
  return fallback;
}

/* ------------------------------------------------------------------ 工具 */

// 判定逻辑在 logic.js（那份不依赖 schemastery，便于单测）
import {
  parseAdmins,
  isAdmin,
  unreachableOutcome,
  desktopApprovalDecision,
  bridgeApprovalDecision,
  desktopAnswerDecision,
  bridgeAnswerDecision,
} from './logic.js';
import { registerBridgeRoutes } from './routes.js';
import { resolveBridgeUrl } from './discovery.js';

export { parseAdmins, isAdmin, unreachableOutcome };

/* ------------------------------------------------------------------ 桥客户端 */

/**
 * 极简的桥进程客户端。
 *
 * 只做三件事：ping（有人在吗）、ask（问一个审批）、notify（上报事件）。
 * 刻意不引第三方 HTTP 库——Node 自带 fetch 够了。
 */
export class BridgeClient {
  /** @type {{url: string, token: string}} */
  #cfg;

  /**
   * @param {{url: string, token: string}} cfg
   */
  constructor(cfg) {
    this.#cfg = cfg;
  }

  /** 仅用于诊断：当前实际会连的地址 */
  /**
   * 换一份地址/令牌。
   *
   * 热更新必须在**原地**改这个对象，不能新建一个：
   * 轮询器和审批处理器都握着这个引用，换对象它们就还在用旧的。
   *
   * @param {{url: string, token: string}} cfg
   */
  reconfigure(cfg) {
    const url = String(cfg?.url ?? '').trim();
    const token = String(cfg?.token ?? '').trim();
    if (!url || !token) return false;
    this.#cfg = { url, token };
    return true;
  }

  get urlForDiag() {
    return this.#cfg.url;
  }

  /**
   * 地址还没定：去发现文件里找一次。
   *
   * ## 为什么需要这一步
   *
   * DSH 与 Ling-bot 是两个独立程序，谁先启动不确定。
   * 如果 DSH 先起，`apply` 那一刻发现文件还不存在（或指向已死的 pid），
   * 地址就是空的、`enabled` 为 false，**之后再也不会有东西去补它**——
   * 表现是"两边都开着，审批就是不推"。
   *
   * 所以让调用方（指令轮询 + 审批处理器）在每次真正要用之前补一次。
   * 找到就就地修好；找不到就继续等下一次。
   *
   * @returns {boolean} 这次有没有把地址补上
   */
  discover() {
    if (this.#cfg.url) return false;
    if (!this.#cfg.token) return false;
    const found = resolveBridgeUrl('');
    if (!found) return false;
    this.#cfg = { ...this.#cfg, url: found };
    return true;
  }

  /**
   * 地址和令牌都齐了才算可用。
   *
   * 注意：`enabled` 为 false 时**不是**"功能坏了"，而是"还没配好"。
   * 处理器一律先 `discover()` 再读它。
   */
  get enabled() {
    return Boolean(this.#cfg.url && this.#cfg.token);
  }

  /**
   * @param {string} p
   * @returns {string}
   */
  #abs(p) {
    return `${this.#cfg.url.replace(/\/+$/, '')}${p}`;
  }

  /**
   * 发一个带令牌的请求。**不抛 HTTP 错误**，由调用方按状态码判断。
   *
   * @param {string} p
   * @param {object} [body]
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ok: boolean, status: number, data: any, error?: string}>}
   */
  async #post(p, body, signal) {
    if (!this.enabled) return { ok: false, status: 0, data: null, error: '桥未配置' };

    const sig = signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(this.#abs(p), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#cfg.token}`,
        },
        body: JSON.stringify(body ?? {}),
        signal: sig,
      });
      const text = await res.text().catch(() => '');
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = { _raw: text };
      }
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      const e = /** @type {any} */ (err);
      // abort 与网络错误要分开：前者是调用方主动放弃，不算桥故障
      const aborted = e?.name === 'AbortError' || e?.name === 'TimeoutError';
      return {
        ok: false,
        status: 0,
        data: null,
        error: aborted ? 'aborted' : String(e?.message ?? e),
      };
    }
  }

  /** 探活：QQ 那边有人能处理吗 */
  async ping(signal) {
    return this.#post('/dsh/ping', {}, signal);
  }

  /**
   * 登记一个审批，立刻拿回编号（v2 两段式的第一段）。
   *
   * 为什么不再用一次长轮询：桌面端先答时，插件需要知道编号才能
   * 调 `/dsh/withdraw` 把 QQ 那条撤掉。长轮询的响应要等结果，
   * 拿不到编号，所以拆成「登记 → 等待」两步。
   *
   * @param {object} req
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ok: boolean, id?: string|null, outcome?: string, error?: string}>}
   */
  async askStart(req, signal) {
    const res = await this.#post('/dsh/ask', { ...req, kind: 'approval' }, signal);
    if (!res.ok) return { ok: false, error: res.error ?? `HTTP ${res.status}` };

    // 免打扰：桥直接给结论，没有待回复编号
    const outcome = res.data?.outcome;
    if (outcome !== undefined) {
      if (!APPROVAL_OUTCOMES.has(outcome)) {
        return { ok: false, error: `桥返回了无法识别的结论：${String(outcome)}` };
      }
      return { ok: true, id: null, outcome };
    }

    const id = res.data?.id;
    if (typeof id !== 'string' || !id) {
      return { ok: false, error: '桥没有返回待回复编号（协议版本可能不匹配）' };
    }
    return { ok: true, id };
  }

  /**
   * 登记一个提问，立刻拿回编号（v2 两段式的第一段）。
   *
   * @param {{questions: Array<object>}} req
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ok: boolean, id?: string|null, answer?: any, error?: string}>}
   */
  async askQuestionStart(req, signal) {
    const res = await this.#post(
      '/dsh/ask',
      { kind: 'question', questions: req?.questions ?? [] },
      signal,
    );
    if (!res.ok) return { ok: false, error: res.error ?? `HTTP ${res.status}` };

    // 没有选项 / 免打扰之类：桥直接给答案（null 也算给了）
    if (res.data?.answer !== undefined) {
      return { ok: true, id: null, answer: res.data.answer };
    }

    const id = res.data?.id;
    if (typeof id !== 'string' || !id) {
      return { ok: false, error: '桥没有返回待回复编号（协议版本可能不匹配）' };
    }
    return { ok: true, id };
  }

  /**
   * 用编号等结果（v2 两段式的第二段）。
   *
   * `status` 是唯一判据：`answered` 才有结论；`timeout` 不是拒绝；
   * `withdrawn` 表示桌面端已经处理、QQ 这条作废。
   *
   * @param {string} id
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ok: boolean, status?: string, kind?: string, outcome?: string, answer?: any, error?: string}>}
   */
  async awaitResult(id, signal) {
    const res = await this.#post('/dsh/await', { id }, signal);
    if (!res.ok) return { ok: false, error: res.error ?? `HTTP ${res.status}` };

    const status = String(res.data?.status ?? '');
    if (!AWAIT_STATUSES.has(status)) {
      return { ok: false, error: `桥返回了无法识别的状态：${status}` };
    }
    if (status !== 'answered') return { ok: true, status };

    const kind = res.data?.kind === 'question' ? 'question' : 'approval';
    if (kind === 'question') {
      return { ok: true, status, kind, answer: res.data?.answer ?? null };
    }

    const outcome = res.data?.outcome;
    if (!APPROVAL_OUTCOMES.has(outcome)) {
      return { ok: false, error: `桥返回了无法识别的结论：${String(outcome)}` };
    }
    return { ok: true, status, kind, outcome };
  }

  /**
   * 撤销一条还没回答的待回复。
   *
   * 桌面端先答时必须调它，否则 QQ 那条会一直挂到 120 秒超时，
   * 用户看到一条永远"待处理"的消息，回数字还会得到过期回执。
   *
   * @param {string} id
   * @param {string} reason
   * @returns {Promise<{ok: boolean, removed?: boolean, error?: string}>}
   */
  async withdraw(id, reason) {
    if (!id) return { ok: true, removed: false };
    const res = await this.#post('/dsh/withdraw', { id, reason });
    return { ok: res.ok, removed: Boolean(res.data?.removed), error: res.error };
  }

  /**
   * 问一个审批（登记 + 等待的便捷包装）。
   *
   * 保留给单测与旧调用方；双通道逻辑走 askStart/awaitResult。
   *
   * @param {object} req
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ok: boolean, outcome?: string, error?: string}>}
   */
  async ask(req, signal) {
    const started = await this.askStart(req, signal);
    if (!started.ok) return { ok: false, error: started.error };
    if (started.outcome) return { ok: true, outcome: started.outcome };

    const r = await this.awaitResult(started.id, signal);
    if (!r.ok) return { ok: false, error: r.error };
    if (r.status === 'answered') return { ok: true, outcome: r.outcome };
    if (r.status === 'cancelled') return { ok: true, outcome: 'cancelled' };
    return { ok: false, error: r.status };
  }

  /**
   * 上报一条事件（给 QQ 侧做通知用）。
   *
   * @param {object} evt
   */
  async notify(evt) {
    return this.#post('/dsh/event', evt);
  }

  /**
   * 问一个问题，等 QQ 那边回答（登记 + 等待的便捷包装）。
   *
   * @param {{questions: Array<object>}} req
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ok: boolean, answer?: any, error?: string}>}
   */
  async askQuestion(req, signal) {
    const started = await this.askQuestionStart(req, signal);
    if (!started.ok) return { ok: false, error: started.error };
    // null 表示"没有选项/没人回答"，和"用户选了默认项"必须区分开
    if (started.answer !== undefined) return { ok: true, answer: started.answer };

    const r = await this.awaitResult(started.id, signal);
    if (!r.ok) return { ok: false, error: r.error };
    if (r.status === 'answered' && r.kind === 'question') return { ok: true, answer: r.answer };
    return { ok: true, answer: null };
  }

  /**
   * 取走桥里排队的 QQ 指令。
   *
   * @returns {Promise<{ok: boolean, items?: any[], error?: string}>}
   */
  async drain() {
    const res = await this.#post('/dsh/drain', {}, AbortSignal.timeout(HTTP_TIMEOUT_MS));
    if (!res.ok) return { ok: false, error: res.error ?? `HTTP ${res.status}` };
    return { ok: true, items: Array.isArray(res.data?.items) ? res.data.items : [] };
  }

  /**
   * 报告一条指令投递失败，让 QQ 侧能告诉用户"没生效"。
   *
   * @param {{text: string, error: string}} info
   */
  async reportDelivery(info) {
    return this.#post('/dsh/delivery-failed', info, AbortSignal.timeout(HTTP_TIMEOUT_MS));
  }
}

/* ------------------------------------------------------------------ 插件装配 */

/**
 * 跑一个"善后"动作，**不等它返回**。
 *
 * 为什么不等：桌面点了同意之后，工具执行器马上就该开跑。
 * 撤销 QQ 那条只是个收尾动作（一个 HTTP 往返，最坏 5 秒），
 * 让审批结论等它等于凭空给每次审批加延迟。
 * 失败也不影响结论 —— 桥那边最坏是超时后自己回收。
 *
 * @param {(() => Promise<any>) | undefined} fn
 */
function fireAndForget(fn) {
  if (!fn) return;
  Promise.resolve()
    .then(fn)
    .catch(() => {});
}

/**
 * 双通道竞速：桌面 UI 与 QQ 谁先给出**决定**就用谁。
 *
 * ## 为什么不是简单的 Promise.race
 *
 * 桌面端在没有浏览器连接时会立刻返回 `unavailable`。那不是决定，
 * 如果让它"赢"，QQ 还没推出去就被判成没人回答——用户会以为
 * 审批根本没发过来。所以这里比的是"谁先给出决定"，不是"谁先返回"。
 *
 * ## 两边都可能是"没有决定"
 *
 * 桌面：`unavailable`（没界面）/ `cancelled`（请求撤回）
 * QQ：`timeout` / `withdrawn` / `unknown` / 不可达
 * 这种情况下调用方按 `onUnreachable` 收场，绝不当成同意。
 *
 * @param {object} o
 * @param {() => any} o.desktop 调 next()，让 DSH 自己的界面先显示
 * @param {() => Promise<any>} o.remote 推 QQ 并等待
 * @param {(v: any) => any} o.desktopDecision 桌面返回值 → 决定/答案（null = 没答）
 * @param {(r: any) => any} o.remoteDecision 桥返回值 → 决定/答案（null = 没答）
 * @param {(info: {src: 'desktop'|'qq', decision: any}) => Promise<void>} [o.onDecision]
 * @returns {Promise<{winner: 'desktop'|'qq'|'none', decision: any, desktopValue: any, remoteValue: any}>}
 */
async function runDualChannel({ desktop, remote, desktopDecision, remoteDecision, onDecision }) {
  const d = Promise.resolve()
    .then(desktop)
    .then(
      (value) => ({ src: /** @type {const} */ ('desktop'), value }),
      () => ({ src: /** @type {const} */ ('desktop'), value: 'unavailable' }),
    );
  const q = Promise.resolve()
    .then(remote)
    .then(
      (value) => ({ src: /** @type {const} */ ('qq'), value }),
      () => ({ src: /** @type {const} */ ('qq'), value: { ok: false } }),
    );

  const first = await Promise.race([d, q]);

  if (first.src === 'desktop') {
    const decision = desktopDecision(first.value);
    if (decision) {
      fireAndForget(() => onDecision?.({ src: 'desktop', decision }));
      return { winner: 'desktop', decision, desktopValue: first.value, remoteValue: null };
    }
    // 桌面没给出决定（没有界面 / 只是 unavailable）→ 等 QQ
    const qr = await q;
    const qd = remoteDecision(qr.value);
    return {
      winner: qd ? 'qq' : 'none',
      decision: qd,
      desktopValue: first.value,
      remoteValue: qr.value,
    };
  }

  const qd = remoteDecision(first.value);
  if (qd) {
    fireAndForget(() => onDecision?.({ src: 'qq', decision: qd }));
    return { winner: 'qq', decision: qd, desktopValue: null, remoteValue: first.value };
  }
  // QQ 没给出决定（超时 / 不可达）→ 等桌面。这正是原来的 delegate 语义：
  // 界面还开着，用户仍可以在 DSH 里点，不应该因为 QQ 超时就判失败。
  const dr = await d;
  const dd = desktopDecision(dr.value);
  if (dd) fireAndForget(() => onDecision?.({ src: 'desktop', decision: dd }));
  return {
    winner: dd ? 'desktop' : 'none',
    decision: dd,
    desktopValue: dr.value,
    remoteValue: first.value,
  };
}

/**
 * @param {any} ctx
 * @param {any} config
 */
export function apply(ctx, config) {

  // apply 收到的 config 常常是**未求值的占位对象**（每个字段都是 {}），
  // 见 normalizeConfig 上的注释。真正的值要用 settings.describe() 读。
  //
  // 所以这里先归一化传入值，再和 settings 里的实时值合并：
  // settings 读得到就用它，读不到才退回传入值。
  const fromArgs = normalizeConfig(config);
  const fromSettings = normalizeConfig(readEffectiveConfig(ctx, config));
  const cfg = {
    bridgeUrl: fromSettings.bridgeUrl || fromArgs.bridgeUrl,
    bridgeToken: fromSettings.bridgeToken || fromArgs.bridgeToken,
    admins: fromSettings.admins || fromArgs.admins,
    relayApprovals: fromSettings.relayApprovals || fromArgs.relayApprovals,
    onUnreachable: fromSettings.onUnreachable || fromArgs.onUnreachable,
  };

  /* ---- 配置热更新 ------------------------------------------------------ */

  // 用户保存设置页之后，DSH 会把新值写进 profile patch，
  // 并发 'settings/document-updated'。
  //
  // **但是**插件实例不会因此重建：实测诊断日志里，保存完只有一行
  // "配置已更新"，之后再没出现过 apply，于是运行中的实例继续拿着
  // 旧的 relay=false / admins=[] 干活。表现是最难查的那种：
  // "设置里明明开着，功能就是不工作"。
  //
  // 所以自己订阅：配置一变就把新值读进这个可变对象，
  // 下游全部从它读，不再直接捕获闭包里的旧值。
  const live = {
    relayApprovals: cfg.relayApprovals,
    onUnreachable: cfg.onUnreachable,
    admins: cfg.admins,
  };

  const applyLive = () => {
    const next = normalizeConfig(readEffectiveConfig(ctx, config));
    live.relayApprovals = next.relayApprovals;
    live.onUnreachable = next.onUnreachable;
    live.admins = next.admins;

    // 地址和令牌也要跟着更新——这一条最关键。
    //
    // apply 往往在 settings 就绪**之前**执行（实测日志里两者相差约 1 秒），
    // 那一刻读到的 token 是空的，BridgeClient 于是 disabled。
    // 如果热更新只补 relay/admins 而不管 url/token，
    // 这个实例就会永远废着：轮询在跑、没有任何报错、桥一次也没被访问过。
    //
    // 所以这里重新算一次地址，生效后立刻把 bridge 修复成可用状态。
    const nextUrl = resolveBridgeUrl(next.bridgeUrl) ?? next.bridgeUrl;
    if (nextUrl && next.bridgeToken) {
      if (!bridge.enabled) {
        diag(`桥配置已补全，重新启用：${nextUrl}`);
      }
      bridge.reconfigure({ url: nextUrl, token: next.bridgeToken });
    }

    diag(
      `配置热更新：relay=${live.relayApprovals} admins=${parseAdmins(live.admins).length} bridge=${bridge.enabled ? 'enabled' : 'disabled'}`,
    );
  };

  try {
    if (typeof ctx.on === 'function') {
      ctx.effect(() =>
        ctx.on('settings/document-updated', (ns) => {
          if (!String(ns ?? '').includes(NS)) return;
          try {
            applyLive();
          } catch (err) {
            diag(`配置热更新失败：${String(err?.message ?? err)}`);
          }
        }),
      );
    }
  } catch (err) {
    diag(`订阅配置变更失败（不影响主功能）：${String(err?.message ?? err)}`);
  }
  const admins = parseAdmins(live.admins);

  // 端口自动发现。
  //
  // bridgeUrl 留空时去读 Ling-bot 写的发现文件（`~/.ling-bot/bridge.json`），
  // 于是"端口不固定"这件事用户不用管：只要填一次令牌，地址自动跟上。
  //
  // 用户显式填了就以他填的为准——自动发现只是兜底，绝不覆盖人的选择。
  const resolvedUrl = resolveBridgeUrl(cfg.bridgeUrl);
  if (!cfg.bridgeUrl && resolvedUrl) {
    diag(`bridgeUrl 未填，自动发现到 ${resolvedUrl}`);
  } else if (!cfg.bridgeUrl) {
    diag('bridgeUrl 未填，且没找到端口发现文件（Ling-bot 可能没启动过）');
  }

  const bridge = new BridgeClient({ url: resolvedUrl ?? cfg.bridgeUrl, token: cfg.bridgeToken });

  /* ---- 设置页接口 ------------------------------------------------------ */

  // 必须在**任何 return 之前**挂上。
  // 设置页恰恰是"还没配令牌"时要用的东西——如果挂不上，用户就没有任何入口
  // 去填第一份配置，只能去改 YAML。
  mountRoutes(ctx, cfg);

  diag(
    `apply: bridge=${bridge.enabled ? 'enabled' : 'disabled'} relay=${live.relayApprovals} admins=${parseAdmins(live.admins).length}`,
  );

  // **不在这里 return。**
  //
  // 以前是"桥没配就直接退出"，看着干净，实际有个致命副作用：
  // apply 经常跑在 settings 就绪之前（实测两者相差约 1 秒），
  // 那一刻 token 还是空的，于是两个方向**都还没注册**。
  // 之后即使热更新把令牌补上，也没有任何东西会去用它——
  // 表现就是"配置明明填好了，功能就是不动"。
  //
  // 改成：先把处理器挂上，让它们自己在运行时看 bridge.enabled。
  // 未配置时什么都不做，配置好了立刻开始工作。
  if (!bridge.enabled) {
    diag('桥尚未配置 —— 处理器已就位，等配置补全后自动开始工作');
  }

  /* ---- 方向一：QQ → DSH（下指令）------------------------------------- */

  // 与审批转推**互相独立**：只要桥配了就能用。
  // 这样"只想从 QQ 发指令、审批继续在界面点"是一种可用组合。
  const stopPoller = startCommandPoller(ctx, bridge);
  ctx.effect(() => () => {
    stopPoller();
    diag('已停止指令轮询');
  });
  diag('已启动指令轮询');

  /* ---- 方向二：DSH → QQ（审批转推）----------------------------------- */

  // 同样**不能**在这里 return：relayApprovals 可能是热更新之后才打开的，
  // 提前 return 会让审批处理器永远不被注册。改成注册后每次调用时再看开关。
  if (!live.relayApprovals) {
    diag('relayApprovals 当前关闭 —— 处理器已就位，打开后立即生效');
  }

  ctx.on('approval/request', async (req, next) => {
    // 每次调用都现读开关和名单，不用 apply 时那份快照。
    // apply 常常跑在 settings 就绪之前，那时这两样都还是空的。
    if (!live.relayApprovals) return next();

    // 没配管理员 = 没人有权决定 = 不接管（不是"全放行"）
    if (parseAdmins(live.admins).length === 0) {
      diag('没有配置管理员 —— 不接管审批');
      return next();
    }

    const signal = req?.signal;
    if (signal?.aborted) return 'cancelled';

    // 地址可能是空的（DSH 先于 Ling-bot 启动）。这里补一次，
    // 补不到就走桌面端——不能因为"对面还没起"让审批彻底失效。
    bridge.discover();
    if (!bridge.enabled) {
      diag('桥地址/令牌未就绪 —— 审批走桌面端');
      return next();
    }

    // QQ 的等待上限：到点就不再等 QQ。桌面界面不受影响，仍由用户决定。
    //
    // 比桥内队列的 120s 多留 5s：桥到点会回 status:'timeout'，
    // 那是**有意义的结论**（按 onUnreachable 处理）；如果两边同时到点，
    // 客户端会先 abort，把 timeout 变成一个普通的网络错误，白丢信息。
    const timeout = new AbortController();
    const onAbort = () => timeout.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => timeout.abort(), REMOTE_WAIT_MS);

    /**
     * 桥登记的结果。
     *
     * 为什么要把"登记"本身也存下来：桌面面板可能在 `/dsh/ask` 还没返回时
     * 就被点了（本地 UI 比一次 HTTP 往返快得多）。那一刻 `id` 还是空的，
     * 直接判断 `if (id)` 会跳过撤销，QQ 那条就白挂到超时。
     * 所以撤销前先等这个 Promise —— 它一定会 settle，不会卡住。
     */
    const remoteState = { id: '', registered: Promise.resolve(null) };

    try {
      const { decision } = await runDualChannel({
        // 关键：先调 next()，桌面审批面板照常出现。
        // 不能像以前那样把 QQ 的结论直接 return——那会让面板根本收不到请求。
        desktop: () => next(),
        remote: async () => {
          const startPromise = bridge.askStart(
            {
              toolName: String(req?.toolName ?? 'unknown'),
              reason: String(req?.reason ?? ''),
              displayReason: req?.displayReason ?? null,
              agentId: String(req?.agent?.id ?? ''),
              callId: req?.callId ? String(req.callId) : '',
              timeoutMs: APPROVAL_TIMEOUT_MS,
            },
            // 登记这一步**只受调用方取消影响**，不受"等 QQ"的超时控制：
            // 桌面先答时我们要立刻 abort 掉挂着的 await，但撤销还需要编号，
            // 如果登记也挂在同一个 signal 上，编号就永远拿不到了。
            signal,
          );
          remoteState.registered = startPromise.then(
            (s) => {
              remoteState.id = s.ok ? String(s.id ?? '') : '';
              return s;
            },
            () => null,
          );
          const started = await startPromise;
          if (!started.ok) return { ok: false, error: started.error };
          // 免打扰：桥直接给了结论，没有待回复编号
          if (started.outcome) {
            return { ok: true, status: 'answered', kind: 'approval', outcome: started.outcome };
          }
          return bridge.awaitResult(started.id, timeout.signal);
        },
        desktopDecision: desktopApprovalDecision,
        remoteDecision: bridgeApprovalDecision,
        onDecision: async ({ src }) => {
          // 桌面先答：把 QQ 那条撤掉，免得用户再回一次过期编号
          if (src !== 'desktop') return;
          await remoteState.registered;
          if (remoteState.id) await bridge.withdraw(remoteState.id, 'desktop').catch(() => {});
        },
      });

      if (signal?.aborted) return 'cancelled';
      if (decision) {
        diag(`审批结论：${req?.toolName} → ${decision}`);
        return decision;
      }
      // 两边都没有结论：按 onUnreachable。delegate 的"交还"就是 unavailable，
      // 因为桌面端已经问过了（next() 的返回值就是 DSH 自己的结果）。
      diag('审批没有结论（QQ 超时/不可达，桌面也没答）—— 按 onUnreachable 处理');
      return unreachableOutcome(live.onUnreachable) ?? 'unavailable';
    } catch (err) {
      // 任何意外都按 onUnreachable 处理，绝不让异常穿透到 DSH 的审批链
      diag(`审批处理异常：${String(err?.message ?? err)}`);
      return unreachableOutcome(live.onUnreachable) ?? 'unavailable';
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);

      // 结论已经定了，把还挂着的 /dsh/await 掐掉，别白占一条连接。
      //
      // 这样做是安全的：撤销用的编号来自 `askStart`，它挂在**调用方的**
      // signal 上（不受这里影响），所以 abort 之后 fire-and-forget 的
      // withdraw 仍然拿得到编号。
      timeout.abort();
    }
  }, { prepend: true });

  diag('已接管 approval/request');

  /* ---- 提问也要能推到 QQ ---------------------------------------------- */

  // `user-questions/request` 是 waterfall：返回答案，或 `next()` 交还界面。
  //
  // 与审批的关键区别：**没有"只有一种答案合法"这回事**。
  // 选项数量、是否多选、是否自由输入，全由这次请求自己决定。
  // 所以这里只做搬运：把 questions 原样送到桥，把答案原样搬回来。
  if (typeof ctx.on === 'function') {
    ctx.on('user-questions/request', async (request, next) => {
      const answer = () => next();

      if (!live.relayApprovals) return answer();

      // 一次只转推**一组**问题，且必须至少有一个选项——
      // 纯自由输入的问题在 QQ 端没有编号可回，硬转只会让人无从下手。
      const questions = Array.isArray(request?.questions) ? request.questions : [];
      const hasOptions = questions.some(
        (q) => Array.isArray(q?.options) && q.options.length > 0,
      );
      if (!hasOptions) {
        diag('提问没有选项（纯自由输入）—— 交还界面');
        return answer();
      }

      const signal = request?.signal;
      if (signal?.aborted) throw new Error('ASK_ABORTED');

      // 同审批：地址可能是空的，用之前补一次
      bridge.discover();
      if (!bridge.enabled) {
        diag('桥地址/令牌未就绪 —— 提问交还界面');
        return answer();
      }

      const timeout = new AbortController();
      const onAbort = () => timeout.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      // 同审批：比桥内 120s 多留 5s，让"超时"作为一个明确状态传回来
      const timer = setTimeout(() => timeout.abort(), REMOTE_WAIT_MS);
      // 同审批：撤销前要等登记结果，否则界面比 HTTP 快时会漏撤
      const remoteState = { id: '', registered: Promise.resolve(null) };

      try {
        const { decision, desktopValue } = await runDualChannel({
          // 同样先调 next()：DSH 的提问面板照常出现，QQ 只是第二条通道
          desktop: () => next(),
          remote: async () => {
            // 同审批：登记只受调用方取消影响，撤销要用它拿到的编号
            const startPromise = bridge.askQuestionStart({ questions }, signal);
            remoteState.registered = startPromise.then(
              (s) => {
                remoteState.id = s.ok ? String(s.id ?? '') : '';
                return s;
              },
              () => null,
            );
            const started = await startPromise;
            if (!started.ok) return { ok: false, error: started.error };
            if (started.answer !== undefined) {
              return { ok: true, status: 'answered', kind: 'question', answer: started.answer };
            }
            return bridge.awaitResult(started.id, timeout.signal);
          },
          desktopDecision: desktopAnswerDecision,
          remoteDecision: bridgeAnswerDecision,
          onDecision: async ({ src }) => {
            if (src !== 'desktop') return;
            await remoteState.registered;
            if (remoteState.id) await bridge.withdraw(remoteState.id, 'desktop').catch(() => {});
          },
        });

        if (decision) {
          diag(`提问答案：${JSON.stringify(decision).slice(0, 120)}`);
          return decision;
        }

        // 两边都没答案：把桌面端本来的返回值交回去（等价于 delegate）。
        // 注意不能在这里再调一次 next()——那会把下游监听器跑第二遍。
        diag('提问没人回答 —— 交还界面');
        return desktopValue;
      } catch (err) {
        // 任何异常都交还界面：绝不能让 QQ 侧的问题把 DSH 卡死
        diag(`提问处理异常：${String(err?.message ?? err)} —— 交还界面`);
        return answer();
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        // 同审批：结论已定，把挂着的 /dsh/await 掐掉
        timeout.abort();
      }
    });
    diag('已接管 user-questions/request');
  }
}

/**
 * 把可能为空的配置整理成确定的形状。
 *
 * @param {any} raw
 */
/**
 * 把 DSH 传进来的 config 归一化。
 *
 * ## 为什么不能直接 `String(x ?? '')`
 *
 * 实测：apply 收到的每一个字段都可能是**空对象** `{}`，不是值。
 * 因为 Config schema 把每个字段声明成
 * `anyOf: [string, loaderExpression]`，而 loaderExpression 是
 * `{ __jsExpr: string }` —— 未求值时就是一个普通对象。
 *
 * `String({})` 得到字面量 `"[object Object]"`。
 * 于是 bridgeUrl 变成 "[object Object]"、token 变成 "[object Object]"，
 * 两者都"非空"，`enabled` 于是为 true，请求发往
 * `[object Object]/dsh/drain` —— 报 "Failed to parse URL"。
 *
 * 更糟的是这看起来一切正常：插件说 enabled、轮询在跑、日志不报错。
 * 这一层必须把"对象"一律当**没有值**，而不是当字符串。
 *
 * @param {any} raw
 */
function normalizeConfig(raw) {
  const c = raw ?? {};

  /** 只接受真正的字符串/数字/布尔，其它一律当没有 */
  const str = (v) => {
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    // 对象（含 { __jsExpr } 与占位 {}）、数组、null、undefined 都不算值
    return '';
  };

  return {
    bridgeUrl: str(c.bridgeUrl),
    bridgeToken: str(c.bridgeToken),
    admins: str(c.admins),
    relayApprovals: c.relayApprovals === true,
    onUnreachable: str(c.onUnreachable),
  };
}

/* ------------------------------------------------------------------ 下指令 */

/** 轮询间隔。3 秒对"人发指令"这个节奏足够了，也不会把 CPU 空转起来。 */
const POLL_MS = 3_000;

/**
 * 把 QQ 指令投进 DSH 的会话。
 *
 * ## 为什么用 `sessionController.prompt()` 而不是自己造消息
 *
 * `prompt()` 是 DSH 自己的**公开入口**：它会走完整的准入流程
 * （会话存在性、队列/插话语义、持久化）。绕开它直接改会话事件流
 * 会跳过这些检查，而且下次 DSH 升级内部结构就会崩。
 *
 * ## mode 选 'queue'
 *
 * 'queue' = 排队，等当前回合结束再处理；'steer' = 打断当前回合。
 * 从 QQ 发来的指令**不应该**打断正在跑的任务——你人在外面，
 * 不知道它进行到哪一步，插话更可能把有用的中间结果丢掉。
 *
 * @param {any} ctx
 * @param {{sessionId: string, text: string}} cmd
 * @returns {Promise<void>}
 */
async function deliverCommand(ctx, cmd) {
  const sc = ctx.get('sessionController');
  if (!sc) throw new Error('sessionController 不可用（DSH 版本可能不匹配）');

  const sessionId = String(cmd?.sessionId ?? '');
  if (!sessionId) throw new Error('指令没有指定会话');

  // requestId 必须唯一：同一个 requestId 重复提交会被 DSH 当成幂等重放
  const requestId = `qq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await sc.prompt(
    {
      requestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: String(cmd.text) }],
    },
    new AbortController().signal,
  );
}

/**
 * 起一个轮询循环，从桥进程取指令并投给 DSH。
 *
 * @param {any} ctx
 * @param {BridgeClient} bridge
 * @returns {() => void} 停止函数
 */
function startCommandPoller(ctx, bridge) {
  let stopped = false;
  /** 失败计数：只记前几次，避免刷屏 */
  let failCount = 0;
  /** tick 计数：确认轮询是否真的重入 */
  let tickCount = 0;
  let timer = /** @type {NodeJS.Timeout | null} */ (null);

  const tick = async () => {
    /** @type {any} */
    let res;
    if (stopped) return;

    // 每次 tick 都补一次地址：Ling-bot 可能比 DSH 晚启动，
    // 那时 apply 阶段读不到发现文件。补上之后这条轮询就自动开始工作，
    // 不需要用户重启 DSH。
    if (bridge.discover()) diag(`已自动发现桥地址：${bridge.urlForDiag}`);

    // 只在前两次记心跳：够证明轮询重入了，又不至于把日志淹掉
    if (++tickCount <= 2) diag(`tick #${tickCount}（stopped=${stopped}）bridge=${bridge.urlForDiag ?? '?'} enabled=${bridge.enabled}`);
    try {
      res = await bridge.drain();
      if (res.ok && Array.isArray(res.items)) {
        for (const cmd of res.items) {
          try {
            await deliverCommand(ctx, cmd);
            diag(`指令已投递：${String(cmd?.text ?? '').slice(0, 40)}`);
          } catch (err) {
            // 投递失败要上报，否则用户以为指令生效了
            diag(`指令投递失败：${String(err?.message ?? err)}`);
            await bridge
              .reportDelivery({
                text: String(cmd?.text ?? ''),
                error: String(err?.message ?? err),
              })
              .catch(() => {});
          }
        }
      }
    } catch (err) {
      // 之前这里完全静默，结果是"轮询已启动"却一次都没连上，
      // 而日志一片安静 —— 排查时毫无线索。
      // 现在只记前几次：既不刷屏，也能证明到底通没通。
      if (failCount < 3) {
        failCount++;
        diag(`drain 失败(#${failCount})：${String(err?.message ?? err)}`);
      }
    }
    if (typeof res !== 'undefined' && res && !res.ok && failCount < 3) {
      // 桥可达但返回失败：最常见的是令牌对不上（401），
      // 或者 enabled=false 时 #post 直接短路（status=0）。
      // 这段以前根本不存在，于是"轮询在跑但什么也没发生"完全没有痕迹。
      failCount++;
      diag(`drain 未成功(#${failCount})：status=${res.status} ${res.error ?? JSON.stringify(res.data ?? null)?.slice(0, 160) ?? ''}`);
    }
    if (!stopped) timer = setTimeout(tick, POLL_MS);
  };

  timer = setTimeout(tick, POLL_MS);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
