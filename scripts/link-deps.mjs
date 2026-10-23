/**
 * dsh-qq-bridge 的依赖解析兜底
 *
 * ## 为什么需要这个文件
 *
 * 插件是以 `link:` 形式装进 DSH profile 的（开发期常态）：
 *
 *   profile/node_modules/dsh-qq-bridge -> D:/deepseek-harness/.../dsh-qq-bridge
 *
 * Node 的 ESM 解析会**先 realpath 再用真实路径找依赖**，于是
 * `import '@deepseek-ai/schemastery'` 从 `D:/deepseek-harness/.../lib/index.js`
 * 往上找，一路找到 `D:/` 都没有 `node_modules`，直接报：
 *
 *   ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'
 *
 * 表现是整个插件加载失败（DSH 启动日志里只有一行 "1 entry did not activate"），
 * 桥接当然也就完全不通。
 *
 * ## 解法
 *
 * 在本目录放一个 `node_modules` 链接，指向 profile 的 `node_modules`
 * —— 那里已经有 DSH 自己装好的 schemastery。不是把依赖复制一份：
 * 复制会随 DSH 升级而版本漂移，而链接永远跟着 profile 走。
 *
 * Windows 下用 junction（不需要管理员权限，跨盘也行）：
 *
 *   cmd /c mklink /J node_modules "%USERPROFILE%\.dsh\profiles\desktop\node_modules"
 *
 * 这个脚本把上面那条命令包起来，并做幂等检查。
 */

import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// 本文件在 scripts/ 里，链接要落在**插件根目录**（lib/ 的上一级）
const linkPath = path.join(path.resolve(here, '..'), 'node_modules');

/**
 * 按优先级猜 profile 的 node_modules。
 *
 * `DSH_PROFILE_DIR` 可以显式指定；否则用桌面版默认位置。
 *
 * @returns {string[]}
 */
function candidates() {
  const out = [];
  if (process.env.DSH_PROFILE_DIR) {
    out.push(path.join(process.env.DSH_PROFILE_DIR, 'node_modules'));
  }
  out.push(path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules'));
  return out;
}

const target = candidates().find((p) => existsSync(path.join(p, '@deepseek-ai', 'schemastery')));
if (!target) {
  console.error('找不到 DSH profile 里的 @deepseek-ai/schemastery。');
  console.error('请设置 DSH_PROFILE_DIR 指向你的 profile 目录后重试。');
  process.exit(1);
}

if (existsSync(linkPath)) {
  const st = lstatSync(linkPath);
  const cur = st.isSymbolicLink() ? readlinkSync(linkPath) : '(真实目录)';
  console.log(`已存在：${linkPath} -> ${cur}`);
  process.exit(0);
}

if (process.platform === 'win32') {
  const r = spawnSync('cmd', ['/c', 'mklink', '/J', linkPath, target], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const r = spawnSync('ln', ['-s', target, linkPath], { stdio: 'inherit' });
process.exit(r.status ?? 1);
