import { useEffect, useState } from "react";
import {
  Activity,
  BookOpen,
  CloudSun,
  HelpCircle,
  ListChecks,
  MessageSquareText,
  Newspaper,
  PenLine,
  Plug,
  Power,
  QrCode,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Wifi,
  WifiOff,
} from "lucide-react";
import type { StatusPayload } from "../types";
import { API_BASE, deleteJson, getJson, postJson } from "../lib/api";
import { formatDate } from "../lib/utils";
import { PageTitle, StatusPill } from "../components/common";

type WechatBridgeStatus = {
  ok?: boolean;
  running?: boolean;
  status?: string;
  activeMode?: string;
  processes?: Array<{ pid?: number; creationDate?: string; commandLine?: string }>;
  logs?: string[];
  lastLog?: string;
  updatedAt?: string;
  login?: {
    sessionKey?: string;
    qrcodeUrl?: string;
    qrcodeImage?: string;
    qrcodeImageUrl?: string;
    status?: string;
    message?: string;
    connected?: boolean;
    expiresAt?: string;
  };
};

type IntelSourceStatus = {
  checkedAt?: string;
  total?: number;
  okCount?: number;
  failedCount?: number;
  sources?: Array<{
    name?: string;
    url?: string;
    region?: string;
    ok?: boolean;
    status?: number;
    itemCount?: number;
    ms?: number;
    message?: string;
    checkedAt?: string;
    builtIn?: boolean;
    removable?: boolean;
  }>;
};

const commandSections = [
  {
    icon: ListChecks,
    title: "基础菜单",
    desc: "用于查看助手能力、取消当前确认流程，适合不知道发什么时先唤起菜单。",
    commands: [
      { text: "菜单", note: "查看微信助手支持的主要能力和示例。" },
      { text: "帮助", note: "查看更详细的使用说明。" },
      { text: "取消", note: "取消当前等待确认的情报或任务流程。" },
    ],
  },
  {
    icon: CloudSun,
    title: "天气查询",
    desc: "不调用大模型，不消耗 token。优先使用后台默认城市，也支持在微信内单独设置城市。",
    commands: [
      { text: "今天什么天气", note: "按默认城市查询今天的天气。" },
      { text: "杭州明天天气", note: "查询指定城市明天的天气。" },
      { text: "未来几天天气", note: "查看默认城市最近几天的天气列表。" },
      { text: "设置城市 杭州", note: "把当前微信联系人自己的默认城市设为杭州。" },
    ],
  },
  {
    icon: Newspaper,
    title: "情报收集",
    desc: "适合收集行业动态、政策、公司新闻、内容机会；AI 只是可选主题，不是固定范围。",
    commands: [
      { text: "帮我整理今天行业情报", note: "触发通用情报整理流程。" },
      { text: "今天有什么值得关注的行业新闻", note: "按行业新闻和热点筛选可用信息。" },
      { text: "最近有什么适合做小红书的工具新闻", note: "先筛选内容机会，再按确认继续生成。" },
      { text: "要", note: "对助手提出的待确认情报任务进行确认。" },
    ],
  },
  {
    icon: PenLine,
    title: "小红书发布包",
    desc: "用于把主题、素材或情报转成标题、正文、标签、图片提示词和发布包记录。",
    commands: [
      { text: "帮我做一篇小红书，主题是 AI 新手如何用知识库", note: "直接创建内容发布包任务。" },
      { text: "把刚才那条情报做成小红书发布包", note: "基于上一条情报继续生成内容。" },
      { text: "继续", note: "确认进入后续生成或发布包整理流程。" },
    ],
  },
  {
    icon: Sparkles,
    title: "日常对话",
    desc: "非菜单命令会进入普通助手回复；涉及分析、写作、策划时会调用模型并消耗 token。",
    commands: [
      { text: "帮我想 5 个选题", note: "走 AI 回复，适合轻量脑暴。" },
      { text: "这条内容怎么优化", note: "走 AI 分析，适合临时改稿。" },
    ],
  },
];

