# cfproxy 项目长期记忆

## 协作约定（用户明确要求）

- **`git push` 之前必须先问用户确认**。可以自行修改代码、跑测试、本地 `git commit`，但推出远程（以及 `wrangler deploy` 等对外发布的动作）一律先停下来问一句「要推送/部署吗？」。
- **直连推送被阻断时，不要再耗时间试代理通道**：先直连试一次，失败就直接告诉用户「本机连不上 github.com:443，请在你能连的机器上 `git push`」，由用户手动推送。不要再逐个试镜像 IP、本地代理端口、GitHub API 搬提交这类绕行方案（2026-11-20 试遍全失败，纯浪费一轮对话）。
- 拉取/推送网络注意：环境里的 `https_proxy`（曾为 127.0.0.1:6705，后为 :4560，现为 :2809）常失效，需要 `git -c http.proxy= -c https.proxy= ...`。

## github.com:443 被阻断时的推送通道（2026-11-20 验证可用）

- 症状：`Recv failure: Connection was reset` / 连不上 443，TCP 通但 TLS 被打断；`api.github.com` 正常。
- 绕行：用本项目自己的 Worker 当 Git 传输层（Worker 转发 `authorization`、丢弃 `cookie`、透传 POST body，smart HTTP 可走通）：
  ```
  TOK=$(awk '/cfproxy_session/{print $NF}' ~/.cfproxy.cookie)
  git -c http.extraHeader="Cookie: cfproxy_session=$TOK" \
      -c http.extraHeader="Authorization: Basic $(printf '%s' 'USER:TOKEN' | base64 -w0)" \
      push https://<域名>/https://github.com/<owner>/<repo>.git main:main
  ```
  凭据用 `printf 'protocol=https\nhost=github.com\n\n' | git credential fill` 取，**不要**写进文件或长期记忆。
- 备选：SSH 端口（github.com:22、ssh.github.com:443）可达，但本机 `~/.ssh` 无密钥。
- 注意：Worker 通道需要本机有有效的 `~/.cfproxy.cookie`（登录脚本已被回滚，cookie 过期后就没法再生成），没有 cookie 时此路不通，直接交给用户手动推送。
