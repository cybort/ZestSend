import { useEffect, useRef, useState } from "react";
import {
  RiCheckboxCircleLine,
  RiCloseCircleLine,
  RiFileLine,
  RiFolderOpenLine,
  RiLoader4Line,
  RiPlayLine,
  RiRestartLine,
  RiRobotLine,
  RiSendPlaneLine,
  RiTerminalBoxLine,
} from "@remixicon/react";
import type { HarnessController, HarnessClientEvents } from "../lib/harness";
import type { HarnessPermissionMode, HarnessSessionInfo, HarnessSnapshotEntry } from "../../shared/harness-protocol";

const harnessCopy = {
  en: {
    title: "Remote agent",
    subtitle: "Control the AI coding agent running on the other device.",
    pairingRequired: "Authorization required",
    pairingHint: "Enter the connection code shown on the agent's machine.",
    pairingPlaceholder: "6-digit code",
    pairingSubmit: "Authorize",
    verifying: "Verifying…",
    authed: "Authorized",
    failed: "Authorization failed",
    idle: "Connecting…",
    fingerprint: "Host fingerprint",
    permissions: "Permissions",
    sessions: "Sessions",
    newSession: "New session",
    workspacePlaceholder: "Workspace path on the host",
    start: "Start session",
    promptPlaceholder: "Send a prompt to the agent…",
    send: "Send",
    cancel: "Cancel",
    resume: "Resume",
    refresh: "Refresh",
    waitingTool: "Waiting for approval",
    allow: "Allow",
    deny: "Deny",
    approved: "Approved",
    denied: "Denied",
    empty: "No sessions yet. Start one to begin.",
    tabAgent: "Agent",
    tabShell: "Shell",
    tabFiles: "Files",
    shellPlaceholder: "Command to run on the host…",
    shellEmpty: "Shell output appears here. Requires the `full` permission mode.",
    run: "Run",
    filesPathPlaceholder: "Path inside the host workspace",
    list: "List",
    read: "Read",
    write: "Write",
    offline: "Offline queue: messages will send when the connection returns.",
    permissionBadge: (mode: HarnessPermissionMode) => mode,
  },
  zh: {
    title: "远程代理",
    subtitle: "控制对方设备上运行的 AI 编码代理。",
    pairingRequired: "需要授权",
    pairingHint: "请输入代理设备上显示的连接码。",
    pairingPlaceholder: "6 位连接码",
    pairingSubmit: "授权",
    verifying: "验证中…",
    authed: "已授权",
    failed: "授权失败",
    idle: "连接中…",
    fingerprint: "主机指纹",
    permissions: "权限",
    sessions: "会话",
    newSession: "新建会话",
    workspacePlaceholder: "主机上的工作区路径",
    start: "启动会话",
    promptPlaceholder: "向代理发送提示词…",
    send: "发送",
    cancel: "取消",
    resume: "恢复",
    refresh: "刷新",
    waitingTool: "等待审批",
    allow: "允许",
    deny: "拒绝",
    approved: "已允许",
    denied: "已拒绝",
    empty: "暂无会话。启动一个会话以开始。",
    tabAgent: "代理",
    tabShell: "终端",
    tabFiles: "文件",
    shellPlaceholder: "在主机上执行的命令…",
    shellEmpty: "命令输出将显示在此。需要 `full` 权限模式。",
    run: "执行",
    filesPathPlaceholder: "主机工作区内的路径",
    list: "列出",
    read: "读取",
    write: "写入",
    offline: "离线队列：连接恢复后自动发送。",
    permissionBadge: (mode: HarnessPermissionMode) => mode,
  },
} as const;

type TranscriptEntry = HarnessSnapshotEntry & { kind: "output" | "snapshot" | "state" | "approval" };

