"use client";

import { useEffect } from "react";
import { MessageSquare, Clock, Plus, ChevronRight, X } from "lucide-react";
import { useLabStore } from "@/lib/store";

interface SessionBrowserProps {
  open: boolean;
  onClose: () => void;
}

export function SessionBrowser({ open, onClose }: SessionBrowserProps) {
  const {
    sessions,
    activeSessionId,
    fetchSessions,
    loadSession,
    clearSession,
    isConnected,
    messages,
  } = useLabStore();

  useEffect(() => {
    if (open && isConnected) {
      fetchSessions();
    }
  }, [open, isConnected, fetchSessions]);

  if (!open) return null;

  const handleNewChat = () => {
    clearSession();
    onClose();
  };

  const handleSelectSession = async (sessionId: string) => {
    await loadSession(sessionId);
    onClose();
  };

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso);
      const now = new Date();
      const diffMs = now.getTime() - d.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      if (diffDays === 0) {
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      } else if (diffDays === 1) {
        return "Yesterday";
      } else if (diffDays < 7) {
        return `${diffDays}d ago`;
      } else {
        return d.toLocaleDateString([], { month: "short", day: "numeric" });
      }
    } catch {
      return "";
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-30" onClick={onClose} />

      {/* Sidebar */}
      <div className="fixed left-0 top-0 bottom-0 z-40 w-72 bg-ax-surface border-r border-ax-border flex flex-col shadow-xl">
        {/* Header */}
        <div className="h-9 border-b border-ax-border flex items-center px-3 shrink-0">
          <span className="text-xs text-ax-text-dim uppercase tracking-wider">
            Conversations
          </span>
          <button
            onClick={onClose}
            className="p-0.5 ml-auto rounded text-ax-text-dim hover:text-ax-text transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* New Chat button */}
        <div className="p-3 border-b border-ax-border">
          <button
            onClick={handleNewChat}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-ax-text bg-ax-primary/15 hover:bg-ax-primary/25 border border-ax-primary/20 transition-colors"
          >
            <Plus className="w-4 h-4" />
            New conversation
          </button>
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-y-auto">
          {sessions.length === 0 && (
            <div className="flex items-center justify-center h-full text-ax-text-dim">
              <div className="text-center p-6">
                <Clock className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-xs">
                  {isConnected
                    ? "No past conversations yet"
                    : "Connect to crew to see history"}
                </p>
              </div>
            </div>
          )}

          {sessions.map((session) => {
            const isActive = session.id === activeSessionId;
            return (
              <button
                key={session.id}
                onClick={() => handleSelectSession(session.id)}
                className={`w-full text-left px-3 py-2.5 border-b border-ax-border/50 transition-colors ${
                  isActive
                    ? "bg-ax-primary/10 border-l-2 border-l-ax-primary"
                    : "hover:bg-ax-surface-hover border-l-2 border-l-transparent"
                }`}
              >
                <div className="flex items-start gap-2">
                  <MessageSquare
                    className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${
                      isActive ? "text-ax-primary" : "text-ax-text-dim"
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div
                      className={`text-xs truncate ${
                        isActive ? "text-ax-primary" : "text-ax-text"
                      }`}
                    >
                      {session.title || "Untitled conversation"}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-ax-text-dim/50">
                        {formatDate(session.started_at)}
                      </span>
                      <span className="text-[10px] text-ax-text-dim/50">
                        {session.turn_count} turn{session.turn_count !== 1 ? "s" : ""}
                      </span>
                    </div>
                  </div>
                  <ChevronRight
                    className={`w-3 h-3 mt-0.5 shrink-0 transition-colors ${
                      isActive ? "text-ax-primary" : "text-ax-text-dim/30"
                    }`}
                  />
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
