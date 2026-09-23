package com.burzhbeats.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.AudioTrack;
import android.media.AudioFormat;
import android.os.Bundle;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
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
    private static final String LOFI_ALBUM_ID = "41987524";
    private static final String FUTURE_GARAGE_ALBUM_ID = "23384649";
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
    private Vibrator vibrator;
    private AudioTrack clickSoft;
    private AudioTrack clickNav;
    private String accessToken = "";
    private String currentStation = "Lo-Fi";
    private String currentAlbumId = LOFI_ALBUM_ID;
    private int sourceGeneration = 0;

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
        try { clickSoft = createClickTrack(2150.0, 18); } catch (Throwable ignored) { clickSoft = null; }
        try { clickNav = createClickTrack(2850.0, 22); } catch (Throwable ignored) { clickNav = null; }

        accessToken = getSharedPreferences("burzh_auth", MODE_PRIVATE)
                .getString("yandex_oauth_token", "")
                .trim();

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
        webView.getSettings().setTextZoom(100);
        webView.getSettings().setUseWideViewPort(true);
        webView.getSettings().setLoadWithOverviewMode(true);
        webView.addJavascriptInterface(new Bridge(), "AndroidBridge");
        webView.setWebViewClient(new WebViewClient());
        setContentView(webView);

        webView.loadUrl("file:///android_asset/index.html");
        main.postDelayed(() -> {
            if (accessToken.isEmpty()) {
                emitAuthRequired("CONNECT YANDEX");
            } else {
                loadAlbum();
            }
        }, 500);
        main.post(progressTicker);
    }

    private AudioTrack createClickTrack(double frequency, int milliseconds) {
        final int sampleRate = 22050;
        int samples = Math.max(128, sampleRate * milliseconds / 1000);
        byte[] pcm = new byte[samples * 2];
        for (int i = 0; i < samples; i++) {
            double envelope = Math.exp(-6.0 * i / Math.max(1.0, samples - 1.0));
            double transientPart = (i < 10 ? (1.0 - i / 10.0) * 0.55 : 0.0);
            double tone = Math.sin(2.0 * Math.PI * frequency * i / sampleRate) * 0.36;
            short value = (short) (32767.0 * envelope * (tone + transientPart));
            pcm[i * 2] = (byte) (value & 0xff);
            pcm[i * 2 + 1] = (byte) ((value >> 8) & 0xff);
        }

        AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
        AudioFormat format = new AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(sampleRate)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .build();

        AudioTrack track = new AudioTrack.Builder()
                .setAudioAttributes(attrs)
                .setAudioFormat(format)
                .setTransferMode(AudioTrack.MODE_STATIC)
                .setBufferSizeInBytes(pcm.length)
                .build();
        track.write(pcm, 0, pcm.length);
        return track;
    }

    private void playClick(AudioTrack track) {
        if (track == null) return;
        try {
            track.pause();
            track.setPlaybackHeadPosition(0);
            track.play();
        } catch (Throwable ignored) {}
    }

    private void vibrateClick(String kind) {
        if (vibrator == null || !vibrator.hasVibrator()) return;
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                int effect = VibrationEffect.EFFECT_CLICK;
                if ("next".equals(kind) || "previous".equals(kind) || "station".equals(kind)) {
                    effect = VibrationEffect.EFFECT_TICK;
                } else if ("play".equals(kind)) {
                    effect = VibrationEffect.EFFECT_HEAVY_CLICK;
                }
                vibrator.vibrate(VibrationEffect.createPredefined(effect));
            } else {
                int ms = "play".equals(kind) ? 18 : 11;
                int amp = "play".equals(kind) ? 180 : 125;
                vibrator.vibrate(VibrationEffect.createOneShot(ms, amp));
            }
        } catch (Throwable ignored) {}
    }

    private void loadAlbum() {
        loadAlbum(false);
    }

    private void loadAlbum(boolean autoPlay) {
        if (accessToken.isEmpty()) {
            emitAuthRequired("CONNECT YANDEX");
            return;
        }

        final int generation = ++sourceGeneration;
        final String albumId = currentAlbumId;
        final String station = currentStation;

        emitSimple("status", "LOADING " + station.toUpperCase(Locale.US));

        executor.execute(() -> {
            try {
                JSONObject json = getJson(API + "/albums/" + albumId + "/with-tracks");
                JSONObject result = json.optJSONObject("result");
                if (result == null) result = json;

                JSONArray volumes = result.optJSONArray("volumes");
                if (volumes == null) throw new Exception("Album tracks unavailable");

                List<Track> loaded = new ArrayList<>();
                for (int disc = 0; disc < volumes.length(); disc++) {
                    JSONArray volume = volumes.optJSONArray(disc);
                    if (volume == null) continue;

                    for (int i = 0; i < volume.length(); i++) {
                        JSONObject t = volume.optJSONObject(i);
                        if (t == null) continue;

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

                        loaded.add(new Track(id, title, artist));
                    }
                }

                if (loaded.isEmpty()) throw new Exception("Album is empty");
                if (generation != sourceGeneration) return;

                synchronized (tracks) {
                    tracks.clear();
                    tracks.addAll(loaded);
                    currentIndex = 0;
                }

                JSONObject s = baseState();
                s.put("status", "READY");
                s.put("count", tracks.size());
                s.put("connected", true);
                s.put("switching", false);
                addCurrentTrack(s);
                emitState(s);

                if (autoPlay) {
                    main.postDelayed(() -> {
                        if (generation == sourceGeneration) playCurrent();
                    }, 110);
                }
            } catch (Exception e) {
                if (generation != sourceGeneration) return;
                JSONObject s = baseState();
                try {
                    s.put("status", "SOURCE ERROR");
                    s.put("error", e.getMessage());
                    s.put("connected", !accessToken.isEmpty());
                    s.put("switching", false);
                } catch (Exception ignored) {}
                emitState(s);
            }
        });
    }

    private void playCurrent() {
        Track track;
        synchronized (tracks) {
            if (tracks.isEmpty()) {
                if (accessToken.isEmpty()) emitAuthRequired("CONNECT YANDEX");
                else loadAlbum(true);
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
                try { mp.setVolume(0f, 0f); } catch (Exception ignored) {}
                mp.start();
                fadeVolume(mp, 0f, 1f, 360);
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

    private void fadeVolume(MediaPlayer mp, float from, float to, int durationMs) {
        final int steps = 12;
        final int stepMs = Math.max(12, durationMs / steps);

        for (int i = 0; i <= steps; i++) {
            final int step = i;
            main.postDelayed(() -> {
                try {
                    if (mp != player) return;
                    float t = step / (float) steps;
                    float value = from + (to - from) * t;
                    mp.setVolume(value, value);
                } catch (Exception ignored) {}
            }, (long) step * stepMs);
        }
    }

    private void fadeOutThen(Runnable done) {
        final MediaPlayer mp = player;
        if (mp == null || !prepared) {
            done.run();
            return;
        }

        final int steps = 8;
        final int stepMs = 24;

        for (int i = 0; i <= steps; i++) {
            final int step = i;
            main.postDelayed(() -> {
                try {
                    if (mp != player) return;
                    float value = 1f - (step / (float) steps);
                    mp.setVolume(value, value);
                } catch (Exception ignored) {}

                if (step == steps) done.run();
            }, (long) step * stepMs);
        }
    }

    private void switchStation(String key) {
        String station;
        String albumId;

        if ("lofi".equals(key)) {
            station = "Lo-Fi";
            albumId = LOFI_ALBUM_ID;
        } else if ("futureGarage".equals(key)) {
            station = "Future Garage";
            albumId = FUTURE_GARAGE_ALBUM_ID;
        } else {
            JSONObject s = baseState();
            try {
                s.put("status", "COMING SOON");
                s.put("unavailableStation", key);
            } catch (Exception ignored) {}
            emitState(s);
            return;
        }

        if (station.equals(currentStation) && albumId.equals(currentAlbumId)) {
            emitSimple("status", "READY");
            return;
        }

        final boolean resumePlayback = player != null && prepared && player.isPlaying();

        currentStation = station;
        currentAlbumId = albumId;
        currentIndex = 0;
        sourceGeneration++;

        JSONObject switchingState = baseState();
        try {
            switchingState.put("status", "SWITCHING");
            switchingState.put("switching", true);
            switchingState.put("title", station);
            switchingState.put("artist", "BURZH beats");
        } catch (Exception ignored) {}
        emitState(switchingState);

        fadeOutThen(() -> {
            releasePlayer();
            synchronized (tracks) {
                tracks.clear();
            }
            loadAlbum(resumePlayback);
        });
    }

    private String resolveStreamUrl(String trackId) throws Exception {
        if (accessToken.isEmpty()) throw new Exception("Yandex authorization required");

        JSONObject infoJson = getJson(API + "/tracks/" + trackId + "/download-info");
        JSONArray infos = infoJson.optJSONArray("result");
        if (infos == null || infos.length() == 0) throw new Exception("No audio variants");

        JSONObject best = null;
        int bestScore = Integer.MIN_VALUE;

        for (int i = 0; i < infos.length(); i++) {
            JSONObject x = infos.optJSONObject(i);
            if (x == null) continue;

            // Never use preview/shortened streams.
            if (x.optBoolean("preview", true)) continue;

            String codec = x.optString("codec", "");
            int bitrate = x.optInt("bitrateInKbps", 0);
            int score = bitrate;
            if ("mp3".equalsIgnoreCase(codec)) score += 10000;

            if (best == null || score > bestScore) {
                best = x;
                bestScore = score;
            }
        }

        if (best == null) throw new Exception("Full track is unavailable for this account");

        String xmlUrl = best.optString("downloadInfoUrl", "");
        if (xmlUrl.isEmpty()) xmlUrl = best.optString("download_info_url", "");
        if (xmlUrl.isEmpty()) throw new Exception("Missing full-track URL");

        HttpURLConnection c = open(xmlUrl);
        if (!accessToken.isEmpty()) c.setRequestProperty("Authorization", "OAuth " + accessToken);

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
        if (!accessToken.isEmpty()) {
            c.setRequestProperty("Authorization", "OAuth " + accessToken);
        }
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
            s.put("station", currentStation);
            s.put("albumId", currentAlbumId);
            s.put("index", currentIndex);
            synchronized (tracks) {
                s.put("count", tracks.size());
            }
            s.put("connected", !accessToken.isEmpty());
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

    private void emitAuthRequired(String message) {
        JSONObject s = baseState();
        try {
            s.put("status", message);
            s.put("authRequired", true);
            s.put("connected", false);
        } catch (Exception ignored) {}
        emitState(s);
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
        try { if (clickSoft != null) clickSoft.release(); } catch (Throwable ignored) {}
        try { if (clickNav != null) clickNav.release(); } catch (Throwable ignored) {}
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
        @JavascriptInterface public void reload() { loadAlbum(false); }

        @JavascriptInterface public void selectStation(String stationKey) {
            main.post(() -> switchStation(stationKey));
        }

        @JavascriptInterface public void saveYandexToken(String token) {
            if (token == null) return;
            String clean = token.trim();
            if (clean.startsWith("OAuth ")) clean = clean.substring(6).trim();
            if (clean.length() < 10) {
                emitAuthRequired("TOKEN REQUIRED");
                return;
            }

            accessToken = clean;
            getSharedPreferences("burzh_auth", MODE_PRIVATE)
                    .edit()
                    .putString("yandex_oauth_token", accessToken)
                    .apply();
            loadAlbum();
        }

        @JavascriptInterface public void clearYandexToken() {
            accessToken = "";
            synchronized (tracks) { tracks.clear(); }
            releasePlayer();
            getSharedPreferences("burzh_auth", MODE_PRIVATE)
                    .edit()
                    .remove("yandex_oauth_token")
                    .apply();
            emitAuthRequired("CONNECT YANDEX");
        }

        @JavascriptInterface public void feedback(String kind) {
            main.post(() -> {
                vibrateClick(kind);
                if ("next".equals(kind) || "previous".equals(kind) || "station".equals(kind)) {
                    playClick(clickNav);
                } else {
                    playClick(clickSoft);
                }
                if (webView != null) {
                    try {
                        webView.performHapticFeedback(
                                "play".equals(kind) ? HapticFeedbackConstants.VIRTUAL_KEY : HapticFeedbackConstants.KEYBOARD_TAP,
                                HapticFeedbackConstants.FLAG_IGNORE_GLOBAL_SETTING
                        );
                    } catch (Throwable ignored) {}
                }
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
