import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "映刻 YINGKE · AI 视频创作工作台",
  description: "从一个镜头开始。管理素材、选取片段，构建你的 AI 视频创作流程。",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
