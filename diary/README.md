# Pet Diary AI MVP

古いスマホをペットカメラ化し、定期キャプチャから「ペット日報」を作る最小プロトタイプ。

## Run

```bash
cp .env.example .env
# .env に OLLAMA_API_KEY を入れる場合は、source してから起動
set -a; source .env; set +a
npm run dev
```

Open: <http://localhost:8787>

スマホからカメラを使う場合、Safari/ChromeはHTTPSが必要。Tailscale ServeなどでHTTPS化する。

```bash
tailscale serve --bg --yes 8787
# https://<machine-name>.<tailnet>.ts.net/
```

## MVP flow

1. スマホ/PCのブラウザでカメラ許可
2. `Start diary capture` を押す
3. 1〜5分ごとに静止画を保存
4. `/api/report` で日報を生成

## Architecture

```text
browser camera
  -> POST /api/capture
  -> data/frames/YYYY-MM-DD/*.jpg
  -> data/YYYY-MM-DD.events.json
  -> GET /api/report
  -> Vision observation
  -> report polishing
  -> data/reports/YYYY-MM-DD.{json,md}
```

## AI pipeline

優先順:

1. Vision: `gemma4:31b` via Ollama Cloud
2. Report writing: `deepseek-v4-pro` via Ollama Cloud
3. Local fallback: `moondream` via local Ollama

Environment variables:

```bash
OLLAMA_API_KEY=
OLLAMA_CLOUD_VISION_MODEL=gemma4:31b
OLLAMA_CLOUD_MODEL=deepseek-v4-pro
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_VISION_MODEL=moondream
PORT=8787
```

## Project structure

```text
server.mjs                 HTTP entrypoint
server.ts                  Hono API server
src/config.ts              environment/path config
src/frame-service.ts       capture persistence
src/report-service.mjs     metrics + report generation
src/ollama-client.mjs      Ollama Cloud/local clients
src/static-files.ts        static file serving
src/http-utils.ts          request/response helpers
src/time.ts                JST date helpers
src/json-store.ts          JSON/file helpers
public/                    browser UI
docs/                      product notes
```

## Scope

やる:

- ブラウザカメラ入力
- 定期JPEG保存
- クライアント側の簡易モーション量計算
- 時間帯ごとの活動サマリ
- Visionモデルによる代表フレーム観察
- 日報JSON/Markdown生成

まだやらない:

- 病気診断
- 正確な異常検知
- Tapo/Eufy/Furbo連携
- リアルタイム通知
- 顔認識

## Privacy

`data/` is gitignored because it contains captured frames and generated reports. Do not commit user images or API keys.
