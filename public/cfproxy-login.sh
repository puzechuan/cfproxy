#!/usr/bin/env bash
#
# cfproxy 登录脚本（无浏览器环境用）
#
# 服务器 / CI / 容器里没有图形界面，打不开登录页。这个脚本直接调 /api/login
# 换取会话 Cookie，写成 Netscape 格式的 cookie 文件，之后 curl / wget / aria2c
# 都能直接复用；git 用 http.extraHeader 带上同一个 Cookie。
#
# 会话有效期 7 天（服务端 SESSION_TTL），过期重跑一次即可。
#
# 用法：
#   ./cfproxy-login.sh                             # 交互输入用户名和密码
#   CF_USER=me CF_PASS='***' ./cfproxy-login.sh -q  # 定时任务 / CI（-q 只输出错误）
#   ./cfproxy-login.sh -u me -b https://你的域名 -f /root/.cfproxy.cookie
#   ./cfproxy-login.sh -t                          # 只打印当前 Cookie 里的 token
#
# 参数：
#   -u 用户名    默认 $CF_USER，缺省则交互询问
#   -p 密码      默认 $CF_PASS，缺省则静默提示（写在命令行会进 shell history，不推荐）
#   -b 站点地址  默认 $CF_BASE，缺省 https://cfproxy.koomer.site
#   -f cookie文件 默认 $CF_COOKIE，缺省 ~/.cfproxy.cookie
#   -t 只打印 token（用于拼 git 的 extraHeader）
#   -q 安静模式   成功时不输出任何内容
#   -h 帮助
#
# 退出码：0 成功；1 网络或服务端错误；2 参数错误。

set -u

BASE="${CF_BASE:-https://cfproxy.koomer.site}"
COOKIE_FILE="${CF_COOKIE:-$HOME/.cfproxy.cookie}"
USER_NAME="${CF_USER:-}"
PASSWORD="${CF_PASS:-}"
QUIET=0
PRINT_TOKEN=0

usage() {
	cat <<'EOF'
cfproxy 登录脚本

  ./cfproxy-login.sh [-u 用户名] [-p 密码] [-b 站点] [-f cookie文件] [-t] [-q]

  -u 用户名     也可用环境变量 CF_USER
  -p 密码       也可用环境变量 CF_PASS；不传则静默提示输入
  -b 站点地址   默认 https://cfproxy.koomer.site
  -f cookie文件 默认 ~/.cfproxy.cookie（权限会被设成 600）
  -t 只打印当前文件里的会话 token，不发起登录
  -q 安静模式   成功时不输出（只报错），适合 cron
  -h 显示本帮助

登录成功后可直接使用：
  curl -b ~/.cfproxy.cookie -fLO 'https://<站点>/https://github.com/u/r/releases/download/v1/x.zip'
  wget --load-cookies ~/.cfproxy.cookie -c 'https://<站点>/https://github.com/...'
  aria2c --load-cookies ~/.cfproxy.cookie -x16 -s16 'https://<站点>/https://github.com/...'
  git -c http.extraHeader="Cookie: cfproxy_session=$(./cfproxy-login.sh -t)" clone 'https://<站点>/https://github.com/u/r.git'
EOF
}

while getopts "u:p:b:f:tqh" opt; do
	case "$opt" in
		u) USER_NAME="$OPTARG" ;;
		p) PASSWORD="$OPTARG" ;;
		b) BASE="$OPTARG" ;;
		f) COOKIE_FILE="$OPTARG" ;;
		t) PRINT_TOKEN=1 ;;
		q) QUIET=1 ;;
		h) usage; exit 0 ;;
		*) usage; exit 2 ;;
	esac
done

BASE="${BASE%/}"

# 取 Cookie 文件里的 token（curl 写的是 Netscape 格式，HttpOnly 行有 #HttpOnly_ 前缀）
read_token() {
	[ -f "$COOKIE_FILE" ] || return 1
	awk '/cfproxy_session/{print $NF}' "$COOKIE_FILE" | tail -n 1
}

if [ "$PRINT_TOKEN" -eq 1 ]; then
	token="$(read_token)" || {
		echo "找不到 cookie 文件：$COOKIE_FILE" >&2
		exit 1
	}
	[ -n "$token" ] || {
		echo "cookie 文件里没有 cfproxy_session：$COOKIE_FILE" >&2
		exit 1
	}
	printf '%s\n' "$token"
	exit 0
