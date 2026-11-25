#!/usr/bin/env bash
#
# cfproxy 边缘 IP 测速脚本（macOS / Linux）
#
# 从页面上点「下载测速脚本（.sh）」取得，或者直接：
#   curl -fsSLO https://你的域名/cf-ip-test.sh && bash cf-ip-test.sh 你的域名
#
# 对每个候选 IP 做一次 TCP 握手（443），按时延排序，输出最快的 5 个。
# 注意：这只测「你的设备 ↔ Cloudflare 边缘」，不代表实际下载速度。
#
# 用法：
#   bash cf-ip-test.sh 你的域名            # 命令行给域名
#   CF_BASE=你的域名 bash cf-ip-test.sh    # 也可以用环境变量
#   ./cf-ip-test.sh                        # 都不给就交互询问
#

set -u

BASE="${CF_BASE:-${1:-}}"
if [ -z "$BASE" ]; then
  printf '站点地址（例如 你的域名）：'
  read -r BASE || exit 1
fi
HOST=$(printf '%s' "$BASE" | sed -E 's#^https?://##; s#/.*$##; s#:.*$##')
if [ -z "$HOST" ]; then
  echo '站点地址不能为空' >&2
  exit 2
fi

if ! command -v curl >/dev/null 2>&1; then
  echo '需要 curl，请先安装后再运行' >&2
  exit 1
fi

# Cloudflare 官方 IPv4 段（cloudflare.com/ips-v4）的均匀取样，与页面上的候选一致
IPS="
173.245.48.1 173.245.53.1 173.245.58.1 103.21.244.1 103.21.245.1 103.21.246.1
103.22.200.1 103.22.201.1 103.22.202.1 103.31.4.1 103.31.5.1 103.31.6.1
141.101.64.1 141.101.85.1 141.101.106.1 108.162.192.1 108.162.213.1 108.162.234.1
190.93.240.1 190.93.245.1 190.93.250.1 188.114.96.1 188.114.101.1 188.114.106.1
197.234.240.1 197.234.241.1 197.234.242.1 198.41.128.1 198.41.170.1 198.41.212.1
162.158.0.1 162.159.0.1 104.16.0.1 104.18.0.1 104.20.0.1 104.24.0.1
104.25.0.1 104.26.0.1 172.64.0.1 172.66.0.1 172.68.0.1 131.0.72.1
131.0.73.1 131.0.74.1
"

COUNT=$(printf '%s\n' $IPS | wc -l | tr -d ' ')
printf '\n目标: %s\n候选 IP: %s 个\n' "$HOST" "$COUNT"
printf '正在测量 443 端口握手时延，约需 1-2 分钟，请稍候...\n\n'

for ip in $IPS; do
  r=$(curl -s -o /dev/null --noproxy '*' --max-time 3 \
        -w '%{http_code} %{time_connect}' \
        --resolve "$HOST:443:$ip" "https://$HOST/health" 2>/dev/null) || continue
  printf '%s %s\n' "$r" "$ip"
done | awk '$1 == 200 { printf "%4.0f ms  %s\n", $2 * 1000, $3 }' | sort -n | head -5

echo ''
echo '时延最小的排在前面。挑一个填到页面的「最快的 IP」里生成 hosts 行。'
