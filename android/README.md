# 家計簿アプリ（Android）

家計簿（GitHub Pages の `https://tmhys.github.io/kakeibo-pwa/`）を表示する Android アプリ。
**画面の中身は Web のまま**で、ネイティブで受け持つのは次だけ:

| 何を | なぜアプリ側でやるか |
|---|---|
| 戻るボタン | 戻れるあいだは家計簿の中で戻り（画面・詳細シート）、ホームでもう一度押すと閉じる |
| 下に引っぱって更新 | 家計簿の `refreshData()` を呼ぶ（ページの一番上にいるときだけ） |
| CSV の書き出し | WebView はブラウザと同じ方法ではファイルを保存できないので、保存先を選ぶ画面に渡す |
| ファイルの読み込み | 銀行明細CSVの取り込みでファイルを選ぶ |
| 読み込めなかったとき | URL の確認・変更と再読み込みの画面 |
| ブラウザから起動される | マイツールのポータルのカードから `kakeibo://open` で開く（下記） |

画面を直すときは、リポジトリ直下の `index.html`・`*.js`・`style.css` を直せばよい。
**APK を作り直す必要はない**（アプリは毎回 GitHub Pages を読む）。APK を作り直すのは
`android/` を変えたときだけ（`.github/workflows/android.yml`）。

## 入れ方

1. GitHub の **Releases** の「家計簿（最新ビルド）」（`android-latest`）から `kakeibo.apk` を落として入れる。
   更新を自動で追うなら、日記アプリと同じく Obtainium にこのリポジトリ（`tmhys/kakeibo-pwa`）を足す
2. 初回だけ、家計簿の設定画面で WebApp URL とトークンを入れる
   （ブラウザで使っていた家計簿とは保存場所が別のため）

## ブラウザから開く（`kakeibo://`）

マイツール（[tmhys/my-apps](https://github.com/tmhys/my-apps)）のポータルに
「らくな家計簿」のカードがあり、Android ではここを叩いてアプリを起動する。

```
intent://open#Intent;scheme=kakeibo;package=com.tmhys.kakeibo;S.browser_fallback_url=...;end
```

**`BROWSABLE` が要る。** Chrome は `intent://` を発射するとき `BROWSABLE` を必ず足し、
Android は付いた全カテゴリを宣言しているアクティビティしか起動しない。
`MAIN` / `LAUNCHER` だけだと一致せず、フォールバック先（ウェブ版）が開いてしまう。

独自スキームにしているのは、`https://tmhys.github.io/kakeibo-pwa/` をそのまま
受けるには Digital Asset Links（`assetlinks.json`）が要り、`tmhys.github.io` は
共用ドメインで置きにくいため。**渡ってくる URL は使わない**（いつもどおり `appUrl` を開く）。
入口が1つ増えるだけで、アプリの動きは変わらない。

アプリが入っていない端末では、ポータル側のフォールバックでウェブ版が開く。

## 署名鍵

鍵ファイルもパスワードも**リポジトリに置かない**（公開リポジトリのため）。GitHub の
Settings → Secrets and variables → Actions に次の2つを登録すると、その鍵で署名される（上書きで更新できる）:

- `KAKEIBO_KEYSTORE_B64`: 鍵ファイル（PKCS12）を base64 にした文字列
- `KAKEIBO_KEYSTORE_PASSWORD`: 鍵のパスワード（エイリアスは `kakeibo`）

無いと debug 鍵でビルドされ、更新のたびにアンインストールが要る。
鍵をなくすと、以後の APK は上書きインストールできなくなる（一度アンインストールが要る）ので、控えを残しておくこと。
