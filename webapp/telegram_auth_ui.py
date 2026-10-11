"""Shared browser authorization surface for the Telegram workbenches.

The video and tweet bridges intentionally keep their tickets and exchange
endpoints separate, but the user-facing authorization surface should feel like
one Vecto product.  This module owns only presentation and browser-side
preview rendering; authentication and ticket consumption remain in each
workbench module.
"""

from __future__ import annotations

import html
import json
from typing import Any

from .db import db


DEFAULT_ACCOUNT_AVATAR = "/assets/opc/account-avatar-mascot.png"
VECTO_LOGO = "/assets/opc/vecto-logo-ui-icon.png?v=20260711"
GOOGLE_LOGO = "/assets/opc/google-g-gradient.svg"


def account_avatar_url(account: dict[str, Any] | None) -> str:
    """Resolve the same avatar a signed-in Vecto user sees in the profile UI.

    Google picture metadata is kept in ``oauth_identities`` for older accounts
    whose ``users.avatar_url`` has not yet been backfilled.  The fallback is a
    local asset, so a missing or malformed remote URL never breaks the bridge.
    """

    data = account if isinstance(account, dict) else {}
    try:
        if bool(int(data.get("avatar_cleared") or 0)):
            return DEFAULT_ACCOUNT_AVATAR
    except (TypeError, ValueError):
        pass
    stored = str(data.get("avatar_url") or "").strip()
    if stored and stored != DEFAULT_ACCOUNT_AVATAR:
        return stored[:900000]
    try:
        user_id = int(data.get("id") or 0)
    except (TypeError, ValueError, OverflowError):
        user_id = 0
    if user_id > 0:
        try:
            with db() as conn:
                row = conn.execute(
                    "SELECT profile_json FROM oauth_identities WHERE user_id = ? AND provider = 'google' LIMIT 1",
                    (user_id,),
                ).fetchone()
            profile = json.loads(str(row["profile_json"] or "{}")) if row else {}
            picture = str(profile.get("picture") or "").strip()
            if picture.startswith("https://") and len(picture) <= 2048:
                return picture
        except Exception:
            pass
    return DEFAULT_ACCOUNT_AVATAR


