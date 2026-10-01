package com.burzhbeats.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.view.HapticFeedbackConstants;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * BURZH beats for Android: a thin native shell around the same web radio that
 * runs on iPhone. All stations, the broadcast clock and the UI live in docs/
 * and are published to GitHub Pages, so both platforms always play the same
 * thing. The shell only adds what the web cannot do on its own here:
 * haptics and keeping the screen awake for the landscape desk screen.
 */
public class MainActivity extends Activity {
    private static final String APP_URL = "https://mburzhinsky-hub.github.io/burzh_beats/";
    private static final String APP_HOST = "mburzhinsky-hub.github.io";
    private static final String APP_PATH = "/burzh_beats/";
    private static final String OFFLINE_URL = "file:///android_asset/offline.html";

    private static final int REQ_LOCATION = 7;

    private WebView webView;
    private Vibrator vibrator;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        window.setStatusBarColor(Color.BLACK);
        window.setNavigationBarColor(Color.BLACK);

        try {
            if (Build.VERSION.SDK_INT >= 31) {
                VibratorManager vm = (VibratorManager) getSystemService(VIBRATOR_MANAGER_SERVICE);
                vibrator = vm != null ? vm.getDefaultVibrator() : null;
            } else {
                vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            }
        } catch (Throwable ignored) {
            vibrator = null;
        }

        webView = new WebView(this);
        webView.setBackgroundColor(Color.BLACK);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        webView.setOverScrollMode(android.view.View.OVER_SCROLL_NEVER);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        webView.addJavascriptInterface(new Bridge(), "AndroidBridge");
        webView.setWebViewClient(new ShellClient());
        webView.setWebChromeClient(new WebChromeClient() {
            // Weather asks for the device location; coarse is enough and only our own page may ask.
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (origin == null || !origin.startsWith("https://" + APP_HOST)) {
                    callback.invoke(origin, false, false);
                    return;
                }
                if (Build.VERSION.SDK_INT < 23 || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                    callback.invoke(origin, true, false);
                } else {
                    pendingGeoCallback = callback;
                    pendingGeoOrigin = origin;
                    requestPermissions(new String[]{Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
                }
            }
        });
        setContentView(webView);

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(APP_URL);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_LOCATION || pendingGeoCallback == null) return;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        pendingGeoCallback.invoke(pendingGeoOrigin, granted, false);
        pendingGeoCallback = null;
        pendingGeoOrigin = null;
    }

    /* The radio keeps playing in the background, so the WebView is deliberately
     * not paused in onPause(). */

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private static boolean isAppUrl(Uri uri) {
        if (uri == null) return false;
        if ("file".equals(uri.getScheme())) return OFFLINE_URL.equals(uri.toString());
        String path = uri.getPath() == null ? "" : uri.getPath();
        return "https".equals(uri.getScheme())
                && APP_HOST.equalsIgnoreCase(uri.getHost())
                && (path.startsWith(APP_PATH) || (path + "/").equals(APP_PATH));
    }

    private class ShellClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (isAppUrl(uri)) return false;
            // Anything outside the app opens in the browser, never inside the shell.
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException ignored) {
            }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame() && !OFFLINE_URL.equals(request.getUrl().toString())) {
                view.loadUrl(OFFLINE_URL);
            }
        }
    }

    public class Bridge {
        @JavascriptInterface
        public void feedback(final String kind) {
            runOnUiThread(() -> {
                vibrate(kind);
                if (webView != null) {
                    try {
                        webView.performHapticFeedback(
                                "play".equals(kind) ? HapticFeedbackConstants.VIRTUAL_KEY : HapticFeedbackConstants.KEYBOARD_TAP);
                    } catch (Throwable ignored) {
                    }
                }
            });
        }

        @JavascriptInterface
        public void setKeepAwake(final boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        @JavascriptInterface
        public void retry() {
            runOnUiThread(() -> {
                if (webView != null) webView.loadUrl(APP_URL);
            });
        }
    }

    private void vibrate(String kind) {
        if (vibrator == null || !vibrator.hasVibrator()) return;
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                int effect = "play".equals(kind) ? VibrationEffect.EFFECT_HEAVY_CLICK
                        : "station".equals(kind) ? VibrationEffect.EFFECT_TICK
                        : VibrationEffect.EFFECT_CLICK;
                vibrator.vibrate(VibrationEffect.createPredefined(effect));
            } else {
                vibrator.vibrate(VibrationEffect.createOneShot("play".equals(kind) ? 18 : 11, 150));
            }
        } catch (Throwable ignored) {
        }
    }
}