export function HarnessWorkspace({ controller, locale }: { controller: HarnessController | null; locale: "en" | "zh" }) {
  const copy = harnessCopy[locale];
  const [auth, setAuth] = useState<string>("idle");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<HarnessPermissionMode | null>(null);
  const [pairCode, setPairCode] = useState("");
  const [sessions, setSessions] = useState<HarnessSessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<Record<string, TranscriptEntry[]>>({});
  const [approvals, setApprovals] = useState<Record<string, HarnessClientEvents["toolRequest"]>>({});
  const [prompt, setPrompt] = useState("");
  const [tab, setTab] = useState<"agent" | "shell" | "files">("agent");
  const [shellCommand, setShellCommand] = useState("");
  const [shellLines, setShellLines] = useState<string[]>([]);
  const [filePath, setFilePath] = useState("");
  const [fileLines, setFileLines] = useState<string[]>([]);
  const [workspacePath, setWorkspacePath] = useState("");
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!controller) return;
    // The handshake may already be complete before this panel mounts
    // (the user opens Remote after connecting), so mirror current state first.
    setAuth(controller.status);
    setFingerprint(controller.fingerprint);
    setPermissions(controller.permissions ?? null);
    setSessions(controller.sessionList);
    setActiveSessionId((current) => current ?? controller.focusedSessionId ?? controller.sessionList.at(0)?.sessionId ?? null);
    const offStatus = controller.on("status", (event) => {
      setAuth(event.auth);
      setStatusDetail(event.detail ?? null);
      setFingerprint(event.fingerprint ?? controller.fingerprint);
      setPermissions(event.permissions ?? null);
    });
    const offSessions = controller.on("sessions", (event) => {
      const sessions = Array.isArray(event.sessions) ? event.sessions : [];
      setSessions(sessions);
      setActiveSessionId((current) => current ?? sessions.at(0)?.sessionId ?? null);
    });
    const offState = controller.on("sessionState", (event) => {
      setTranscript((current) => ({
        ...current,
        [event.sessionId]: [
          ...(current[event.sessionId] ?? []),
          { kind: "state", role: "system", text: event.detail ?? event.state, at: Date.now() },
        ],
      }));
    });
    const offOutput = controller.on("output", (event) => {
      setTranscript((current) => ({
        ...current,
        [event.sessionId]: [
          ...(current[event.sessionId] ?? []),
          {
            kind: "output",
            role: event.stream === "tool" ? "tool" : "assistant",
            text: event.data,
            at: Date.now(),
          },
        ],
      }));
    });
    const offSnapshot = controller.on("snapshot", (event) => {
      setTranscript((current) => ({
        ...current,
        [event.snapshot.sessionId]: event.snapshot.transcript.map((entry) => ({ ...entry, kind: "snapshot" as const })),
      }));
      // Pending approvals rehydrate across view switches and reconnects.
      setApprovals((current) => {
        const next = { ...current };
        for (const request of event.snapshot.pendingApprovals) next[request.requestId] = request;
        return next;
      });
    });
    const offTool = controller.on("toolRequest", (event) => {
      setApprovals((current) => ({ ...current, [event.requestId]: event }));
      setTranscript((current) => ({
        ...current,
        [event.sessionId]: [
          ...(current[event.sessionId] ?? []),
          { kind: "approval", role: "tool", text: `${event.tool}(${event.argsJson})`, at: Date.now() },
        ],
      }));
    });
    const offShell = controller.on("shell", (event) => {
      if (event.data) setShellLines((current) => [...current.slice(-400), `${event.stream === "stderr" ? "! " : ""}${event.data}`]);
      if (event.done && event.exitCode !== undefined) {
        setShellLines((current) => [...current, `— exit ${event.exitCode ?? "?"}${event.timedOut ? " (timed out)" : ""} —`]);
      }
    });
    const offFs = controller.on("fs", (event) => {
      if (event.entries) {
        setFileLines(event.entries.map((entry) => `${entry.kind === "directory" ? "d" : "f"} ${entry.size.toString().padStart(10)} ${entry.name}`));
      } else if (event.data) {
        setFileLines([`(${event.data.length} base64 chars)`, event.data.slice(0, 4_000)]);
      } else if (event.error) {
        setFileLines([`error: ${event.error}`]);
      }
    });
    const offError = controller.on("error", (event) => {
      setShellLines((current) => [...current.slice(-400), `! ${event.message}`]);
    });
    controller.refresh();
    return () => {
      offStatus(); offSessions(); offState(); offOutput(); offSnapshot(); offTool(); offShell(); offFs(); offError();
    };
  }, [controller]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "end" });
  }, [transcript, activeSessionId]);

  const entries = (activeSessionId && transcript[activeSessionId]) || [];

  const submitPrompt = () => {
    if (!controller || !activeSessionId || !prompt.trim()) return;
    controller.prompt(activeSessionId, prompt.trim());
    setTranscript((current) => ({
      ...current,
      [activeSessionId]: [
        ...(current[activeSessionId] ?? []),
        { kind: "output", role: "user", text: prompt.trim(), at: Date.now() },
      ],
    }));
    setPrompt("");
  };

  const statusLabel = auth === "authed" ? copy.authed
    : auth === "pairing-required" ? copy.pairingRequired
    : auth === "verifying" ? copy.verifying
    : auth === "failed" ? copy.failed
    : copy.idle;

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3 overflow-hidden p-4 text-white/90">
      <header className="flex flex-wrap items-center gap-3">
        <RiRobotLine size={22} className="text-white/70" />
        <div className="mr-auto">
          <div className="text-sm font-semibold">{copy.title}</div>
          <div className="text-xs text-white/50">{copy.subtitle}</div>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs ${auth === "authed" ? "bg-emerald-500/20 text-emerald-300" : auth === "failed" ? "bg-rose-500/20 text-rose-300" : "bg-white/10 text-white/70"}`}>
          {statusLabel}
        </span>
        {permissions ? (
          <span className="rounded-full bg-white/10 px-3 py-1 text-xs text-white/70">{copy.permissions}: {permissions}</span>
        ) : null}
        {fingerprint ? (
          <span className="hidden rounded-full bg-white/10 px-3 py-1 text-xs text-white/50 md:inline" title={fingerprint}>
            {copy.fingerprint}: {fingerprint.slice(0, 8)}…
          </span>
        ) : null}
      </header>

      {auth === "pairing-required" || auth === "failed" ? (
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="text-sm font-medium">{copy.pairingRequired}</div>
          <div className="mt-1 text-xs text-white/60">{copy.pairingHint}</div>
          <div className="mt-3 flex gap-2">
            <input
              className="w-40 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm tracking-widest outline-none focus:border-white/30"
              inputMode="numeric"
              maxLength={6}
              placeholder={copy.pairingPlaceholder}
              value={pairCode}
              onChange={(event) => setPairCode(event.target.value.replace(/\D/g, ""))}
            />
            <button
              className="rounded-xl bg-white/90 px-4 py-2 text-sm font-medium text-black disabled:opacity-40"
              disabled={pairCode.length !== 6}
              onClick={() => {
                void controller?.submitPairCode(pairCode);
                setPairCode("");
              }}
            >
              {copy.pairingSubmit}
            </button>
          </div>
          {statusDetail ? <div className="mt-2 text-xs text-rose-300/80">{statusDetail}</div> : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-white/50">{copy.sessions}</span>
        {sessions.map((session) => (
          <button
            key={session.sessionId}
            className={`rounded-full px-3 py-1 text-xs transition ${session.sessionId === activeSessionId ? "bg-white/90 text-black" : "bg-white/10 text-white/70 hover:bg-white/20"}`}
            onClick={() => {
              setActiveSessionId(session.sessionId);
              controller?.focusSession(session.sessionId);
              controller?.requestSnapshot(session.sessionId);
            }}
          >
            {session.label} · {session.state}
            {session.pendingApprovals > 0 ? " (!)" : ""}
          </button>
        ))}
        <button
          className="rounded-full bg-white/10 px-3 py-1 text-xs text-white/70 hover:bg-white/20"
          onClick={() => controller?.refresh()}
        >
          <RiRestartLine size={13} className="mr-1 inline" />{copy.refresh}
        </button>
        {activeSessionId ? (
          <button
            className="rounded-full bg-white/10 px-3 py-1 text-xs text-white/70 hover:bg-white/20"
            onClick={() => activeSessionId && controller?.cancel(activeSessionId)}
          >
            {copy.cancel}
          </button>
        ) : null}
      </div>

      {auth === "authed" ? (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-white/5 p-4">
          <input
            className="flex-1 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-white/30"
            placeholder={copy.workspacePlaceholder}
            value={workspacePath}
            onChange={(event) => setWorkspacePath(event.target.value)}
          />
          <button
            className="rounded-xl bg-white/90 px-4 py-2 text-sm font-medium text-black disabled:opacity-40"
            disabled={!workspacePath.trim()}
            onClick={() => {
              controller?.startSession(workspacePath.trim());
              setWorkspacePath("");
            }}
          >
            <RiPlayLine size={14} className="mr-1 inline" />{copy.start}
          </button>
          {sessions.length === 0 ? <div className="w-full text-xs text-white/50">{copy.empty}</div> : null}
        </div>
      ) : null}

      <div className="flex gap-2">
        {(["agent", "shell", "files"] as const).map((id) => (
          <button
            key={id}
            className={`rounded-full px-3 py-1 text-xs ${tab === id ? "bg-white/90 text-black" : "bg-white/10 text-white/70 hover:bg-white/20"}`}
            onClick={() => setTab(id)}
          >
            {id === "agent" ? copy.tabAgent : id === "shell" ? copy.tabShell : copy.tabFiles}
          </button>
        ))}
      </div>

      {tab === "agent" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-white/10 bg-black/20 p-3">
            {entries.length === 0 ? (
              <div className="p-4 text-center text-xs text-white/40">{copy.empty}</div>
            ) : null}
            {entries.map((entry, index) => (
              <div
                key={`${entry.at}-${index}`}
                className={`mb-2 whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-sm ${
                  entry.role === "user" ? "ml-8 bg-white/15"
                    : entry.role === "tool" ? "bg-amber-500/10 text-amber-200/90"
                    : entry.role === "system" ? "text-white/40 italic"
                    : "mr-8 bg-white/5"
                }`}
              >
                {entry.text}
              </div>
            ))}
            {Object.values(approvals).map((request) => (
              <div key={request.requestId} className="mb-2 rounded-xl border border-amber-400/30 bg-amber-500/10 p-3">
                <div className="flex items-center gap-2 text-sm text-amber-200">
                  <RiLoader4Line size={16} className="animate-spin" />
                  {copy.waitingTool}: <code className="text-xs">{request.tool}</code>
                </div>
                <div className="mt-1 break-all text-xs text-white/60">{request.argsJson}</div>
                <div className="mt-2 flex gap-2">
                  <button
                    className="rounded-lg bg-emerald-400/90 px-3 py-1.5 text-xs font-medium text-black"
                    onClick={() => {
                      controller?.decide(request.requestId, true);
                      setApprovals((current) => {
                        const next = { ...current };
                        delete next[request.requestId];
                        return next;
                      });
                    }}
                  >
                    <RiCheckboxCircleLine size={13} className="mr-1 inline" />{copy.allow}
                  </button>
                  <button
                    className="rounded-lg bg-rose-400/90 px-3 py-1.5 text-xs font-medium text-black"
                    onClick={() => {
                      controller?.decide(request.requestId, false);
                      setApprovals((current) => {
                        const next = { ...current };
                        delete next[request.requestId];
                        return next;
                      });
                    }}
                  >
                    <RiCloseCircleLine size={13} className="mr-1 inline" />{copy.deny}
                  </button>
                </div>
              </div>
            ))}
            <div ref={transcriptEndRef} />
          </div>
          <div className="flex gap-2">
            <textarea
              className="min-h-[52px] flex-1 resize-none rounded-2xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none focus:border-white/30"
              placeholder={copy.promptPlaceholder}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submitPrompt();
                }
              }}
            />
            <button
              className="self-end rounded-2xl bg-white/90 px-4 py-2 text-sm font-medium text-black disabled:opacity-40"
              disabled={!prompt.trim() || !activeSessionId}
              onClick={submitPrompt}
            >
              <RiSendPlaneLine size={16} className="mr-1 inline" />{copy.send}
            </button>
          </div>
        </div>
      ) : null}

      {tab === "shell" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-white/10 bg-black/30 p-3 font-mono text-xs">
            {shellLines.length === 0 ? <div className="p-4 text-center text-white/40">{copy.shellEmpty}</div> : null}
            {shellLines.map((line, index) => (
              <div key={index} className="whitespace-pre-wrap break-words">{line}</div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-2xl border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm outline-none focus:border-white/30"
              placeholder={copy.shellPlaceholder}
              value={shellCommand}
              onChange={(event) => setShellCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && shellCommand.trim()) {
                  controller?.shellExec(shellCommand.trim());
                  setShellCommand("");
                }
              }}
            />
            <button
              className="rounded-2xl bg-white/90 px-4 py-2 text-sm font-medium text-black disabled:opacity-40"
              disabled={!shellCommand.trim()}
              onClick={() => {
                controller?.shellExec(shellCommand.trim());
                setShellCommand("");
              }}
            >
              <RiTerminalBoxLine size={16} className="mr-1 inline" />{copy.run}
            </button>
          </div>
        </div>
      ) : null}

      {tab === "files" ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-white/10 bg-black/30 p-3 font-mono text-xs">
            {fileLines.length === 0 ? <div className="p-4 text-center text-white/40"><RiFolderOpenLine size={18} className="mr-1 inline" />{copy.tabFiles}</div> : null}
            {fileLines.map((line, index) => (
              <div key={index} className="whitespace-pre-wrap break-words">{line}</div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-2xl border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm outline-none focus:border-white/30"
              placeholder={copy.filesPathPlaceholder}
              value={filePath}
              onChange={(event) => setFilePath(event.target.value)}
            />
            <button className="rounded-2xl bg-white/10 px-3 py-2 text-sm text-white/80 hover:bg-white/20" onClick={() => controller?.fsList(filePath || ".")}>
              <RiFolderOpenLine size={15} className="mr-1 inline" />{copy.list}
            </button>
            <button className="rounded-2xl bg-white/10 px-3 py-2 text-sm text-white/80 hover:bg-white/20" onClick={() => controller?.fsRead(filePath)}>
              <RiFileLine size={15} className="mr-1 inline" />{copy.read}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
