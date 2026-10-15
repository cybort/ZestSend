import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  PairCodeGuard,
  type HarnessAgentType,
  type HarnessHostMessage,
  type HarnessPermissionMode,
} from "../shared/harness-protocol";
import { HarnessDispatcher } from "./dispatch";
import { SessionManager } from "./sessions";
import { TrustStore } from "./trust-store";
import { SignalingClient } from "./signaling";
import { WeriftPeer } from "./peer";
import { fakeAdapterFactory } from "./adapters/fake";
import { claudeCodeAdapterFactory } from "./adapters/claude-code";
import { copilotCliAdapterFactory } from "./adapters/copilot-cli";
import type { AdapterFactory } from "./adapters/types";

const PUBLIC_STUN = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

type CliOptions = {
  room: string;
  server: string;
  agent: HarnessAgentType;
  workspace: string;
  permission: HarnessPermissionMode;
  stateDir: string;
  label: string;
  allowPatterns: string[];
  denyPatterns: string[];
  binary?: string;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    room: "",
    server: "http://localhost:8787",
    agent: "claude-code",
    workspace: process.cwd(),
    permission: "approve",
    stateDir: join(homedir(), ".zestsend", "harness"),
    label: "remote agent",
    allowPatterns: [],
    denyPatterns: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[(index += 1)] ?? "";
    switch (arg) {
      case "--room": options.room = next(); break;
      case "--server": options.server = next(); break;
      case "--agent": options.agent = next() as HarnessAgentType; break;
      case "--workspace": options.workspace = resolve(next()); break;
      case "--permission": options.permission = next() as HarnessPermissionMode; break;
      case "--state-dir": options.stateDir = resolve(next()); break;
      case "--label": options.label = next(); break;
      case "--allow": options.allowPatterns.push(next()); break;
      case "--deny": options.denyPatterns.push(next()); break;
      case "--binary": options.binary = next(); break;
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!/^\d{6}$/.test(options.room)) {
    throw new Error("Usage: harness-daemon --room <6-digit room> [--server url] [--agent fake|claude-code|copilot-cli] [--workspace dir] [--permission readonly|approve|full]");
  }
  return options;
}