_AUTH_BRIDGE_STYLE = r"""
:root {
  color-scheme: light;
  --bridge-ink: #173548;
  --bridge-muted: #607984;
  --bridge-teal: #2db99d;
  --bridge-mint: #c8f9e8;
  --bridge-coral: #ff9a78;
  --bridge-yellow: #f4c94e;
  --bridge-lilac: #a18cff;
  --bridge-line: rgba(75, 123, 132, .18);
}

* { box-sizing: border-box; }
html, body { min-height: 100%; }
body.telegram-auth-bridge {
  margin: 0;
  min-height: 100vh;
  overflow-x: hidden;
  color: var(--bridge-ink);
  font-family: ui-rounded, "SF Pro Rounded", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  background:
    radial-gradient(circle at 8% 18%, rgba(116, 237, 208, .36), transparent 28rem),
    radial-gradient(circle at 86% 8%, rgba(255, 215, 134, .34), transparent 26rem),
    radial-gradient(circle at 84% 88%, rgba(205, 188, 255, .29), transparent 30rem),
    linear-gradient(135deg, #f6fcfa 0%, #eef8f4 52%, #fff8f3 100%);
}

body.telegram-auth-bridge::before,
body.telegram-auth-bridge::after {
  position: fixed;
  z-index: 0;
  width: 34rem;
  height: 34rem;
  border-radius: 50%;
  content: "";
  pointer-events: none;
  filter: blur(5px);
  opacity: .42;
}

body.telegram-auth-bridge::before {
  top: 16%;
  left: -21rem;
  background: radial-gradient(circle, rgba(67, 211, 180, .24), transparent 68%);
  animation: tg-bridge-breathe 16s ease-in-out infinite alternate;
}

body.telegram-auth-bridge::after {
  right: -19rem;
  bottom: -15rem;
  background: radial-gradient(circle, rgba(248, 145, 122, .23), transparent 68%);
  animation: tg-bridge-breathe 19s ease-in-out -6s infinite alternate-reverse;
}

.tg-bridge-shell {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: minmax(0, 1.12fr) minmax(390px, 460px);
  gap: clamp(30px, 5.2vw, 86px);
  align-items: center;
  width: min(1240px, 100%);
  min-height: 100vh;
  margin: 0 auto;
  padding: clamp(36px, 7vw, 94px) clamp(20px, 5.5vw, 82px);
}

.tg-bridge-showcase {
  position: relative;
  min-width: 0;
  padding: 18px 4px;
}

.tg-bridge-showcase::after {
  position: absolute;
  top: 8%;
  left: 2%;
  z-index: -2;
  width: 78%;
  height: 70%;
  border-radius: 50%;
  background:
    radial-gradient(circle at 30% 32%, rgba(105, 233, 204, .22), transparent 40%),
    radial-gradient(circle at 72% 66%, rgba(255, 164, 133, .18), transparent 38%);
  content: "";
  filter: blur(22px);
  pointer-events: none;
}

.tg-bridge-grid {
  position: absolute;
  inset: 0 -8% 0 -8%;
  z-index: -1;
  background-image: radial-gradient(rgba(77, 154, 150, .2) 1px, transparent 1.2px);
  background-size: 23px 23px;
  mask-image: radial-gradient(ellipse at center, #000 0%, transparent 72%);
  opacity: .42;
  pointer-events: none;
}

.tg-bridge-brandline,
.tg-bridge-card-eyebrow {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #58817e;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: .14em;
  text-transform: uppercase;
}

.tg-bridge-logo {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  overflow: hidden;
  border-radius: 14px;
  background: #071112;
  box-shadow: 0 9px 18px rgba(68, 159, 151, .18);
}

.tg-bridge-logo img { width: 38px; height: 38px; object-fit: contain; }
.tg-bridge-live {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  padding: 7px 10px;
  color: #4d8176;
  border-radius: 999px;
  background: rgba(255, 255, 255, .58);
  box-shadow: 0 7px 16px rgba(83, 142, 134, .08);
  font-size: 9px;
  letter-spacing: .08em;
}

.tg-bridge-live i,
.tg-bridge-card-eyebrow i {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #42cfa6;
  box-shadow: 0 0 0 4px rgba(66, 207, 166, .13);
}

.tg-bridge-kicker {
  margin-top: clamp(27px, 4vw, 46px);
  color: #279f8e;
  font-size: 11px;
  font-weight: 900;
  letter-spacing: .15em;
}

.tg-bridge-showcase h1 {
  max-width: 660px;
  margin: 9px 0 0;
  color: #173548;
  font-size: clamp(34px, 4.4vw, 58px);
  line-height: 1.05;
  letter-spacing: -.055em;
}

.tg-bridge-showcase-copy {
  max-width: 610px;
  margin: 16px 0 0;
  color: #58717a;
  font-size: clamp(14px, 1.45vw, 17px);
  line-height: 1.75;
}

.tg-bridge-pills { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
.tg-bridge-pills span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 12px;
  color: #476b70;
  border-radius: 999px;
  background: rgba(255, 255, 255, .6);
  box-shadow: 0 9px 18px rgba(68, 119, 116, .08);
  font-size: 11px;
  font-weight: 800;
}

.tg-bridge-pills b { color: #28aa91; font-size: 14px; }

.tg-bridge-constellation {
  position: relative;
  height: 285px;
  margin: 24px 0 4px;
}

.tg-bridge-orbit {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 185px;
  height: 185px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255, 255, 255, .86), rgba(173, 244, 222, .18) 58%, transparent 72%);
  transform: translate(-50%, -50%);
  animation: tg-bridge-halo 8s ease-in-out infinite;
}

.tg-bridge-core,
.tg-bridge-node {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 9px;
  border-radius: 22px;
  background: rgba(255, 255, 255, .7);
  box-shadow: 0 14px 26px rgba(75, 126, 122, .1);
}

.tg-bridge-core {
  top: 50%;
  left: 50%;
  display: grid;
  place-items: center;
  width: 148px;
  height: 148px;
  padding: 16px;
  color: #286460;
  text-align: center;
  border-radius: 50%;
  box-shadow: 0 20px 36px rgba(65, 130, 121, .13), inset 0 0 0 9px rgba(224, 255, 244, .48);
  transform: translate(-50%, -50%);
  animation: tg-bridge-core 8s ease-in-out infinite;
}

.tg-bridge-core-mark {
  display: grid;
  place-items: center;
  width: 37px;
  height: 37px;
  overflow: hidden;
  color: #fff;
  border-radius: 14px;
  background: linear-gradient(145deg, #3fc8a8, #6c9dff);
  box-shadow: 0 8px 15px rgba(75, 157, 171, .2);
  font-size: 19px;
}

.tg-bridge-core strong { margin-top: 5px; font-size: 12px; letter-spacing: .12em; }
.tg-bridge-core small { color: #73918f; font-size: 10px; }
.tg-bridge-node { min-width: 150px; padding: 11px 14px 11px 10px; color: #31565e; animation: tg-bridge-float 7s ease-in-out infinite; }
.tg-bridge-node-a { top: 4%; left: 3%; animation-delay: -.8s; }
.tg-bridge-node-b { top: 9%; right: 3%; animation-delay: -2.2s; }
.tg-bridge-node-c { bottom: 2%; left: 10%; animation-delay: -3.6s; }
.tg-bridge-node-d { right: 9%; bottom: 0; animation-delay: -5s; }
.tg-bridge-node-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 13px; font-size: 17px; }
.tg-bridge-node-icon.mint { background: var(--bridge-mint); }
.tg-bridge-node-icon.coral { background: #ffe0d4; }
.tg-bridge-node-icon.yellow { background: #fff0b9; }
.tg-bridge-node-icon.lilac { background: #e8ddff; }
.tg-bridge-node b { display: block; color: #315660; font-size: 12px; }
.tg-bridge-node small { display: block; margin-top: 2px; color: #789093; font-size: 10px; }

.tg-bridge-showcase-foot { display: flex; justify-content: space-between; gap: 12px; color: #7a9996; font-size: 9px; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; }
.tg-bridge-showcase-foot i { display: inline-block; width: 6px; height: 6px; margin-right: 5px; border-radius: 50%; background: #42cfa6; }

.tg-bridge-card {
  position: relative;
  overflow: hidden;
  padding: clamp(24px, 3vw, 34px);
  border: 1px solid rgba(255, 255, 255, .82);
  border-radius: 28px;
  background: rgba(255, 255, 255, .78);
  box-shadow: 0 24px 60px rgba(43, 79, 87, .16), inset 0 1px 0 rgba(255, 255, 255, .9);
  backdrop-filter: blur(18px);
}

.tg-bridge-card::before {
  position: absolute;
  top: 0;
  right: 10%;
  left: 10%;
  height: 3px;
  border-radius: 99px;
  background: linear-gradient(90deg, #37c9ad, #83a5ff, #ff9c7c);
  content: "";
}

.tg-bridge-card-eyebrow { color: #4f8278; font-size: 9px; letter-spacing: .1em; }
.tg-bridge-card h2 { margin: 17px 0 8px; color: #173548; font-size: clamp(24px, 2.5vw, 31px); letter-spacing: -.035em; }
.tg-bridge-card-lead { margin: 0; color: var(--bridge-muted); font-size: 13px; line-height: 1.65; }

.tg-bridge-account {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 22px;
  padding: 14px;
  border: 1px solid rgba(89, 164, 157, .2);
  border-radius: 20px;
  background: linear-gradient(135deg, rgba(235, 255, 248, .86), rgba(247, 244, 255, .82));
}

.tg-bridge-account[hidden] { display: none; }
.tg-bridge-avatar-shell { position: relative; flex: 0 0 auto; }
.tg-bridge-avatar { display: block; width: 64px; height: 64px; border: 3px solid rgba(255, 255, 255, .94); border-radius: 50%; background: #d7f4ed; box-shadow: 0 8px 18px rgba(66, 139, 130, .18); object-fit: cover; }
.tg-bridge-avatar-status { position: absolute; right: 1px; bottom: 2px; width: 14px; height: 14px; border: 3px solid #f2fffb; border-radius: 50%; background: #35c99d; }
.tg-bridge-account-copy { min-width: 0; }
.tg-bridge-method { display: inline-flex; align-items: center; gap: 5px; color: #47736e; font-size: 10px; font-weight: 900; letter-spacing: .04em; }
.tg-bridge-method img { width: 16px; height: 16px; object-fit: contain; }
.tg-bridge-account-name { display: block; margin-top: 4px; overflow: hidden; color: #173548; font-size: 16px; font-weight: 900; text-overflow: ellipsis; white-space: nowrap; }
.tg-bridge-account-meta { display: block; margin-top: 3px; overflow: hidden; color: #70898e; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }

.tg-bridge-consent { margin-top: 18px; padding: 12px 14px; border-radius: 15px; color: #5b737a; background: rgba(240, 248, 248, .78); font-size: 12px; line-height: 1.6; }
.tg-bridge-consent strong { color: #2c615e; }
.tg-bridge-status { min-height: 2.2em; margin: 17px 0 0; color: #5d7780; font-size: 13px; line-height: 1.65; }
.tg-bridge-status.error { color: #b42318; font-weight: 800; }
.tg-bridge-status.success { color: #1b8e6d; font-weight: 800; }
.tg-bridge-actions { margin-top: 15px; }
.tg-bridge-authorize { display: inline-flex; align-items: center; justify-content: center; gap: 8px; width: 100%; min-height: 50px; border: 0; border-radius: 15px; color: #fff; background: #193c4f; box-shadow: 0 12px 20px rgba(25, 60, 79, .18); font: inherit; font-size: 14px; font-weight: 900; cursor: pointer; transition: transform .2s ease, box-shadow .2s ease, opacity .2s ease; }
.tg-bridge-authorize:hover { transform: translateY(-2px); box-shadow: 0 16px 24px rgba(25, 60, 79, .22); }
.tg-bridge-authorize:disabled { cursor: wait; opacity: .6; transform: none; }
.tg-bridge-note { margin: 11px 0 0; padding: 11px 13px; border-radius: 13px; color: #47736e; background: rgba(213, 255, 240, .7); font-size: 12px; line-height: 1.6; }
.tg-bridge-note.error { color: #8a3518; background: #fff1e9; }
.tg-bridge-security { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; color: #718d91; font-size: 10px; }
.tg-bridge-security span { display: inline-flex; align-items: center; gap: 4px; }
.tg-bridge-security b { color: #2db99d; font-size: 13px; }

@keyframes tg-bridge-breathe { from { transform: translate3d(-1%, -2%, 0) scale(.95); } to { transform: translate3d(5%, 4%, 0) scale(1.06); } }
@keyframes tg-bridge-halo { 0%, 100% { transform: translate(-50%, -50%) scale(.96); opacity: .72; } 50% { transform: translate(-50%, -50%) scale(1.07); opacity: 1; } }
@keyframes tg-bridge-core { 0%, 100% { transform: translate(-50%, -50%) rotate(-1deg); } 50% { transform: translate(-50%, -50%) rotate(1deg) scale(1.02); } }
@keyframes tg-bridge-float { 0%, 100% { transform: translate3d(0, 0, 0) rotate(-1deg); } 50% { transform: translate3d(7px, -8px, 0) rotate(1deg); } }

@media (max-width: 940px) {
  .tg-bridge-shell { grid-template-columns: minmax(0, 1fr) minmax(350px, 430px); gap: 28px; padding-right: 30px; padding-left: 30px; }
  .tg-bridge-node { min-width: 136px; }
}

@media (max-width: 760px) {
  .tg-bridge-shell { grid-template-columns: 1fr; gap: 10px; min-height: 100dvh; padding: 22px 14px 26px; align-content: center; }
  .tg-bridge-showcase { padding: 0 3px; }
  .tg-bridge-showcase h1 { font-size: clamp(30px, 9vw, 44px); }
  .tg-bridge-showcase-copy { margin-top: 10px; font-size: 12px; line-height: 1.55; }
  .tg-bridge-kicker { margin-top: 17px; font-size: 9px; }
  .tg-bridge-pills { margin-top: 12px; }
  .tg-bridge-pills span { padding: 6px 9px; font-size: 10px; }
  .tg-bridge-constellation { height: 108px; margin: 7px 0 0; }
  .tg-bridge-orbit { width: 108px; height: 108px; }
  .tg-bridge-core { width: 82px; height: 82px; padding: 8px; }
  .tg-bridge-core-mark { width: 24px; height: 24px; border-radius: 9px; font-size: 13px; }
  .tg-bridge-core strong { margin-top: 2px; font-size: 8px; }
  .tg-bridge-core small { font-size: 7px; }
  .tg-bridge-node { min-width: 0; padding: 7px 9px 7px 7px; border-radius: 15px; }
  .tg-bridge-node-a { top: 0; left: 0; }
  .tg-bridge-node-b { top: 0; right: 0; }
  .tg-bridge-node-c { bottom: 0; left: 7%; }
  .tg-bridge-node-d { right: 7%; bottom: 0; }
  .tg-bridge-node-icon { width: 26px; height: 26px; border-radius: 10px; font-size: 13px; }
  .tg-bridge-node b { font-size: 10px; }
  .tg-bridge-node small { font-size: 8px; }
  .tg-bridge-showcase-foot { font-size: 8px; }
  .tg-bridge-card { padding: 21px 17px; border-radius: 22px; }
  .tg-bridge-card h2 { margin-top: 12px; font-size: 24px; }
  .tg-bridge-card-lead { font-size: 12px; }
  .tg-bridge-account { margin-top: 15px; padding: 11px; }
  .tg-bridge-avatar { width: 55px; height: 55px; }
  .tg-bridge-account-name { font-size: 14px; }
  .tg-bridge-consent { margin-top: 12px; font-size: 11px; }
  .tg-bridge-security { margin-top: 13px; }
}

@media (prefers-reduced-motion: reduce) {
  body.telegram-auth-bridge::before, body.telegram-auth-bridge::after, .tg-bridge-orbit, .tg-bridge-core, .tg-bridge-node { animation: none; }
}
"""


