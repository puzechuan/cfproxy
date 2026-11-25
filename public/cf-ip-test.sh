#!/usr/bin/env bash
#
# cfproxy 边缘 IP 测速脚本（macOS / Linux）
#
# 从页面上点「下载测速脚本（.sh）」取得，或者直接：
#   curl -fsSLO https://你的域名/cf-ip-test.sh && bash cf-ip-test.sh 你的域名
#
# 每次运行先从 cloudflare.com/ips-v4 取官方 IPv4 段并均匀取样；
# 取不到就用上次成功缓存的段，再取不到才用内置历史段。
# 对每个候选 IP 测一次 TCP 握手（443），按时延排序，输出最快的 5 个。
# 注意：这只测「你的设备 ↔ Cloudflare 边缘」，不代表实际下载速度。
#
# 用法：
#   bash cf-ip-test.sh 你的域名            # 命令行给域名
#   CF_BASE=你的域名 bash cf-ip-test.sh    # 也可以用环境变量
#   ./cf-ip-test.sh                        # 都不给就交互询问
#   CF_IP_CACHE=/path/to/cache bash ...    # 自定义段列表缓存位置
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

CIDR_URL='https://cloudflare.com/ips-v4'
HISTORY_FILE="${CF_IP_CACHE:-$HOME/.cfproxy-ips-v4}"
VALID_CIDR='^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$'

# 内置历史段：只有联网取不到且本地也没有缓存时才用
HISTORY_RANGES='173.245.48.0/20
103.21.244.0/22
103.22.200.0/22
103.31.4.0/22
141.101.64.0/18
108.162.192.0/18
190.93.240.0/20
188.114.96.0/20
197.234.240.0/22
198.41.128.0/17
162.158.0.0/15
104.16.0.0/13
104.24.0.0/14
172.64.0.0/13
131.0.72.0/22'

# 1) 每次都先实时取官方段；成功后留一份到本地作为历史记录
RANGES=$(curl -fsSL --max-time 8 "$CIDR_URL" 2>/dev/null | grep -E "$VALID_CIDR" | head -60) || RANGES=''
if [ -n "$RANGES" ]; then
  SOURCE='cloudflare.com/ips-v4（实时获取）'
  printf '%s\n' "$RANGES" > "$HISTORY_FILE" 2>/dev/null || true
else
  # 2) 取不到就读历史记录（上次成功获取时缓存下来的段）
  if [ -s "$HISTORY_FILE" ]; then
    RANGES=$(grep -E "$VALID_CIDR" "$HISTORY_FILE" | head -60) || RANGES=''
  fi
  if [ -n "$RANGES" ]; then
    SOURCE='历史记录（上次成功获取）'
  else
    # 3) 连历史记录也没有，才用脚本内置的段
    RANGES="$HISTORY_RANGES"
    SOURCE='内置历史记录'
  fi
fi

# 每个段均匀取最多 3 个代表地址，尽量落在整 /16（不足时退到整 /24）的 .1 上
IPS=$(printf '%s\n' "$RANGES" | awk '
  function ip2int(ip, p) { split(ip, p, "."); return p[1]*16777216 + p[2]*65536 + p[3]*256 + p[4] }
  function int2ip(n) {
    return int(n/16777216)%256 "." int(n/65536)%256 "." int(n/256)%256 "." n%256
  }
  /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\/[0-9]+$/ {
    split($0, c, "/")
    base = ip2int(c[1]); size = 2^(32 - c[2])
    units = int(size / 65536)
    take = (units >= 1 && units < 3) ? units : 3
    if (units >= 1) {
      step = int(units / take); if (step < 1) step = 1
      step *= 65536
    } else {
      b24 = int(size / 256); if (b24 < 1) b24 = 1
      step = int(b24 / take); if (step < 1) step = 1
      step *= 256
    }
    for (k = 0; k < take; k++) {
      off = k * step
      if (off + 256 > size) break
      print int2ip(base + off + 1)
    }
  }
')
if [ -z "$IPS" ]; then
  SOURCE='内置历史记录（采样兜底）'
  IPS='173.245.48.1 173.245.53.1 173.245.58.1 103.21.244.1 103.21.245.1 103.21.246.1 103.22.200.1 103.22.201.1 103.22.202.1 103.31.4.1 103.31.5.1 103.31.6.1 141.101.64.1 141.101.85.1 141.101.106.1 108.162.192.1 108.162.213.1 108.162.234.1 190.93.240.1 190.93.245.1 190.93.250.1 188.114.96.1 188.114.101.1 188.114.106.1 197.234.240.1 197.234.241.1 197.234.242.1 198.41.128.1 198.41.170.1 198.41.212.1 162.158.0.1 162.159.0.1 104.16.0.1 104.18.0.1 104.20.0.1 104.24.0.1 104.25.0.1 104.26.0.1 172.64.0.1 172.66.0.1 172.68.0.1 131.0.72.1 131.0.73.1 131.0.74.1'
fi

COUNT=$(printf '%s\n' $IPS | wc -l | tr -d ' ')
printf '\n目标: %s\nIP 来源: %s\n候选 IP: %s 个\n' "$HOST" "$SOURCE" "$COUNT"
printf '正在测量 443 端口握手时延，约需 1-2 分钟，请稍候...\n\n'

for ip in $IPS; do
  r=$(curl -s -o /dev/null --noproxy '*' --max-time 3 \
        -w '%{http_code} %{time_connect}' \
        --resolve "$HOST:443:$ip" "https://$HOST/health" 2>/dev/null) || continue
  printf '%s %s\n' "$r" "$ip"
done | awk '$1 == 200 { printf "%4.0f ms  %s\n", $2 * 1000, $3 }' | sort -n | head -5

echo ''
echo '时延最小的排在前面。挑一个填到页面「写入 hosts」的输入框里生成 hosts 行。'
