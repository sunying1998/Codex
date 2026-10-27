"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Aperture,
  LayoutGrid,
  FolderOpen,
  ListVideo,
  Settings2,
  Plus,
  ArrowUpRight,
  ArrowRight,
  Film,
  Upload,
  Search,
  X,
  Clock3,
  AlertCircle,
  LogOut,
  ChevronRight,
  HardDrive,
  Sparkles,
  CheckCircle2,
  ShieldCheck,
  Menu,
  Video,
  Download,
  Square,
  Trash2,
  ImagePlus,
  LoaderCircle,
} from "lucide-react";
import AuthScreen from "./auth-screen";
import Workbench from "./workbench";
import { api, bytes, formatTime, message, uploadFile } from "@/lib/client";
import type {
  User,
  Project,
  ProjectDetail,
  ProjectSummary,
  Job,
} from "@/lib/types";

type Overview = {
  worker_online: boolean;
  usage: { source_bytes: number; assets: number };
  tasks: {
    total: number;
    exports: number | null;
    active: number | null;
    processing_ms: number;
  };
};
export const statusLabels: Record<Job["status"], string> = {
  queued: "排队中",
  running: "处理中",
  succeeded: "已完成",
  failed: "未完成",
  cancelled: "已取消",
};
export default function Studio() {
  const router = useRouter(),
    params = useSearchParams();
  const view = params.get("view") || "home",
    projectId = params.get("project");
  const [user, setUser] = useState<User | null>(null),
    [initialized, setInitialized] = useState(false),
    [booting, setBooting] = useState(true);
  const [projects, setProjects] = useState<ProjectSummary[]>([]),
    [jobs, setJobs] = useState<Job[]>([]),
    [overview, setOverview] = useState<Overview | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null),
    [detailError, setDetailError] = useState("");
  const [search, setSearch] = useState(""),
    [modal, setModal] = useState(false),
    [title, setTitle] = useState(""),
    [creating, setCreating] = useState(false),
    [modalError, setModalError] = useState("");
  const [uploading, setUploading] = useState<number | null>(null),
    [toast, setToast] = useState<{ text: string; error: boolean } | null>(null),
    [mobileNav, setMobileNav] = useState(false),
    [dragging, setDragging] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null),
    [deleting, setDeleting] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null),
    toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function notify(text: string, error = false) {
    setToast({ text, error });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5500);
  }
  async function load() {
    const [p, j, o] = await Promise.all([
      api<{ projects: ProjectSummary[] }>("/api/projects"),
      api<{ jobs: Job[] }>("/api/jobs"),
      api<Overview>("/api/overview"),
    ]);
    setProjects(p.projects);
    setJobs(j.jobs);
    setOverview(o);
  }
  async function reloadDetail() {
    if (projectId)
      setDetail(await api<ProjectDetail>(`/api/projects/${projectId}`));
  }
  useEffect(() => {
    let alive = true;
    api<{ initialized: boolean; user: User | null }>("/api/auth/status")
      .then((data) => {
        if (alive) {
          setInitialized(data.initialized);
          setUser(data.user);
        }
      })
      .catch((error) => {
        if (alive) notify(message(error), true);
      })
      .finally(() => {
        if (alive) setBooting(false);
      });
    return () => {
      alive = false;
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);
  useEffect(() => {
    const expired = () => {
      setUser(null);
      setInitialized(true);
      notify("登录已过期，请重新登录。", true);
    };
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, []);
  useEffect(() => {
    if (!user) return;
    let alive = true;
    const refresh = async () => {
      try {
        if (alive && document.visibilityState === "visible") await load();
      } catch (error) {
        if (alive) notify(message(error), true);
      }
    };
    void refresh();
    const interval = setInterval(refresh, 5000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [user]);
  useEffect(() => {
    setDetail(null);
    setDetailError("");
    if (!projectId || !user) return;
    let alive = true;
    const refresh = async () => {
      try {
        const data = await api<ProjectDetail>(`/api/projects/${projectId}`);
        if (alive) {
          setDetail(data);
          setDetailError("");
        }
      } catch (error) {
        if (alive) setDetailError(message(error));
      }
    };
    void refresh();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 2000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [projectId, user]);
  function navigate(next: string) {
    if (
      !window.dispatchEvent(new Event("yingke:navigate", { cancelable: true }))
    )
      return;
    router.push(next);
    setMobileNav(false);
    setSearch("");
  }
  async function create(event?: React.FormEvent) {
    event?.preventDefault();
    setCreating(true);
    setModalError("");
    try {
      const data = await api<{ project: Project }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ title: title.trim() || "未命名项目" }),
      });
      setModal(false);
      setTitle("");
      await load();
      navigate(`/?project=${data.project.id}`);
    } catch (error) {
      setModalError(message(error));
    } finally {
      setCreating(false);
    }
  }
  async function importVideo(file?: File) {
    if (!file || uploading !== null) return;
    if (!/\.(mp4|mov|webm|mkv)$/i.test(file.name)) {
      notify("请选择 MP4、MOV、WebM 或 MKV 视频。", true);
      return;
    }
    if (file.size > 512 * 1024 ** 2) {
      notify("视频大小不能超过 512 MB。", true);
      return;
    }
    setUploading(0);
    let created: string | undefined;
    try {
      const data = await api<{ project: Project }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          title: file.name.replace(/\.[^.]+$/, "").slice(0, 80) || "新视频项目",
        }),
      });
      created = data.project.id;
      await uploadFile(created, file, "source", setUploading);
      await load();
      navigate(`/?project=${created}`);
      notify("素材上传成功，正在解析视频。");
    } catch (error) {
      notify(message(error), true);
      if (created) {
        void load();
        navigate(`/?project=${created}`);
      }
    } finally {
      setUploading(null);
      if (uploadInput.current) uploadInput.current.value = "";
    }
  }
  async function cancel(job: Job) {
    try {
      await api(`/api/jobs/${job.id}/cancel`, { method: "POST" });
      await load();
      if (projectId) await reloadDetail();
      notify("已提交取消请求。");
    } catch (error) {
      notify(message(error), true);
    }
  }
  async function remove() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api(`/api/projects/${deleteTarget.id}`, { method: "DELETE" });
      setDeleteTarget(null);
      await load();
      notify("项目与素材已删除。");
    } catch (error) {
      notify(message(error), true);
    } finally {
      setDeleting(false);
    }
  }
  const filtered = projects.filter((p) =>
    p.title.toLowerCase().includes(search.toLowerCase()),
  );
  if (booting)
    return (
      <div className="boot-screen">
        <Aperture className="spin" size={30} />
        <span>正在打开映刻…</span>
      </div>
    );
  if (!user)
    return (
      <>
        <AuthScreen
          initialized={initialized}
          onLogin={(value) => {
            setUser(value);
            setInitialized(true);
          }}
        />
        {toast && <Toast toast={toast} close={() => setToast(null)} />}
      </>
    );
  return (
    <div className={`app-shell ${projectId ? "editor-shell" : ""}`}>
      {mobileNav && (
        <button
          className="nav-backdrop"
          aria-label="关闭导航"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
        <a
          href="/"
          className="brand"
          onClick={(event) => {
            event.preventDefault();
            navigate("/");
          }}
        >
          <span className="brand-mark">
            <Aperture size={25} />
          </span>
          <span>
            映刻<span className="brand-en">YINGKE</span>
          </span>
        </a>
        <div className="workspace-switch">
          <span className="workspace-avatar">Y</span>
          <div>
            个人工作空间<small>Private workspace</small>
          </div>
          <ShieldCheck size={15} />
        </div>
        <div className="nav-label">
          工作台 <span>WORKSPACE</span>
        </div>
        <nav>
          {[
            { id: "home", label: "创作概览", icon: LayoutGrid },
            { id: "projects", label: "我的项目", icon: FolderOpen },
            { id: "tasks", label: "任务中心", icon: ListVideo },
            { id: "settings", label: "工作室设置", icon: Settings2 },
          ].map((item) => (
            <button
              key={item.id}
              className={`nav-item ${!projectId && view === item.id ? "active" : ""}`}
              onClick={() =>
                navigate(item.id === "home" ? "/" : `/?view=${item.id}`)
              }
            >
              <item.icon size={18} />
              {item.label}
              {item.id === "tasks" && !!overview?.tasks.active && (
                <span className="nav-count">{overview.tasks.active}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="note-symbol">
            <Sparkles size={18} />
          </span>
          <strong>每一帧，皆有可能</strong>
          <p>
            先从素材开始，
            <br />
            慢慢实现你的创作想象。
          </p>
          <span className="beta-label">
            PERSONAL BETA <span>0.1</span>
          </span>
        </div>
        <div className="sidebar-bottom">
          <div className="storage-label">
            <span>
              <HardDrive size={13} />
              素材存储
            </span>
            <span>{bytes(overview?.usage.source_bytes || 0)}</span>
          </div>
          <div className="storage-track">
            <i
              style={{
                width: `${Math.min(100, ((overview?.usage.source_bytes || 0) / (10 * 1024 ** 3)) * 100)}%`,
              }}
            />
          </div>
          <small>源素材用量 · 10 GB 内测额度</small>
          <div className="user-row">
            <span className="user-avatar">
              {user.username[0].toUpperCase()}
            </span>
            <div>
              <strong>{user.username}</strong>
              <small>工作室所有者</small>
            </div>
            <button
              className="icon-button"
              title="退出登录"
              aria-label="退出登录"
              onClick={async () => {
                try {
                  await api("/api/auth/logout", { method: "POST" });
                  setUser(null);
                  setInitialized(true);
                } catch (error) {
                  notify(message(error), true);
                }
              }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={20} />
            </button>
            <span>工作空间</span>
            <ChevronRight size={13} />
            <strong>
              {projectId
                ? "创作工作台"
                : {
                    home: "概览",
                    projects: "我的项目",
                    tasks: "任务中心",
                    settings: "设置",
                  }[view] || "概览"}
            </strong>
          </div>
          <div className="topbar-right">
            <span className="private-indicator">
              <span className="tiny-dot" />
              私人内测
            </span>
            <span className="topbar-divider" />
            <span className="topbar-wordmark">MADE FOR YOUR VISION</span>
          </div>
        </header>
        {overview && !overview.worker_online && (
          <div className="service-warning" role="status">
            <AlertCircle size={14} />
            <span>
              视频处理服务暂不可用。已提交的任务会保留，服务恢复后继续处理。
            </span>
          </div>
        )}
        {projectId ? (
          <main className="editor-main">
            {detail ? (
              <Workbench
                key={projectId}
                detail={detail}
                onUpdate={async () => {
                  await reloadDetail();
                  await load();
                }}
                notify={notify}
                onBack={() => navigate("/?view=projects")}
                onCancel={cancel}
              />
            ) : detailError ? (
              <div className="empty-state">
                <AlertCircle size={32} />
                <h2>{detailError}</h2>
                <button
                  className="button"
                  onClick={() => navigate("/?view=projects")}
                >
                  返回项目
                </button>
              </div>
            ) : (
              <div className="boot-screen inline">
                <span className="spinner" />
                正在加载项目…
              </div>
            )}
          </main>
        ) : (
          <main className="content">
            {view === "tasks" ? (
              <>
                <PageTitle
                  eyebrow="RENDER QUEUE"
                  title="任务中心"
                  description="从上传解析到片段导出，每一步都有迹可循。"
                />
                <div className="stats-row compact">
                  <Stat
                    label="全部任务"
                    value={String(overview?.tasks.total || 0)}
                    icon={<ListVideo size={18} />}
                  />
                  <Stat
                    label="正在处理"
                    value={String(overview?.tasks.active || 0)}
                    icon={<LoaderCircle size={18} />}
                  />
                  <Stat
                    label="成功导出"
                    value={String(overview?.tasks.exports || 0)}
                    icon={<CheckCircle2 size={18} />}
                  />
                </div>
                <JobList
                  jobs={jobs}
                  projects={projects}
                  onOpen={(id) => navigate(`/?project=${id}`)}
                  onCancel={cancel}
                />
              </>
            ) : view === "settings" ? (
              <Settings user={user} overview={overview} />
            ) : (
              <>
                <PageTitle
                  eyebrow={
                    view === "projects"
                      ? "YOUR CREATIVE LIBRARY"
                      : "YOUR CREATIVE SPACE"
                  }
                  title={
                    view === "projects" ? "我的项目" : "让想象，进入画面。"
                  }
                  description={
                    view === "projects"
                      ? "每一份素材，每一个版本，都在这里。"
                      : "从一个镜头开始，探索视频创作的更多可能。"
                  }
                  action={
                    <button
                      className="button primary"
                      onClick={() => {
                        setModal(true);
                        setModalError("");
                      }}
                    >
                      <Plus size={17} />
                      新建项目
                    </button>
                  }
                />
                {view !== "projects" && (
                  <div className="hero-grid">
                    <section
                      className={`creation-hero ${dragging ? "dragging" : ""}`}
                      onDragOver={(event) => {
                        event.preventDefault();
                        setDragging(true);
                      }}
                      onDragLeave={() => setDragging(false)}
                      onDrop={(event) => {
                        event.preventDefault();
                        setDragging(false);
                        void importVideo(event.dataTransfer.files[0]);
                      }}
                    >
                      <div className="hero-grid-lines" />
                      <div className="hero-visual">
                        <div className="visual-frame back" />
                        <div className="visual-frame front">
                          <Film size={36} strokeWidth={1.2} />
                          <span>YOUR NEXT FRAME</span>
                        </div>
                        <div className="visual-spark spark-a">+</div>
                        <div className="visual-spark spark-b">+</div>
                        <div className="visual-line" />
                      </div>
                      <span className="eyebrow">
                        <span className="tiny-dot" /> START SOMETHING NEW
                      </span>
                      <h2>
                        好作品，
                        <br />
                        从你的素材开始。
                      </h2>
                      <p>
                        导入视频，选取心动的一帧。
                        <br />
                        在专属工作台里，开始新的创作。
                      </p>
                      <button
                        className="button light"
                        disabled={uploading !== null}
                        onClick={() => uploadInput.current?.click()}
                      >
                        {uploading !== null ? (
                          <span className="spinner" />
                        ) : (
                          <Upload size={16} />
                        )}{" "}
                        {uploading !== null
                          ? `上传中 ${uploading}%`
                          : "导入视频"}
                        <ArrowUpRight size={16} />
                      </button>
                      <small className="hero-hint">
                        也可以拖放到这里 · MP4 / MOV / WebM / MKV
                      </small>
                    </section>
                    <section className="workflow-card">
                      <div className="section-heading">
                        <h3>你的创作路径</h3>
                        <span className="micro-label">WORKFLOW</span>
                      </div>
                      <div className="workflow-steps">
                        <WorkflowStep
                          num="01"
                          title="导入素材"
                          description="上传视频与人物参考照片"
                          active
                        />
                        <WorkflowStep
                          num="02"
                          title="选取片段"
                          description="预览画面，确定起止时间"
                        />
                        <WorkflowStep
                          num="03"
                          title="导出作品"
                          description="保留原素材，保存新的版本"
                        />
                      </div>
                      <div className="workflow-footer">
                        <Sparkles size={15} />
                        <span>人物替换能力正在准备中</span>
                        <span className="subtle-dot" />
                      </div>
                    </section>
                  </div>
                )}
                {view !== "projects" && (
                  <div className="stats-row">
                    <Stat
                      label="创作项目"
                      value={String(projects.length).padStart(2, "0")}
                      icon={<FolderOpen size={18} />}
                    />
                    <Stat
                      label="素材文件"
                      value={String(overview?.usage.assets || 0).padStart(
                        2,
                        "0",
                      )}
                      icon={<Film size={18} />}
                    />
                    <Stat
                      label="成功导出"
                      value={String(overview?.tasks.exports || 0).padStart(
                        2,
                        "0",
                      )}
                      icon={<CheckCircle2 size={18} />}
                    />
                    <Stat
                      label="处理任务"
                      value={String(overview?.tasks.active || 0).padStart(
                        2,
                        "0",
                      )}
                      icon={<Clock3 size={18} />}
                      suffix="进行中"
                    />
                  </div>
                )}
                <section className="project-section">
                  <div className="project-section-header">
                    <div className="section-heading">
                      <h2>{view === "projects" ? "全部项目" : "最近项目"}</h2>
                      <span className="count-label">{projects.length}</span>
                    </div>
                    <div className="project-controls">
                      <label className="search-field">
                        <Search size={15} />
                        <input
                          aria-label="搜索项目"
                          placeholder="搜索项目…"
                          value={search}
                          onChange={(event) => setSearch(event.target.value)}
                        />
                        {search && (
                          <button
                            className="icon-button"
                            aria-label="清除搜索"
                            onClick={() => setSearch("")}
                          >
                            <X size={13} />
                          </button>
                        )}
                      </label>
                      {view !== "projects" && (
                        <button
                          className="text-button"
                          onClick={() => navigate("/?view=projects")}
                        >
                          全部项目
                          <ArrowRight size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                  {filtered.length ? (
                    <div className="project-grid">
                      {(view === "projects"
                        ? filtered
                        : filtered.slice(0, 6)
                      ).map((project) => (
                        <article className="project-card" key={project.id}>
                          <button
                            className="project-preview"
                            onClick={() => navigate(`/?project=${project.id}`)}
                            aria-label={`打开项目 ${project.title}`}
                          >
                            {project.thumbnail_id ? (
                              <img
                                src={`/api/assets/${project.thumbnail_id}/thumbnail`}
                                alt={project.title}
                              />
                            ) : (
                              <div className="project-placeholder">
                                <Film size={30} strokeWidth={1} />
                                <span>
                                  {project.source_status === "pending"
                                    ? "素材解析中"
                                    : "等待你的第一份素材"}
                                </span>
                              </div>
                            )}
                            <span className="preview-open">
                              <ArrowUpRight size={20} />
                            </span>
                            {project.duration != null && (
                              <span className="duration-badge">
                                {formatTime(project.duration)}
                              </span>
                            )}
                            {!!project.active_jobs && (
                              <span className="processing-badge">
                                <LoaderCircle size={12} className="spin" />
                                处理中
                              </span>
                            )}
                          </button>
                          <div className="project-info">
                            <button
                              onClick={() =>
                                navigate(`/?project=${project.id}`)
                              }
                              className="project-name"
                            >
                              {project.title}
                            </button>
                            <button
                              className="icon-button delete-project"
                              aria-label={`删除项目 ${project.title}`}
                              title="删除项目"
                              onClick={() => setDeleteTarget(project)}
                            >
                              <Trash2 size={15} />
                            </button>
                            <p>
                              {project.asset_count} 份素材<span>·</span>
                              {new Date(project.updated_at).toLocaleDateString(
                                "zh-CN",
                                { month: "short", day: "numeric" },
                              )}
                              更新
                            </p>
                          </div>
                        </article>
                      ))}
                      <button
                        className="add-project-card"
                        onClick={() => {
                          setModal(true);
                          setModalError("");
                        }}
                      >
                        <span>
                          <Plus size={22} />
                        </span>
                        开始新的创作<small>NEW PROJECT</small>
                      </button>
                    </div>
                  ) : (
                    <div className="projects-empty">
                      <div className="empty-icon">
                        <FolderOpen size={25} strokeWidth={1.3} />
                      </div>
                      <h3>
                        {search
                          ? "没有找到相关项目"
                          : "你的第一部作品，即将开始"}
                      </h3>
                      <p>
                        {search
                          ? "换个关键词试试。"
                          : "创建项目或直接导入视频，让灵感有一个落点。"}
                      </p>
                      {!search && (
                        <button
                          className="text-button accent-text"
                          onClick={() => {
                            setModal(true);
                            setModalError("");
                          }}
                        >
                          创建第一个项目
                          <ArrowRight size={15} />
                        </button>
                      )}
                    </div>
                  )}
                </section>
                <footer className="page-footer">
                  <span>
                    <Aperture size={13} /> 映刻 YINGKE
                  </span>
                  <span>每一个镜头，都值得被认真对待。</span>
                  <span>个人内测 · v0.1</span>
                </footer>
              </>
            )}
          </main>
        )}
      </div>
      <input
        ref={uploadInput}
        type="file"
        className="sr-only"
        aria-label="导入视频文件"
        accept=".mp4,.mov,.webm,.mkv"
        onChange={(event) => void importVideo(event.target.files?.[0])}
      />
      {uploading !== null && (
        <div className="upload-floating">
          <Upload size={17} />
          <div>
            <strong>正在上传视频 · {uploading}%</strong>
            <span>上传完成后会自动进入工作台，请保持页面打开。</span>
            <div className="progress-track">
              <i style={{ width: `${uploading}%` }} />
            </div>
          </div>
        </div>
      )}
      {modal && (
        <Modal
          title="开始新的创作"
          subtitle="给项目一个名字，稍后可以继续修改。"
          onClose={() => {
            if (!creating) setModal(false);
          }}
        >
          <form onSubmit={create}>
            <label className="field-label">
              项目名称
              <input
                autoFocus
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="例如：我的第一支 MV"
                maxLength={80}
              />
            </label>
            {modalError && (
              <p className="inline-error" role="alert">
                {modalError}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="button"
                disabled={creating}
                onClick={() => setModal(false)}
              >
                取消
              </button>
              <button className="button primary" disabled={creating}>
                {creating ? <span className="spinner" /> : <Plus size={16} />}
                创建项目
              </button>
            </div>
          </form>
        </Modal>
      )}
      {deleteTarget && (
        <Modal
          title="删除这个项目？"
          subtitle={`「${deleteTarget.title}」的原素材、参考照片和导出结果将一并删除。此操作无法撤销。`}
          onClose={() => {
            if (!deleting) setDeleteTarget(null);
          }}
        >
          <div className="modal-actions">
            <button
              className="button"
              disabled={deleting}
              onClick={() => setDeleteTarget(null)}
            >
              保留项目
            </button>
            <button
              className="button danger"
              disabled={deleting}
              onClick={() => void remove()}
            >
              {deleting ? <span className="spinner" /> : <Trash2 size={16} />}
              确认删除
            </button>
          </div>
        </Modal>
      )}
      {toast && <Toast toast={toast} close={() => setToast(null)} />}
    </div>
  );
}
function PageTitle({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
function Stat({
  label,
  value,
  icon,
  suffix,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  suffix?: string;
}) {
  return (
    <div className="stat-card">
      <span className="stat-icon">{icon}</span>
      <div>
        <span className="stat-label">{label}</span>
        <strong>
          {value}
          <small>{suffix}</small>
        </strong>
      </div>
    </div>
  );
}
function WorkflowStep({
  num,
  title,
  description,
  active,
}: {
  num: string;
  title: string;
  description: string;
  active?: boolean;
}) {
  return (
    <div className={`workflow-step ${active ? "active" : ""}`}>
      <span className="step-number">{num}</span>
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
    </div>
  );
}
export function JobList({
  jobs,
  projects,
  onOpen,
  onCancel,
}: {
  jobs: Job[];
  projects: { id: string; title: string }[];
  onOpen: (id: string) => void;
  onCancel: (job: Job) => void;
}) {
  if (!jobs.length)
    return (
      <div className="panel empty-state">
        <span className="empty-icon">
          <ListVideo size={27} />
        </span>
        <h3>还没有处理任务</h3>
        <p>上传素材或导出片段后，可以在这里查看进度。</p>
      </div>
    );
  return (
    <div className="jobs-panel">
      <div className="jobs-table-head">
        <span>任务 / 项目</span>
        <span>状态</span>
        <span>创建时间</span>
        <span>操作</span>
      </div>
      {jobs.map((job) => (
        <div className="job-row" key={job.id}>
          <div className="job-identity">
            <span className={`job-icon ${job.kind}`}>
              {job.kind === "export" ? (
                <Download size={18} />
              ) : (
                <Video size={18} />
              )}
            </span>
            <div>
              <strong>
                {job.kind === "export" ? "片段导出" : "素材解析"}
                <span className="job-id">#{job.id.slice(0, 6)}</span>
              </strong>
              <button
                className="text-button"
                onClick={() => onOpen(job.project_id)}
              >
                {projects.find((p) => p.id === job.project_id)?.title ||
                  "打开项目"}
                <ArrowUpRight size={11} />
              </button>
              {job.error && <p className="job-error">{job.error}</p>}
            </div>
          </div>
          <div className="job-status">
            <span className={`status ${job.status}`}>
              <span />
              {job.cancel_requested && job.status === "running"
                ? "正在取消"
                : statusLabels[job.status]}
            </span>
            {["queued", "running"].includes(job.status) && (
              <div className="progress-track">
                <i style={{ width: `${job.progress}%` }} />
              </div>
            )}
          </div>
          <time>
            {new Date(job.created_at).toLocaleString("zh-CN", {
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
          <div className="job-actions">
            {["queued", "running"].includes(job.status) ? (
              <button
                className="icon-button"
                title="取消任务"
                aria-label="取消任务"
                disabled={!!job.cancel_requested}
                onClick={() => onCancel(job)}
              >
                <Square size={15} />
              </button>
            ) : job.kind === "export" && job.status === "succeeded" ? (
              <a
                className="icon-button"
                href={`/api/jobs/${job.id}/download`}
                title="下载片段"
                aria-label="下载片段"
              >
                <Download size={17} />
              </a>
            ) : (
              <button
                className="icon-button"
                title="打开项目"
                aria-label="打开项目"
                onClick={() => onOpen(job.project_id)}
              >
                <ArrowUpRight size={17} />
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
function Settings({
  user,
  overview,
}: {
  user: User;
  overview: Overview | null;
}) {
  return (
    <>
      <PageTitle
        eyebrow="STUDIO PREFERENCES"
        title="工作室设置"
        description="了解你的工作空间与当前可用能力。"
      />
      <div className="settings-grid">
        <section className="panel settings-panel">
          <h3>
            <ShieldCheck size={18} />
            私人工作空间
          </h3>
          <div className="setting-row">
            <span>工作室账号</span>
            <strong>{user.username}</strong>
          </div>
          <div className="setting-row">
            <span>访问方式</span>
            <span className="status succeeded">
              <span />
              仅所有者登录
            </span>
          </div>
          <div className="setting-row">
            <span>注册状态</span>
            <strong>公众注册未开放</strong>
          </div>
          <p className="setting-note">
            当前为个人内测版。请妥善保管密码，暂未接入邮件找回。
          </p>
        </section>
        <section className="panel settings-panel">
          <h3>
            <HardDrive size={18} />
            素材与处理用量
          </h3>
          <div className="setting-row">
            <span>源素材大小</span>
            <strong>{bytes(overview?.usage.source_bytes || 0)}</strong>
          </div>
          <div className="setting-row">
            <span>素材文件</span>
            <strong>{overview?.usage.assets || 0} 份</strong>
          </div>
          <div className="setting-row">
            <span>累计任务处理时间</span>
            <strong>
              {((overview?.tasks.processing_ms || 0) / 1000).toFixed(1)} 秒
            </strong>
          </div>
          <p className="setting-note">
            素材统计不含缩略图与导出文件；实际磁盘占用会更大。当前版本未启用计费。
          </p>
        </section>
        <section className="panel settings-panel wide">
          <h3>
            <Sparkles size={18} />
            创作能力
          </h3>
          <div className="capability-list">
            <div>
              <span className="capability-icon">
                <Film size={19} />
              </span>
              <div>
                <strong>基础视频工作台</strong>
                <p>上传、预览、片段选择、持久化保存、H.264 / AAC 导出</p>
              </div>
              <span className="pill green">已开放</span>
            </div>
            <div>
              <span className="capability-icon">
                <ImagePlus size={19} />
              </span>
              <div>
                <strong>人物参考素材</strong>
                <p>每个项目最多 8 张 JPG / PNG，保存用于后续模型接入</p>
              </div>
              <span className="pill green">已开放</span>
            </div>
            <div>
              <span className="capability-icon">
                <Sparkles size={19} />
              </span>
              <div>
                <strong>AI 人物替换</strong>
                <p>已预留服务端模型接口，接入真实模型并验证效果后开放</p>
              </div>
              <span className="pill">未接入</span>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
      if (event.key === "Tab") {
        const controls = ref.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]),input:not([disabled]),a[href]",
        );
        if (!controls?.length) return;
        const first = controls[0],
          last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    const prior = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (!ref.current?.querySelector("input"))
      ref.current?.querySelector("button")?.focus();
    return () => {
      document.removeEventListener("keydown", handler);
      document.body.style.overflow = prior;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className="modal"
      >
        <button
          className="icon-button modal-close"
          aria-label="关闭弹窗"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <span className="modal-icon">
          <FolderOpen size={23} />
        </span>
        <h2 id="modal-title">{title}</h2>
        <p>{subtitle}</p>
        {children}
      </div>
    </div>
  );
}
function Toast({
  toast,
  close,
}: {
  toast: { text: string; error: boolean };
  close: () => void;
}) {
  return (
    <div
      className={`toast ${toast.error ? "error" : ""}`}
      role={toast.error ? "alert" : "status"}
    >
      {toast.error ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
      <span>{toast.text}</span>
      <button className="icon-button" aria-label="关闭提示" onClick={close}>
        <X size={15} />
      </button>
    </div>
  );
}
