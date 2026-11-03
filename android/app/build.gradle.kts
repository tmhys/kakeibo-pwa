plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 家計簿アプリ（Android）。画面そのものは GitHub Pages の家計簿（このリポジトリの
// index.html など）を WebView で表示する。ネイティブで受け持つのは、戻るボタン・
// 引っぱって更新・ファイルの読み書き・アプリとしての起動だけ。
// 画面を直すときは Web 側を直せばよく、APK を作り直す必要はない。

// GitHub Actions のビルド番号。versionCode と versionName（v1.<番号>）に使う。
val buildNumber: Int? = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull()

// 署名: 鍵ファイルもパスワードもリポジトリに置かない（このリポジトリは公開なので）。
// Actions が Secrets「KAKEIBO_KEYSTORE_B64」から app/kakeibo.keystore を書き出し、
// パスワードは「KAKEIBO_KEYSTORE_PASSWORD」から読む（.github/workflows/android.yml）。
// どちらか無ければ debug 鍵でビルドする（ビルドは通るが、更新のたびにアンインストールが要る）。
val keystoreFile = file("kakeibo.keystore")
val keystorePassword: String? = System.getenv("KAKEIBO_KEYSTORE_PASSWORD")?.takeIf { it.isNotBlank() && keystoreFile.exists() }

android {
    namespace = "com.tmhys.kakeibo"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.tmhys.kakeibo"
        minSdk = 26
        targetSdk = 35
        versionCode = buildNumber ?: 1
        versionName = if (buildNumber != null) "1.$buildNumber" else "0.1-local"
        // 表示する家計簿の URL。アプリの中（読み込めなかったときの画面）からも変えられる
        buildConfigField("String", "APP_URL", "\"https://tmhys.github.io/kakeibo-pwa/\"")
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        if (keystorePassword != null) {
            create("release") {
                storeFile = keystoreFile
                storePassword = keystorePassword
                keyAlias = "kakeibo"
                keyPassword = keystorePassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (keystorePassword != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    // DayNight テーマ（WebView の prefers-color-scheme が端末のダークモードに従う）と AppCompatActivity
    implementation("androidx.appcompat:appcompat:1.7.0")
    // 戻るボタン（OnBackPressedDispatcher）とファイル選択（ActivityResultContracts）
    implementation("androidx.activity:activity:1.9.3")
    // WindowInsets を API 26 から同じ書き方で扱う
    implementation("androidx.core:core-ktx:1.13.1")
    // 下に引っぱって更新
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
}
