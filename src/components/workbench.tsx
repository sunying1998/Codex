"use client";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  Download,
  Film,
  ImagePlus,
  LoaderCircle,
  Play,
  Save,
  Scissors,
  ShieldCheck,
  Sparkles,
  Square,
  Upload,
  Video,
  X,
  AlertCircle,
} from "lucide-react";
import { api, bytes, formatTime, message, uploadFile } from "@/lib/client";
import type { Project, ProjectDetail, Job } from "@/lib/types";

const labels: Record<Job["status"], string> = {
  queued: "排队中",
  running: "处理中",
  succeeded: "已完成",
  failed: "未完成",
  cancelled: "已取消",
};
export default function Workbench({
  detail,
  onUpdate,
  notify,
  onBack,
  onCancel,
}: {
  detail: ProjectDetail;
  onUpdate: () => Promise<void>;
  notify: (text: string, error?: boolean) => void;
  onBack: () => void;
  onCancel: (job: Job) => Promise<void>;
}) {
  const [draft, setDraft] = useState(detail.project),
    [dirty, setDirty] = useState(false),
    [saving, setSaving] = useState(false),
    [exporting, setExporting] = useState(false);
  const [tab, setTab] = useState<"source" | "references">("source"),
    [position, setPosition] = useState(0),
    [upload, setUpload] = useState<{ kind: string; progress: number } | null>(
      null,
    );
  const [previewError, setPreviewError] = useState(false);
  const dirtyRef = useRef(false),
    video = useRef<HTMLVideoElement>(null),
    sourceInput = useRef<HTMLInputElement>(null),
    referenceInput = useRef<HTMLInputElement>(null);
  const source = detail.assets.find(
    (a) => a.kind === "source" && a.status !== "failed",
  );
  const failedSources = detail.assets.filter(
    (a) => a.kind === "source" && a.status === "failed",
  );
  const references = detail.assets.filter((a) => a.kind === "reference");
  const exports = detail.jobs.filter((j) => j.kind === "export");
  const duration = source?.duration || 0;
  const canEdit = source?.status === "ready";
  useEffect(() => {
    if (!dirtyRef.current)
      setDraft((current) =>
        detail.project.version >= current.version ? detail.project : current,
      );
  }, [detail.project]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const navigate = (event: Event) => {
      if (
        dirtyRef.current &&
        !window.confirm("项目有未保存的修改，确定离开吗？")
      )
        event.preventDefault();
    };
    window.addEventListener("beforeunload", unload);
    window.addEventListener("yingke:navigate", navigate);
    return () => {
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener("yingke:navigate", navigate);
    };
  }, []);
  function change(values: Partial<Project>) {
    setDraft((current) => ({ ...current, ...values }));
    setDirty(true);
    dirtyRef.current = true;
  }
  async function save() {
    if (!dirtyRef.current) return;
    setSaving(true);
    try {
      const result = await api<{ project: Project }>(
        `/api/projects/${draft.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            title: draft.title,
            trim_start: draft.trim_start,
            trim_end: draft.trim_end,
            version: draft.version,
          }),
        },
      );
      setDraft(result.project);
      setDirty(false);
      dirtyRef.current = false;
      await onUpdate();
    } finally {
      setSaving(false);
    }
  }
  async function exportVideo() {
    setExporting(true);
    try {
      await save();
      await api(`/api/projects/${draft.id}/export`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      await onUpdate();
      notify("导出任务已加入队列，完成后可在下方下载。");
    } catch (error) {
      notify(message(error), true);
    } finally {
      setExporting(false);
    }
  }
  async function handleUpload(
    file: File | undefined,
    kind: "source" | "reference",
  ) {
    if (!file || upload) return;
    const max = (kind === "source" ? 512 : 15) * 1024 ** 2;
    if (file.size > max) {
      notify(`文件不能超过 ${kind === "source" ? 512 : 15} MB。`, true);
      return;
    }
    setUpload({ kind, progress: 0 });
    try {
      await uploadFile(draft.id, file, kind, (progress) =>
        setUpload({ kind, progress }),
      );
      await onUpdate();
      notify("上传成功，正在解析素材。");
    } catch (error) {
      notify(message(error), true);
    } finally {
      setUpload(null);
      if (sourceInput.current) sourceInput.current.value = "";
      if (referenceInput.current) referenceInput.current.value = "";
    }
  }
  async function deleteReference(id: string) {
    if (!window.confirm("删除这张参考照片？")) return;
    try {
      await api(`/api/assets/${id}`, { method: "DELETE" });
      await onUpdate();
      notify("参考照片已删除。");
    } catch (error) {
      notify(message(error), true);
    }
  }
  function seek(time: number) {
    if (video.current) {
      video.current.currentTime = time;
      setPosition(time);
    }
  }
  const valid =
    canEdit &&
    draft.trim_end > draft.trim_start &&
    draft.trim_end - draft.trim_start >= 0.1 &&
    draft.trim_end <= duration + 0.05 &&
    draft.trim_start >= 0 &&
    draft.title.trim().length > 0;
  return (
    <>
      <div className="editor-toolbar">
        <div className="editor-title">
          <button
            className="icon-button"
            onClick={onBack}
            aria-label="返回项目"
          >
            <ArrowLeft size={19} />
          </button>
          <span className="editor-title-divider" />
          <input
            aria-label="项目名称"
            value={draft.title}
            disabled={saving}
            onChange={(event) => change({ title: event.target.value })}
            maxLength={80}
          />
          <span className={`save-status ${dirty ? "unsaved" : ""}`}>
            {dirty ? (
              <>
                <span className="tiny-dot" />
                未保存
              </>
            ) : (
              <>
                <Check size={12} />
                已保存
              </>
            )}
          </span>
        </div>
        <div className="editor-actions">
          <button
            className="button small"
            disabled={!dirty || saving || !draft.title.trim()}
            onClick={() =>
              void save()
                .then(() => notify("项目已保存。"))
                .catch((error) => notify(message(error), true))
            }
          >
            {saving ? <span className="spinner" /> : <Save size={15} />}保存项目
          </button>
          <button
            className="button primary small"
            disabled={!valid || exporting || saving}
            onClick={() => void exportVideo()}
          >
            {exporting ? <span className="spinner" /> : <Download size={15} />}
            导出片段
          </button>
        </div>
      </div>
      <div className="editor-grid">
        <aside className="media-panel">
          <div className="media-panel-heading">
            <span>项目素材</span>
            <span className="count-label">
              {detail.assets.filter((a) => a.status !== "failed").length}
            </span>
          </div>
          <div className="media-tabs">
            <button
              className={tab === "source" ? "active" : ""}
              onClick={() => setTab("source")}
            >
              <Film size={14} />
              源视频
            </button>
            <button
              className={tab === "references" ? "active" : ""}
              onClick={() => setTab("references")}
            >
              <ImagePlus size={14} />
              参考照片
            </button>
          </div>
          <div className="media-panel-body">
            {tab === "source" ? (
              <>
                {source ? (
                  <div className="source-card">
                    <div className="source-thumb">
                      {source.thumbnail ? (
                        <img
                          src={`/api/assets/${source.id}/thumbnail`}
                          alt={source.name}
                        />
                      ) : (
                        <LoaderCircle className="spin" size={25} />
                      )}
                      <span>
                        {source.status === "ready"
                          ? formatTime(duration)
                          : "解析中"}
                      </span>
                    </div>
                    <strong>{source.name}</strong>
                    <p>
                      {bytes(source.bytes)}
                      {source.width
                        ? ` · ${source.width} × ${source.height}`
                        : " · 等待处理"}
                    </p>
                    <span
                      className={`status ${source.status === "ready" ? "succeeded" : "running"}`}
                    >
                      <span />
                      {source.status === "ready"
                        ? "源素材已就绪"
                        : "正在解析素材"}
                    </span>
                  </div>
                ) : (
                  <button
                    className="media-upload"
                    disabled={!!upload}
                    onClick={() => sourceInput.current?.click()}
                  >
                    <Upload size={23} />
                    <strong>上传源视频</strong>
                    <span>
                      MP4 / MOV / WebM / MKV
                      <br />
                      最大 512 MB · 最长 10 分钟
                    </span>
                  </button>
                )}
                {failedSources.map((asset) => (
                  <div key={asset.id} className="asset-failure">
                    <AlertCircle size={15} />
                    <div>
                      <strong>{asset.name}</strong>
                      <p>{asset.error}</p>
                    </div>
                  </div>
                ))}
                <div className="media-tip">
                  <ShieldCheck size={15} />
                  <p>原始素材独立保存。片段导出会生成新的文件。</p>
                </div>
              </>
            ) : (
              <>
                <div className="reference-hint">
                  添加人物多角度参考照片，用于后续人物替换。当前版本仅保存素材。
                </div>
                <div className="reference-grid">
                  {references.map((asset) => (
                    <div className="reference-card" key={asset.id}>
                      {asset.status === "ready" ? (
                        <img
                          src={`/api/assets/${asset.id}/thumbnail`}
                          alt={asset.name}
                        />
                      ) : (
                        <span>
                          {asset.status === "failed" ? (
                            <AlertCircle size={22} />
                          ) : (
                            <LoaderCircle size={22} className="spin" />
                          )}
                        </span>
                      )}
                      <strong title={asset.name}>{asset.name}</strong>
                      {asset.status === "failed" && (
                        <p title={asset.error || ""}>解析失败</p>
                      )}
                      <button
                        className="reference-delete icon-button"
                        aria-label={`删除参考照片 ${asset.name}`}
                        title="删除参考照片"
                        disabled={asset.status === "pending"}
                        onClick={() => void deleteReference(asset.id)}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                  {references.filter((a) => a.status !== "failed").length <
                    8 && (
                    <button
                      className="reference-add"
                      disabled={!!upload}
                      onClick={() => referenceInput.current?.click()}
                    >
                      <ImagePlus size={22} />
                      <span>添加照片</span>
                    </button>
                  )}
                </div>
                {references
                  .filter((asset) => asset.status === "failed")
                  .map((asset) => (
                    <div
                      className="asset-failure"
                      key={`error-${asset.id}`}
                      role="alert"
                    >
                      <AlertCircle size={15} />
                      <div>
                        <strong>{asset.name}</strong>
                        <p>
                          {asset.error ||
                            "图片解析失败，请重新上传有效的 JPG 或 PNG 图片。"}
                        </p>
                      </div>
                    </div>
                  ))}
                <small className="reference-limit">
                  JPG / PNG · 每张最大 15 MB · 最多 8 张
                </small>
              </>
            )}
            {upload && (
              <div className="media-upload-progress">
                <span>
                  上传{upload.kind === "source" ? "视频" : "照片"}{" "}
                  {upload.progress}%
                </span>
                <div className="progress-track">
                  <i style={{ width: `${upload.progress}%` }} />
                </div>
              </div>
            )}
          </div>
          <div className="media-panel-footer">
            <span className="tiny-dot" />
            素材仅工作室所有者可访问
          </div>
        </aside>
        <section className="preview-panel">
          <div className="preview-heading">
            <span>
              <Video size={14} />
              画面预览
            </span>
            <span>
              {canEdit ? `${source.width} × ${source.height}` : "等待素材"}
            </span>
          </div>
          <div className="video-stage">
            {canEdit ? (
              <>
                <video
                  ref={video}
                  src={`/api/assets/${source.id}`}
                  controls
                  preload="metadata"
                  onTimeUpdate={() =>
                    setPosition(video.current?.currentTime || 0)
                  }
                  onError={() => setPreviewError(true)}
                />
                {previewError && (
                  <div className="video-warning">
                    浏览器无法播放此编码。可以尝试导出为兼容的 MP4 后下载查看。
                  </div>
                )}
              </>
            ) : (
              <div className="preview-empty">
                <div className="preview-crosshair">
                  <span />
                  <Film size={38} strokeWidth={1} />
                </div>
                <h3>
                  {source ? "正在准备你的画面" : "你的画面，即将在这里展开"}
                </h3>
                <p>
                  {source
                    ? "素材正在后台解析，请稍候。"
                    : "先上传一段视频，开始这次创作。"}
                </p>
                {!source && (
                  <button
                    className="button small"
                    disabled={!!upload}
                    onClick={() => sourceInput.current?.click()}
                  >
                    <Upload size={15} />
                    上传视频
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="preview-bottom">
            <span className="preview-time">
              <strong>{formatTime(position)}</strong>
              <span>/</span>
              {formatTime(duration)}
            </span>
            <span className="micro-label">ORIGINAL FOOTAGE</span>
            <span className="preview-quality">原始画面</span>
          </div>
        </section>
        <aside className="inspector-panel">
          <div className="media-panel-heading">
            <span>片段设置</span>
            <Scissors size={16} />
          </div>
          <div className="inspector-body">
            <span className="inspector-label">导出范围</span>
            <div className="trim-fields">
              <label>
                入点 / 秒
                <input
                  aria-label="片段入点（秒）"
                  type="number"
                  min={0}
                  max={duration}
                  step="0.1"
                  value={draft.trim_start}
                  disabled={!canEdit || saving}
                  onChange={(event) =>
                    change({ trim_start: Number(event.target.value) })
                  }
                />
              </label>
              <span>—</span>
              <label>
                出点 / 秒
                <input
                  aria-label="片段出点（秒）"
                  type="number"
                  min={0.1}
                  max={duration}
                  step="0.1"
                  value={draft.trim_end}
                  disabled={!canEdit || saving}
                  onChange={(event) =>
                    change({ trim_end: Number(event.target.value) })
                  }
                />
              </label>
            </div>
            <div className="trim-seek-buttons">
              <button
                disabled={!canEdit || saving}
                onClick={() =>
                  change({
                    trim_start: Math.min(
                      position,
                      Math.max(0, draft.trim_end - 0.1),
                    ),
                  })
                }
              >
                将播放位置设为入点
              </button>
              <button
                disabled={!canEdit || saving}
                onClick={() =>
                  change({
                    trim_end: Math.min(
                      duration,
                      Math.max(position, draft.trim_start + 0.1),
                    ),
                  })
                }
              >
                设为出点
              </button>
            </div>
            <div className="selection-duration">
              <span>选中时长</span>
              <strong>
                {Math.max(0, draft.trim_end - draft.trim_start).toFixed(1)}{" "}
                <small>秒</small>
              </strong>
            </div>
            {canEdit && !valid && (
              <p className="inline-error">
                请输入有效片段范围，最短 0.1 秒，并填写项目名称。
              </p>
            )}
            <div className="inspector-divider" />
            <span className="inspector-label">导出格式</span>
            <div className="format-option">
              <span className="format-radio" />
              <div>
                <strong>
                  MP4 <span>H.264</span>
                </strong>
                <p>保留源视频分辨率 · AAC 音频</p>
              </div>
              <Check size={15} />
            </div>
            <div className="inspector-divider" />
            <div className="ai-section-heading">
              <span>
                <Sparkles size={15} />
                AI 人物替换
              </span>
              <span className="pill">未接入</span>
            </div>
            <p className="ai-description">
              从参考人物出发，探索画面的更多可能。模型接入并验证后开放。
            </p>
            <div className="ai-modes">
              <span>面部替换</span>
              <span>整个头部</span>
              <span>服装修改</span>
              <span>全身替换</span>
            </div>
            <button className="button ai-disabled" disabled>
              <Sparkles size={15} />
              人物替换准备中
            </button>
            <p className="ai-footnote">当前导出保留原视频中的人物外貌。</p>
          </div>
        </aside>
      </div>
      <section className="timeline-panel">
        <div className="timeline-heading">
          <div>
            <Scissors size={15} />
            <strong>片段时间线</strong>
            <span className="pill">基础剪辑</span>
          </div>
          <button
            className="text-button"
            disabled={!canEdit}
            onClick={() => seek(draft.trim_start)}
          >
            <Play size={12} />
            跳至入点
          </button>
        </div>
        <div className="timeline-body">
          <div className="timeline-track-label">
            <Film size={15} />
            <span>视频 01</span>
          </div>
          <div className="timeline-tracks">
            <div className="timeline-ruler">
              {Array.from({ length: 7 }, (_, index) => (
                <span key={index}>{formatTime((duration / 6) * index)}</span>
              ))}
            </div>
            <div className={`timeline-clip ${canEdit ? "ready" : ""}`}>
              {canEdit && (
                <>
                  <div className="filmstrip">
                    {Array.from({ length: 12 }, (_, index) => (
                      <img
                        key={index}
                        src={`/api/assets/${source.id}/thumbnail`}
                        alt=""
                      />
                    ))}
                  </div>
                  <div
                    className="timeline-shade left"
                    style={{ width: `${(draft.trim_start / duration) * 100}%` }}
                  />
                  <div
                    className="timeline-shade right"
                    style={{
                      width: `${Math.max(0, ((duration - draft.trim_end) / duration) * 100)}%`,
                    }}
                  />
                  <div
                    className="timeline-selection"
                    style={{
                      left: `${Math.min(100, (draft.trim_start / duration) * 100)}%`,
                      width: `${(Math.max(0, Math.min(duration, draft.trim_end) - draft.trim_start) / duration) * 100}%`,
                    }}
                  >
                    <span />
                    <span />
                  </div>
                  <div
                    className="timeline-playhead"
                    style={{ left: `${(position / duration) * 100}%` }}
                  />
                </>
              )}
              {!canEdit && (
                <span className="timeline-empty-label">
                  上传视频后，在这里调整导出范围
                </span>
              )}
            </div>
            {canEdit && (
              <div className="timeline-sliders">
                <label>
                  <span>入点</span>
                  <input
                    type="range"
                    aria-label="调整片段入点"
                    min="0"
                    max={Math.max(0, draft.trim_end - 0.1)}
                    step="0.1"
                    value={draft.trim_start}
                    disabled={saving}
                    onChange={(event) =>
                      change({ trim_start: Number(event.target.value) })
                    }
                  />
                  <span>{draft.trim_start.toFixed(1)}s</span>
                </label>
                <label>
                  <span>出点</span>
                  <input
                    type="range"
                    aria-label="调整片段出点"
                    min={draft.trim_start + 0.1}
                    max={duration}
                    step="0.1"
                    value={draft.trim_end}
                    disabled={saving}
                    onChange={(event) =>
                      change({ trim_end: Number(event.target.value) })
                    }
                  />
                  <span>{draft.trim_end.toFixed(1)}s</span>
                </label>
              </div>
            )}
          </div>
        </div>
      </section>
      <section className="export-section">
        <div className="section-heading">
          <h3>导出版本</h3>
          <span className="count-label">{exports.length}</span>
          <span className="export-subtitle">每次导出都会保留独立结果</span>
        </div>
        {exports.length ? (
          <div className="export-list">
            {exports.map((job) => (
              <div className="export-row" key={job.id}>
                <span className="export-file-icon">
                  <Film size={18} />
                </span>
                <div className="export-identity">
                  <strong>
                    片段导出 <span>#{job.id.slice(0, 6)}</span>
                  </strong>
                  <small>
                    {new Date(job.created_at).toLocaleString("zh-CN")}
                    {job.error && ` · ${job.error}`}
                  </small>
                </div>
                <div className="export-state">
                  <span className={`status ${job.status}`}>
                    <span />
                    {job.cancel_requested && job.status === "running"
                      ? "正在取消"
                      : labels[job.status]}
                  </span>
                  {["running", "queued"].includes(job.status) && (
                    <div className="progress-track">
                      <i style={{ width: `${job.progress}%` }} />
                    </div>
                  )}
                </div>
                {job.status === "succeeded" ? (
                  <a
                    className="button small"
                    href={`/api/jobs/${job.id}/download`}
                  >
                    <Download size={14} />
                    下载
                  </a>
                ) : ["running", "queued"].includes(job.status) ? (
                  <button
                    className="icon-button"
                    title="取消导出"
                    aria-label="取消导出"
                    disabled={!!job.cancel_requested}
                    onClick={() => void onCancel(job)}
                  >
                    <Square size={15} />
                  </button>
                ) : (
                  <button
                    className="text-button"
                    disabled={!valid || exporting}
                    onClick={() => void exportVideo()}
                  >
                    重新导出当前片段
                    <ArrowUpRight size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="export-empty">
            <Download size={19} />
            <span>选好片段后，点击右上角「导出片段」，结果会保存在这里。</span>
          </div>
        )}
      </section>
      <input
        ref={sourceInput}
        type="file"
        className="sr-only"
        aria-label="上传源视频文件"
        accept=".mp4,.mov,.webm,.mkv"
        onChange={(event) =>
          void handleUpload(event.target.files?.[0], "source")
        }
      />
      <input
        ref={referenceInput}
        type="file"
        className="sr-only"
        aria-label="上传人物参考照片"
        accept=".jpg,.jpeg,.png"
        onChange={(event) =>
          void handleUpload(event.target.files?.[0], "reference")
        }
      />
    </>
  );
}
