package com.burzhbeats.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Window;
import android.view.WindowManager;
import android.view.HapticFeedbackConstants;
import android.view.SoundEffectConstants;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;
import org.w3c.dom.Document;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.xml.parsers.DocumentBuilderFactory;

public class MainActivity extends Activity {
    private static final String PLAYLIST_UUID = "a0a4175e-9293-1c07-b536-aa9a4522bee8";
    private static final String API = "https://api.music.yandex.net";
    private static final String CLIENT_HEADER = "YandexMusicAndroid/24023621";
    private static final String SIGN_SALT = "XGRlBW9FXlekgbPrRHuSiA";

    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<Track> tracks = new ArrayList<>();

    private WebView webView;
    private MediaPlayer player;
    private int currentIndex = 0;
    private boolean prepared = false;

    private final Runnable progressTicker = new Runnable() {
        @Override public void run() {
            if (player != null && prepared) {
                try {
                    JSONObject s = baseState();
                    s.put("positionMs", player.getCurrentPosition());
                    s.put("durationMs", player.getDuration());
                    s.put("playing", player.isPlaying());
                    emitState(s);
                } catch (Exception ignored) {}
            }
            main.postDelayed(this, 700);
        }
    };

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window w = getWindow();
        w.setStatusBarColor(Color.BLACK);
        w.setNavigationBarColor(Color.BLACK);
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.BLACK);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        webView.setOverScrollMode(android.view.View.OVER_SCROLL_NEVER);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.getSettings().setMediaPlaybackRequiresUserGesture(false);
        webView.addJavascriptInterface(new Bridge(), "AndroidBridge");
        webView.setWebViewClient(new WebViewClient());
        setContentView(webView);

        webView.loadUrl("file:///android_asset/index.html");
        main.postDelayed(this::loadPlaylist, 500);
        main.post(progressTicker);
    }

    private void loadPlaylist() {
        emitSimple("status", "LOADING PLAYLIST");
        executor.execute(() -> {
            try {
                JSONObject json = getJson(API + "/playlist/" + PLAYLIST_UUID);
                JSONObject result = json.optJSONObject("result");
                if (result == null) result = json;
                JSONArray arr = result.optJSONArray("tracks");
                if (arr == null) throw new Exception("Playlist is unavailable");

                synchronized (tracks) {
                    tracks.clear();
                    for (int i = 0; i < arr.length(); i++) {
                        JSONObject entry = arr.optJSONObject(i);
                        if (entry == null) continue;
                        JSONObject t = entry.optJSONObject("track");
                        if (t == null) t = entry;

                        String id = t.optString("id", "");
                        if (id.isEmpty()) id = t.optString("trackId", "");
                        if (id.isEmpty()) continue;

                        String title = t.optString("title", "Unknown track");
                        String artist = "Unknown artist";
                        JSONArray artists = t.optJSONArray("artists");
                        if (artists != null && artists.length() > 0) {
                            JSONObject a = artists.optJSONObject(0);
                            if (a != null) artist = a.optString("name", artist);
                        }
                        tracks.add(new Track(id, title, artist));
                    }
                    if (currentIndex >= tracks.size()) currentIndex = 0;
                }

                JSONObject s = baseState();
                s.put("status", tracks.isEmpty() ? "PLAYLIST EMPTY" : "READY");
                s.put("count", tracks.size());
                addCurrentTrack(s);
                emitState(s);
            } catch (Exception e) {
                JSONObject s = baseState();
                try {
                    s.put("status", "PLAYLIST ERROR");
                    s.put("error", e.getMessage());
                } catch (Exception ignored) {}
                emitState(s);
            }
        });
    }

    private void playCurrent() {
        Track track;
        synchronized (tracks) {
            if (tracks.isEmpty()) {
                loadPlaylist();
                return;
            }
            track = tracks.get(currentIndex);
        }

        emitSimple("status", "RESOLVING AUDIO");
        executor.execute(() -> {
            try {
                String stream = resolveStreamUrl(track.id);
                main.post(() -> startPlayer(stream, track));
            } catch (Exception e) {
                JSONObject s = baseState();
                try {
                    s.put("status", "AUDIO UNAVAILABLE");
                    s.put("error", e.getMessage());
                    addCurrentTrack(s);
                } catch (Exception ignored) {}
                emitState(s);
            }
        });
    }

    private void startPlayer(String streamUrl, Track track) {
        releasePlayer();
        try {
            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .build());
            player.setDataSource(streamUrl);
            player.setOnPreparedListener(mp -> {
                prepared = true;
                mp.start();
                JSONObject s = baseState();
                try {
                    s.put("status", "PLAYING");
                    s.put("playing", true);
                    s.put("title", track.title);
                    s.put("artist", track.artist);
                    s.put("durationMs", mp.getDuration());
                } catch (Exception ignored) {}
                emitState(s);
            });
            player.setOnCompletionListener(mp -> nextTrack());
            player.setOnErrorListener((mp, what, extra) -> {
                emitSimple("status", "PLAYBACK ERROR");
                return true;
            });
            player.prepareAsync();
        } catch (Exception e) {
            emitSimple("status", "PLAYBACK ERROR");
        }
    }

    private String resolveStreamUrl(String trackId) throws Exception {
        JSONObject infoJson = getJson(API + "/tracks/" + trackId + "/download-info");
        JSONArray infos = infoJson.optJSONArray("result");
        if (infos == null || infos.length() == 0) throw new Exception("No audio variants");

        JSONObject best = null;
        for (int i = 0; i < infos.length(); i++) {
            JSONObject x = infos.optJSONObject(i);
            if (x == null) continue;
            if (!"mp3".equalsIgnoreCase(x.optString("codec", ""))) continue;
            if (best == null || x.optInt("bitrateInKbps", 0) > best.optInt("bitrateInKbps", 0)) best = x;
        }
        if (best == null) best = infos.optJSONObject(0);
        if (best == null) throw new Exception("No playable variant");

        String xmlUrl = best.optString("downloadInfoUrl", "");
        if (xmlUrl.isEmpty()) throw new Exception("Missing download URL");

        HttpURLConnection c = open(xmlUrl);
        try (InputStream in = c.getInputStream()) {
            Document doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(in);
            String host = doc.getElementsByTagName("host").item(0).getTextContent();
            String path = doc.getElementsByTagName("path").item(0).getTextContent();
            String ts = doc.getElementsByTagName("ts").item(0).getTextContent();
            String s = doc.getElementsByTagName("s").item(0).getTextContent();
            String sign = md5(SIGN_SALT + path.substring(1) + s);
            return "https://" + host + "/get-mp3/" + sign + "/" + ts + path;
        } finally {
            c.disconnect();
        }
    }

    private JSONObject getJson(String address) throws Exception {
        HttpURLConnection c = open(address);
        c.setRequestProperty("X-Yandex-Music-Client", CLIENT_HEADER);
        c.setRequestProperty("Accept-Language", "ru");
        int status = c.getResponseCode();
        String text = readAll(status >= 400 ? c.getErrorStream() : c.getInputStream());
        c.disconnect();
        if (status >= 400) throw new Exception("HTTP " + status);
        return new JSONObject(text);
    }

    private HttpURLConnection open(String address) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(address).openConnection();
        c.setConnectTimeout(12000);
        c.setReadTimeout(15000);
        c.setRequestProperty("User-Agent", "BURZH-beats/0.5 Android");
        return c;
    }

    private static String readAll(InputStream input) throws Exception {
        if (input == null) return "";
        BufferedReader br = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = br.readLine()) != null) sb.append(line);
        return sb.toString();
    }

    private static String md5(String text) throws Exception {
        byte[] d = MessageDigest.getInstance("MD5").digest(text.getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        for (byte b : d) sb.append(String.format(Locale.US, "%02x", b & 0xff));
        return sb.toString();
    }

    private JSONObject baseState() {
        JSONObject s = new JSONObject();
        try {
            s.put("station", "Lo-Fi");
            s.put("playlistUuid", PLAYLIST_UUID);
            s.put("playing", player != null && prepared && player.isPlaying());
        } catch (Exception ignored) {}
        return s;
    }

    private void addCurrentTrack(JSONObject s) {
        synchronized (tracks) {
            if (!tracks.isEmpty()) {
                Track t = tracks.get(currentIndex);
                try {
                    s.put("title", t.title);
                    s.put("artist", t.artist);
                    s.put("index", currentIndex);
                } catch (Exception ignored) {}
            }
        }
    }

    private void emitSimple(String key, String value) {
        JSONObject s = baseState();
        try {
            s.put(key, value);
            addCurrentTrack(s);
        } catch (Exception ignored) {}
        emitState(s);
    }

    private void emitState(JSONObject state) {
        main.post(() -> {
            if (webView != null) {
                webView.evaluateJavascript("window.BURZH&&window.BURZH.onState(" + state.toString() + ")", null);
            }
        });
    }

    private void nextTrack() {
        synchronized (tracks) {
            if (tracks.isEmpty()) return;
            currentIndex = (currentIndex + 1) % tracks.size();
        }
        playCurrent();
    }

    private void previousTrack() {
        synchronized (tracks) {
            if (tracks.isEmpty()) return;
            currentIndex = (currentIndex - 1 + tracks.size()) % tracks.size();
        }
        playCurrent();
    }

    private void releasePlayer() {
        prepared = false;
        if (player != null) {
            try { player.reset(); } catch (Exception ignored) {}
            try { player.release(); } catch (Exception ignored) {}
            player = null;
        }
    }

    @Override protected void onDestroy() {
        main.removeCallbacks(progressTicker);
        releasePlayer();
        executor.shutdownNow();
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    public class Bridge {
        @JavascriptInterface public void playPause() {
            main.post(() -> {
                if (player != null && prepared) {
                    if (player.isPlaying()) player.pause(); else player.start();
                    emitSimple("status", player.isPlaying() ? "PLAYING" : "PAUSED");
                } else {
                    playCurrent();
                }
            });
        }
        @JavascriptInterface public void next() { nextTrack(); }
        @JavascriptInterface public void previous() { previousTrack(); }
        @JavascriptInterface public void reload() { loadPlaylist(); }
        @JavascriptInterface public void feedback(String kind) {
            main.post(() -> {
                if (webView == null) return;
                try {
                    int haptic = HapticFeedbackConstants.KEYBOARD_TAP;
                    if ("next".equals(kind) || "previous".equals(kind) || "station".equals(kind)) {
                        haptic = HapticFeedbackConstants.CLOCK_TICK;
                    } else if ("play".equals(kind)) {
                        haptic = HapticFeedbackConstants.VIRTUAL_KEY;
                    }
                    webView.performHapticFeedback(
                            haptic,
                            HapticFeedbackConstants.FLAG_IGNORE_GLOBAL_SETTING
                    );
                } catch (Throwable ignored) {}

                try {
                    int sound = SoundEffectConstants.CLICK;
                    if ("next".equals(kind) || "station".equals(kind)) {
                        sound = SoundEffectConstants.NAVIGATION_RIGHT;
                    } else if ("previous".equals(kind)) {
                        sound = SoundEffectConstants.NAVIGATION_LEFT;
                    }
                    webView.playSoundEffect(sound);
                } catch (Throwable ignored) {}
            });
        }
    }

    private static class Track {
        final String id;
        final String title;
        final String artist;
        Track(String id, String title, String artist) {
            this.id = id;
            this.title = title;
            this.artist = artist;
        }
    }
}
