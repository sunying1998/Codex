# 技术说明

## 当前结构

Next.js / React / TypeScript 提供中文网页及同源 HTTP API。Node.js 内置 SQLite 保存状态，独立 TypeScript Worker 调用 FFmpeg / ffprobe。数据库和媒体统一保存在可配置持久化目录中，不依赖开发进程内存。

```text
浏览器 → 同源 API → SQLite（账号 / 项目 / 素材 / 任务）
             ↓                     ↑
         私有文件目录 ← 独立 Worker → FFmpeg / ffprobe
```

代码入口：`src/components/` 是界面；`src/app/api/[...path]/route.ts` 是 API；`src/lib/db.ts` 封装数据和存储路径；`src/lib/worker.ts` 负责持久化任务；`src/lib/ai.ts` 定义未来模型适配契约。

## 数据模型

- `users`：唯一所有者，scrypt 密码哈希。
- `sessions`：随机会话的 SHA-256 摘要和到期时间，不保存原始 token。
- `projects`：所有者、标题、入点、出点和乐观并发版本。
- `assets`：所属项目、类型、文件键、解析状态、尺寸、时长、缩略图。
- `jobs`：不可变输入快照、状态、进度、取消标记、尝试次数、导出结果、起止时间、幂等请求键。
- `worker_lock`：单 Worker 租约，防止重复领取和错误恢复其他活跃进程的任务。

启用外键、WAL、busy timeout 与短事务。原素材与导出分别存储，导出使用提交时保存的片段输入快照，不随之后的编辑而变化。

## API

写请求必须带同源 `Origin`；浏览器正常操作自动附带。后续外部 API / MCP 应建立独立的受限 token 认证入口，不能简单绕过当前来源检查。

| 路径                                              | 方法                 | 用途                                   |
| ------------------------------------------------- | -------------------- | -------------------------------------- |
| `/api/auth/status`                                | GET                  | 初始化与登录状态                       |
| `/api/auth/setup`                                 | POST                 | 首次建号，后续拒绝注册                 |
| `/api/auth/login`、`logout`                       | POST                 | 建立 / 撤销会话                        |
| `/api/overview`                                   | GET                  | 素材与任务用量                         |
| `/api/capabilities`                               | GET                  | 当前真实能力状态                       |
| `/api/projects`                                   | GET / POST           | 列表 / 创建                            |
| `/api/projects/:id`                               | GET / PATCH / DELETE | 详情 / 带版本保存 / 删除               |
| `/api/projects/:id/assets?kind=source或reference` | POST                 | 单文件 multipart，字段 `file`          |
| `/api/projects/:id/export`                        | POST                 | 导出保存的范围，要求 `Idempotency-Key` |
| `/api/assets/:id`                                 | GET / HEAD           | 所有者可访问的素材，支持单 Range       |
| `/api/assets/:id`                                 | DELETE               | 删除参考照片                           |
| `/api/assets/:id/thumbnail`                       | GET / HEAD           | 私有缩略图                             |
| `/api/jobs`、`/api/jobs/:id`                      | GET                  | 任务列表 / 详情                        |
| `/api/jobs/:id/cancel`                            | POST                 | 取消排队或运行任务                     |
| `/api/jobs/:id/download`                          | GET / HEAD           | 下载成功的 MP4 导出                    |

## 任务生命周期

`queued → running → succeeded / failed / cancelled`。领取使用立即事务；同一所有者的相同幂等键返回同一个导出任务。队列保存在数据库，Worker 每次只处理一个任务，FFmpeg 使用有限线程。

运行中取消会终止子进程，清理临时输出。正常关机会把工作重新排队；异常退出后，租约过期可重新启动 Worker，恢复残留的 running 任务。反复异常中断达到 3 次时标记失败，避免无限恢复。输出先写临时文件，完成后原子重命名，再提交成功状态。

失败的原视频可重新上传。失败或取消的导出可在工作台重新导出**当前保存的片段**，新结果有独立任务和版本。

## 文件与访问边界

文件流式写入私有目录，限制单文件类型、大小和请求体总量。解析时检验真实容器、尺寸、时长，限制 FFmpeg 的输入协议和容器白名单。子进程使用参数数组，不拼接 shell 命令。原始文件名仅作显示，物理文件使用随机 ID。

素材、项目、任务及结果读取均检查所有者；媒体响应禁止共享缓存、禁止 MIME 嗅探并支持浏览器字节范围请求。服务端处理写请求来源，认证尝试限流，前端避免用 HTML 渲染文件名和项目标题。

首次初始化不具备预先身份信息，应先在受信网络完成。公开部署前要完善认证生命周期与运维措施；单所有者试用版不代表公众平台已经完成。

## 扩展路径

迁移时保持稳定的项目、素材与任务 ID，数据层改为 PostgreSQL，文件键映射到 S3 兼容对象存储，任务状态持久化配合分布式队列。多 Worker 需要新的租约 / 并发设计，不能直接增加当前 Worker 数量。模型 SDK 留在服务端，接口层校验输入、额度和目标项目后排队。
