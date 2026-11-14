// 书生·端砚 Intern InkStone (TokenPlan) as a magpie / OpenCode provider plugin.
//
// Inference goes to the official OpenAI / Anthropic compatible endpoints with a
// TokenPlan API key. Quota comes from the web session endpoints, which want the
// `uaa-token` cookie value instead — a different credential, so one sign-in is
// `<api key>|<uaa-token>`. An API key alone still works for inference; it just
// has no quota to show.
//
// Several accounts: `magpie plugin login intern` again. magpie stores the first
// as `intern` and each later one as `intern#xxxxxx`, and calls auth.usage once
// per account, so every account gets its own card and its own numbers.

const ID = "intern"
const API_V1 = "https://discovery-api.intern-ai.org.cn/v1"
const WEB = "https://discovery.intern-ai.org.cn"

// Prices are 墨点 per million tokens, from /api/tokenplan/v1/public/models and
// the platform's "模型列表与计费" page, checked 2026-11-14. The platform does not
// publish a max-output figure, so `limit.output` is the context length.
// `intern-decision-4b` is left out: it only answers on the SystemOne endpoint,
// which is not a chat protocol.
const MODELS = [
  {
    id: "deepseek-v4.1-flash-1017",
    name: "DeepSeek-V4.1-Flash-1017",
    ctx: 1048576,
    inCached: 20,
    inUncached: 1000,
    outPrice: 4000,
    reasoning: true,
    tool: true,
    image: true,
    protocols: ["openai_chat", "anthropic_messages", "openai_responses"],
  },
  {
    id: "glm-5.3",
    name: "GLM-5.3",
    ctx: 1048576,
    inCached: 2000,
    inUncached: 8000,
    outPrice: 28000,
    reasoning: true,
    tool: true,
    image: false,
    protocols: ["openai_chat", "anthropic_messages", "openai_responses"],
  },
  {
    id: "kimi-k3.1-pro",
    name: "Kimi-K3.1-Pro",
    ctx: 1048576,
    inCached: null,
    inUncached: 13000,
    outPrice: 68000,
    reasoning: true,
    tool: true,
    image: true,
    protocols: ["openai_chat", "anthropic_messages", "openai_responses"],
  },
  {
    id: "qwen3.8-27b",
    name: "Qwen3.8-27B",
    ctx: 262144,
    inCached: 100,
    inUncached: 800,
    outPrice: 2700,
    reasoning: true,
    tool: true,
    image: true,
    protocols: ["openai_chat", "anthropic_messages"],
  },
  {
    id: "intern-s2",
    name: "书生-S2",
    ctx: 262144,
    inCached: 6,
    inUncached: 30,
    outPrice: 180,
    reasoning: false,
    tool: true,
    image: true,
    protocols: ["openai_chat", "anthropic_messages"],
  },
  {
    id: "Agents-A1",
    name: "Agents-A1",
    ctx: 262144,
    inCached: 3.2,
    inUncached: 16,
    outPrice: 64,
    reasoning: false,
    tool: true,
    image: true,
    protocols: ["openai_chat", "anthropic_messages", "openai_responses"],
  },
  {
    id: "Sage-A1.5",
    name: "Sage-A1.5",
    ctx: 524288,
    inCached: 3.2,
    inUncached: 16,
    outPrice: 64,
    reasoning: false,
    tool: true,
    image: true,
    protocols: ["openai_chat", "anthropic_messages", "openai_responses"],
  },
  {
    id: "Sage-A1.5-Taiyi",
    name: "Sage-A1.5-Taiyi",
    ctx: 524288,
    inCached: 6.4,
    inUncached: 32,
    outPrice: 128,
    reasoning: false,
    tool: true,
    image: false,
    protocols: ["openai_chat", "anthropic_messages", "openai_responses"],
  },
  {
    id: "Atria-Dawn",
    name: "Atria-Dawn",
    ctx: 524288,
    inCached: 20,
    inUncached: 80,
    outPrice: 280,
    reasoning: false,
    tool: false,
    image: false,
    protocols: ["openai_chat", "anthropic_messages", "openai_responses"],
  },
]

const byId = new Map(MODELS.map((m) => [m.id, m]))

// ---- credentials -------------------------------------------------------------

