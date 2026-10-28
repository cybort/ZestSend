# ZestSend

ZestSend 是一个开源的 WebRTC 点对点连接网页工具，可自行部署在 Cloudflare 上。

支持端对端加密的匿名实时聊天、文件互传、语音通话、视频通话、屏幕共享、同播共享、文本协作、画板等功能，支持点对点直连或 Cloudflare TURN 中转。

无任何账号机制、完全匿名，两位参与者输入相同的六位房间号后即可连接。聊天等应用内容默认只在浏览器之间点对点传输；刷新后由本标签页的 sessionStorage 恢复，离开页面即清除。对方先后离线时，未送达消息以 AES-256-GCM 密文暂存在房间（最多 24 小时、条数与体积有上限），密钥只经已建立的端对端数据通道分发，服务器看不到明文。直接使用 Cloudflare 部署，即可建立点对点直连连接。配置 Cloudflare TURN 服务器后，可每月免费获得 1000GB 中转连接流量。

页面切到后台时连接与传输会继续：信令心跳会容忍浏览器对后台定时器的节流而不误断开，文件传输改用数据通道背压事件驱动而非定时器推进，音视频通话与屏幕共享期间持有屏幕常亮锁（Wake Lock）。移动端浏览器将页面挂起时受操作系统限制只能尽力而为，回到前台会自动探测连通并补齐未送达消息。

延续并改进了 [RavelloH/TimePulse](https://github.com/RavelloH/TimePulse) 的玻璃态设计美学。

## 部署

Fork 本仓库后，在 Cloudflare Dashboard 的 **Workers & Pages** 中依次选择 **Create application** → **Import a repository**，选择自己的 Fork 并完成 GitHub 授权。

在部署设置中保留 Worker 名称为 `zestsend`（需与 `wrangler.jsonc` 一致），选择 `main` 作为生产分支，并设置：

| 配置 | 值 |
| --- | --- |
| Package manager | `pnpm` |
| Build command | 留空 |
| Deploy command | `pnpm deploy` |

### 可选：配置 Cloudflare TURN

未配置 TURN 时，应用仍会使用公共 STUN 尝试直连；如需在受限网络中使用中继，请先在 Cloudflare Dashboard 的 **Realtime** → **TURN** 创建凭证，然后在已部署 Worker 的 **Settings** → **Variables and Secrets** 中添加两个 **Secret**：

| 名称 | 值 |
| --- | --- |
| `TURN_ID` | TURN 凭证的 Key ID |
| `TURN_TOKEN` | TURN 凭证的 API Token |

后续更新时，在 GitHub 通过 **Sync fork** 拉取上游提交并合并到 `main`；Cloudflare 会自动构建并部署。

## 预览

前往 https://send.ravelloh.com 查看效果。

<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/c842bdce-a80c-4760-947d-b601b1023b1f" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/578cf5c6-5ec1-4ba5-a490-a3052cc9bc25" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/90ba302f-a5ed-4e9a-98c0-f2fcc2f0484a" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/ea9522f1-e074-4d6b-8d4c-26963523d044" />
<img width="2560" height="1528" alt="image" src="https://github.com/user-attachments/assets/db5058f0-96ab-43f2-bbea-802ada0e25f1" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/d8524922-8792-45c1-9196-36585af365b2" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/d3fd6f95-285a-49be-9c59-d6ae7a63ed3e" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/a9c5cde1-74f1-4b72-9bdc-4c4e3a484d1b" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/6004e9f8-8b6e-4fee-99e8-000107e96524" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/5fdd10e9-b273-4c8d-a5d1-5f579ec4cd91" />
<img width="2478" height="1455" alt="image" src="https://github.com/user-attachments/assets/808932dc-671d-4dec-9a3a-8ac7e08282e0" />



## 技术栈

- Cloudflare Workers、Durable Objects、Realtime TURN
- Hono、Wrangler、Cloudflare Vite Plugin
- 原生 WebRTC 的 `RTCPeerConnection`、`RTCDataChannel`、MediaStream
- React、Vite、TypeScript、Tailwind CSS、TanStack Router
- Tiptap、Yjs
- Framer Motion

## 本地开发

```bash
pnpm install
pnpm dev
```

打开 [http://127.0.0.1:8787](http://127.0.0.1:8787)。

可选的 Cloudflare TURN 配置写入 `.env`：

```dotenv
TURN_ID=your_cloudflare_turn_key_id
TURN_TOKEN=your_cloudflare_turn_api_token
```

未配置 TURN 时，应用仍会使用公共 STUN 尝试直连；受限网络无法穿透时则不会启用中继。

内网代理或防火墙拦截 `Upgrade: websocket` 时，信令会在两次 WebSocket 失败后自动改走普通 HTTPS 长轮询（`POST /api/rooms/:roomId/signal`）。房间两端可以分别使用 WebSocket 与 HTTPS，ICE、席位恢复和心跳语义保持一致。

## 远程控制 AI 代理（harness）

ZestSend 房间内新增「远程」面板：通过端对端数据通道，控制另一台设备上运行的 CLI AI 编码代理（Claude Code / Copilot CLI）——发送提示词、查看流式输出、批准/拒绝工具调用，并可选执行 shell 命令与文件读写。每个房间可管理多个代理会话，随时切换且互不打断。

### 被控端守护进程

```bash
# 在运行 AI 代理的机器上启动（Node.js 22+）
node node_modules/tsx/dist/cli.mjs src/harness/main.ts \
  --room <六位房间号> \
  --server https://<部署域名> \
  --agent claude-code \        # 或 copilot-cli / fake（测试）
  --workspace /path/to/repo \
  --permission approve \       # readonly | approve | full
  --state-dir ~/.zestsend/harness
```

守护进程会打印一次性**连接码**；在浏览器「远程」面板输入该码完成授权。`full` 权限才会开放 shell/文件写入，可配合 `--allow`/`--deny` 命令白名单。

### 安全模型

- **连接码授权**：首次配对/新设备必须输入被控端本地显示的一次性 6 位连接码（单次使用、2 分钟有效、错误限次防爆破）。
- **设备指纹固定（TOFU）**：授权后双向 Ed25519 公钥写入信任库，后续连接凭签名握手免连接码；换设备或指纹变化需重新授权。房间号仅用于寻址，不构成授权。
- **权限分级**：`readonly`（只读）/ `approve`（提示词 + 审批）/ `full`（含 shell、文件写入）；shell 受工作目录沙箱与命令黑白名单约束，`panic` 可立即断开。
- **数据边界**：控制流量仅走 P2P（DTLS 端到端加密），不经服务器明文；断线期间的提示词与审批在控制端本地排队，恢复后自动补发，会话转录由被控端持久化并在重连后快照重放。

### 测试

```bash
npm test                                    # 单测（含 daemon 控制面）
npx playwright test e2e/harness-control.spec.ts   # 端到端（FakeAdapter）
```

## 许可证

本项目采用 [MIT License](LICENSE)。