async function iceServersFor(server: string): Promise<Array<{ urls: string | string[]; username?: string; credential?: string }>> {
  try {
    const response = await fetch(`${server}/api/turn/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: 86_400 }),
    });
    if (response.ok) {
      const body = await response.json() as { iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }> };
      if (body.iceServers?.length) return body.iceServers;
    }
  } catch {
    // TURN is optional; STUN-only still works on most networks.
  }
  return PUBLIC_STUN;
}

function factoryFor(agent: HarnessAgentType, binary?: string): AdapterFactory {
  switch (agent) {
    case "fake":
      return fakeAdapterFactory();
    case "copilot-cli":
      return copilotCliAdapterFactory(binary ? { binary } : {});
    case "claude-code":
    default:
      return claudeCodeAdapterFactory(binary ? { binary } : {});
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  mkdirSync(options.stateDir, { recursive: true });

  const trust = await TrustStore.load(options.stateDir);
  const pairCodeGuard = new PairCodeGuard();
  const pairCodeDisplay = (code: string) => {
    console.log(`\n=== ZestSend pairing code: ${code} ===`);
    console.log("Enter this code in the browser's Remote panel to authorize the controller.\n");
  };

  // The fake agent streams one reply and raises a tool request so the remote
  // approval flow can be exercised end to end without a real coding agent.
  const fakeFactory = fakeAdapterFactory({
    reply: ["hello from fake agent"],
    tools: [{
      tool: "shell",
      argsJson: "{\"command\":\"echo hi\"}",
      risk: "medium",
      onAllow: "shell allowed",
      onDeny: "shell denied",
    }],
  });

  let harnessChannel: { send(data: string): void; readyState?: string } | null = null;
  let channelOpen = false;
  let dispatcher: HarnessDispatcher | null = null;

  const sessions = new SessionManager({
    statePath: join(options.stateDir, "sessions.json"),
    factories: { [options.agent]: options.agent === "fake" ? fakeFactory : factoryFor(options.agent, options.binary) },
    send: (message: HarnessHostMessage) => {
      if (harnessChannel && channelOpen) harnessChannel.send(JSON.stringify(message));
    },
  });

  const shellPolicy = {
    permission: options.permission,
    sandboxRoot: options.workspace,
    allowPatterns: options.allowPatterns.length ? options.allowPatterns : undefined,
    denyPatterns: options.denyPatterns.length ? options.denyPatterns : undefined,
  };

  const wsUrl = `${options.server.replace(/^http/, "ws")}/api/rooms/${options.room}/ws`;
  const signaling = new SignalingClient(wsUrl);
  const peer = new WeriftPeer(await iceServersFor(options.server));
  let initiator = false;
  let offerCreated = false;

  const resetPeer = () => {
    peer.close();
    offerCreated = false;
    channelOpen = false;
    harnessChannel = null;
  };

  peer.on("description", ({ type, sdp }) => {
    console.log(`[harness-daemon] sending description: ${type}`);
    signaling.sendSignal({ description: { type, sdp } });
  });
  peer.on("candidate", (candidate) => signaling.sendSignal({ candidate }));
  peer.on("failed", resetPeer);
  peer.on("connected", () => console.log("[harness-daemon] peer connection connected"));
  peer.on("channelOpen", ({ label }) => console.log(`[harness-daemon] channel open: ${label}`));
  peer.on("channelClose", ({ label }) => console.log(`[harness-daemon] channel closed: ${label}`));

  signaling.on("welcome", ({ initiator: isInitiator, peerCount }) => {
    initiator = isInitiator;
    console.log(`[harness-daemon] welcome (initiator=${initiator}, peers=${peerCount})`);
    if (initiator && peerCount > 1 && !offerCreated) {
      offerCreated = true;
      void peer.createOffer();
    }
  });
  signaling.on("negotiate", () => {
    if (initiator && !offerCreated) {
      offerCreated = true;
      void peer.createOffer();
    }
  });
  signaling.on("peerReady", () => {
    if (initiator && !offerCreated) {
      offerCreated = true;
      void peer.createOffer();
    }
  });
  signaling.on("peerLeft", () => {
    resetPeer();
  });
  signaling.on("signal", (payload) => {
    if (payload.description) {
      const type = payload.description.type;
      console.log(`[harness-daemon] signal description: ${type}`);
      if (type === "offer") {
        offerCreated = true;
        void peer.acceptOffer(payload.description);
      } else if (type === "answer") {
        void peer.acceptAnswer(payload.description);
      }
      return;
    }
    if (payload.candidate) void peer.addCandidate(payload.candidate);
  });

  peer.on("channelOpen", ({ label, channel }) => {
    if (label !== "harness") return;
    channelOpen = true;
    harnessChannel = {
      send: (data: string) => {
        try { channel.send(data); } catch { /* channel may have closed */ }
      },
    };
    dispatcher = new HarnessDispatcher({
      transport: {
        send: (message) => {
          if (harnessChannel && channelOpen) harnessChannel.send(JSON.stringify(message));
        },
      },
      trust,
      sessions,
      shellPolicy,
      fsPolicy: { permission: options.permission, sandboxRoot: options.workspace },
      pairCodeGuard,
      agentType: options.agent,
      permission: options.permission,
      onPairCode: pairCodeDisplay,
      stateDir: options.stateDir,
    });
    channel.onmessage = (event) => {
      void dispatcher?.onMessage(String((event as { data: unknown }).data));
    };
    void dispatcher.open();
    console.log(`Harness channel open (agent=${options.agent}, permission=${options.permission}).`);
  });

  // Keep a fresh pairing code on display while the daemon runs.
  const issueCode = () => pairCodeDisplay(pairCodeGuard.issue());
  issueCode();
  const codeTimer = setInterval(issueCode, 110_000);

  console.log(`Joining room ${options.room} at ${options.server} (agent=${options.agent}, permission=${options.permission}).`);
  signaling.connect();

  await new Promise<void>((resolveExit) => {
    const shutdown = () => {
      clearInterval(codeTimer);
      dispatcher?.dispose();
      sessions.dispose();
      peer.close();
      signaling.close();
      resolveExit();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

const isDirectRun = process.argv[1]?.includes("harness");
if (isDirectRun) {
  main().catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
