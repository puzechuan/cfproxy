# cfproxy 项目长期记忆

## 协作约定（用户明确要求）

- **`git push` 之前必须先问用户确认**。可以自行修改代码、跑测试、本地 `git commit`，但推出远程一律先停下来问一句「要推送吗？」。
- **推送即部署，不需要再手动 `wrangler deploy`**：仓库已接 Cloudflare 自动构建，`main` 有新提交就自动上线（2026-11-21 用户明确说明）。所以推送前那句确认，同时也是「要不要发布到线上」的确认；除非用户单独要求，不要主动跑 `wrangler deploy`。

## 本机推送通道

- **代理**：`http://127.0.0.1:12334`（2026-11-21 验证可用，curl 走它访问 github.com 返回 200）。
  ```
  git -c http.proxy=http://127.0.0.1:12334 -c https.proxy=http://127.0.0.1:12334 push origin main
  ```
- 直连 `github.com:443` 仍会被 reset（`Recv failure: Connection was reset`），**直接用代理，不必先浪费一轮直连**；环境变量 `https_proxy` 常失效，用 `-c` 显式覆盖。
- 代理端口会变（历史：6705 / 4560 / 2809 / 12334）。失效时问用户当前端口，**不要自己猜端口或扫端口**。
- 核对远程是否同步：`git -c http.proxy=... ls-remote origin refs/heads/main`；push 返回 `Everything up-to-date` 说明远程已是最新。

## 备选通道（基本用不上）

- 用本项目 Worker 当 Git 传输层（转发 `authorization`、丢弃 `cookie`、透传 POST body）：需要本机有效的 `~/.cfproxy.cookie`，但 2026-11-21 已确认该文件不存在，此路不通。
- SSH 端口（github.com:22、ssh.github.com:443）可达，但本机 `~/.ssh` 无密钥。
- 不要再试镜像 IP、GitHub API 搬提交这类绕行方案（2026-11-20 试遍全失败）。
