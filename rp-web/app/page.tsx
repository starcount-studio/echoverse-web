"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "next-auth/react";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type SSEEvent = {
  event: string;
  data: any;
};

type SessionItem = {
  id: string;
  title: string;
  world_name: string;
  updated_at: string | null;
  archived: boolean;
};

type CharacterSheet = {
  name: string;
  description: string;
  personality: string;
  style: string;
  rules: string;
};

type PlayerSheet = {
  name: string;
  description: string;
  notes: string;
};

function parseSSE(buffer: string): { events: SSEEvent[]; rest: string } {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const events: SSEEvent[] = [];

  for (const part of parts) {
    const lines = part.split("\n").filter(Boolean);

    let event = "message";
    let dataLine = "";

    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) dataLine += line.slice(5).trim();
    }

    if (!dataLine) continue;

    try {
      events.push({ event, data: JSON.parse(dataLine) });
    } catch {
      events.push({ event, data: dataLine });
    }
  }

  return { events, rest };
}

const InputBar = React.memo(function InputBar(props: {
  loading: boolean;
  onSend: (text: string) => void;
}) {
  const { loading, onSend } = props;
  const [text, setText] = useState("");

  return (
    <div
      className="border-t bg-white px-3 py-2 flex gap-2 fixed bottom-0 left-0 right-0 max-w-md mx-auto"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 8px)" }}
    >
      <textarea
        className="flex-1 border rounded px-3 py-2 min-h-11 max-h-28 overflow-y-auto text-base leading-5 resize-none bg-white text-black placeholder:text-gray-500"
        placeholder="Type a message… (Enter = new line, Cmd/Ctrl+Enter = send)"
        value={text}
        disabled={loading}
        rows={1}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            const trimmed = text.trim();
            if (!trimmed || loading) return;
            onSend(trimmed);
            setText("");
          }
        }}
      />
      <button
        onClick={() => {
          const trimmed = text.trim();
          if (!trimmed || loading) return;
          onSend(trimmed);
          setText("");
        }}
        disabled={loading}
        className="px-4 h-11 rounded bg-blue-600 text-white text-base disabled:opacity-50"
      >
        Send
      </button>
    </div>
  );
});

function emptyCharacter(): CharacterSheet {
  return { name: "", description: "", personality: "", style: "", rules: "" };
}

function emptyPlayer(): PlayerSheet {
  return { name: "", description: "", notes: "" };
}

