package com.tmhys.kakeibo

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout

/**
 * 家計簿アプリの画面は1枚だけ。中身は GitHub Pages の家計簿を WebView で表示する。
 *
 * ネイティブで受け持つのは次だけ（画面の見た目や機能は Web 側で直す）:
 *   - 戻るボタン: Web 側が画面の切り替え・詳細シートを履歴に積んでいるので、
 *     戻れるあいだは WebView の履歴を戻り、ホームまで戻ったらアプリを閉じる
 *   - 下に引っぱって更新（Web 側の refreshData を呼ぶ）
 *   - ファイルの読み込み（銀行明細CSVの取り込み）と書き出し（CSV保存）
 *   - 読み込めなかったときの画面（URL の確認・再読み込み）
 *
 * URL とトークンなど家計簿の設定は、WebView の中の localStorage に入る
 * （ブラウザで使っていた家計簿とは別。初回だけ設定画面で入れ直す）。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var refresh: SwipeRefreshLayout
    private lateinit var errorView: View
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingSave: Pair<String, String>? = null // (ファイル名, 中身)

    private val prefs by lazy { getSharedPreferences("kakeibo", MODE_PRIVATE) }
    private val appUrl: String get() = prefs.getString("url", null) ?: BuildConfig.APP_URL

    // 銀行明細CSVなどを選ぶ（Web の <input type="file">）
    private val pickFile = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        fileCallback?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
        fileCallback = null
    }

    // CSV の保存先を選んでもらう（Web の書き出しボタン）
    private val createFile = registerForActivityResult(ActivityResultContracts.CreateDocument("text/csv")) { uri ->
        val save = pendingSave
        pendingSave = null
        if (uri == null || save == null) return@registerForActivityResult
        try {
            contentResolver.openOutputStream(uri)?.use { it.write(save.second.toByteArray(Charsets.UTF_8)) }
            Toast.makeText(this, "保存しました: ${save.first}", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, "保存できませんでした: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true // 設定・取引のキャッシュ（localStorage）
            settings.setSupportZoom(false)
            settings.userAgentString = settings.userAgentString + " KakeiboApp/" + BuildConfig.VERSION_NAME
            setBackgroundColor(ContextCompat.getColor(this@MainActivity, R.color.app_background))
            addJavascriptInterface(Bridge(), "KakeiboApp")
            webViewClient = Client()
            webChromeClient = Chrome()
        }
        refresh = SwipeRefreshLayout(this).apply {
            addView(webView, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            setColorSchemeColors(ContextCompat.getColor(this@MainActivity, R.color.app_accent))
            // ページの一番上にいるときだけ引っぱれる（途中で引くとスクロールが優先）
            setOnChildScrollUpCallback { _, _ -> webView.scrollY > 0 }
            setOnRefreshListener {
                webView.evaluateJavascript(
                    "(typeof refreshData === 'function') ? (refreshData(), 'ok') : (location.reload(), 'reload')"
                ) { postDelayed({ isRefreshing = false }, 800) }
            }
        }
        errorView = buildErrorView()

        val root = FrameLayout(this).apply {
            setBackgroundColor(ContextCompat.getColor(this@MainActivity, R.color.app_background))
            addView(refresh, FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
            addView(errorView, FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
        }
        // ステータスバー・ナビゲーションバー・キーボードの分だけ内側に寄せる（Android 15 は全画面表示が既定）
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)

        // 戻るボタン: 戻れるあいだは家計簿の中で戻る。ホームまで戻ったらアプリを閉じる
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (errorView.visibility != View.VISIBLE && webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        if (savedInstanceState != null) webView.restoreState(savedInstanceState) else webView.loadUrl(appUrl)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    // ---------------------------------------------------------------------------

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            val home = Uri.parse(appUrl)
            // 家計簿と同じ場所の中はアプリ内で開く。それ以外（ヘルプのリンクなど）はブラウザで
            if (url.host == home.host && (url.path ?: "").startsWith(home.path ?: "/")) return false
            try {
                startActivity(Intent(Intent.ACTION_VIEW, url))
            } catch (_: Exception) {
            }
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            errorView.visibility = View.GONE
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            // 画面そのもの（GitHub Pages）が読めなかったときだけ。gas への通信の失敗は Web 側が知らせる
            if (request.isForMainFrame) showError("読み込めませんでした（${error.description}）")
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onShowFileChooser(
            view: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: FileChooserParams,
        ): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            return try {
                pickFile.launch("*/*") // CSV の MIME 型は端末によってまちまちなので絞らない
                true
            } catch (_: Exception) {
                fileCallback = null
                false
            }
        }
    }

    /** Web 側から呼ぶ口（window.KakeiboApp）。CSV の書き出しは WebView では blob を保存できないため */
    private inner class Bridge {
        @JavascriptInterface
        fun saveFile(name: String, text: String) {
            runOnUiThread {
                pendingSave = name to text
                createFile.launch(name)
            }
        }

        @JavascriptInterface
        fun version(): String = BuildConfig.VERSION_NAME
    }

    // ---------------------------------------------------------------------------
    // 読み込めなかったときの画面

    private lateinit var errorMessage: TextView
    private lateinit var urlInput: EditText

    private fun buildErrorView(): View {
        val pad = (24 * resources.displayMetrics.density).toInt()
        errorMessage = TextView(this).apply { textSize = 15f; setPadding(0, 0, 0, pad / 2) }
        urlInput = EditText(this).apply { setSingleLine(); hint = BuildConfig.APP_URL }
        val retry = Button(this).apply {
            text = "再読み込み"
            setOnClickListener {
                val url = urlInput.text.toString().trim()
                if (url.isNotEmpty() && url != appUrl) prefs.edit().putString("url", url).apply()
                errorView.visibility = View.GONE
                webView.loadUrl(appUrl)
            }
        }
        val reset = Button(this).apply {
            text = "既定の URL に戻す"
            setOnClickListener {
                prefs.edit().remove("url").apply()
                urlInput.setText(BuildConfig.APP_URL)
            }
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(pad, pad, pad, pad)
            setBackgroundColor(ContextCompat.getColor(this@MainActivity, R.color.app_background))
            visibility = View.GONE
            addView(TextView(this@MainActivity).apply { text = "家計簿"; textSize = 22f; setPadding(0, 0, 0, pad / 2) })
            addView(errorMessage)
            addView(TextView(this@MainActivity).apply { text = "家計簿の URL（GitHub Pages）"; textSize = 12f })
            addView(urlInput)
            addView(retry)
            addView(reset)
        }
    }

    private fun showError(message: String) {
        errorMessage.text = message + "\n通信できる状態か、URL が正しいか確認してください。"
        urlInput.setText(appUrl)
        errorView.visibility = View.VISIBLE
        refresh.isRefreshing = false
    }
}
