#!/bin/sh
# 从本机 ego-browser 的登录态里取出 uaa-token，拼成插件要的凭据。
#
#   ./tools/get-token.sh                 # 只打印 uaa-token
#   ./tools/get-token.sh sk-xxxxxxxx     # 打印 sk-xxxxxxxx|eyJ...
#
# 前提：ego-browser 里已经登录过 https://discovery.intern-ai.org.cn
# 没有 ego-browser 的话，按 README「怎么拿 uaa-token」手动从 DevTools 复制。

set -e

KEY="$1"

if ! command -v ego-browser >/dev/null 2>&1; then
  echo "没找到 ego-browser。手动取法见 README「怎么拿 uaa-token」。" >&2
  exit 1
fi

# ego-browser 把 console.log 写到 stderr，所以这里收 stderr、丢 stdout。
TOKEN=$(ego-browser nodejs <<'EOF' 2>&1 >/dev/null | grep -E '^eyJ[A-Za-z0-9_.-]+$' | tail -1
const task = await taskSpace("intern token");
const page = task.page("p1");
await page.goto("https://discovery.intern-ai.org.cn/token-plan/home?tabIndex=0&lang=zh-CN");
await page.waitForTimeout(3000);
const cookies = await page.cdp("Network.getAllCookies", {});
const tok = (cookies.cookies || []).find((c) => c.name === "uaa-token")?.value;
if (!tok) {
  console.error("NO_TOKEN");
  process.exit(1);
}
console.log(tok);
EOF
)

if [ -z "$TOKEN" ]; then
  echo "没取到 uaa-token。先在 ego-browser 里登录 https://discovery.intern-ai.org.cn" >&2
  exit 1
fi

if [ -n "$KEY" ]; then
  printf '%s|%s\n' "$KEY" "$TOKEN"
else
  printf '%s\n' "$TOKEN"
fi