def _json_string(value: Any) -> str:
    return json.dumps(str(value or ""), ensure_ascii=False)


def render_telegram_authorization_page(
    *,
    ticket: str,
    workbench_label: str,
    page_title: str,
    login_path: str,
    return_path: str,
    context_key: str,
    context_flag: str,
    exchange_path: str,
    fallback_target: str,
) -> str:
    """Return the shared rich authorization page for one workbench."""

    safe_title = html.escape(str(page_title or "Telegram 工作台授权"), quote=True)
    safe_label = html.escape(str(workbench_label or "工作台"), quote=True)
    template = r'''<!doctype html>
<html lang="zh-Hans">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <meta name="referrer" content="no-referrer">
  <meta name="telegram-workbench-context" content="__CONTEXT_FLAG__=1">
  <title>__PAGE_TITLE__</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>__AUTH_BRIDGE_STYLE__</style>
</head>
<body class="telegram-auth-bridge">
  <main class="tg-bridge-shell">
    <section class="tg-bridge-showcase" aria-label="Vecto 工作台介绍">
      <div class="tg-bridge-grid" aria-hidden="true"></div>
      <div class="tg-bridge-brandline">
        <span class="tg-bridge-logo"><img src="__VECTO_LOGO__" alt="Vecto" width="1024" height="1024"></span>
        <span>VECTO / WORKSPACE SIGNAL</span>
        <span class="tg-bridge-live"><i aria-hidden="true"></i> LIVE SYSTEM</span>
      </div>
      <div class="tg-bridge-kicker">TELEGRAM / __WORKBENCH_LABEL__</div>
      <h1>确认你的<br>__WORKBENCH_LABEL__账号</h1>
      <p class="tg-bridge-showcase-copy">在安全的 Vecto 网页中确认当前登录身份，再把这个账号授权给 Telegram。登录方式、头像和账号信息都会清楚展示。</p>
      <div class="tg-bridge-pills" aria-label="授权特点">
        <span><b aria-hidden="true">✦</b> 账号可识别</span>
        <span><b aria-hidden="true">↗</b> 一键授权</span>
        <span><b aria-hidden="true">◌</b> 安全隔离</span>
      </div>
      <div class="tg-bridge-constellation" aria-hidden="true">
        <div class="tg-bridge-orbit"></div>
        <div class="tg-bridge-core"><span class="tg-bridge-core-mark">✦</span><strong>WORKSPACE</strong><small>灵感 · 人设 · 发布</small></div>
        <div class="tg-bridge-node tg-bridge-node-a"><span class="tg-bridge-node-icon mint">👤</span><span><b>识别账号</b><small>看清登录身份</small></span></div>
        <div class="tg-bridge-node tg-bridge-node-b"><span class="tg-bridge-node-icon coral">🔐</span><span><b>确认授权</b><small>一步完成绑定</small></span></div>
        <div class="tg-bridge-node tg-bridge-node-c"><span class="tg-bridge-node-icon yellow">🚀</span><span><b>进入工作台</b><small>马上开始创作</small></span></div>
        <div class="tg-bridge-node tg-bridge-node-d"><span class="tg-bridge-node-icon lilac">✨</span><span><b>状态同步</b><small>Bot 即时反馈</small></span></div>
      </div>
      <div class="tg-bridge-showcase-foot"><span><i aria-hidden="true"></i> Vecto workspace</span><span>IDENTIFY · AUTHORIZE · CREATE</span></div>
    </section>

    <section class="tg-bridge-card" aria-labelledby="bridgeTitle">
      <div class="tg-bridge-card-eyebrow"><i aria-hidden="true"></i> 安全授权 · __WORKBENCH_LABEL__</div>
      <h2 id="bridgeTitle">Telegram __WORKBENCH_LABEL__授权</h2>
      <p class="tg-bridge-card-lead">先确认网页中登录的是谁，再授权给当前 Telegram。已经绑定的账号不会重复授权。</p>
      <div class="tg-bridge-account" id="accountCard" hidden>
        <div class="tg-bridge-avatar-shell"><img class="tg-bridge-avatar" id="accountAvatar" src="__DEFAULT_AVATAR__" alt="当前账号头像"><span class="tg-bridge-avatar-status" aria-hidden="true"></span></div>
        <div class="tg-bridge-account-copy">
          <span class="tg-bridge-method"><img id="accountProviderLogo" src="__VECTO_LOGO__" alt=""><span id="accountProviderLabel">VECTO 网页账号</span></span>
          <strong class="tg-bridge-account-name" id="accountName">当前 VECTO 账号</strong>
          <small class="tg-bridge-account-meta" id="accountMeta">正在读取账号信息…</small>
        </div>
      </div>
      <div class="tg-bridge-consent"><strong>授权范围：</strong>仅将当前登录的 Vecto 账号绑定到这次 Telegram 会话，不会读取或保存 Telegram 之外的浏览器密码。</div>
      <p class="tg-bridge-status" id="status" role="status" aria-live="polite">正在验证 Telegram 身份和网页登录状态，请稍候…</p>
      <div class="tg-bridge-actions" id="actions"></div>
      <noscript><div class="tg-bridge-note error">确认授权并打开__WORKBENCH_LABEL__需要启用浏览器脚本。</div></noscript>
      <div class="tg-bridge-security" aria-label="安全提示"><span><b>✓</b> 一次性链接</span><span><b>✓</b> 登录方式可见</span><span><b>✓</b> 头像由账号提供</span></div>
    </section>
  </main>
  <script>
  (async () => {
    const ticket = __TICKET_JSON__;
    const workbenchLabel = __WORKBENCH_JSON__;
    const returnPath = __RETURN_PATH_JSON__;
    const loginPath = __LOGIN_PATH_JSON__;
    const contextKey = __CONTEXT_KEY_JSON__;
    const contextFlag = __CONTEXT_FLAG_JSON__;
    const exchangePath = __EXCHANGE_PATH_JSON__;
    const fallbackTarget = __FALLBACK_TARGET_JSON__;
    const status = document.getElementById("status");
    const actions = document.getElementById("actions");
    const accountCard = document.getElementById("accountCard");
    const accountAvatar = document.getElementById("accountAvatar");
    const accountProviderLogo = document.getElementById("accountProviderLogo");
    const accountProviderLabel = document.getElementById("accountProviderLabel");
    const accountName = document.getElementById("accountName");
    const accountMeta = document.getElementById("accountMeta");
    const defaultAvatar = __DEFAULT_AVATAR_JSON__;
    const loginReturn = returnPath + "?ticket=" + encodeURIComponent(ticket);
    const requestedProvider = new URLSearchParams(window.location.search).get("provider") === "google" ? "google" : "";
    const loginPage = loginPath + "?return_url=" + encodeURIComponent(loginReturn) + "&" + contextFlag + "=1" + (requestedProvider ? "&auth_provider=" + requestedProvider : "");
    const webApp = window.Telegram?.WebApp;
    const initData = webApp?.initData || "";
    const browser = !initData;
    if (!browser) webApp.ready();

    function setStatus(message, kind = "") {
      status.textContent = String(message || "");
      status.className = "tg-bridge-status" + (kind ? " " + kind : "");
    }

    function safeAvatarUrl(value) {
      const raw = String(value || "").trim();
      if (!raw || raw.length > 900000) return defaultAvatar;
      if (raw.toLowerCase().startsWith("data:image/")) return raw;
      try {
        const parsed = new URL(raw, window.location.origin);
        if (parsed.origin === window.location.origin || parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.href;
      } catch (_) {}
      return defaultAvatar;
    }

    function renderAccount(payload) {
      const account = payload?.web_user || {};
      const google = String(payload?.auth_method || "").toLowerCase() === "google";
      const provider = google ? "Google 官方授权" : "VECTO 网页账号";
      const name = String(account.full_name || account.display_name || account.username || "当前 VECTO 账号").trim();
      const email = String(account.email || "").trim();
      const username = String(account.username || "").trim();
      const identity = email || (username ? "@" + username.replace(/^@+/, "") : (account.id ? "账号 ID " + account.id : "已登录账号"));
      accountCard.hidden = false;
      accountAvatar.src = safeAvatarUrl(account.avatar_url);
      accountAvatar.alt = name + "的账号头像";
      accountAvatar.onerror = () => { accountAvatar.onerror = null; accountAvatar.src = defaultAvatar; };
      accountProviderLogo.src = google ? "__GOOGLE_LOGO__" : "__VECTO_LOGO__";
      accountProviderLogo.alt = google ? "Google" : "Vecto";
      accountProviderLabel.textContent = provider;
      accountName.textContent = name;
      accountMeta.textContent = identity + (google ? " · 通过 Google 官方授权" : " · 通过 VECTO 网页账号登录");
      return provider;
    }

    function showAuthorizationPrompt(payload, authorize) {
      const provider = renderAccount(payload);
      setStatus("已识别 " + provider + " 登录状态，请确认将此账号授权给当前 Telegram " + workbenchLabel + "。", "success");
      actions.replaceChildren();
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tg-bridge-authorize";
      button.innerHTML = "<span aria-hidden=\"true\">✓</span><span>确认授权并打开" + workbenchLabel + "</span>";
      button.addEventListener("click", () => { button.disabled = true; authorize(true); });
      actions.append(button);
    }

    function showAlreadyAuthorized(payload) {
      const provider = renderAccount(payload);
      setStatus("已识别当前 " + provider + " 账号，Telegram 已完成绑定，正在打开" + workbenchLabel + "…", "success");
      actions.replaceChildren();
      const note = document.createElement("div");
      note.className = "tg-bridge-note";
      note.textContent = "当前账号无需重复授权，正在同步已绑定状态。";
      actions.append(note);
      window.setTimeout(() => exchange(true), 520);
    }

    function showFailure(message, expired = false) {
      setStatus(message || ("Telegram " + workbenchLabel + "授权失败，请重试。"), "error");
      actions.replaceChildren();
      const hint = document.createElement("div");
      hint.className = "tg-bridge-note error";
      hint.textContent = expired
        ? "授权链接已失效，请返回 Telegram Bot，重新点击「账号管理」获取新的授权链接。"
        : "请返回 Telegram Bot 重试；如问题持续，请联系管理员。";
      actions.append(hint);
    }

    async function exchange(confirm) {
      try {
        setStatus(confirm ? "正在确认授权，请稍候…" : "正在检查网页登录状态…");
        const response = await fetch(exchangePath, {
          method: "POST", credentials: "same-origin",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({ticket, init_data: initData, browser, preview: !confirm}),
        });
        const payload = await response.json().catch(() => ({}));
        const detail = payload?.detail;
        if (response.status === 401 && detail?.code === "web_login_required") {
          try {
            sessionStorage.setItem(contextKey, JSON.stringify({ticket, initData, browser, provider: requestedProvider, expiresAt: Date.now() + 150000}));
          } catch (_) {
            throw new Error("当前浏览器不支持安全登录续接，请重新打开授权入口");
          }
          window.location.replace(loginPage);
          return;
        }
        if (!response.ok) {
          showFailure(String(detail?.message || detail || ("Telegram " + workbenchLabel + "授权失败，请重试。")), response.status === 410);
          return;
        }
        if (!confirm && payload.already_authorized) {
          showAlreadyAuthorized(payload);
          return;
        }
        if (!confirm && payload.authorization_required) {
          showAuthorizationPrompt(payload, exchange);
          return;
        }
        try { sessionStorage.removeItem(contextKey); } catch (_) {}
        setStatus("授权成功，正在打开" + workbenchLabel + "…", "success");
        window.location.replace(payload.target || fallbackTarget);
      } catch (error) {
        showFailure(error?.message || String(error));
      }
    }

    exchange(false);
  })();
  </script>
</body>
</html>'''
    replacements = {
        "__PAGE_TITLE__": safe_title,
        "__AUTH_BRIDGE_STYLE__": _AUTH_BRIDGE_STYLE,
        "__WORKBENCH_LABEL__": safe_label,
        "__WORKBENCH_JSON__": _json_string(workbench_label),
        "__TICKET_JSON__": _json_string(ticket),
        "__RETURN_PATH_JSON__": _json_string(return_path),
        "__LOGIN_PATH_JSON__": _json_string(login_path),
        "__CONTEXT_KEY_JSON__": _json_string(context_key),
        "__CONTEXT_FLAG_JSON__": _json_string(context_flag),
        "__CONTEXT_FLAG__": html.escape(str(context_flag or "telegram_workbench"), quote=True),
        "__EXCHANGE_PATH_JSON__": _json_string(exchange_path),
        "__FALLBACK_TARGET_JSON__": _json_string(fallback_target),
        "__VECTO_LOGO__": VECTO_LOGO,
        "__GOOGLE_LOGO__": GOOGLE_LOGO,
        "__DEFAULT_AVATAR__": DEFAULT_ACCOUNT_AVATAR,
        "__DEFAULT_AVATAR_JSON__": _json_string(DEFAULT_ACCOUNT_AVATAR),
    }
    for key, value in replacements.items():
        template = template.replace(key, value)
    return template


