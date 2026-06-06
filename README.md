# Ahrefs UI Auto Export

Ahrefs の画面操作を自動化して、対象ページやドメインの `Organic keywords` をまとめて取得するツールです。

公開リポジトリには実データを含めない方針のため、`input/` と `output/` の中身は GitHub には含めていません。
実行時に手元でファイルを作成して使う想定です。

このプロジェクトで今できることは、主に次の 3 つです。

- Ahrefs から複数 URL / ドメインのキーワードをまとめて取得する
- キーワード候補に使いたい「ジャンル」を入れて、調査対象 URL を `input/targets.csv` に追加する
- 取得したキーワードを Jenkins に渡して rank check し、見やすい CSV に整形する

利用者向けに一言でいうと、
「調査したいページ候補を集める -> Ahrefs からキーワードを取る -> Jenkins に流して順位確認する」
までを、コマンドベースで回せる作業用ツールです。

## このツールが向いている人

- 競合サイトや対象ページの検索キーワードをまとめて取得したい人
- Ahrefs の UI で 1 件ずつ Export するのが面倒な人
- `Organic keywords` を CSV / TXT にして次の工程へ渡したい人
- Jenkins の rank checker にキーワードを渡して、その後の整形まで一気に進めたい人

## 今のプロジェクトでできること

### 1. `targets.csv` にある対象を Ahrefs で一括処理

- `input/targets.csv` に書かれた URL / ドメインを順番に処理します
- Ahrefs の `Organic keywords` 画面に移動し、Export を自動で実行します
- 出力された CSV から `keyword` と `volume` を抽出して保存します
- 実行済みの行は `status=done` になり、次回はスキップされます
- 失敗した行には `error_message` が残るので、あとで再実行しやすいです

### 2. ジャンルを入れて、調査対象 URL を自動追加

- `npm run discover:targets -- 脱毛` のようにジャンルを渡せます
- そのジャンルから関連検索語を自動生成します
- Serper API で検索結果 URL を集め、`input/targets.csv` に追記します
- 既存の `target` と重複する URL は追加しません

補足:
この機能は「ジャンルから候補 URL を集める」までです。
Ahrefs の実行は別コマンドの `npm run export` です。

### 3. 取得したキーワードを Jenkins に渡す

- `npm run jenkins:run`
  Jenkins API 経由でジョブを起動します
- `npm run jenkins:ui`
  ブラウザで Jenkins にログインして、画面操作でジョブを起動します
- `npm run jenkins:rankchecker`
  rank checker 用ジョブを実行し、成果物 CSV の取得と整形まで進めます

### 4. rank check の結果を見やすく整形

- `npm run rankcheck:pivot`
  `keyword, volume, rank1 ... rank10` の横持ち CSV を作ります
- `npm run rankcheck:domains`
  上の横持ち CSV をもとに、出現ドメイン数の集計 CSV を作ります
  あわせて、`host` と `host + 第1ディレクトリ` を自動判定で切り分けた `media cluster` 集計も出します

### 5. 頻出上位メディアからキーワードを再拡張

- `npm run expand:keywords`
  最新の `rank_check_wide` を起点に、次の流れをまとめて実行します
- `media cluster` 頻出上位 5 件を選ぶ
- 上位 5 件を Ahrefs の対象 CSV に変換する
- Ahrefs から `Organic keywords` を取得する
- 取得キーワードを重複削除して、最初の seed keywords と統合する
- 統合後のキーワードを Jenkins rank checker に再投入する

## このツールでまだできないこと

- Web 画面にキーワードを直接入力して、そのまま全部実行すること
- 1 コマンドで「ジャンル入力 -> 候補 URL 収集 -> Ahrefs 実行」まで完全自動にすること

今の流れは次のどちらかです。

1. `input/targets.csv` を自分で用意して `npm run export`
2. `npm run discover:targets -- <ジャンル>` で候補 URL を追加してから `npm run export`

## 最短の使い方

### パターン A: すでに調査対象 URL がある場合

1. `input/targets.csv` を用意する
2. `npm run login` で Ahrefs にログインする
3. `npm run export` を実行する

### パターン B: ジャンルから候補 URL を集めたい場合

1. `.env` に `SERPER_API_KEY` を入れる
2. `npm run discover:targets -- 脱毛` を実行する
3. 追加された `input/targets.csv` を確認する
4. `npm run login` で Ahrefs にログインする
5. `npm run export` を実行する

## セットアップ

### 前提

- Node.js 20 以上
- Chrome または Chromium が使える環境
- Ahrefs にログインできるアカウント

### 初回セットアップ

```bash
cd ahrefs-ui-auto-export
nvm use 20
npm install
npx playwright install chromium
```

## 入力ファイル

### `input/targets.csv`

このリポジトリでは `input/` の実データを公開していないため、必要に応じてこのファイルを手元で作成してください。

最低限、次の 3 列があれば動かせます。

```csv
target,mode,country
https://gorilla.clinic/operation/aga/,prefix,jp
https://example.com/service/seo/,prefix,jp
example.com,domain,jp
```

