# dsh-llm-qoder

把 **Qoder CN / Qoder 国际版** 接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 LLM provider 插件。

直连官方推理接口：**没有 SDK、没有 CLI 子进程、没有本地代理服务**。签名、设备指纹、编码、SSE 解包全在 Harness 进程内完成。

```
DSH ──ctx.llm──> dsh-llm-qoder ──COSY 签名──> gateway.qoder.com.cn   (CN)
                                             api1.qoder.sh           (INTL)
```

---

## 特性

| 能力 | 状态 |
|---|---|
| 原生工具调用（含多轮结果回传） | ✅ |
| 原生思考过程（`reasoning_content`） | ✅ |
| 推理强度（`parameters.reasoning_effort`） | ✅ 真实参数，实测 thinking 长度线性增长 |
| 图片输入 | ⏳ 未接（`inputModalities` 只声明 text） |
| 双区（国内 / 国际） | ✅ 每账号独立 `realm` |
| 多账号池 + 轮询 + 失败换号 | ✅ |
| OAuth token 自动续期 | ✅ |
| 外部依赖 | **0**（只用 Node 内置模块 + Harness 提供的 schemastery） |

## 原理

Qoder 的推理接口不是 OpenAI 兼容的 REST，而是一套带签名的 SSE：

```
messages ──> baseprompt 骨架 ──> qoder_encode ──> COSY 头 ──> POST
                                                              /algo/api/v2/service/pro/sse/agent_chat_generation
                                                              └─> SSE 信封 {"headers","body","statusCodeValue"}
                                                                    └─> 内层 OpenAI chunk
```

签名（`lib/qoder-sign.mjs`）：

```
temp_key = uuid4().hex[:16]                     16 ASCII → AES-128 key/iv
cosy_key = base64(RSA_PKCS1v15(temp_key))       用官方客户端内置公钥包裹
info     = base64(AES_CBC(sorted_json(identity), temp_key, temp_key))
raw      = payload_b64 \n cosy_key \n date \n body \n path
bearer   = "Bearer COSY." + payload_b64 + "." + md5(raw)
```

自定义 Base64（三段轮转 + 字母表映射，`=` → `$`）与设备指纹派生见同文件。

## 安装

插件是 Harness 的 bundle，需要三步：

```powershell
# 1. 放进 profile 的 node_modules
git clone <this-repo> "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-llm-qoder"

# 2. 登记到 profile 的 bundles
#    $DSH_HOME/profiles/desktop/package.json
#    "dependencies": { "dsh-llm-qoder": "file:..." }
#    "dsh": { "profile": { "bundles": [ ..., "dsh-llm-qoder" ] } }

# 3. 重启 Harness
```

插件的 `cordis.patch.yml` 会自己把 provider 插进去，不需要改 profile 的 patch。

## 账号

### 从桌面客户端导入（最省事）

```powershell
node lib\cli.mjs import-desktop            # 扫 CN + INTL
node lib\cli.mjs import-desktop --realm intl
```

它自己走完整的解密链：`Local State → DPAPI → AES-256-GCM → auth.v1.dat`，
OAuth 的 `dt-` 和 `drt-` 会一起带过来。

### 手动加

```powershell
node lib\cli.mjs add pt-xxxxx 主号                    # PAT（换 jobToken）
node lib\cli.mjs add dt-xxxxx 国际版 --realm intl --refresh drt-xxxxx   # OAuth
echo pt-xxxxx | node lib\cli.mjs add --stdin          # 不进 shell 历史
```

### 管理

```powershell
node lib\cli.mjs list
node lib\cli.mjs test                 # 逐个验证，顺手触发续期
node lib\cli.mjs prefer intl          # 区域优先（intl / cn / none）
node lib\cli.mjs remove <id|昵称>
```

账号存在 `~/.dsh/qoder-accounts.json`；池为空时回落读 `~/.dsh/qoder.token` 单账号。

## 两种凭证

| 前缀 | 类型 | 续期 | 适用 |
|---|---|---|---|
| `pt-` | Personal Access Token | `jobToken/exchange`，24h | 自动化 |
| `dt-` | OAuth access token | `deviceToken/refresh`，30d | 桌面客户端登录（国际版走这条） |

续期在凭证剩余有效期不足 5 分钟时自动发生。**每次 OAuth 刷新都会换发新的 `refresh_token`，旧的立刻作废**，插件会把新凭证回写账号池。

## 已知限制

- **图片未接**：`inputModalities` 只声明 `text`，选这个模型时 Harness 不会把图片交给它。接它需要 `attachments` 服务名确认后用 `imageHostPath()` 读字节。
- **模型名大小写敏感**：上游认 `DeepSeek-Flash`，不认 `deepseek-flash`。
- **内容策略由模型决定**：某些题材会被模型自身对齐拒绝，这是模型权重层面的事，客户端参数改不了。
- **协议是私有的**：上游改版时 `lib/qoder-client.mjs` 和 `lib/baseprompt.json` 需要跟着更新。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/index.js` | Harness 适配器：模型目录、chunk 映射、工具往返、账号轮询 |
| `lib/qoder-client.mjs` | PAT/OAuth 身份解析、续期、请求体构造、SSE 解包 |
| `lib/qoder-sign.mjs` | COSY 签名、设备指纹、自定义 Base64 |
| `lib/accounts.mjs` | 账号池读写、区域偏好、凭证回写 |
| `lib/desktop-auth.mjs` | 从桌面客户端读登录态（DPAPI + AES-GCM） |
| `lib/cli.mjs` | 账号管理 CLI |
| `lib/baseprompt.json` | 官方请求骨架 |

## License

MIT
