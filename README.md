# PSP Detector

複数のWebサイトを巡回して、使用している決済サービス（PSP）を検出するNode.js CLIツールです。

## 検出対象PSP

| PSP | 検出方法の例 |
|-----|------------|
| Stripe | `js.stripe.com`, `pk_live_` キー |
| PayPal | `paypal.com/sdk/js`, `paypalobjects.com` |
| Braintree | `js.braintreegateway.com` |
| Square | `js.squareup.com`, `squareupsandbox.com` |
| Adyen | `checkoutshopper*.adyen.com`, `AdyenCheckout` |
| Checkout.com | `cdn.checkout.com`, `Frames.init` |
| SoftBank Payment | `sbpayment.jp` |
| GMO Payment Gateway | `static.mul-pay.com`, `p01.mul-pay.com` |
| GMO Epsilon | `epsilon.jp`, `trans.epsilon.jp` |
| DGFT (Digital Garage) | `dgft.jp`, `veritrans` |

## セットアップ

Node.js (v14以上) のみ必要です。外部ライブラリは不要です。

```bash
# リポジトリをクローン（またはファイルをダウンロード）
git clone https://github.com/your-org/psp-detector.git
cd psp-detector
```

## 使い方

### 1. URLリストを準備

`urls.txt` に調査対象URLを1行1つ記載します：

```
# コメント行はスキップされます
https://example.com
https://shop.example.jp
example-store.com        # https:// は省略可
```

### 2. 実行

```bash
node psp-detect.js urls.txt
```

### オプション

| オプション | デフォルト | 説明 |
|-----------|-----------|------|
| `--output <file>` | `results.csv` | 出力CSVファイル名 |
| `--concurrency <n>` | `5` | 並列実行数 |
| `--timeout <ms>` | `15000` | タイムアウト（ミリ秒） |

```bash
# カスタムオプション例
node psp-detect.js \
  --output 2024-01-scan.csv \
  --concurrency 10 \
  --timeout 20000 \
  urls.txt
```

## 出力形式

BOM付きUTF-8のCSVファイルが生成されます（Excelで直接開けます）。

| 列名 | 内容 |
|------|------|
| URL | 対象URL |
| Status | HTTPステータスコード |
| Detected PSPs | 検出されたPSP（パイプ区切り） |
| Error | エラーメッセージ（正常時は空） |
| Stripe〜DGFT | 各PSPの検出フラグ（1/0） |

## GitHub Actionsでの実行

`.github/workflows/scan.yml` をリポジトリに配置すると、GitHubのActionsタブから手動実行できます。

1. GitHubリポジトリの **Actions** タブを開く
2. **PSP Scan** ワークフローを選択
3. **Run workflow** をクリック
4. パラメータを入力して実行
5. 完了後、**Artifacts** から結果CSVをダウンロード

## 注意事項

- JavaScriptで動的に読み込まれるPSPは検出できない場合があります（HTMLソース解析のみ）
- 一部のサイトはボット判定でブロックする場合があります
- 商用利用時はサイトのロボット規約を確認してください