各列の意味:

- `target`
  調査対象の URL またはドメイン
- `mode`
  `exact | prefix | domain | subdomains`
- `country`
  2 文字の国コード。例: `jp`, `us`

使い分けの目安:

- 記事や LP 単位なら `prefix`
- ドメイン全体を見たいなら `domain`
- サブドメイン込みで見たいなら `subdomains`

実行後は、次の管理列が自動で追記されます。

- `status`
- `planned_at`
- `started_at`
- `completed_at`
- `progress_note`
- `last_run_id`
- `result_rows`
- `result_file`
- `error_message`

運用ルール:

- `status` が空の行は次回実行時の対象になります
- `status=done` の行はスキップされます
- 再実行したい行は `status` を空欄に戻してください
- `status=error` の行は原因を見て修正後に再実行してください

## 実行コマンド

### Ahrefs にログイン

```bash
npm run login
```

ブラウザが開くので Ahrefs にログインし、ターミナルに戻って Enter を押します。
ログイン状態は `.ahrefs-profile/` に保存されます。

### Ahrefs から一括エクスポート

```bash
npm run export
```

このコマンドは `input/targets.csv` を読み込み、未完了の行だけ処理します。

### ジャンルから調査対象 URL を追加

`.env` に Serper API キーを設定してください。

```bash
SERPER_API_KEY=your_serper_api_key
```

実行例:

```bash
npm run discover:targets -- 脱毛
```

この機能のポイント:

- ジャンルから関連キーワードを自動生成します
- 検索結果 URL を `input/targets.csv` に追加します
- 追加時は `mode=prefix`, `country=jp` が既定値です
- `source_genre`, `source_keyword`, `source_rank`, `source_title`, `discovered_at` も保存されます

注意:
検索結果は必ずしも意図通りとは限りません。
`npm run export` の前に `input/targets.csv` を確認するのがおすすめです。

## 出力ファイル

### Ahrefs の生 CSV

- `downloads/`
- `output/01_ahrefs_raw_csv/`

### 整形済みキーワード

- `output/02_keyword_research/per_target_csv/<target>_YYYYMMDD_HHMMSS.csv`
  対象ごとの `keyword,volume`
- `output/02_keyword_research/merged_csv/organic_keywords_all_YYYYMMDD_HHMMSS.csv`
  全対象をまとめた CSV
- `output/02_keyword_research/merged_csv/organic_keywords_unique_YYYYMMDD_HHMMSS.csv`
  重複キーワードをまとめた CSV
- `output/02_keyword_research/keyword_lists_txt/organic_keywords_all_keywords_YYYYMMDD_HHMMSS.txt`
  1 行 1 キーワードの TXT
- `output/02_keyword_research/spreadsheet_tsv/*_spreadsheet.tsv`
  スプシ貼り付け用のタブ区切りファイル

補足:
`organic_keywords_all_*.csv` と `organic_keywords_unique_*.csv` は、既定では `volume > 100` のキーワードだけを書き出します。
しきい値は `MIN_VOLUME_ALL` で変更できます。
Ahrefs の Organic keywords export は既定で最大 `3000` 行までを選ぶようにしてあります。

### Jenkins / rank check 関連

- `output/03_jenkins_rankchecker/raw_csv/`
  Jenkins の成果物生 CSV を保存します
- `output/03_jenkins_rankchecker/wide_csv/`
  `keyword, rank1 ... rank10` の横持ち結果です
- `output/03_jenkins_rankchecker/domain_summary/*_domains_*.csv`
  従来の host 単位の頻出集計です
- `output/03_jenkins_rankchecker/domain_summary/*_media_clusters_*.csv`
  `host` または `host + 第1ディレクトリ` の自動判定で切り分けた頻出集計です

### キーワード再拡張ループ

- `output/05_keyword_expansion/selected_clusters/`
  再拡張に使った上位 media cluster の記録です
- `output/05_keyword_expansion/ahrefs_targets/`
  Ahrefs に再投入した対象 CSV です
- `output/05_keyword_expansion/rerun_keywords_txt/`
  seed keywords と expanded keywords を統合して、再度 Jenkins に渡した TXT です

## 実運用上の制約

- Ahrefs `Organic keywords` export
  既定で最大 `3000` 行までを選びます
- Ahrefs `Batch Analysis`
  既定で `200 URL` ごとに分割して処理します
- Jenkins 再投入キーワード
  既定では `volume > 100` のキーワードだけを対象にします
  上限件数は既定で `2000` 件、必要なら `EXPANSION_RERUN_MAX_KEYWORDS` で変更できます
- `output/03_jenkins_rankchecker/wide_csv/`
  `rank1` から `rank10` の横持ち CSV を保存します
- `output/03_jenkins_rankchecker/domain_summary/`
  ドメイン出現数の集計 CSV を保存します

主な出力例:

- `raw_csv/rank_check_YYYYMMDD_HHMMSS.csv`
- `raw_csv/build_<buildNo>_rank_check_YYYYMMDD_HHMMSS.csv`
- `wide_csv/rank_check_wide_YYYYMMDD_HHMMSS.csv`
- `domain_summary/rank_check_wide_domains_YYYYMMDD_HHMMSS.csv`

