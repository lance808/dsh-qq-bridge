# dsh-qq-bridge

把 **DSH 的工具审批与会话控制**接到 QQ：审批请求推到 QQ 由管理员拍板，QQ 指令反过来驱动 DSH 干活。

> 这是一个 **DSH 插件**（Cordis bundle patch），装在 DSH 里。
> 它不是 [Ling-bot](https://github.com/lance808/ling-bot) 自身的内置插件 —— 那是另一套东西。

## 它解决什么问题

DSH 默认在**它自己的界面**里等工具审批。人不在电脑前时，一次需要确认的调用就会把整个任务卡住。

这个插件把「审批」搬到 QQ：

- DSH 要执行需要确认的工具 → **桌面审批面板照常弹出**，同时把请求推到 QQ
- 你在 QQ 里回一句同意/拒绝 → 插件把结论交回 DSH
- 你在桌面面板点同意/拒绝 → 插件把 QQ 那条撤掉，不再打扰你
- QQ 不可达时按配置决定：交还 DSH 默认策略（fail-open），或直接拒绝（更严）

**两边同时存在、先到先得**：不是「推到 QQ 就把界面藏起来」，而是两条通道
并行等待。哪边先给出决定就用哪边，另一边随后作废。

同时支持从 QQ 下发指令，让 DSH 替你干活。

## 设计取向

**功能纯增量**：所有配置项默认留空。留空即「未设置」，对应能力就不启用 ——
因此「没装这个插件」和「装了但没配」的行为完全一致。

**QQ 掉线不拖死 DSH**：`onUnreachable` 决定兜底策略。
默认语义是「不接管，把决定权交回 DSH」，而不是替 DSH 做拒绝决定 ——
这两件事在 `lib/logic.js` 的回调返回 `null` 与 `'rejected'` 上是严格区分的。

**只读判定与运行时分离**：`lib/logic.js` 不导入 `schemastery`，
所以管理员解析、权限判定、兜底结论、双通道「谁算答了」这四件事
可以脱离 DSH 运行时直接单测。

**面板不消失**：处理器以 `{ prepend: true }` 注册，但**先调 `next()`** ——
DSH 自己的审批界面必须先拿到请求。以前是把 QQ 的结论直接 `return`，
那样面板根本收不到请求，用户看到的是「审批凭空消失了」。

**QQ 先答时面板留一个残影**：插件无法从审批链内部撤销 `req.signal`
（那会被工具执行器当成「用户取消」），所以迟到的桌面点击会被 DSH 丢弃，
面板本身要等它自己超时才收起。这是刻意的取舍 —— 宁可多一个空面板，
也不要把「取消」误传给正在跑的工具。

## 安装

```bash
# 在你的 DSH profile 里装这个包
npm install dsh-qq-bridge
```

然后通过 `cordis.patch.yml` 注册（本仓库自带，作为 bundle patch 使用）。

### 开发期用 `link:` 安装时必看

以 `link:` 装进 profile 时，Node 的 ESM 解析会**先 realpath 再找依赖**，
于是 `import '@deepseek-ai/schemastery'` 从本仓库真实路径往上找，
一路到 `D:/` 都没有 `node_modules`，插件直接加载失败：

```
dsh-qq-bridge (dsh-qq-bridge): failed to import:
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/schemastery'
```

而 DSH 启动日志里只会多一行 `warning: 1 entry did not activate` —— 很容易被忽略。

修法是让本目录有个 `node_modules` 指向 profile 的那份（不是复制，避免版本漂移）：

```bash
npm run link-deps
# 等价于：cmd /c mklink /J node_modules "%USERPROFILE%\.dsh\profiles\desktop\node_modules"
```

> ⚠️ patch 里 entry 的 **id 必须是 `dsh-qq-bridge`**（= 包名 = settings 命名空间名）。
> DSH 0.2.0 起命名空间完全由 loader entry 的 id 推导，
> 写成别的会让 `settings.update({ns:'dsh-qq-bridge'})` 永远抛
> `No configurable plugin entry "dsh-qq-bridge"`。

## 配置项

全部留空即不启用任何能力。

| 键 | 说明 |
| --- | --- |
| `bridgeUrl` | 桥进程的 HTTP 地址，例如 `http://127.0.0.1:3458`；留空表示不启用 |
| `bridgeToken` | 与桥进程约定的共享令牌；留空表示不启动桥连接（插件静默待命） |
| `admins` | 允许通过 QQ 控制 DSH 的管理员 QQ 号，逗号分隔；留空表示一个都不允许 |
| `relayApprovals` | 是否把工具审批请求推到 QQ；`false` 表示完全不接管审批 |
| `onUnreachable` | QQ 不可达时：`delegate` 交还 DSH 默认策略（推荐）；`deny` 直接拒绝 |

## 与桥进程的协议（v2 两段式）

桥进程是 Ling-bot 侧的 `dsh-bridge` 插件（回环端口，默认 3458）。
完整契约见 `D:\Ling-bot\docs\dsh-bridge-protocol.md`，这里是插件实际用到的那部分：

| 路由 | 作用 |
| --- | --- |
| `POST /dsh/ask` | 登记一次审批/提问，**立刻**回 `{ok, id}`；免打扰时回 `{ok, id:null, outcome}` |
| `POST /dsh/await` | 用编号等结论：`{status: answered\|timeout\|withdrawn\|cancelled\|unknown}` |
| `POST /dsh/withdraw` | 桌面端先答了，撤销 QQ 那条（失败可忽略：多半是已经答过/超时） |
| `POST /dsh/drain` | 取走 QQ 排队的指令 |
| `POST /dsh/delivery-failed` | 上报指令投递失败 |
| `POST /dsh/ping` | 探活 |

为什么要拆成两段：长轮询的响应要等结果才回来，插件**拿不到编号**，
也就无法在「桌面先答」时撤销 QQ 那条。拆开之后编号在推送的同时就有了。

`status` 是唯一判据，HTTP 码不承载结论。`timeout` 不是拒绝 —— 用户可能只是
没看手机；调用方按 `onUnreachable` 收场。

## 提供的 HTTP 路由

插件在 DSH 的 web server 上挂载 `/api/qq-bridge`：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/qq-bridge/config` | 读当前配置（令牌只回 `hasToken` 布尔值，不回显） |
| POST | `/api/qq-bridge/config` | 更新配置 |
| POST | `/api/qq-bridge/config/clear-token` | 清除已存的令牌 |

前端界面在 `client.js`（`dsh.client.platform = web`，立即注入）。

## 安全须知

- `bridgeToken` **不会**通过 GET 路由回显，只返回 `hasToken`
- `admins` 为空时**没有任何 QQ 号**能控制 DSH —— 这是刻意的默认值
- 不要把填了真实 `bridgeToken` / `admins` 的配置文件提交进仓库

## 许可

MIT
