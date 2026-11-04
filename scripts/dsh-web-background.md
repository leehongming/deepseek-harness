# DeepSeek Harness Web 后台启动与公网入口

`scripts/dsh-web-background.sh` 统一管理 DeepSeek Harness Web 服务及其对外入口。脚本默认使用官方 Node `22.22.1` 把 Harness 启动在 `127.0.0.1:9910`，对外入口提供两种模式：

- **`task-board`（默认）**：`scripts/dsh-web-task-board-proxy.mjs` —— 带认证的反向代理。它保留浏览器的 `Host`/`Origin`/`Cookie`/`Sec-Fetch-*`，并注入任务看板 Host 闸门要求的服务端 token（`trustedProxyHosts` + `X-Dsh-Task-Board-Proxy-Token`），因此任务看板在公网 authority 下可用。
- **`socat`**：原始 TCP 转发，不改写任何请求头。GUI 可用，但任务看板的 `/api/task-board/*` 会被插件闸门拒绝（403），面板显示 `board.hostError.forbidden`。

脚本同时会临时关闭 HMR watcher（规避当前主机的 inotify 限制），并按模式生成 overlay、token 与代理口令。

## 使用方式

```bash
cd /workspace/deepseek-harness

./scripts/dsh-web-background.sh start      # 启动 Harness + 对外入口
./scripts/dsh-web-background.sh status     # 查看进程、端口与当前模式
./scripts/dsh-web-background.sh restart    # 先停后起
./scripts/dsh-web-background.sh verify     # 验收：看板经代理 200、绕过代理 403
./scripts/dsh-web-background.sh stop       # 停止全部
./scripts/dsh-web-background.sh logs       # 持续输出两个服务的日志
```

从 socat 模式切换到默认的 task-board 代理（会重启 Harness，脚本会先等待交互回合结束，失败自动回滚）：

```bash
( setsid nohup ./scripts/dsh-web-switch-to-task-board-proxy.sh >/dev/null 2>&1 & )
tail -f /tmp/deepseek-harness-web/switch.log
```

## 默认配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| Harness 监听地址 | `127.0.0.1:9910` | Harness 自身保持 loopback 绑定 |
| 对外入口 | `0.0.0.0:8211` | task-board 代理或 socat |
| 公开访问地址 | `http://<首个本机 IPv4>:8211/` | 自动取 `hostname -I` 的第一个 IPv4 地址 |
| 信任主机 | 本机 IP、主机名、公开主机 | 写入 `--trusted-host` 与 `trustedProxyHosts` |
| 运行目录 | `/tmp/deepseek-harness-web` | PID、日志、overlay、token、代理口令 |
| 代理口令 | `proxy-basic-auth`（0600） | `user:pass`，默认用户 `dsh` |
| 看板 token | `task-board-proxy-token`（0600） | 只由代理注入，不下发给浏览器 |

## 环境变量覆盖

```bash
PUBLIC_HOST=10.227.13.5 \
DSH_PROXY_MODE=task-board \
DSH_INTERNAL_PORT=9910 \
DSH_PROXY_PORT=8211 \
DSH_RUNTIME_DIR=/tmp/deepseek-harness-web \
./scripts/dsh-web-background.sh restart
```

可用变量包括 `DSH_NODE`、`PUBLIC_HOST`、`DSH_PUBLIC_URL`、`DSH_INTERNAL_PORT`、`DSH_PROXY_BIND`、`DSH_PROXY_PORT`、`DSH_PROXY_MODE`、`DSH_PROXY_BASIC_AUTH`、`DSH_RUNTIME_DIR`、`DSH_WEB_READY_TIMEOUT_SECONDS`。

## 安全说明

任务看板闸门接受非 loopback authority 的前提是「显式 Host 白名单 + 服务端注入 token」。代理是唯一持有 token 的一侧，因此代理必须自带认证：默认启用 HTTP Basic 认证，否则 `/api/task-board/*` 会变成局域网内无需凭据即可调用的 agent 控制面。若要关闭，设置 `DSH_PROXY_BASIC_AUTH=off`（不推荐，除非端口本身已有其他保护）。Basic 凭据在明文 HTTP 上传输，内网使用可接受；暴露到公网前应加 TLS 终止。

当前 `8211` 入口为明文 HTTP，适合内网或受信网络使用。若需要暴露到公网，应在代理前增加 TLS 终止，并限制 `8211` 和 `9910` 的网络访问范围。
