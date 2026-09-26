# BURZH beats web proxy

Small Vercel serverless proxy for the iPhone/PWA build.

Why it exists: Safari enforces browser CORS for direct calls to Yandex Music API, while the Android APK uses native networking and is not subject to that restriction.

The proxy:
- accepts only GET requests;
- only forwards HTTPS requests to Yandex-owned domains;
- does not store the OAuth token;
- returns CORS headers only to the BURZH beats GitHub Pages origin.

Deploy this directory as a separate Vercel project. The Android project is not affected.
