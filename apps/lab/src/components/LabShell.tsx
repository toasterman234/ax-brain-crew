"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  MessageSquare,
  GitBranch,
  Code2,
  Puzzle,
  PanelRight,
  Activity,
  FlaskConical,
  History,
  PenTool,
  Database,
  Network,
} from "lucide-react";
import { useLabStore } from "@/lib/store";
import dynamic from "next/dynamic";
import { ChatPanel } from "./ChatPanel";
import { TracePanel } from "./TracePanel";
import { InspectorDrawer } from "./InspectorDrawer";
import { ComponentsPanel } from "./ComponentsPanel";
import { SessionBrowser } from "./SessionBrowser";
import { RunsHistoryPanel } from "./RunsHistoryPanel";
import { DatasetBuilderPanel } from "./DatasetBuilderPanel";
import { OrchestratorLab } from "./OrchestratorLab";

const NotebookPanel = dynamic(
  () => import("./NotebookPanel").then((mod) => mod.NotebookPanel),
  {
    ssr: false,
    loading: () => (
      <div className="h-full flex items-center justify-center text-ax-text-dim">
        <div className="text-center">
          <div className="w-5 h-5 border-2 border-ax-primary/30 border-t-ax-primary rounded-full animate-spin mx-auto mb-2" />
          <p className="text-xs">Loading notebook...</p>
        </div>
      </div>
    ),
  }
);

const EvalPanel = dynamic(
  () => import("./EvalPanel").then((mod) => mod.EvalPanel),
  {
    ssr: false,
    loading: () => (
      <div className="h-full flex items-center justify-center text-ax-text-dim">
        <div className="text-center">
          <div className="w-5 h-5 border-2 border-ax-primary/30 border-t-ax-primary rounded-full animate-spin mx-auto mb-2" />
          <p className="text-xs">Loading eval panel...</p>
        </div>
      </div>
    ),
  }
);

const SignatureBuilder = dynamic(
  () => import("./SignatureBuilder").then((mod) => mod.SignatureBuilder),
  {
    ssr: false,
    loading: () => (
      <div className="h-full flex items-center justify-center text-ax-text-dim">
        <div className="text-center">
          <div className="w-5 h-5 border-2 border-ax-primary/30 border-t-ax-primary rounded-full animate-spin mx-auto mb-2" />
          <p className="text-xs">Loading builder...</p>
        </div>
      </div>
    ),
  }
);


type Tab = "chat-trace" | "notebook" | "eval" | "components" | "builder";

const tabs: { id: Tab; label: string; icon: typeof MessageSquare }[] = [
  { id: "chat-trace", label: "Chat & Trace", icon: MessageSquare },
  { id: "builder", label: "Builder", icon: PenTool },
  { id: "notebook", label: "Notebook", icon: Code2 },
  { id: "eval", label: "Eval & Optimize", icon: FlaskConical },
  { id: "components", label: "Components", icon: Puzzle },
];

