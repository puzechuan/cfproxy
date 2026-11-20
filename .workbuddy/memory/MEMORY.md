# cfproxy 项目长期记忆

## 协作约定（用户明确要求）

- **`git push` 之前必须先问用户确认**。可以自行修改代码、跑测试、本地 `git commit`，但推出远程（以及 `wrangler deploy` 等对外发布的动作）一律先停下来问一句「要推送/部署吗？」。
- 拉取/推送网络注意：环境里的 `https_proxy=127.0.0.1:6705` 常失效，需要 `git -c http.proxy= -c https.proxy= ...`；推送再加 `-c http.curloptResolve=github.com:443:140.82.114.3`。
