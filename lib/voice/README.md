# voice/ —— 语音模块（收 + 发）

| 文件 | 职责 |
|---|---|
| `stt.mjs` | **收语音**：CQ record 段 → 音频字节（base64:// / http 下载 / 本地文件）→ Harness `speechToText` 服务转写 |
| `tts.mjs` | **发语音**：双引擎 —— `piper`（本地离线，spawn 可执行文件）／ `openai`（OpenAI 兼容 `POST /audio/speech`）；合成前按 150 字截断 |
| `index.mjs` | 装配：`hooks.stt` / `hooks.voice` / `/语音 <文本>` 命令，接进 chat 引擎 |

## 行为说明

- **收语音**：`voice.sttEnabled=true`（默认）时，收到的语音自动转写成文字进对话；转写失败/服务不可用 → 回「没听清」软文案。
- **发语音**：`voice.mode` 控制 —— `off` 不发 / `on` 每条回复都配音 / `smart` 短回复（≤80 字）才配音；
  TTS 引擎由 `voice.tts.provider` 选（`off` / `piper` / `openai`）。
- **/语音 一句话**：强制发一段语音，不依赖 mode。

## Piper 模型下载指引

1. 下载 `piper` 可执行文件：https://github.com/rhasspy/piper/releases（选 `piper_<os>_<arch>.tar.gz`）；
2. 下载中文语音模型（`.onnx` + `.onnx.json` 放一起），推荐 `zh_CN-huayan-medium`：
   https://huggingface.co/rhasspy/piper-voices/tree/main/zh/zh_CN；
3. 设置页填：语音 → TTS → Piper → 可执行文件路径 + 模型 `.onnx` 路径。

## 错误码

`EBOT-STT-*`（BAD-RECORD / HTTP-<status> / TIMEOUT / NETWORK / FILE / UNAVAILABLE / EMPTY）、
`EBOT-TTS-*`（PIPER-NO-MODEL / PIPER-SPAWN / PIPER-FAILED / PIPER-OUTPUT / OPENAI-NO-URL /
HTTP-<status> / TIMEOUT / NETWORK / EMPTY / PROVIDER-OFF）。用户侧只看到软文案。