const guardrails = [
  "天气查询是本地 Weather Skill，不消耗模型 token；写作、分析、情报整理会调用模型。",
  "连接、重新连接都会弹出二维码，扫码确认后才会启动微信 bridge。",
  "任务类消息会沉淀到任务中心；发布包、本地素材和情报记录不会因为断开微信而删除。",
  "如果换了微信账号，建议使用“重新连接”，扫码后会刷新当前 bridge 使用的登录凭证。",
];

export function EntriesView({ status }: { status: StatusPayload | null }) {
  const wechatEntry = status?.entryConfig?.entries?.find((entry) => entry.id === "wechat");
  const [bridge, setBridge] = useState<WechatBridgeStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [error, setError] = useState("");
  const [loginSessionKey, setLoginSessionKey] = useState("");
  const [sourceStatus, setSourceStatus] = useState<IntelSourceStatus | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceNotice, setSourceNotice] = useState("");
  const [pendingDeleteSource, setPendingDeleteSource] = useState("");

  async function loadBridgeStatus() {
    setLoading(true);
    setError("");
    try {
      setBridge(await getJson<WechatBridgeStatus>("/api/local/entries/wechat-bridge"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function controlBridge(action: "start" | "stop" | "restart") {
    setBusyAction(action);
    setError("");
    try {
      const next = await postJson<WechatBridgeStatus>("/api/local/entries/wechat-bridge", { action });
      setBridge(next);
      if (next.login?.sessionKey) setLoginSessionKey(next.login.sessionKey);
      if (action === "stop") setLoginSessionKey("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction("");
    }
  }

  async function loadSourceStatus(check = false) {
    setSourceLoading(true);
    try {
      setSourceStatus(await getJson<IntelSourceStatus>(`/api/local/intel/source-status${check ? "" : "?check=0"}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSourceLoading(false);
    }
  }

  async function addSource() {
    const url = sourceUrl.trim();
    if (!url) {
      setSourceNotice("请先输入 RSS 源地址。");
      return;
    }
    setSourceLoading(true);
    setSourceNotice("");
    try {
      await postJson("/api/local/intel/sources", { url });
      setSourceUrl("");
      setSourceNotice("情报源已添加，可以点击检测确认可用性。");
      await loadSourceStatus(false);
    } catch (err) {
      setSourceNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setSourceLoading(false);
    }
  }

  async function deleteSource(url?: string) {
    const target = String(url || "").trim();
    if (!target) return;
    if (pendingDeleteSource !== target) {
      setPendingDeleteSource(target);
      setSourceNotice("再次点击确认删除该情报源。默认源删除后会从本地情报流程中停用。");
      return;
    }
    setSourceLoading(true);
    setSourceNotice("");
    try {
      await deleteJson(`/api/local/intel/sources/${encodeURIComponent(target)}`);
      setPendingDeleteSource("");
      setSourceNotice("情报源已删除。");
      await loadSourceStatus(false);
    } catch (err) {
      setSourceNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setSourceLoading(false);
    }
  }

  useEffect(() => {
    void loadBridgeStatus();
    void loadSourceStatus(false);
  }, []);

  useEffect(() => {
    if (!loginSessionKey) return undefined;
    const timer = window.setInterval(async () => {
      try {
        const next = await postJson<WechatBridgeStatus>("/api/local/entries/wechat-bridge", { action: "check-login", sessionKey: loginSessionKey });
        setBridge(next);
        if (next.login?.connected || next.login?.status === "expired" || next.login?.status === "failed") {
          setLoginSessionKey("");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [loginSessionKey]);

  const running = Boolean(bridge?.running);
  const disabled = Boolean(busyAction || loading);
  const pidText = bridge?.processes?.length ? bridge.processes.map((item) => item.pid).filter(Boolean).join(", ") : "无";
  const login = bridge?.login;
  const qrSrc = login?.qrcodeImageUrl ? `${API_BASE}${login.qrcodeImageUrl}` : login?.qrcodeImage || login?.qrcodeUrl;
  const showQr = Boolean(qrSrc && loginSessionKey);

  return (
    <main className="pageStack x-page entriesPage">
      <PageTitle
        group="连接与系统"
        title="入口助手"
        desc="管理微信入口连接状态，并查看微信内可直接发送的菜单与任务指令。"
        right={
          <button className="x-secondary" type="button" onClick={() => void loadBridgeStatus()} disabled={disabled}>
            <RefreshCcw size={16} className={loading ? "x-spin" : undefined} />
            刷新状态
          </button>
        }
      />

      <section className="entryBridgePanel x-panel">
        <div className="entryBridgeMain">
          <div className="entryBridgeIcon">{running ? <Wifi size={28} /> : <WifiOff size={28} />}</div>
          <div>
            <div className="entryBridgeTitle">
              <h2>{wechatEntry?.name || "微信助手"}</h2>
              <StatusPill status={running ? "online" : "disabled"} />
            </div>
            <p>{running ? "微信桥接进程正在运行，可以接收入口消息并触发本地任务。" : "微信桥接进程未运行，点击连接后扫码登录微信。"}</p>
          </div>
        </div>
        <div className="entryBridgeActions">
          <button className="x-primary" type="button" onClick={() => void controlBridge("start")} disabled={disabled || running}>
            <Plug size={16} />
            连接
          </button>
          <button className="x-secondary" type="button" onClick={() => void controlBridge("restart")} disabled={disabled}>
            <RefreshCcw size={16} className={busyAction === "restart" ? "x-spin" : undefined} />
            重新连接
          </button>
          <button className="x-danger" type="button" onClick={() => void controlBridge("stop")} disabled={disabled || !running}>
            <Power size={16} />
            断开
          </button>
        </div>
      </section>

      {error ? <div className="x-error-line">{error}</div> : null}

      {showQr ? (
        <section className="entryQrPanel x-panel">
          <div className="entryQrCode">
            <img src={qrSrc} alt="微信连接二维码" />
          </div>
          <div className="entryQrCopy">
            <span><QrCode size={16} />微信扫码连接</span>
            <h2>{login?.status === "scaned" ? "已扫码，请在手机上确认" : "请使用微信扫描二维码"}</h2>
            <p>{login?.message || "扫码确认后会自动保存连接凭证并启动微信 bridge。"}</p>
            <small>{login?.expiresAt ? `二维码有效期至 ${formatDate(login.expiresAt)}` : "二维码短时间内有效。"}</small>
          </div>
        </section>
      ) : null}

      <section className="entryMenuPanel x-panel">
        <div className="entrySectionHead">
          <span><MessageSquareText size={16} />微信消息菜单</span>
          <p>这些不是页面按钮，而是在微信聊天里直接发送的文字。助手会按意图进入天气、情报、发布包或普通 AI 回复。</p>
        </div>
        <div className="entryCommandGrid">
          {commandSections.map(({ icon: Icon, title, desc, commands }) => (
            <article className="entryCommandCard" key={title}>
              <div className="entryCommandHead">
                <span><Icon size={17} /></span>
                <div>
                  <h3>{title}</h3>
                  <p>{desc}</p>
                </div>
              </div>
              <div className="entryCommandList">
                {commands.map((item) => (
                  <div className="entryCommandRow" key={item.text}>
                    <code>{item.text}</code>
                    <small>{item.note}</small>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="entryGuideGrid">
        <article className="entryGuideCard x-card">
          <span><BookOpen size={15} />推荐使用流程</span>
          <ol>
            <li>先在后台确认微信助手已连接。</li>
            <li>在微信里发送“菜单”或“帮助”查看能力。</li>
            <li>天气、城市设置这类查询会快速返回，不进任务中心。</li>
            <li>情报和小红书发布包会进入任务中心，可以回看执行步骤。</li>
            <li>生成发布包后，到发布包中心继续看正文、图片提示词和素材。</li>
          </ol>
        </article>
        <article className="entryGuideCard x-card">
          <span><ShieldCheck size={15} />规则与边界</span>
          <ul>
            {guardrails.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </article>
        <article className="entryGuideCard x-card">
          <span><HelpCircle size={15} />排查提示</span>
          <ul>
            <li>扫码后没有回复：先看连接状态是否为在线，再查看最近日志。</li>
            <li>换微信账号后异常：点击重新连接，重新扫码确认。</li>
            <li>天气没返回：可能是天气源限流，当前会自动切换备用源。</li>
            <li>任务长时间没结果：到任务中心查看步骤状态和错误信息。</li>
          </ul>
        </article>
      </section>

      <section className="entrySourcePanel x-panel">
        <div className="entrySectionHead">
          <span><Newspaper size={16} />情报源状态</span>
          <p>国内源会优先合入情报流程；海外源保留为补充。检测会实际访问 RSS 源，慢源可能需要几秒。</p>
        </div>
        <div className="entrySourceSummary">
          <div>
            <strong>{sourceStatus?.okCount ?? "-"}</strong>
            <span>可用源</span>
          </div>
          <div>
            <strong>{sourceStatus?.failedCount ?? "-"}</strong>
            <span>异常源</span>
          </div>
          <div>
            <strong>{sourceStatus?.total ?? sourceStatus?.sources?.length ?? "-"}</strong>
            <span>总来源</span>
          </div>
          <button className="x-secondary" type="button" onClick={() => void loadSourceStatus(true)} disabled={sourceLoading}>
            <RefreshCcw size={15} className={sourceLoading ? "x-spin" : undefined} />
            {sourceLoading ? "检测中" : "检测情报源"}
          </button>
        </div>
        <div className="entrySourceAdd">
          <label>
            <span>新增 RSS 源</span>
            <input
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
              placeholder="https://example.com/feed.xml"
            />
          </label>
          <button className="x-primary" type="button" onClick={() => void addSource()} disabled={sourceLoading}>
            添加源
          </button>
        </div>
        {sourceNotice ? <p className="entrySourceNotice">{sourceNotice}</p> : null}
        <div className="entrySourceList">
          {(sourceStatus?.sources || []).map((source) => (
            <div className="entrySourceRow" key={source.url}>
              <div>
                <strong>{source.name || source.url}</strong>
                <small>
                  {source.builtIn ? "默认源" : "自定义源"} · {source.region === "domestic" ? "国内" : source.region === "global" ? "海外" : source.region === "healing" ? "疗愈" : "自定义"}
                </small>
              </div>
              <span className={source.ok ? "sourceOk" : source.ok === false ? "sourceFail" : "sourcePending"}>
                {source.ok ? "可用" : source.ok === false ? "异常" : "未检测"}
              </span>
              <small>{source.itemCount == null ? "-" : `${source.itemCount} 条`}</small>
              <small>{source.ms == null ? "-" : `${source.ms}ms`}</small>
              <small>{source.message || source.url}</small>
              <button
                className={pendingDeleteSource === source.url ? "x-danger entrySourceDelete isConfirming" : "x-secondary entrySourceDelete"}
                type="button"
                onClick={() => void deleteSource(source.url)}
                disabled={sourceLoading}
              >
                {pendingDeleteSource === source.url ? "确认删除" : "删除"}
              </button>
            </div>
          ))}
        </div>
        {sourceStatus?.checkedAt ? <p className="entrySourceChecked">最近检测：{formatDate(sourceStatus.checkedAt)}</p> : null}
      </section>

      <section className="entryDetailsGrid">
        <div className="entryInfoCard x-card">
          <span><Activity size={15} />连接信息</span>
          <dl>
            <div><dt>运行模式</dt><dd>{bridge?.activeMode || "未读取"}</dd></div>
            <div><dt>进程 PID</dt><dd>{pidText}</dd></div>
            <div><dt>最近检查</dt><dd>{formatDate(bridge?.updatedAt)}</dd></div>
          </dl>
        </div>

        <div className="entryLogCard x-card">
          <span>最近日志</span>
          {bridge?.logs?.length ? (
            <pre>{bridge.logs.join("\n")}</pre>
          ) : (
            <p>暂无 bridge 日志。</p>
          )}
        </div>
      </section>
    </main>
  );
}