// parseCred reads one sign-in. Accepted shapes:
//   sk-...                      an API key alone (inference only)
//   sk-...|eyJ...               API key and uaa-token, in either order
//   {"key":"sk-...","uaa":"..."} the same, as JSON
function parseCred(raw) {
  const s = String(raw ?? "").trim()
  if (!s) return { key: "", uaa: "" }
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s)
      return {
        key: String(j.key ?? j.apiKey ?? j.api_key ?? "").trim(),
        uaa: String(j.uaa ?? j.uaaToken ?? j.uaa_token ?? j.token ?? "").trim(),
      }
    } catch {
      // fall through to the delimited form
    }
  }
  const parts = s
    .split(/[|\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
  const key = parts.find((p) => p.startsWith("sk-")) ?? parts[0] ?? ""
  const uaa = parts.find((p) => p !== key) ?? ""
  return { key, uaa }
}

// ---- web session reads -------------------------------------------------------

// webGet asks the TokenPlan web API as the signed-in person. The uaa-token goes
// in the Authorization header: the cookie alone is not enough (a bare cookie
// answers 401 "参数错误，请求未认证").
async function webGet(path, uaa) {
  const res = await globalThis.fetch(WEB + path, {
    headers: { Authorization: `Bearer ${uaa}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  })
  const text = await res.text()
  let j = null
  try {
    j = JSON.parse(text)
  } catch {
    j = null
  }
  // Two shapes say "this session is gone": the tokenplan envelope's A0211, and
  // the older -10002 the gateway answers when no session was read at all.
  if (res.status === 401 || j?.msgCode === "A0211" || j?.code === -10002) {
    const e = new Error("uaa-token was turned away")
    e.expired = true
    throw e
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  if (j && j.code !== 0) throw new Error(j.msg || `code ${j.code}`)
  return j?.data ?? j
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function fmt(n) {
  return n.toLocaleString("en-US", { maximumFractionDigits: 3 })
}

// isoOf turns the platform's "2026-11-14 11:03:59" (Beijing time, no zone) into
// an ISO instant, so magpie can show when a window comes back.
function isoOf(s) {
  const m = String(s ?? "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/)
  if (!m) return undefined
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`
}

// ---- responses ---------------------------------------------------------------

// errorResponse is an OpenAI-style error body. `X-Magpie-Sign-In: expired` is
// the marker magpie watches for: it marks the account and can fail the request
// over to another provider instead of surfacing an opaque fetch failure.
function errorResponse(status, message, signIn) {
  const headers = { "content-type": "application/json" }
  if (signIn) headers["X-Magpie-Sign-In"] = signIn
  return new Response(
    JSON.stringify({
      error: { message, type: status === 429 ? "rate_limit_error" : "api_error", code: null },
    }),
    { status, headers },
  )
}

// ---- models ------------------------------------------------------------------

function modelOf(m) {
  return {
    id: m.id,
    name: m.name,
    // 墨点 has no USD rate, so cost stays 0 and the quota lives in auth.usage.
    // `free: false` keeps magpie from treating a priced model as free.
    free: false,
    rate: 0,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: { context: m.ctx, output: m.ctx },
    reasoning: m.reasoning,
    tool_call: m.tool,
    status: "active",
    headers: {},
    options: {},
    release_date: "",
    variants: {},
    capabilities: {
      temperature: true,
      reasoning: m.reasoning,
      attachment: m.image,
      toolcall: m.tool,
      input: { text: true, image: m.image, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false },
      interleaved: false,
    },
  }
}

function protocolOf(options) {
  return options?.api === "anthropic" ? "anthropic_messages" : "openai_chat"
}

function staticModels(options) {
  const want = protocolOf(options)
  return Object.fromEntries(
    MODELS.filter((m) => m.protocols.includes(want)).map((m) => [m.id, modelOf(m)]),
  )
}

// listed asks the API key which models it may call. The reply shape is not
// documented; the three shapes below cover what an OpenAI-compatible endpoint
// normally answers, and anything else falls back to the static list.
async function listed(key) {
  const res = await globalThis.fetch(`${API_V1}/models`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`/v1/models answered HTTP ${res.status}`)
  const j = await res.json()
  const rows = Array.isArray(j) ? j : (j?.data ?? j?.models ?? [])
  return rows
    .map((r) => (typeof r === "string" ? r : r?.id))
    .filter((id) => typeof id === "string" && byId.has(id))
}

// ---- plugin ------------------------------------------------------------------

export const InternTokenPlanPlugin = async ({ client } = {}, options) => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[ID] ??= {}
    const p = cfg.provider[ID]
    p.name ??= "Intern TokenPlan"
    p.npm = protocolOf(options) === "anthropic_messages" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible"
    p.api = API_V1
    p.models = { ...staticModels(options), ...(p.models ?? {}) }
  },

  provider: {
    id: ID,
    async models(provider, { auth } = {}) {
      const { key } = parseCred(auth?.key)
      if (!key) return provider.models
      try {
        const ids = await listed(key)
        if (!ids.length) return provider.models
        return Object.fromEntries(ids.map((id) => [id, modelOf(byId.get(id))]))
      } catch {
        // a key that cannot list still answers chats; keep the static list
        return provider.models
      }
    },
  },

  auth: {
    provider: ID,
    methods: [
      {
        // One sign-in carries both credentials, because they are two different
        // things: the API key pays for inference, the uaa-token reads the quota.
        type: "api",
        label: "TokenPlan 凭据：API Key，或 API Key|uaa-token",
        placeholder: "sk-...|eyJ0eXBlIjoiSldU...",
      },
    ],

    async usage(getAuth) {
      const auth = await getAuth()
      const { uaa } = parseCred(auth?.key)
      if (!uaa) {
        return {
          error:
            "这条凭据只有 API Key，没有额度令牌（uaa-token），所以读不到额度。重新登录时用 `sk-...|eyJ...` 的格式。",
          windows: [],
        }
      }

      try {
        const [who, bal, pkgs] = await Promise.all([
          webGet("/api/tokenplan/v1/users/validate", uaa),
          webGet("/api/tokenplan/v1/credits/balance", uaa),
          webGet("/api/tokenplan/v1/credits/packages?page=1&page_size=20", uaa).catch(() => null),
        ])

        const windows = []
        const w = bal?.usage_windows ?? {}
        for (const [k, label] of [
          ["5h", "5 小时窗口"],
          ["7d", "7 天窗口"],
        ]) {
          const x = w[k]
          if (!x?.enabled) continue
          const limit = num(x.limit_credits)
          const used = num(x.used_credits)
          windows.push({
            name: label,
            used: limit > 0 ? (used / limit) * 100 : 0,
            remaining: limit > 0 ? ((limit - used) / limit) * 100 : 100,
            display: `${fmt(used)} / ${fmt(limit)} 墨点`,
            resetsAt: isoOf(x.next_recover_at),
            unit: "墨点",
          })
        }

        // The monthly free package is the real allowance; the 5h/7d windows are
        // rate caps on top of it.
        const list = pkgs?.packages ?? []
        const pkg = list.find((p) => p.status === "available") ?? list[0]
        let plan = "TokenPlan"
        if (pkg) {
          const total = num(pkg.total_credits)
          const rem = num(pkg.remaining_credits)
          windows.push({
            name: "月度免费包",
            used: total > 0 ? ((total - rem) / total) * 100 : 0,
            remaining: total > 0 ? (rem / total) * 100 : 100,
            display: `${fmt(rem)} / ${fmt(total)} 墨点`,
            resetsAt: isoOf(pkg.current_cycle?.end_at),
            unit: "墨点",
          })
          plan = `${pkg.pkg_id ?? "TokenPlan"} · ${fmt(total)} 墨点/月`
        }

        return {
          plan,
          user: who?.wechatName || who?.phone || who?.ssoUid || "intern",
          windows,
          signIn: "renewed",
        }
      } catch (e) {
        if (e?.expired) {
          return {
            error: "额度令牌（uaa-token）已过期，重新登录一次即可。",
            signIn: "expired",
            windows: [],
          }
        }
        return { error: `读取额度失败：${e?.message ?? e}`, windows: [] }
      }
    },

    async loader(getAuth) {
      const auth = await getAuth()
      const { key } = parseCred(auth?.key)
      if (!key) return {}

      return {
        baseURL: API_V1,
        apiKey: key,
        async fetch(input, init) {
          const req = input instanceof Request ? input : null
          const url = req ? req.url : String(input)
          const headers = new Headers(init?.headers ?? req?.headers ?? {})
          // The SDK sets the right header for its protocol; this only fills a gap.
          if (!headers.has("authorization") && !headers.has("x-api-key")) {
            headers.set("authorization", `Bearer ${key}`)
          }
          const res = await globalThis.fetch(url, {
            method: init?.method ?? req?.method,
            headers,
            body: init?.body ?? (req ? await req.clone().arrayBuffer() : undefined),
            signal: init?.signal ?? req?.signal,
          })
          if (res.status === 401) {
            return errorResponse(
              401,
              "TokenPlan 的 API Key 被拒绝（invalid_api_key）。检查 Key 是否完整，或重新登录。",
              "expired",
            )
          }
          return res
        },
      }
    },
  },
})

export const _internal = { parseCred, isoOf, num, fmt, modelOf, staticModels, listed, MODELS, byId, ID, API_V1, WEB }
export default InternTokenPlanPlugin
