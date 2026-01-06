"use client";

import { useEffect, useState } from "react";

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

  const [sessionId, setSessionId] = useState<string | null>(null);

  // Load saved session on refresh
	useEffect(() => {
	  const saved = localStorage.getItem("rp_session_id");
	  if (!saved) return;

	  setSessionId(saved);

	  (async () => {
		try {
		  const res = await fetch(`${API_URL}/api/messages?session_id=${encodeURIComponent(
			headers: {
				"Content-Type": "application/json",
				"X-Access-Key": process.env.NEXT_PUBLIC_ACCESS_KEY!,
			},
			  saved
			)
			}&limit=50`
		  );
		  if (!res.ok) return;

		  const data = await res.json();
		  // data should be: [{role, content}, ...]
		  setMessages(data);
		} catch {
		  // ignore for now
		}
	  })();
	}, []);


  async function sendMessage() {
    if (!input.trim() || loading) return;

    const userText = input;
    setInput("");
    setLoading(true);

    setMessages((prev) => [
      ...prev,
      { role: "user", content: userText },
      { role: "assistant", content: "Thinking…" },
    ]);

    const t0 = performance.now();

    try {
      const res = await fetch(`${API_URL}/api/chat_stream`, {
        method: "POST",
        headers: {
			"Content-Type": "application/json",
			"X-Access-Key": process.env.NEXT_PUBLIC_ACCESS_KEY!,
		},
        body: JSON.stringify({
          text: userText,
          session_id: sessionId,
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
    }
  }

  return (
    <main className="flex flex-col h-screen max-w-md mx-auto border-x">
      <header className="p-3 border-b text-center font-semibold">
        RP Chat {sessionId ? `· ${sessionId.slice(0, 8)}` : ""}
      </header>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {messages.map((m, i) => (
          <div
            key={i}
            className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
              m.role === "user"
                ? "bg-blue-500 text-white ml-auto"
                : "bg-gray-200 text-gray-900 mr-auto"
            }`}
          >
            {m.content}
          </div>
        ))}
      </div>

      <div className="p-3 border-t flex gap-2">
        <input
          className="flex-1 border rounded px-3 py-2 text-sm"
          placeholder="Type a message…"
          value={input}
          disabled={loading}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") sendMessage();
          }}
        />
        <button
          onClick={sendMessage}
          disabled={loading}
          className="px-4 py-2 rounded bg-blue-600 text-white disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </main>
  );
}
