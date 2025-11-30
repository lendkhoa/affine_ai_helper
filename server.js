import express from "express";

const app = express();
app.use(express.json({ limit: "8mb" }));

app.use((req, res, next) => {
  console.log('\n=== INCOMING REQUEST ===');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Method: ${req.method}`);
  console.log(`URL: ${req.url}`);
  next();
});

// ---------- helpers ----------
function sseHeaders(res) {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
}
function sendSSE(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// extract text from many shapes AFFiNE might send
function extractText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // array of parts like [{type:'input_text', text:'...'}, ...]
    return content
      .map(p => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") return p.text ?? p.content ?? "";
        return "";
      })
      .join("");
  }
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
    // last resort: stringify
    try { return JSON.stringify(content); } catch { return String(content); }
  }
  return String(content);
}

function normalizeOneMessage(m) {
  const role = (m?.role === "system" || m?.role === "assistant" || m?.role === "user")
    ? m.role : "user";
  const content = extractText(m?.content);
  return { role, content };
}

function normalizeMessagesFromBody(body) {
  // 1) If body.messages exists and is array, normalize those
  if (Array.isArray(body?.messages)) {
    return body.messages.map(normalizeOneMessage);
  }

  // 2) Responses API often uses `input`
  const input = body?.input;

  //   2a) input is already an array of messages
  if (Array.isArray(input) && input.length && (input[0]?.role || input[0]?.content)) {
    return input.map(normalizeOneMessage);
  }

  //   2b) input is a single message-like object
  if (input && typeof input === "object" && ("role" in input || "content" in input)) {
    return [normalizeOneMessage(input)];
  }

  //   2c) input is array of parts / strings
  if (Array.isArray(input)) {
    return [{ role: "user", content: extractText(input) }];
  }

  //   2d) input is plain text or something else
  return [{ role: "user", content: extractText(input) }];
}

async function passthru(req, res, path) {
  const r = await fetch(`${process.env.LITELLM_URL}${path}`, {
    method: req.method,
    headers: {
      "Authorization": `Bearer ${process.env.LITELLM_KEY || ""}`,
      "Content-Type": req.get("content-type") || "application/json",
    },
    body: ["GET","HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body),
  });
  res.status(r.status);
  r.headers.forEach((v, k) => { if (!["content-length","transfer-encoding"].includes(k)) res.setHeader(k, v); });
  if (!r.body) return res.end();
  const reader = r.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

// ---------- /v1/models - Custom implementation for Ollama ----------
app.get("/v1/models", async (req, res) => {
  console.log('=== MODELS LIST REQUEST ===');
  try {
    // Call Ollama's /api/tags endpoint
    const ollamaResponse = await fetch(`${process.env.LITELLM_URL}/api/tags`);
    
    if (!ollamaResponse.ok) {
      console.error(`Ollama error: ${ollamaResponse.status}`);
      return res.status(ollamaResponse.status).json({ 
        error: `Failed to fetch models from Ollama: ${ollamaResponse.statusText}` 
      });
    }
    
    const ollamaData = await ollamaResponse.json();
    console.log('Ollama models:', ollamaData.models?.map(m => m.name));
    
    // Transform Ollama format to OpenAI format
    const models = (ollamaData.models || []).map(model => ({
      id: model.name,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'ollama',
    }));
    
    const response = {
      object: 'list',
      data: models
    };
    
    console.log('Returning models:', models.map(m => m.id));
    res.json(response);
  } catch (error) {
    console.error('Error fetching models:', error.message);
    res.status(500).json({ 
      error: error.message,
      details: 'Failed to connect to Ollama. Make sure Ollama is running.'
    });
  }
});

// ---------- /v1/responses adapter ----------
app.post("/v1/responses", async (req, res) => {
  console.log('=== RESPONSES REQUEST ===');
  console.log('Model:', req.body?.model);
  console.log('Stream:', req.body?.stream);
  
  try {
    const { model, stream = true } = req.body || {};
    // Normalize to OpenAI chat messages (strings only)
    const messages = normalizeMessagesFromBody(req.body);

    // Allowed upstream params (avoid leaking unknown keys like toolsConfig)
    const {
      temperature, top_p, max_tokens, presence_penalty, frequency_penalty, stop, user, n
    } = req.body || {};

    // Stable IDs for Responses clients
    const uuid = (globalThis.crypto?.randomUUID?.() || (await import("crypto")).randomUUID()).replace(/-/g,"");
    const msgId  = `msg_${uuid}`;
    const respId = `resp_${Buffer.from(`shim:${Date.now()}:${msgId}`).toString("base64")}`;
    const now    = Math.floor(Date.now()/1000);

    if (!stream) {
      // one-shot non-streaming
      const r = await fetch(`${process.env.LITELLM_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.LITELLM_KEY || ""}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model, messages, stream: false,
          temperature, top_p, max_tokens, presence_penalty, frequency_penalty, stop, user, n
        }),
      });
      const j = await r.json();
      const out = j?.choices?.[0]?.message?.content ?? "";
      return res.json({
        id: respId,
        object: "response",
        model,
        status: "completed",
        created_at: now,
        output: [{
          type: "message",
          id: msgId,
          role: "assistant",
          content: [{ type: "output_text", text: out, annotations: [] }],
        }],
        usage: j?.usage ?? {},
      });
    }

    // streaming branch
    sseHeaders(res);

    // prelude required by Vercel AI/Responses consumers (AFFiNE)
    sendSSE(res, { type: "response.created", response: { id: respId, object: "response", model, created_at: now }});
    sendSSE(res, {
      type: "response.output_item.added",
      output_index: 0,
      item: { id: msgId, type: "message", role: "assistant", status: "in_progress", content: [] }
    });
    sendSSE(res, {
      type: "response.content_part.added",
      item_id: msgId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] }
    });

    const upstream = await fetch(`${process.env.LITELLM_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.LITELLM_KEY || ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model, messages, stream: true,
        temperature, top_p, max_tokens, presence_penalty, frequency_penalty, stop, user, n
      }),
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      console.error('Upstream error:', upstream.status, text.slice(0, 300));
      // Signal error in Responses shape so client surfaces it
      sendSSE(res, {
        type: "response.error",
        error: { message: `Upstream ${upstream.status}: ${text.slice(0,300)}` }
      });
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    let full = "";
    let buffer = "";
    const reader = upstream.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() || "";
      for (const raw of chunks) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          // finish events
          sendSSE(res, { type: "response.output_text.done", item_id: msgId, output_index: 0, content_index: 0, text: full });
          sendSSE(res, {
            type: "response.content_part.done",
            item_id: msgId, output_index: 0, content_index: 0,
            part: { type: "output_text", text: full, annotations: [] }
          });
          sendSSE(res, {
            type: "response.output_item.done",
            output_index: 0,
            item: { id: msgId, type: "message", role: "assistant",
              content: [{ type: "output_text", text: full, annotations: [] }]
            }
          });
          sendSSE(res, {
            type: "response.completed",
            response: {
              id: respId, object: "response", model, status: "completed", created_at: now,
              output: [{ type: "message", id: msgId, role: "assistant",
                content: [{ type: "output_text", text: full, annotations: [] }] }],
              usage: {}
            }
          });
          res.write("data: [DONE]\n\n");
          return res.end();
        }
        let obj;
        try { obj = JSON.parse(data); } catch { continue; }
        const delta = obj?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length) {
          full += delta;
          sendSSE(res, {
            type: "response.output_text.delta",
            item_id: msgId, output_index: 0, content_index: 0, delta
          });
        }
      }
    }
    res.end();
  } catch (err) {
    console.error('Response error:', err);
    // defensive error reporting to client in Responses shape
    sseHeaders(res);
    sendSSE(res, { type: "response.error", error: { message: (err?.message || "adapter error") } });
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

// ---------- /v1/chat/completions - For direct OpenAI compatibility ----------
app.post('/v1/chat/completions', async (req, res) => {
  console.log('\n=== CHAT COMPLETION REQUEST ===');
  console.log('Model:', req.body?.model);
  console.log('Stream:', req.body?.stream);
  console.log('Messages count:', req.body?.messages?.length);
  
  // Just pass through to Ollama
  await passthru(req, res, '/v1/chat/completions');
});

// ---------- pass-throughs ----------
app.post("/v1/embeddings", (req, res) => passthru(req, res, "/v1/embeddings"));
app.all("*", (req, res) => {
  console.log('Unknown endpoint, attempting passthrough:', req.originalUrl);
  passthru(req, res, req.originalUrl);
});

// ---------- start ----------
const PORT = process.env.PORT || 4011;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 responses-adapter listening on ${PORT}`);
  console.log(`📍 Local: http://localhost:${PORT}`);
  console.log(`🐳 Docker: http://host.docker.internal:${PORT}`);
  console.log(`🤖 Ollama: ${process.env.LITELLM_URL || 'http://localhost:11434'}\n`);
});