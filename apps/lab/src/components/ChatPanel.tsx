"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { Send, Loader2, ChevronDown, Plus, MessageSquare } from "lucide-react";
import { useLabStore } from "@/lib/store";

export function ChatPanel() {
  const {
    messages,
    isChatStreaming,
    streamingStatus,
    streamingAnswer,
    addMessage,
    setIsChatStreaming,
    setStreamingStatus,
    appendStreamingAnswer,
    resetCurrentTrace,
    updateCurrentTrace,
    addToolCall,
    updateToolCall,
    isConnected,
    backendUrl,
    selectedModel,
    isAgentForced,
    availableModels,
    fetchModels,
    setSelectedModel,
    clearSession,
  } = useLabStore();

  const [input, setInput] = useState("");
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch available models when backend connects
  useEffect(() => {
    if (isConnected && availableModels.length === 0) {
      fetchModels();
    }
  }, [isConnected, availableModels.length, fetchModels]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isChatStreaming) return;

    setInput("");
    addMessage({ role: "user", content: text });
    resetCurrentTrace();
    setIsChatStreaming(true);
    setStreamingStatus("Classifying your request...");

    if (!isConnected) {
      setStreamingStatus(null);
      setIsChatStreaming(false);
      addMessage({
        role: "agent",
        content: "Backend not connected. Start the crew server to chat.",
      });
      return;
    }

    // SSE from ax-brain-crew (OpenAI-compatible + named events)
    try {
      setStreamingStatus("Routing...");
      const res = await fetch(`${backendUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: selectedModel,
          messages: [...messages, { role: "user", content: text }].map(m => ({
            role: m.role,
            content: m.content,
          })),
          stream: true,
        }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No stream");

      const decoder = new TextDecoder();
      let buffer = "";
      let fullAnswer = "";
      let currentEventType = "";

      setStreamingStatus("Agent thinking...");
      updateCurrentTrace({ isStreaming: true });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();

          // Named SSE events (event: route_decision, event: tool_call)
          if (trimmed.startsWith("event: ")) {
            currentEventType = trimmed.slice(7).trim();
            continue;
          }

          if (trimmed.startsWith("data: ")) {
            const isDone = trimmed === "data: [DONE]";
            if (isDone) continue;

            try {
              const json = JSON.parse(trimmed.slice(6));

              // Named events: route_decision, tool_call, langfuse
              if (currentEventType === "route_decision" && json.kind === "route") {
                updateCurrentTrace({
                  routeDecision: {
                    agent: json.agent ?? "crew",
                    model: "",
                    mechanism: json.detail ?? "",
                  },
                });
                setStreamingStatus(`Routed to ${json.agent ?? "crew"}`);
                currentEventType = "";
                continue;
              }

              if (currentEventType === "langfuse" && json.kind === "langfuse") {
                updateCurrentTrace({ langfuseUrl: json.langfuseUrl ?? null });
                currentEventType = "";
                continue;
              }

              if (currentEventType === "tool_call" && json.kind === "tool") {
                setStreamingStatus(`Calling ${json.tool}...`);
                addToolCall({
                  id: json.callId ?? crypto.randomUUID(),
                  name: json.tool ?? "unknown",
                  args: json.args ?? {},
                  source: json.source,
                  durationMs: 0,
                  timestamp: Date.now(),
                });
                currentEventType = "";
                continue;
              }

              if (currentEventType === "tool_call" && json.kind === "tool_result") {
                setStreamingStatus(`Received result from ${json.tool}...`);
                if (json.callId) {
                  updateToolCall(json.callId, {
                    result: json.result,
                    durationMs: json.callId
                      ? Date.now() - (useLabStore.getState().currentTrace.toolCalls.find((tc) => tc.id === json.callId)?.timestamp ?? Date.now())
                      : 0,
                  });
                }
                currentEventType = "";
                continue;
              }

              // Standard OpenAI-compatible: choices[0].delta.content
              const content = json.choices?.[0]?.delta?.content;
              if (content) {
                fullAnswer += content;
                appendStreamingAnswer(content);
                if (fullAnswer.length > 20) {
                  setStreamingStatus(null);
                }
              }
            } catch {
              // Skip unparseable lines
            }

            currentEventType = "";
          }
        }
      }

      // Done streaming
      const finalAnswer = fullAnswer || useLabStore.getState().streamingAnswer || "";
      setStreamingStatus(null);
      updateCurrentTrace({ isStreaming: false });

      if (finalAnswer) {
        addMessage({
          role: "agent",
          content: finalAnswer,
          trace: { ...useLabStore.getState().currentTrace },
        });
      }
    } catch (e) {
      setStreamingStatus(null);
      setIsChatStreaming(false);
      addMessage({
        role: "agent",
        content: `Error: ${e instanceof Error ? e.message : "Failed to connect"}`,
      });
      return;
    }

    setIsChatStreaming(false);
  }, [
    input,
    isChatStreaming,
    isConnected,
    backendUrl,
    addMessage,
    setIsChatStreaming,
    resetCurrentTrace,
    updateCurrentTrace,
    addToolCall,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const hasMessages = messages.length > 0;

  return (
    <div className="h-full flex flex-col bg-ax-surface">
      {/* Header */}
      <div className="h-9 border-b border-ax-border flex items-center px-3 shrink-0 gap-2">
        <span className="text-xs text-ax-text-dim uppercase tracking-wider">
          Chat
        </span>

        {/* New Chat button */}
        <button
          onClick={() => clearSession()}
          disabled={isChatStreaming}
          className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded text-ax-text-dim hover:text-ax-text hover:bg-ax-surface-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="New conversation"
        >
          <Plus className="w-3 h-3" />
          <span>New</span>
        </button>

        {/* Agent Selector */}
        <div className="relative">
          <button
            onClick={() => setModelDropdownOpen(!modelDropdownOpen)}
            disabled={isChatStreaming || availableModels.length === 0}
            className={`flex items-center gap-1 text-[11px] px-2 py-0.5 rounded transition-colors ${
              isAgentForced
                ? "bg-ax-accent/15 text-ax-accent border border-ax-accent/30"
                : "text-ax-text-dim hover:text-ax-text hover:bg-ax-surface-hover"
            }`}
          >
            <span className="font-mono">{selectedModel}</span>
            <ChevronDown className={`w-3 h-3 transition-transform ${modelDropdownOpen ? "rotate-180" : ""}`} />
          </button>

          {modelDropdownOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setModelDropdownOpen(false)}
              />
              <div className="absolute top-full left-0 mt-1 z-20 w-48 bg-ax-surface border border-ax-border rounded-lg shadow-lg overflow-hidden">
                {availableModels.map((model) => {
                  const isSelected = model === selectedModel;
                  const isCrew = model === "crew";
                  return (
                    <button
                      key={model}
                      onClick={() => {
                        setSelectedModel(model);
                        setModelDropdownOpen(false);
                      }}
                      className={`w-full flex items-center justify-between px-3 py-1.5 text-xs text-left transition-colors ${
                        isSelected
                          ? "bg-ax-primary/15 text-ax-primary"
                          : "text-ax-text-dim hover:bg-ax-surface-hover hover:text-ax-text"
                      }`}
                    >
                      <span className="font-mono">{model}</span>
                      {isCrew && (
                        <span className="text-[9px] text-ax-text-dim/50">auto-route</span>
                      )}
                      {isSelected && (
                        <span className="text-[9px] text-ax-primary">●</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {isChatStreaming && (
          <Loader2 className="w-3 h-3 ml-auto text-ax-primary animate-spin" />
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {!hasMessages && (
          <div className="flex items-center justify-center h-full text-ax-text-dim">
            <div className="text-center">
              <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p className="text-xs">{isConnected ? "Start a new conversation" : "Backend not connected"}</p>
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i}>
            {msg.role === "user" ? (
              <div className="flex justify-end mb-1">
                <div className="bg-ax-primary/15 text-ax-text rounded-lg px-3 py-2 max-w-[85%] text-sm">
                  {msg.content}
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <div className="w-5 h-5 rounded-full bg-ax-primary/30 flex items-center justify-center shrink-0 mt-0.5">
                  <span className="text-[10px] text-ax-primary">A</span>
                </div>
                <div className="text-sm text-ax-text whitespace-pre-wrap">
                  {msg.content}
                </div>
              </div>
            )}
          </div>
        ))}

        {isChatStreaming && (
          <div className="flex gap-2">
            <div className="w-5 h-5 rounded-full bg-ax-primary/30 flex items-center justify-center shrink-0 mt-0.5">
              <Loader2 className="w-3 h-3 text-ax-primary animate-spin" />
            </div>
            <div>
              {streamingStatus && (
                <div className="text-xs text-ax-accent mb-1">{streamingStatus}</div>
              )}
              {streamingAnswer !== null && (
                <div className="text-sm text-ax-text whitespace-pre-wrap">
                  {streamingAnswer || "\u00A0"}
                  <span className="inline-block w-1.5 h-4 bg-ax-primary animate-pulse ml-0.5 align-middle" />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-ax-border p-3">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isConnected ? "Ask the crew..." : "Crew not connected"}
            className="flex-1 bg-ax-bg border border-ax-border rounded-lg px-3 py-2 text-sm text-ax-text placeholder:text-ax-text-dim focus:outline-none focus:border-ax-primary/50"
            disabled={isChatStreaming}
          />
          <button
            onClick={handleSend}
            disabled={isChatStreaming || !input.trim()}
            className="p-2 rounded-lg bg-ax-primary text-white hover:bg-ax-primary-dim disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
