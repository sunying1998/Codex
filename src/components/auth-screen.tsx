"use client";
import { useState } from "react";
import {
  ArrowRight,
  Aperture,
  Eye,
  EyeOff,
  LockKeyhole,
  Film,
  ShieldCheck,
} from "lucide-react";
import { api, message } from "@/lib/client";
import type { User } from "@/lib/types";
export default function AuthScreen({
  initialized,
  onLogin,
}: {
  initialized: boolean;
  onLogin: (user: User) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (!initialized && password !== confirm) {
      setError("两次输入的密码不一致。");
      return;
    }
    setBusy(true);
    try {
      const data = await api<{ user: User }>(
        `/api/auth/${initialized ? "login" : "setup"}`,
        { method: "POST", body: JSON.stringify({ username, password }) },
      );
      onLogin(data.user);
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-layout">
      <section className="auth-art">
        <a className="brand" href="/">
          <span className="brand-mark">
            <Aperture size={25} />
          </span>
          <span>
            映刻<span className="brand-en">YINGKE</span>
          </span>
        </a>
        <div className="auth-statement">
          <span className="eyebrow">
            <span className="tiny-dot" /> YOUR NEXT FRAME
          </span>
          <h1>
            让想象，
            <br />
            进入画面<span className="accent">。</span>
          </h1>
          <p>
            每一个镜头，都有新的可能。
            <br />
            你的私人 AI 视频创作空间。
          </p>
        </div>
        <div className="auth-frame">
          <div className="frame-corner tl" />
          <div className="frame-corner tr" />
          <div className="frame-corner bl" />
          <div className="frame-corner br" />
          <div className="frame-orbit orbit-one" />
          <div className="frame-orbit orbit-two" />
          <div className="frame-center">
            <Film size={38} strokeWidth={1} />
            <span>CREATE WHAT’S NEXT</span>
          </div>
          <span className="frame-label">YINGKE STUDIO — 001</span>
          <span className="frame-record">
            <i /> PRIVATE BETA
          </span>
        </div>
        <div className="auth-art-bottom">
          <span>为每一次创作，留下空间。</span>
          <span>EST. 2026</span>
        </div>
      </section>
      <section className="auth-form-area">
        <div className="auth-form-wrap">
          <div className="auth-lock">
            <LockKeyhole size={24} />
          </div>
          <span className="pill">个人内测版</span>
          <h2>{initialized ? "欢迎回到映刻" : "开启你的创作空间"}</h2>
          <p className="muted">
            {initialized
              ? "登录工作室，继续你的下一帧。"
              : "创建唯一的工作室账号，素材与项目仅你可见。"}
          </p>
          <form onSubmit={submit} className="auth-form">
            <label>
              工作室账号
              <input
                aria-label="工作室账号"
                aria-describedby="username-help"
                name="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                placeholder="输入账号名称"
                pattern="[a-zA-Z0-9_@.\-]+"
                minLength={3}
                maxLength={60}
                required
              />
              <small id="username-help">3–60 位英文字母、数字或 _ @ . -</small>
            </label>
            <label>
              密码
              <div className="password-field">
                <input
                  name="password"
                  type={show ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={
                    initialized ? "current-password" : "new-password"
                  }
                  placeholder="至少 12 位字符"
                  minLength={12}
                  maxLength={128}
                  required
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={show ? "隐藏密码" : "显示密码"}
                  onClick={() => setShow(!show)}
                >
                  {show ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </label>
            {!initialized && (
              <label>
                确认密码
                <input
                  name="confirm"
                  type={show ? "text" : "password"}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  placeholder="再次输入密码"
                  minLength={12}
                  maxLength={128}
                  required
                />
              </label>
            )}
            {error && (
              <div className="inline-error" role="alert">
                {error}
              </div>
            )}
            <button className="button primary auth-submit" disabled={busy}>
              {busy ? <span className="spinner" /> : null}
              {initialized ? "进入工作室" : "创建工作室"}
              <ArrowRight size={17} />
            </button>
          </form>
          <p className="auth-note">
            <ShieldCheck size={15} />
            {initialized
              ? "私人工作室 · 暂未开放公众注册"
              : "请妥善保存密码。当前版本暂不提供邮件找回。"}
          </p>
        </div>
        <p className="auth-footer">
          映刻 YINGKE <span>·</span> 给创作更多可能
        </p>
      </section>
    </div>
  );
}
