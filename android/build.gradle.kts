// ルートの build ファイル。使うプラグインのバージョンをここで一括して決める。
// apply false = 「ここでは有効にしない、バージョンだけ宣言する」。実際に使うのは app/ の方。
plugins {
    id("com.android.application") version "8.11.1" apply false
    id("org.jetbrains.kotlin.android") version "2.1.21" apply false
}
