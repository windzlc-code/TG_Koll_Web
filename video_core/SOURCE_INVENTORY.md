# Digital-human source inventory

Source archive SHA-256: `8E2EE46D2239F2D90099397F63656C5395CD2F78CE2EAFA54CF3575E6AE5A27D`

The `source/` package is a white-list extraction of the original generation implementation:

- RunningHub submission, polling, upload and workflow helpers
- digital-human video and TTS node mappings
- commerce-video generation and FFmpeg processing
- model/product replacement
- image-model integration
- media probing, frame extraction and voice preset support

Fixed application assets live in `webapp/static/assets/voice_presets/` and the
`subtitle-template-*.svg` files. They are part of the application, not user or
generated data.

Explicitly excluded: Telegram/aiogram code, legacy FastAPI pages and styling,
legacy authentication/account management, databases, uploads, generated media,
caches, desktop launchers, TikTok download tools, systemd/nginx files and runtime
secrets.