export default function Page() {
  const { data: auth } = useSession();
  const userEmail =
    (auth?.user?.email ?? "").toString().trim().toLowerCase() || null;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);

  const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";
  const ACCESS_KEY = process.env.NEXT_PUBLIC_ACCESS_KEY!;

  const [sessionId, setSessionId] = useState<string | null>(null);

  // Modal + sessions UI
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState<"sessions" | "setup">("sessions");

  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  // Setup state
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupSavedMsg, setSetupSavedMsg] = useState<string | null>(null);

  const [character, setCharacter] = useState<CharacterSheet>(emptyCharacter());
  const [player, setPlayer] = useState<PlayerSheet>(emptyPlayer());

  // refs
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sendInFlightRef = useRef(false);

  // streaming batch refs
  const pendingAssistantTextRef = useRef("");
  const flushTimerRef = useRef<number | null>(null);

  // Auto-scroll when message count changes (not for every delta)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [messages.length]);

  function buildHeaders() {
    return {
      "Content-Type": "application/json",
      "X-Access-Key": ACCESS_KEY,
      "X-User-Email": userEmail ?? "",
    } as Record<string, string>;
  }

  async function fetchSessions() {
    if (!userEmail) return;
    setSessionsLoading(true);
    setSessionsError(null);

    try {
      const res = await fetch(`${API_URL}/api/sessions?limit=50`, {
        headers: buildHeaders(),
      });
      if (!res.ok) throw new Error(await res.text());

      const data = (await res.json()) as SessionItem[];
      setSessions(data);

      const last = localStorage.getItem("rp_last_session_id");
      const lastExists = last && data.some((s) => s.id === last);

      if (!sessionId) {
        const pick = lastExists ? last! : data[0]?.id;
        if (pick) setSessionId(pick);
      }
    } catch (err: any) {
      setSessionsError(err?.message ?? "Failed to load sessions");
    } finally {
      setSessionsLoading(false);
    }
  }

  async function createSession() {
    if (!userEmail) return;
    setSessionsLoading(true);
    setSessionsError(null);

    try {
      const res = await fetch(`${API_URL}/api/sessions`, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({ world_name: "Dev World", title: "New session" }),
      });
      if (!res.ok) throw new Error(await res.text());

      const data = await res.json();
      const sid = data?.session_id as string | undefined;
      if (!sid) throw new Error("No session_id returned");

      setSessionId(sid);
      localStorage.setItem("rp_last_session_id", sid);
      setMessages([]);
      setMenuOpen(false);

      await fetchSessions();
    } catch (err: any) {
      setSessionsError(err?.message ?? "Failed to create session");
    } finally {
      setSessionsLoading(false);
    }
  }

  async function loadMessagesForSession(sid: string) {
    try {
      const res = await fetch(
        `${API_URL}/api/messages?session_id=${encodeURIComponent(sid)}&limit=50`,
        { headers: buildHeaders() }
      );
      if (!res.ok) return;
      const data = await res.json();
      setMessages(data);
    } catch {
      // ignore for now
    }
  }

  async function loadSetupForSession(sid: string) {
    setSetupError(null);
    setSetupSavedMsg(null);

    try {
      // We reuse /api/sessions list to get order/title, but we need state_json.
      // Your backend patch endpoint returns state_json on save; for initial load,
      // simplest is: read session via messages endpoint? Not available.
      // So we keep it lightweight: default empty until you save once.
      //
      // If you want "load existing setup", add GET /api/sessions/{id} that returns state_json.
      // For now: reset local form when switching sessions.
      setCharacter(emptyCharacter());
      setPlayer(emptyPlayer());
    } catch {
      // ignore
    }
  }

  // On login: load sessions
  useEffect(() => {
    if (!userEmail) return;
    fetchSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userEmail]);

  // When sessionId changes: persist + load messages + reset setup form
  useEffect(() => {
    if (!userEmail) return;
    if (!sessionId) return;
    localStorage.setItem("rp_last_session_id", sessionId);
    loadMessagesForSession(sessionId);
    loadSetupForSession(sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, userEmail]);

  async function saveSetup() {
    if (!userEmail) {
      setSetupError("Please sign in first.");
      return;
    }
    if (!sessionId) {
      setSetupError("No session selected.");
      return;
    }

    setSetupLoading(true);
    setSetupError(null);
    setSetupSavedMsg(null);

    try {
      const res = await fetch(`${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/state`, {
        method: "PATCH",
        headers: buildHeaders(),
        body: JSON.stringify({
          character,
          player,
        }),
      });

      if (!res.ok) throw new Error(await res.text());

      setSetupSavedMsg("Saved ✓ (applies immediately to RP)");
    } catch (err: any) {
      setSetupError(err?.message ?? "Failed to save setup");
    } finally {
      setSetupLoading(false);
    }
  }

  async function sendMessage(text: string) {
    if (!text.trim() || loading) return;
    if (sendInFlightRef.current) return;

    if (!userEmail) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "[Auth] Please sign in first." },
      ]);
      return;
    }

    if (!sessionId) {
      setMenuView("sessions");
      setMenuOpen(true);
      return;
    }

    sendInFlightRef.current = true;
    setLoading(true);

    setMessages((prev) => [
      ...prev,
      { role: "user", content: text },
      { role: "assistant", content: "" },
    ]);

    pendingAssistantTextRef.current = "";

    try {
      const res = await fetch(`${API_URL}/api/chat_stream`, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({
          text,
          session_id: sessionId,
          world_name: "Dev World",
        }),
      });

      if (!res.ok) throw new Error(await res.text());
      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const flushAssistant = () => {
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = {
            role: "assistant",
            content: pendingAssistantTextRef.current,
          };
          return next;
        });
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSSE(buffer);
        buffer = parsed.rest;

        for (const evt of parsed.events) {
          if (evt.event === "delta") {
            const delta = evt.data?.text ?? "";
            if (!delta) continue;

            pendingAssistantTextRef.current += delta;

            // throttle UI updates
            if (flushTimerRef.current == null) {
              flushTimerRef.current = window.setTimeout(() => {
                flushTimerRef.current = null;
                flushAssistant();
              }, 100);
            }
          } else if (evt.event === "error") {
            throw new Error(evt.data?.error ?? "Stream error");
          }
        }
      }

      if (flushTimerRef.current != null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      flushAssistant();

      // refresh sessions ordering (updated_at changed)
      fetchSessions();
    } catch (err: any) {
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = {
          role: "assistant",
          content: `[Backend error] ${err?.message ?? "Unknown error"}`,
        };
        return next;
      });
    } finally {
      if (flushTimerRef.current != null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      sendInFlightRef.current = false;
      setLoading(false);
    }
  }

  const onSend = useMemo(
    () => (t: string) => sendMessage(t),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, loading, userEmail]
  );

  return (
    <main className="flex flex-col h-[100dvh] max-w-md mx-auto border-x">
      <header className="p-3 border-b flex items-center justify-between gap-2 shrink-0">
        <div className="font-semibold">
          RP Chat {sessionId ? `· ${sessionId.slice(0, 8)}` : ""}
        </div>

        <button
          onClick={() => {
            setMenuView("sessions");
            setMenuOpen(true);
            fetchSessions();
          }}
          className="px-3 py-1.5 rounded border text-sm bg-white"
        >
          Menu
        </button>
      </header>

      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto px-3 pt-3 pb-28 space-y-2"
      >
        {!userEmail ? (
          <div className="text-sm text-gray-600">
            You’re not signed in yet. Please sign in to load sessions.
          </div>
        ) : null}

        {messages.map((m, i) => (
          <div
            key={i}
            className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-base ${
              m.role === "user"
                ? "bg-blue-500 text-white ml-auto"
                : "bg-gray-200 text-gray-900 mr-auto"
            }`}
          >
            {m.content}
          </div>
        ))}
      </div>

      <InputBar loading={loading} onSend={onSend} />

      {/* Menu Modal */}
      {menuOpen ? (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center">
          <div className="bg-white w-full max-w-md rounded-t-2xl sm:rounded-2xl p-4">
            <div className="flex items-center justify-between">
              <div className="font-semibold">Menu</div>
              <button
                onClick={() => setMenuOpen(false)}
                className="px-3 py-1.5 rounded border text-sm"
              >
                Close
              </button>
            </div>

            <div className="mt-3 flex gap-2">
              <button
                onClick={() => {
                  setMenuView("sessions");
                  fetchSessions();
                }}
                className={`px-3 py-2 rounded text-sm border ${
                  menuView === "sessions" ? "bg-gray-100" : "bg-white"
                }`}
              >
                Sessions
              </button>
              <button
                onClick={() => {
                  setMenuView("setup");
                  if (sessionId) loadSetupForSession(sessionId);
                }}
                className={`px-3 py-2 rounded text-sm border ${
                  menuView === "setup" ? "bg-gray-100" : "bg-white"
                }`}
              >
                Setup
              </button>
            </div>

            {menuView === "sessions" ? (
              <>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={createSession}
                    disabled={sessionsLoading || !userEmail}
                    className="px-3 py-2 rounded bg-blue-600 text-white text-sm disabled:opacity-50"
                  >
                    New session
                  </button>
                  <button
                    onClick={fetchSessions}
                    disabled={sessionsLoading || !userEmail}
                    className="px-3 py-2 rounded border text-sm disabled:opacity-50"
                  >
                    Refresh
                  </button>
                </div>

                {sessionsError ? (
                  <div className="mt-3 text-sm text-red-600 whitespace-pre-wrap">
                    {sessionsError}
                  </div>
                ) : null}

                <div className="mt-3 max-h-80 overflow-y-auto divide-y border rounded">
                  {sessionsLoading ? (
                    <div className="p-3 text-sm text-gray-600">Loading…</div>
                  ) : sessions.length === 0 ? (
                    <div className="p-3 text-sm text-gray-600">
                      No sessions yet. Create one!
                    </div>
                  ) : (
                    sessions.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => {
                          setSessionId(s.id);
                          localStorage.setItem("rp_last_session_id", s.id);
                          setMenuOpen(false);
                        }}
                        className={`w-full text-left p-3 hover:bg-gray-50 ${
                          s.id === sessionId ? "bg-gray-100" : ""
                        }`}
                      >
                        <div className="font-medium text-sm">
                          {s.title || "Untitled"}
                        </div>
                        <div className="text-xs text-gray-600">
                          {s.world_name || "Dev World"}
                          {s.updated_at
                            ? ` · ${new Date(s.updated_at).toLocaleString()}`
                            : ""}
                        </div>
                        <div className="text-xs text-gray-500">{s.id}</div>
                      </button>
                    ))
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="mt-3 text-sm text-gray-700">
                  Saved here applies immediately to the RP (via session state).
                </div>

                {setupError ? (
                  <div className="mt-2 text-sm text-red-600 whitespace-pre-wrap">
                    {setupError}
                  </div>
                ) : null}

                {setupSavedMsg ? (
                  <div className="mt-2 text-sm text-green-700 whitespace-pre-wrap">
                    {setupSavedMsg}
                  </div>
                ) : null}

                <div className="mt-3 space-y-4 max-h-80 overflow-y-auto border rounded p-3">
                  <div>
                    <div className="font-semibold text-sm">AI Character Sheet</div>

                    <label className="block text-xs text-gray-600 mt-2">
                      Name
                    </label>
                    <input
                      className="w-full border rounded px-3 py-2 text-sm"
                      value={character.name}
                      onChange={(e) =>
                        setCharacter((c) => ({ ...c, name: e.target.value }))
                      }
                    />

                    <label className="block text-xs text-gray-600 mt-2">
                      Description (1–3 sentences)
                    </label>
                    <textarea
                      className="w-full border rounded px-3 py-2 text-sm min-h-20"
                      value={character.description}
                      onChange={(e) =>
                        setCharacter((c) => ({
                          ...c,
                          description: e.target.value,
                        }))
                      }
                    />

                    <label className="block text-xs text-gray-600 mt-2">
                      Personality / traits
                    </label>
                    <textarea
                      className="w-full border rounded px-3 py-2 text-sm min-h-20"
                      value={character.personality}
                      onChange={(e) =>
                        setCharacter((c) => ({
                          ...c,
                          personality: e.target.value,
                        }))
                      }
                    />

                    <label className="block text-xs text-gray-600 mt-2">
                      Speaking style
                    </label>
                    <textarea
                      className="w-full border rounded px-3 py-2 text-sm min-h-20"
                      value={character.style}
                      onChange={(e) =>
                        setCharacter((c) => ({ ...c, style: e.target.value }))
                      }
                    />

                    <label className="block text-xs text-gray-600 mt-2">
                      Hard rules / boundaries
                    </label>
                    <textarea
                      className="w-full border rounded px-3 py-2 text-sm min-h-20"
                      value={character.rules}
                      onChange={(e) =>
                        setCharacter((c) => ({ ...c, rules: e.target.value }))
                      }
                    />
                  </div>

                  <div className="border-t pt-3">
                    <div className="font-semibold text-sm">User / Player Sheet</div>

                    <label className="block text-xs text-gray-600 mt-2">
                      Your name (in story)
                    </label>
                    <input
                      className="w-full border rounded px-3 py-2 text-sm"
                      value={player.name}
                      onChange={(e) =>
                        setPlayer((p) => ({ ...p, name: e.target.value }))
                      }
                    />

                    <label className="block text-xs text-gray-600 mt-2">
                      Description (who you are in-story)
                    </label>
                    <textarea
                      className="w-full border rounded px-3 py-2 text-sm min-h-20"
                      value={player.description}
                      onChange={(e) =>
                        setPlayer((p) => ({
                          ...p,
                          description: e.target.value,
                        }))
                      }
                    />

                    <label className="block text-xs text-gray-600 mt-2">
                      Notes (tone, boundaries, preferences)
                    </label>
                    <textarea
                      className="w-full border rounded px-3 py-2 text-sm min-h-20"
                      value={player.notes}
                      onChange={(e) =>
                        setPlayer((p) => ({ ...p, notes: e.target.value }))
                      }
                    />
                  </div>
                </div>

                <div className="mt-3 flex gap-2">
                  <button
                    onClick={saveSetup}
                    disabled={setupLoading || !userEmail || !sessionId}
                    className="px-3 py-2 rounded bg-blue-600 text-white text-sm disabled:opacity-50"
                  >
                    {setupLoading ? "Saving…" : "Save"}
                  </button>

                  <button
                    onClick={() => {
                      setCharacter(emptyCharacter());
                      setPlayer(emptyPlayer());
                      setSetupSavedMsg(null);
                      setSetupError(null);
                    }}
                    className="px-3 py-2 rounded border text-sm"
                  >
                    Clear
                  </button>
                </div>

                <div className="mt-2 text-xs text-gray-500">
                  Tip: after saving, send a message to see the character sheet influence immediately.
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </main>
  );
}
