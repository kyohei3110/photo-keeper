# フォトキーパー

Googleフォトで選んだ写真・動画を、このサービスに保存して見られる個人用Webアプリです。
（Google公式の Photos Picker API を使用）

## セットアップ

1. **Google Cloud Console** でプロジェクトを作成
2. 「APIとサービス」→「ライブラリ」で **Google Photos Picker API** を有効化
3. 「OAuth同意画面」を設定（テストユーザーに使うGoogleアカウントを追加）
4. 「認証情報」→ OAuthクライアントID（**ウェブアプリケーション**）を作成
   - 承認済みリダイレクトURI: `<BASE_URL>/auth/callback`
     （ローカルなら `http://localhost:3000/auth/callback`）
5. `.env.example` を `.env` にコピーして値を設定
6. 起動

```bash
npm install
npm start
```

ブラウザで `BASE_URL` を開き、Googleでログイン → 「Googleフォトから写真を選ぶ」。

## 補足

- 保存先は `data/photos/`、一覧情報は `data/index.json`。バックアップはこのフォルダごと。
- 同じ写真を選び直しても重複保存されません。
- `ALLOWED_EMAILS` に入れたアカウントだけログインできます（夫婦2人ならカンマ区切りで2つ）。
- スマホから使う場合は https の公開URLが必要です（Render / Fly.io / VPS など。ディスクが永続化できる環境を選ぶこと）。
- 2025年3月以降、Googleフォトの旧Library APIでは「ライブラリ全体の読み取り」ができなくなったため、ユーザーが毎回ピッカーで選ぶ方式になっています。

## アプリとして使う（PWA）

https の公開URLで開くと、ホーム画面に追加してアプリのように使えます。

- iPhone: Safariで開く → 共有ボタン → 「ホーム画面に追加」
- Android: Chromeで開く → メニュー → 「アプリをインストール」
