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

  // ✅ Step 1: Auto-scroll anchor + scroll container ref
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // ✅ Auto-scroll whenever messages change (initial load + new messages)
  useEffect(() => {
	  const el = scrollRef.current;
	  if (!el) return;

	  // wait for layout to settle, then jump to bottom
	  requestAnimationFrame(() => {
		el.scrollTop = el.scrollHeight;
	  });
	}, [messages.length]);


  // ✅ Step 3 helper: ensures we don't send with a missing session due to timing.
  // We rely on backend returning session_id in the SSE "start" event.
  // So we don't "create session" separately — we just avoid rapid double-sends.
  const sendInFlightRef = useRef(false);

  // Load saved session on refresh
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
      } catch {
        // ignore for now
      }
    })();
  }, [API_URL, ACCESS_KEY]);

  async function sendMessage() {
    if (!input.trim() || loading) return;
    if (sendInFlightRef.current) return; // ✅ Step 3: prevent rapid double send (mobile taps / Enter)
    sendInFlightRef.current = true;

    const userText = input;
    setInput("");
    setLoading(true);

    setMessages((prev) => [
      ...prev,
      { role: "user", content: userText },
      { role: "assistant", content: "Thinking…" },
    ]);

    // Immediately keep the view pinned to bottom when sending
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    }, 0);

    const t0 = performance.now();

    try {
      const res = await fetch(`${API_URL}/api/chat_stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Access-Key": ACCESS_KEY,
        },
        body: JSON.stringify({
          text: userText,
          session_id: sessionId, // may be null on first-ever mobile use; backend should create and return one
          world_name: "Dev World",
        }),
      });

      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || `HTTP ${res.status}`);
      }
      if (!res.body) throw new Error("No response body (stream not supported?)");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      // Replace "Thinking…" with empty assistant message so we can stream into it
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = { role: "assistant", content: "" };
        return next;
      });

      let buffer = "";
      let reqId: string | undefined;
      let finalMeta: any = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSSE(buffer);
        buffer = parsed.rest;

        for (const evt of parsed.events) {
          if (evt.event === "start") {
            reqId = evt.data?.req_id;
            const sid = evt.data?.session_id;

            // ✅ Step 3: capture session as soon as backend tells us
            if (sid) {
              setSessionId(sid);
              localStorage.setItem("rp_session_id", sid);
            }
          } else if (evt.event === "delta") {
            const delta = evt.data?.text ?? "";
            if (!delta) continue;

            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              next[next.length - 1] = {
                role: "assistant",
                content: (last?.content ?? "") + delta,
              };
              return next;
            });

            // Keep pinned to bottom while streaming
            messagesEndRef.current?.scrollIntoView({
              behavior: "auto",
              block: "end",
            });
          } else if (evt.event === "meta") {
            finalMeta = evt.data;
          } else if (evt.event === "error") {
            throw new Error(evt.data?.error ?? "Backend streaming error");
          }
        }
      }

      const roundtripMs = performance.now() - t0;

      console.log("[chat_stream timing]", {
        frontend_roundtrip_ms: Math.round(roundtripMs),
        req_id: reqId ?? finalMeta?.req_id,
        session_id: finalMeta?.session_id ?? sessionId,
        backend: finalMeta?.timing_ms,
      });

      // Append timing line (debug)
      if (finalMeta?.timing_ms) {
        const t = finalMeta.timing_ms;

        const db =
          t.db_total !== undefined
            ? ` · db_total ${t.db_total}ms (resolve ${t.db_resolve_session}ms, user_ins ${t.db_add_user_message}ms, asst_ins ${t.db_add_assistant_message}ms)`
            : "";

        const timingLine =
          `\n\n⏱ front ${Math.round(roundtripMs)}ms · ` +
          `backend ${t.backend_total}ms · ` +
          `first_token ${t.first_token}ms` +
          db;

        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = {
            role: "assistant",
            content: (next[next.length - 1]?.content ?? "") + timingLine,
          };
          return next;
        });
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
      setLoading(false);
      sendInFlightRef.current = false;
    }
  }

	return (
	  <main className="flex flex-col h-[100dvh] max-w-md mx-auto border-x">
		<header className="p-3 border-b text-center font-semibold shrink-0">
		  RP Chat {sessionId ? `· ${sessionId.slice(0, 8)}` : ""}
		</header>

		{/* Messages */}
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

		  {/* bottom spacer */}
		  <div ref={messagesEndRef} />
		</div>

		{/* Input bar */}
		<div
		  className="border-t bg-white px-3 py-2 flex gap-2 fixed bottom-0 left-0 right-0 max-w-md mx-auto"
		  style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 8px)" }}
		>
		  <textarea
			className="flex-1 border rounded px-3 py-2 min-h-11 max-h-28 overflow-y-auto text-base leading-5 resize-none bg-white text-black placeholder:text-gray-500"

			placeholder="Type a message… (Enter = new line, Ctrl/Cmd+Enter = send)"
			value={input}
			disabled={loading}
			rows={1}
			onChange={(e) => setInput(e.target.value)}
			onKeyDown={(e) => {
			  // Enter should make a new line by default
			  // Ctrl+Enter (Windows) / Cmd+Enter (Mac) sends
			  const isSendCombo = (e.key === "Enter" && (e.ctrlKey || e.metaKey));
			  if (isSendCombo) {
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