fi

command -v curl >/dev/null 2>&1 || {
	echo "缺少 curl，请先安装" >&2
	exit 1
}

if [ -z "$USER_NAME" ]; then
	printf '用户名: ' >&2
	IFS= read -r USER_NAME || true
fi

if [ -z "$PASSWORD" ]; then
	printf '密码（输入不回显）: ' >&2
	IFS= read -rs PASSWORD || true
	printf '\n' >&2
fi

if [ -z "$USER_NAME" ] || [ -z "$PASSWORD" ]; then
	echo "用户名和密码都不能为空" >&2
	exit 2
fi

# JSON 里只需要转义反斜杠和双引号
json_escape() {
	printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t cfproxy)" || {
	echo "无法创建临时目录" >&2
	exit 1
}
trap 'rm -rf "$TMP_DIR"' EXIT

HTTP_CODE="$(
	curl -sS --max-time 30 -o "$TMP_DIR/body" -w '%{http_code}' \
		-c "$TMP_DIR/cookie" \
		-X POST "$BASE/api/login" \
		-H 'content-type: application/json' \
		--data "{\"username\":\"$(json_escape "$USER_NAME")\",\"password\":\"$(json_escape "$PASSWORD")\"}"
)" || {
	echo "无法连接 $BASE（检查网络、域名或代理设置）" >&2
	exit 1
}

if [ "$HTTP_CODE" != "200" ]; then
	# 服务端的错误文案在 {"ok":false,"error":"..."} 里，取出来给人看
	ERR="$(sed -n 's/.*"error"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP_DIR/body" | head -n 1)"
	[ -n "$ERR" ] || ERR="HTTP $HTTP_CODE"
	echo "登录失败：$ERR" >&2
	exit 1
fi

grep -q 'cfproxy_session' "$TMP_DIR/cookie" 2>/dev/null || {
	echo "登录返回 200，但响应里没有会话 Cookie，站点地址对吗？" >&2
	exit 1
}

# 落到目标位置：先建目录，再用 600 权限写入（密码在这份 Cookie 的有效期内等价于凭据）
mkdir -p "$(dirname "$COOKIE_FILE")" 2>/dev/null || true
umask 077
cp "$TMP_DIR/cookie" "$COOKIE_FILE" || {
	echo "无法写入 $COOKIE_FILE" >&2
	exit 1
}
chmod 600 "$COOKIE_FILE" 2>/dev/null || true
# Windows 的 Git Bash / MSYS 上 chmod 基本不生效，属正常，不告警
case "$(uname -s 2>/dev/null)" in
	MINGW* | MSYS* | CYGWIN*) ;;
	*)
		if [ -n "$(find "$COOKIE_FILE" -perm -o+r 2>/dev/null)" ]; then
			echo "警告：无法把 $COOKIE_FILE 的权限限制为 600，请手动检查" >&2
		fi
		;;
esac

[ "$QUIET" -eq 1 ] && exit 0

# 过期时间按服务端的 7 天算，GNU date 与 BSD date 都试一下
EXP=""
if date -d '+7 days' '+%Y-%m-%d %H:%M' >/dev/null 2>&1; then
	EXP="$(date -d '+7 days' '+%Y-%m-%d %H:%M')"
elif date -v+7d '+%Y-%m-%d %H:%M' >/dev/null 2>&1; then
	EXP="$(date -v+7d '+%Y-%m-%d %H:%M')"
fi

echo "✓ 登录成功：$USER_NAME"
echo "  Cookie：$COOKIE_FILE（权限 600${EXP:+，约 $EXP 过期}）"
echo
echo "  接下来的用法："
echo "    curl -b $COOKIE_FILE -fLO '$BASE/https://github.com/u/r/releases/download/v1/x.zip'"
echo "    wget --load-cookies $COOKIE_FILE -c '$BASE/https://github.com/...'"
echo "    aria2c --load-cookies $COOKIE_FILE -x16 -s16 '$BASE/https://github.com/...'"
echo "    git -c http.extraHeader=\"Cookie: cfproxy_session=\$($0 -t)\" clone '$BASE/https://github.com/u/r.git'"
