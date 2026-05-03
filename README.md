# Pet Diary AI MVP

古いスマホをペットカメラ化し、定期キャプチャから「ペット日報」を作る最小プロトタイプ。

## Run

```bash
npm run dev
```

Open: http://localhost:8787

スマホから使う場合は同じWi-Fiで Mac のIPへアクセス:

```bash
ipconfig getifaddr en0
# http://<mac-ip>:8787
```

## MVP flow

1. スマホ/PCのブラウザでカメラ許可
2. `Start diary capture` を押す
3. 1〜5分ごとに静止画を保存
4. `/api/report` で簡易日報を生成

## Scope

やる:
- ブラウザカメラ入力
- 定期JPEG保存
- クライアント側の簡易モーション量計算
- 時間帯ごとの活動サマリ
- 日報JSON/Markdown生成

まだやらない:
- 病気診断
- 正確な異常検知
- Tapo/Eufy/Furbo連携
- リアルタイム通知
- 顔認識

## Ollama Cloud

画像解析と日報整形はOllama Cloudを使える。APIキーは環境変数で渡す。

```bash
export OLLAMA_API_KEY=...
export OLLAMA_CLOUD_VISION_MODEL=gemma4:31b
export OLLAMA_CLOUD_MODEL=deepseek-v4-pro
npm run dev
```

構成:
- Vision: `gemma4:31b` via Ollama Cloud
- Report writing: `deepseek-v4-pro` via Ollama Cloud
- Local fallback: `moondream` via local Ollama

## Privacy

`data/` is gitignored because it contains captured frames and generated reports. Do not commit user images or API keys.