def render_telegram_authorization_error_page(
    message: str,
    *,
    page_title: str,
    workbench_label: str,
    status_code: int = 410,
) -> str:
    """Return a branded, actionable page for expired or invalid tickets."""

    safe_message = html.escape(str(message or "授权入口已失效。"), quote=True)
    safe_title = html.escape(str(page_title or "Telegram 工作台授权"), quote=True)
    safe_label = html.escape(str(workbench_label or "工作台"), quote=True)
    return f'''<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer">
<title>{safe_title}</title><style>{_AUTH_BRIDGE_STYLE}
.tg-bridge-error {{ max-width: 560px; margin: auto; padding: 26px; }}
.tg-bridge-error .tg-bridge-card {{ margin-top: 22px; }}
.tg-bridge-error-icon {{ display: grid; place-items: center; width: 58px; height: 58px; border-radius: 20px; color: #8a3518; background: #fff0e8; font-size: 27px; }}
</style></head><body class="telegram-auth-bridge"><main class="tg-bridge-error">
<div class="tg-bridge-brandline"><span class="tg-bridge-logo"><img src="{VECTO_LOGO}" alt="Vecto" width="1024" height="1024"></span><span>VECTO / WORKSPACE SIGNAL</span></div>
<section class="tg-bridge-card"><div class="tg-bridge-error-icon" aria-hidden="true">!</div><h2>{safe_label}授权入口已失效</h2><p class="tg-bridge-status error">{safe_message}</p><div class="tg-bridge-note error">请返回 Telegram Bot，重新点击「账号管理」获取新的授权链接。旧链接不会再次使用。</div></section>
</main></body></html>'''


__all__ = [
    "account_avatar_url",
    "render_telegram_authorization_page",
    "render_telegram_authorization_error_page",
]
