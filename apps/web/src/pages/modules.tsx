import { useEffect, useMemo, useState } from "react";
import { Bot, Brain, CheckCircle2, Database, Image as ImageIcon, PlugZap, Save, Settings2, Sparkles, Workflow, XCircle } from "lucide-react";
import type { SettingsPayload } from "../types";
import { postJson } from "../lib/api";
import { secretLabel } from "../lib/utils";
import { PageTitle, StatusPill } from "../components/common";

function boolStatus(value?: boolean) {
  return value ? "online" : "disabled";
}

function moduleTone(value?: boolean) {
  return value ? "moduleOk" : "moduleOff";
}

export function ModuleSettingsView({ settings, onSaved }: { settings: SettingsPayload | null; onSaved?: (settings: SettingsPayload) => void }) {
  const [form, setForm] = useState<SettingsPayload>(settings || {});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setForm(settings || {});
  }, [dirty, settings]);

  const skills = Object.entries(form.workflow?.skills || {});
  const enabledSkills = skills.filter(([, skill]) => skill.enabled !== false).length;
  const notionReady = Boolean(form.notionIntel?.enabled || form.notionContent?.databaseId);
  const imageReady = Boolean(form.imageGeneration?.enabled);
  const hermesReady = Boolean(form.hermes?.enabled);
  const modelReady = Boolean(form.modelProvider?.providerId && form.modelProvider?.model);

  const skillIds = useMemo(() => skills.map(([id]) => id), [skills]);

  function update<K extends keyof SettingsPayload>(key: K, value: SettingsPayload[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
    setNotice("");
    setError("");
  }

  function updateSkill(id: string, patch: Record<string, unknown>) {
    setForm((current) => ({
      ...current,
      workflow: {
        ...current.workflow,
        skills: {
          ...current.workflow?.skills,
          [id]: {
            ...current.workflow?.skills?.[id],
            ...patch,
          },
        },
      },
    }));
    setDirty(true);
    setNotice("");
    setError("");
  }

  async function save() {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const next = await postJson<SettingsPayload>("/api/local/settings", form);
      setForm(next);
      setDirty(false);
      onSaved?.(next);
      setNotice("模块配置已保存。");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const modules = [
    {
      icon: Bot,
      label: "模型提供方",
      title: form.modelProvider?.model || "未选择模型",
      desc: `${form.modelProvider?.providerId || "未配置 Provider"} · ${form.modelProvider?.baseUrl || "未配置 Base URL"}`,
      enabled: modelReady,
      status: modelReady ? "online" : "pending",
    },
    {
      icon: PlugZap,
      label: "Hermes Worker",
      title: form.hermes?.provider || "研究增强",
      desc: `${form.hermes?.workerUrl || "http://127.0.0.1:3307"} · ${form.hermes?.fallbackOnError === false ? "不自动降级" : "失败自动降级"}`,
      enabled: hermesReady,
      status: hermesReady ? "online" : "disabled",
    },
    {
      icon: Database,
      label: "Notion 同步",
      title: notionReady ? "外部知识库已接入" : "未启用同步",
      desc: `情报库 ${form.notionIntel?.enabled ? "启用" : "未启用"} · 发布包 ${form.notionContent?.databaseId ? "已配置" : "未配置"}`,
      enabled: notionReady,
      status: notionReady ? "configured" : "disabled",
    },
    {
      icon: ImageIcon,
      label: "素材图生成",
      title: form.imageGeneration?.model || "未选择图片模型",
      desc: `${form.imageGeneration?.size || "1024x1024"} · ${form.imageGeneration?.quality || "high"} · 最多 ${form.imageGeneration?.maxGeneratedImages || 1} 张`,
      enabled: imageReady,
      status: imageReady ? "online" : "disabled",
    },
  ];

  return (
    <main className="pageStack x-page modulesPage">
      <PageTitle
        group="连接与系统"
        title="模块与插件"
        desc="配置模型、研究增强、同步、素材生成和内容工作流阶段。"
        right={
          <button className="x-primary" type="button" onClick={() => void save()} disabled={busy}>
            <Save size={16} />
            {busy ? "保存中" : "保存配置"}
          </button>
        }
      />

      {notice ? <div className="moduleNotice moduleNoticeOk">{notice}</div> : null}
      {error ? <div className="moduleNotice moduleNoticeError">{error}</div> : null}

      <section className="moduleOverviewGrid">
        <div className="moduleSummary x-panel">
          <span><Settings2 size={16} />运行概览</span>
          <h2>{enabledSkills} / {skills.length || 0} 个 Skill 已启用</h2>
          <p>这里保存的是本地配置，会影响后续新任务的研究增强、素材生成和工作流策略。</p>
        </div>
        <div className={`moduleHealth ${moduleTone(modelReady)} x-panel`}>
          {modelReady ? <CheckCircle2 size={24} /> : <XCircle size={24} />}
          <strong>{modelReady ? "核心生成链路可用" : "核心生成链路待确认"}</strong>
          <small>模型提供方是内容生成的关键依赖，Hermes Worker 默认为增强能力。</small>
        </div>
      </section>

      <section className="moduleGrid" aria-label="核心模块">
        {modules.map(({ icon: Icon, label, title, desc, status, enabled }) => (
          <article className={`moduleCard ${moduleTone(enabled)} x-card`} key={label}>
            <div className="moduleCardHead">
              <span className="moduleIcon"><Icon size={18} /></span>
              <StatusPill status={status} />
            </div>
            <span className="moduleLabel">{label}</span>
            <h3>{title}</h3>
            <p>{desc}</p>
          </article>
        ))}
      </section>

      <section className="moduleConfigGrid">
        <div className="moduleConfigCard x-panel">
          <div className="moduleConfigHead">
            <span><PlugZap size={16} />Hermes Worker</span>
            <label className="moduleSwitch"><input type="checkbox" checked={Boolean(form.hermes?.enabled)} onChange={(event) => update("hermes", { ...form.hermes, enabled: event.target.checked })} />启用</label>
          </div>
          <div className="moduleFormGrid">
            <label><span>Worker URL</span><input value={form.hermes?.workerUrl || ""} onChange={(event) => update("hermes", { ...form.hermes, workerUrl: event.target.value })} /></label>
            <label><span>Provider</span><input value={form.hermes?.provider || ""} onChange={(event) => update("hermes", { ...form.hermes, provider: event.target.value })} /></label>
            <label><span>模式</span><input value={form.hermes?.mode || ""} onChange={(event) => update("hermes", { ...form.hermes, mode: event.target.value })} /></label>
            <label><span>超时秒数</span><input type="number" min={30} max={600} value={form.hermes?.timeoutSeconds || 60} onChange={(event) => update("hermes", { ...form.hermes, timeoutSeconds: Number(event.target.value) })} /></label>
            <label className="moduleSwitch moduleWide"><input type="checkbox" checked={form.hermes?.fallbackOnError !== false} onChange={(event) => update("hermes", { ...form.hermes, fallbackOnError: event.target.checked })} />失败时降级到本地流程</label>
          </div>
        </div>

        <div className="moduleConfigCard moduleNotionConfig x-panel">
          <div className="moduleConfigHead">
            <span><Database size={16} />Notion 接入</span>
            <label className="moduleSwitch">
              <input
                type="checkbox"
                checked={Boolean(form.notionIntel?.enabled || form.notionContent?.xiaohongshuEnableNotion)}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  update("notionIntel", { ...form.notionIntel, enabled });
                  update("notionContent", {
                    ...form.notionContent,
                    xiaohongshuEnableNotion: enabled,
                  });
                }}
              />
              启用 Notion
            </label>
          </div>
          <p className="moduleConfigHint">配置一个 Notion 接入后，再指定情报库和发布包分别写入哪个 Database。</p>
          <div className="moduleFormGrid">
            <label className="moduleWide">
              <span>Notion Integration Token</span>
              <input
                type="password"
                placeholder={secretLabel(form.notionIntel?.token) || secretLabel(form.notionContent?.token) || "留空则保持现有密钥"}
                onChange={(event) => {
                  const token = event.target.value || form.notionIntel?.token || form.notionContent?.token;
                  update("notionIntel", { ...form.notionIntel, token });
                  update("notionContent", { ...form.notionContent, token });
                }}
              />
            </label>
            <div className="moduleRouteBlock moduleWide">
              <div className="moduleRouteHead">
                <div>
                  <strong>情报库</strong>
                  <small>用于读取和沉淀情报源。</small>
                </div>
                <label className="moduleSwitch">
                  <input
                    type="checkbox"
                    checked={Boolean(form.notionIntel?.enabled)}
                    onChange={(event) => update("notionIntel", { ...form.notionIntel, enabled: event.target.checked })}
                  />
                  同步情报库
                </label>
              </div>
              <label>
                <span>Database ID</span>
                <input value={form.notionIntel?.databaseId || ""} onChange={(event) => update("notionIntel", { ...form.notionIntel, databaseId: event.target.value })} />
              </label>
            </div>
            <div className="moduleRouteBlock moduleWide">
              <div className="moduleRouteHead">
                <div>
                  <strong>发布包</strong>
                  <small>用于保存生成后的内容包。</small>
                </div>
                <label className="moduleSwitch">
                  <input
                    type="checkbox"
                    checked={Boolean(form.notionContent?.xiaohongshuEnableNotion)}
                    onChange={(event) => {
                      const enabled = event.target.checked;
                      update("notionContent", {
                        ...form.notionContent,
                        xiaohongshuEnableNotion: enabled,
                      });
                    }}
                  />
                  同步发布包
                </label>
              </div>
              <label>
                <span>Database ID</span>
                <input value={form.notionContent?.databaseId || ""} onChange={(event) => update("notionContent", { ...form.notionContent, databaseId: event.target.value })} />
              </label>
            </div>
          </div>
        </div>
        <div className="moduleConfigCard x-panel">
          <div className="moduleConfigHead">
            <span><ImageIcon size={16} />素材图生成</span>
            <label className="moduleSwitch"><input type="checkbox" checked={Boolean(form.imageGeneration?.enabled)} onChange={(event) => update("imageGeneration", { ...form.imageGeneration, enabled: event.target.checked })} />启用</label>
          </div>
          <div className="moduleFormGrid">
            <label><span>模型</span><input value={form.imageGeneration?.model || ""} onChange={(event) => update("imageGeneration", { ...form.imageGeneration, model: event.target.value })} /></label>
            <label><span>Base URL</span><input value={form.imageGeneration?.baseUrl || ""} onChange={(event) => update("imageGeneration", { ...form.imageGeneration, baseUrl: event.target.value })} /></label>
            <label className="moduleWide">
              <span>图片 API Key</span>
              <input
                type="password"
                placeholder={secretLabel(form.imageGeneration?.apiKey) || "留空则保持现有密钥"}
                onChange={(event) => update("imageGeneration", { ...form.imageGeneration, apiKey: event.target.value || form.imageGeneration?.apiKey })}
              />
            </label>
            <label><span>尺寸</span><input value={form.imageGeneration?.size || ""} onChange={(event) => update("imageGeneration", { ...form.imageGeneration, size: event.target.value })} /></label>
            <label>
              <span>质量</span>
              <select value={form.imageGeneration?.quality || "high"} onChange={(event) => update("imageGeneration", { ...form.imageGeneration, quality: event.target.value })}>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </label>
            <label><span>最多张数</span><input type="number" min={1} max={9} value={form.imageGeneration?.maxGeneratedImages || 1} onChange={(event) => update("imageGeneration", { ...form.imageGeneration, maxGeneratedImages: Number(event.target.value) })} /></label>
            <label className="moduleSwitch"><input type="checkbox" checked={Boolean(form.imageGeneration?.generateBodyImages)} onChange={(event) => update("imageGeneration", { ...form.imageGeneration, generateBodyImages: event.target.checked })} />默认生成正文图</label>
          </div>
        </div>
      </section>

      <section className="moduleSkillPanel x-panel">
        <div className="moduleSectionHead">
          <div>
            <span><Workflow size={16} />内容工作流</span>
            <h2>发布包生成的核心阶段</h2>
          </div>
          <div className="moduleSkillToolbar">
            <StatusPill status={skills.length ? "configured" : "pending"} />
            <span>{skillIds.length} 个阶段</span>
          </div>
        </div>

        <div className="moduleSkillList">
          {skills.length ? skills.map(([id, skill]) => (
            <article className="moduleSkillRow" key={id}>
              <div className="moduleSkillName">
                <span className="moduleIcon"><Brain size={17} /></span>
                <div>
                  <strong>{skill.name || id}</strong>
                  <small>{skill.selectedFocuses?.join(" / ") || "未配置关注重点"}</small>
                </div>
              </div>
              <div className="moduleSkillMeta">
                {id === "deliveryGate" ? (
                  <label className="moduleSwitch"><input type="checkbox" checked={skill.enabled !== false} onChange={(event) => updateSkill(id, { enabled: event.target.checked })} />启用</label>
                ) : (
                  <span className="moduleRequiredBadge">必经阶段</span>
                )}
                <label className="moduleTinyInput"><span>超时</span><input type="number" min={30} max={180} value={skill.timeoutSeconds || 60} onChange={(event) => updateSkill(id, { timeoutSeconds: Number(event.target.value) })} /></label>
                <label className="moduleSwitch"><input type="checkbox" checked={skill.fallbackOnError !== false} onChange={(event) => updateSkill(id, { fallbackOnError: event.target.checked })} />失败兜底</label>
              </div>
            </article>
          )) : (
            <div className="moduleEmpty">
              <Sparkles size={18} />
              暂未读取到工作流阶段配置。
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
