/**
 * dsh-qq-bridge 的纯判定逻辑
 *
 * 单独一个文件，**不导入 schemastery**：这样单元测试可以直接测这些判定，
 * 不需要 DSH 的运行时依赖。schema 声明留在 index.js。
 */

export function parseAdmins(raw) {
  return String(raw ?? '')
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{4,15}$/.test(s));
}

/**
 * 判断一个 QQ 号是不是管理员。
 *
 * @param {string} qq
 * @param {string[]} admins
 * @returns {boolean}
 */
export function isAdmin(qq, admins) {
  return admins.includes(String(qq));
}

/**
 * 决定 QQ 不可达时返回什么审批结论。
 *
 * 注意返回 `null` 表示"不接管，调 next()"，
 * 与返回 `'rejected'` 是两件完全不同的事：
 * 前者把决定权交回 DSH，后者是替 DSH 做了拒绝的决定。
 *
 * @param {string} policy
 * @returns {'rejected'|null}
 */
export function unreachableOutcome(policy) {
  return policy === 'deny' ? 'rejected' : null;
}

/* ------------------------------------------------------------------ 双通道 */

/** 审批词表里真正代表"人做了决定"的两个值 */
export const DECISIONS = ['allowed-once', 'rejected'];

/**
 * 这个审批结论是不是一个决定。
 *
 * `unavailable` / `cancelled` / 空值都不算：
 * 前者表示"没人能答"，后者表示"问题被撤回"。
 *
 * @param {unknown} outcome
 * @returns {boolean}
 */
export function isDecision(outcome) {
  return DECISIONS.includes(String(outcome));
}

/**
 * 桌面端（DSH 自己的审批面板）先返回时，这个值算不算"已经答了"。
 *
 * 为什么 `unavailable` 不算：浏览器没连、或 remote forwarder 没挂上时，
 * `next()` 会立刻给出 `unavailable`。如果把它当成决定，QQ 那边还没开始
 * 就被提前结算了——用户会看到"根本没收到审批"。
 *
 * @param {unknown} value
 * @returns {'allowed-once'|'rejected'|'cancelled'|null}
 */
export function desktopApprovalDecision(value) {
  const v = String(value ?? '');
  if (v === 'allowed-once' || v === 'rejected' || v === 'cancelled') {
    return /** @type {any} */ (v);
  }
  return null;
}

/**
 * QQ（桥）先返回时，这个结果算不算"已经答了"。
 *
 * `timeout` / `withdrawn` / `unknown` 都不算决定：
 *   - timeout：没人回答，按 onUnreachable 处理
 *   - withdrawn：这一端已经作废（桌面先答了）
 *   - unknown：编号不在册（多半是超时回收）
 *
 * @param {{ok?: boolean, status?: string, outcome?: string}} result
 * @returns {'allowed-once'|'rejected'|'cancelled'|null}
 */
export function bridgeApprovalDecision(result) {
  if (!result?.ok) return null;
  if (result.status === 'cancelled') return 'cancelled';
  if (result.status === 'answered' && isDecision(result.outcome)) {
    return /** @type {any} */ (result.outcome);
  }
  return null;
}

/**
 * 桌面端先返回时，这个值算不算"已经答了"（提问版）。
 *
 * 提问的答案是对象，空值/undefined 表示界面没答（或没有界面）。
 *
 * @param {unknown} value
 * @returns {object|null}
 */
export function desktopAnswerDecision(value) {
  return value && typeof value === 'object' ? /** @type {object} */ (value) : null;
}

/**
 * QQ 先返回时，这个结果算不算"已经答了"（提问版）。
 *
 * @param {{ok?: boolean, status?: string, kind?: string, answer?: any}} result
 * @returns {object|null}
 */
export function bridgeAnswerDecision(result) {
  if (!result?.ok) return null;
  if (result.status === 'answered' && result.kind === 'question' && result.answer) {
    return result.answer;
  }
  return null;
}