export function LabShell() {
  const {
    activePanel,
    setActivePanel,
    inspectorOpen,
    toggleInspector,
    isConnected,
    backendUrl,
    setConnected,
    loadBench,
    clearSession,
    showDatasetBuilder,
    setShowDatasetBuilder,
  } = useLabStore();

  const [connectionStatus, setConnectionStatus] = useState<
    "checking" | "connected" | "demo"
  >("checking");
  const [sessionBrowserOpen, setSessionBrowserOpen] = useState(false);
  const [orchestratorOpen, setOrchestratorOpen] = useState(false);

  useEffect(() => {
    async function check() {
      try {
        const res = await fetch(`${backendUrl}/health`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          setConnected(true);
          setConnectionStatus("connected");
          // Load the shared shelf once the backend is reachable
          loadBench();
        } else {
          setConnectionStatus("demo");
        }
      } catch {
        setConnected(false);
        setConnectionStatus("demo");
      }
    }
    check();
  }, [backendUrl, setConnected, loadBench]);

  return (
    <div className="h-screen flex flex-col bg-ax-bg">
      {/* Top bar */}
      <header className="h-10 border-b border-ax-border flex items-center px-3 shrink-0">
        <div className="flex items-center gap-2 mr-4">
          <Activity className="w-4 h-4 text-ax-accent" />
          <span className="text-sm font-medium text-ax-text">Ax Visual Lab</span>
        </div>

        <nav className="flex gap-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activePanel === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActivePanel(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs transition-colors ${
                  isActive
                    ? "bg-ax-primary/20 text-ax-primary"
                    : "text-ax-text-dim hover:text-ax-text hover:bg-ax-surface-hover"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          {/* Connection indicator */}
          <div className="flex items-center gap-1.5">
            <div
              className={`w-2 h-2 rounded-full ${
                connectionStatus === "connected"
                  ? "bg-ax-success"
                  : connectionStatus === "checking"
                    ? "bg-ax-warn animate-pulse"
                    : "bg-ax-text-dim"
              }`}
            />
            <span className="text-xs text-ax-text-dim">
              {connectionStatus === "connected"
                ? "crew connected"
                : connectionStatus === "checking"
                  ? "checking..."
                  : "demo mode"}
            </span>
          </div>

          <button
            onClick={() => setOrchestratorOpen(true)}
            className={`p-1 rounded transition-colors ${
              orchestratorOpen
                ? "bg-ax-primary/20 text-ax-primary"
                : "text-ax-text-dim hover:text-ax-text"
            }`}
            title="Orchestrator Lab"
          >
            <Network className="w-4 h-4" />
          </button>

          <button
            onClick={() => setShowDatasetBuilder(!showDatasetBuilder)}
            className={`p-1 rounded transition-colors ${
              showDatasetBuilder
                ? "bg-ax-primary/20 text-ax-primary"
                : "text-ax-text-dim hover:text-ax-text"
            }`}
            title="Dataset Builder"
          >
            <Database className="w-4 h-4" />
          </button>

          <button
            onClick={() => setSessionBrowserOpen(true)}
            className={`p-1 rounded transition-colors ${
              sessionBrowserOpen
                ? "bg-ax-primary/20 text-ax-primary"
                : "text-ax-text-dim hover:text-ax-text"
            }`}
            title="Conversations"
          >
            <History className="w-4 h-4" />
          </button>

          <button
            onClick={toggleInspector}
            className={`p-1 rounded transition-colors ${
              inspectorOpen
                ? "bg-ax-primary/20 text-ax-primary"
                : "text-ax-text-dim hover:text-ax-text"
            }`}
          >
            <PanelRight className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Session browser sidebar */}
      <SessionBrowser
        open={sessionBrowserOpen}
        onClose={() => setSessionBrowserOpen(false)}
      />

      {/* Run history panel */}
      <RunsHistoryPanel />

      {/* Orchestrator Lab — experiment surface (full-screen overlay) */}
      {orchestratorOpen && (
        <OrchestratorLab onClose={() => setOrchestratorOpen(false)} />
      )}

      {/* Dataset Builder panel */}
      {showDatasetBuilder && (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => setShowDatasetBuilder(false)}
          />
          <div className="fixed right-0 top-0 bottom-0 z-40 w-[900px] bg-ax-surface border-l border-ax-border flex flex-col shadow-xl">
            <div className="flex-1 min-h-0">
              <DatasetBuilderPanel />
            </div>
          </div>
        </>
      )}

      {/* Main content */}
      <div className="flex-1 min-h-0">
        <PanelGroup direction="horizontal">
          {/* Chat & Trace panel */}
          <Panel defaultSize={inspectorOpen ? 45 : 55} minSize={30}>
            {activePanel === "chat-trace" && (
              <PanelGroup direction="horizontal">
                <Panel defaultSize={50} minSize={25}>
                  <ChatPanel />
                </Panel>
                <PanelResizeHandle className="w-1 bg-ax-border hover:bg-ax-primary/50 transition-colors" />
                <Panel defaultSize={50} minSize={25}>
                  <TracePanel />
                </Panel>
              </PanelGroup>
            )}

            {activePanel === "notebook" && <NotebookPanel />}

            {activePanel === "builder" && <SignatureBuilder />}

            {activePanel === "eval" && <EvalPanel />}

            {activePanel === "components" && <ComponentsPanel />}
          </Panel>

          {/* Inspector */}
          {inspectorOpen && (
            <>
              <PanelResizeHandle className="w-1 bg-ax-border hover:bg-ax-primary/50 transition-colors" />
              <Panel defaultSize={25} minSize={20} maxSize={40}>
                <InspectorDrawer />
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>
    </div>
  );
}