## Jenkins 連携

### 1. API 経由でジョブを起動

```bash
npm run jenkins:run
```

必要な `.env`:

```bash
JENKINS_BASE_URL=https://your-jenkins.example.com
JENKINS_JOB_NAME=KW-imp取得
JENKINS_USER=your_user
JENKINS_API_TOKEN=your_api_token
JENKINS_KEYWORDS_FILE=output/02_keyword_research/keyword_lists_txt
JENKINS_KEYWORDS_PARAM=keywords
```

`JENKINS_KEYWORDS_FILE` にディレクトリを指定した場合は、その中の最新 `.txt` を使います。

### 2. ブラウザ UI でジョブを起動

```bash
npm run jenkins:ui
```

必要な `.env`:

```bash
JENKINS_BASE_URL=https://your-jenkins.example.com
JENKINS_JOB_NAME=KW-imp取得
JENKINS_LOGIN_URL=https://your-jenkins.example.com/login?from=%2F
JENKINS_UI_USER=your_login_id
JENKINS_UI_PASSWORD=your_password
JENKINS_KEYWORDS_FILE=output/02_keyword_research/keyword_lists_txt
JENKINS_KEYWORDS_PARAM=keywords
```

`JENKINS_UI_USER` と `JENKINS_UI_PASSWORD` が無い場合は、ブラウザで手動ログインして進められます。

### 3. rank checker を実行して成果物まで回収

```bash
npm run jenkins:rankchecker
```

このコマンドでやること:

- Jenkins の rank checker ジョブを開く
- キーワードファイルをアップロードしてビルドする
- 成果物 CSV を待機してダウンロードする
- 横持ち CSV に整形する
- ドメイン出現数 CSV まで作る

代表的な `.env`:

```bash
JENKINS_BASE_URL=https://your-jenkins.example.com
JENKINS_LOGIN_URL=https://your-jenkins.example.com/login?from=%2F
JENKINS_RANKCHECKER_JOB_PATH=lincwell_grc
JENKINS_KEYWORDS_FILE=output/02_keyword_research/keyword_lists_txt
JENKINS_KEYWORDS_PARAM=tmp/keywords.txt
JENKINS_RANKCHECKER_ARTIFACT=rank_check.csv
JENKINS_RANKCHECKER_WAIT_SEC=1800
JENKINS_RANKCHECKER_POLL_SEC=180
```

既に Jenkins 側でビルド済みの番号がある場合は、`JENKINS_RANKCHECKER_BUILD_NO` を指定して再取得もできます。

## rank check の整形だけ行いたい場合

### 横持ち CSV を作る

```bash
npm run rankcheck:pivot
```

最新の `rank_check*.csv` を探して、次の形式に整形します。

```text
keyword,volume,rank1,rank2,...,rank10
```

### ドメイン集計 CSV を作る

```bash
npm run rankcheck:domains
```

最新の `rank_check_wide*.csv` を探して、出現ドメイン数を集計します。

## よく使う環境変数

### Ahrefs 実行まわり

- `HEADLESS=1`
  ブラウザを非表示で実行
- `AHREFS_APP_BASE`
  Ahrefs のベース URL を変更
- `AHREFS_REPORT_PATH`
  `Organic keywords` のパス差分がある場合に変更
- `PRE_EXPORT_WAIT_MS`
  読み込み待機時間を延長
- `MIN_VOLUME_ALL`
  統合 CSV / TXT に残す最小 volume のしきい値

### discover:targets まわり

- `DISCOVERY_MAX_KEYWORDS`
- `DISCOVERY_TOP_RESULTS`
- `DISCOVERY_DEFAULT_MODE`
- `DISCOVERY_DEFAULT_COUNTRY`
- `DISCOVERY_REQUEST_DELAY_MS`
- `DISCOVERY_HL`
- `DISCOVERY_GL`
- `SERPER_API_URL`

## 困ったとき

### Ahrefs が途中で止まる

- `HEADLESS=0 npm run export` で画面を見ながら確認してください
- ログイン切れなら `npm run login` をやり直してください
- `PRE_EXPORT_WAIT_MS=15000 npm run export` のように待機時間を延ばしてください

### `discover:targets` の結果が想定と違う

- そのまま流さず、`input/targets.csv` を先に確認してください
- ノイズのある URL を削除してから `npm run export` を実行してください
- ジャンル名をもう少し具体的にすると改善しやすいです

### Jenkins に渡すファイルを変えたい

- `JENKINS_KEYWORDS_FILE` でファイルまたはディレクトリを指定できます
- ディレクトリを指定した場合は最新 `.txt` が使われます

## 注意事項

- Ahrefs や Jenkins の画面構造が変わると動かなくなることがあります
- ブラウザ自動操作を使うため、ログインや 2FA が必要になることがあります
- Serper API は利用量に応じて課金される場合があります
- 実運用前に、利用規約や社内ルールに問題がないか確認してください
