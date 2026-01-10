"use client";

import { useEffect, useRef, useState } from "react";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type SSEEvent = {
  event: string;
  data: any;
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

export default function Page() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";
  const ACCESS_KEY = process.env.NEXT_PUBLIC_ACCESS_KEY!;

  const [sessionId, setSessionId] = useState<string | null>(null);

  // refs
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sendInFlightRef = useRef(false);

  // streaming batch refs (fix typing lag)
  const pendingAssistantTextRef = useRef("");
  const streamRafRef = useRef<number | null>(null);

  // auto-scroll when messages change
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [messages.length]);

  // load session on refresh
  useEffect(() => {
    const saved = localStorage.getItem("rp_session_id");
    if (!saved) return;

    setSessionId(saved);

    (async () => {
      try {
        const res = await fetch(
          `${API_URL}/api/messages?session_id=${encodeURIComponent(saved)}&limit=50`,
          {
            headers: {
              "Content-Type": "application/json",
              "X-Access-Key": ACCESS_KEY,
            },
          }
        );

        if (!res.ok) return;
        const data = await res.json();
        setMessages(data);
      } catch {}
    })();
  }, [API_URL, ACCESS_KEY]);

  async function sendMessage() {
    if (!input.trim() || loading) return;
    if (sendInFlightRef.current) return;

    sendInFlightRef.current = true;

    const userText = input;
    setInput("");
    setLoading(true);

    setMessages((prev) => [
      ...prev,
      { role: "user", content: userText },
      { role: "assistant", content: "" },
    ]);

    pendingAssistantTextRef.current = "";

    try {
      const res = await fetch(`${API_URL}/api/chat_stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Access-Key": ACCESS_KEY,
        },
        body: JSON.stringify({
          text: userText,
          session_id: sessionId,
          world_name: "Dev World",
        }),
      });

      if (!res.ok) throw new Error(await res.text());
      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSSE(buffer);
        buffer = parsed.rest;

        for (const evt of parsed.events) {
          if (evt.event === "start") {
            const sid = evt.data?.session_id;
            if (sid) {
              setSessionId(sid);
              localStorage.setItem("rp_session_id", sid);
            }
          } else if (evt.event === "delta") {
            const delta = evt.data?.text ?? "";
            if (!delta) continue;

            pendingAssistantTextRef.current += delta;

            if (streamRafRef.current == null) {
              streamRafRef.current = requestAnimationFrame(() => {
                streamRafRef.current = null;

                setMessages((prev) => {
                  const next = [...prev];
                  next[next.length - 1] = {
                    role: "assistant",
                    content: pendingAssistantTextRef.current,
                  };
                  return next;
                });
              });
            }
          } else if (evt.event === "error") {
            throw new Error(evt.data?.error ?? "Stream error");
          }
        }
      }
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
      if (streamRafRef.current != null) {
        cancelAnimationFrame(streamRafRef.current);
        streamRafRef.current = null;
      }

      sendInFlightRef.current = false;
      setLoading(false);
    }
  }

  return (
    <main className="flex flex-col h-[100dvh] max-w-md mx-auto border-x">
      <header className="p-3 border-b text-center font-semibold shrink-0">
        RP Chat {sessionId ? `· ${sessionId.slice(0, 8)}` : ""}
      </header>

      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto px-3 pt-3 pb-28 space-y-2"
      >
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

      <div
        className="border-t bg-white px-3 py-2 flex gap-2 fixed bottom-0 left-0 right-0 max-w-md mx-auto"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 8px)" }}
      >
        <textarea
          className="flex-1 border rounded px-3 py-2 min-h-11 max-h-28 overflow-y-auto text-base leading-5 resize-none bg-white text-black placeholder:text-gray-500"
          placeholder="Type a message… (Enter = new line, Cmd/Ctrl+Enter = send)"
          value={input}
          disabled={loading}
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              (e.ctrlKey || e.metaKey)
            ) {
              e.preventDefault();
              sendMessage();
            }
          }}
        />
        <button
          onClick={sendMessage}
          disabled={loading}
          className="px-4 h-11 rounded bg-blue-600 text-white text-base disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </main>
  );
}
