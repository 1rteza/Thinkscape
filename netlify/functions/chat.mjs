// Netlify Function v2: streaming proxy to Groq (OpenAI-compatible). The key stays server-side.
const LIMIT = 3, WINDOW = 3600e3, MAX_BODY = 10240;
const hits = new Map(); // ip -> timestamps (in-memory, best effort per warm instance)

const SYSTEM = `You are Thinkscape, a concise assistant and an elite web designer.
1. If the user asks to build, create or design a website or web page, respond in EXACTLY this format and nothing outside the tags:
<plan>
- 4 to 6 short steps (e.g. Layout skeleton, Color and typography, Hero section, Features, Interactions)
</plan>
<site>
one complete, self-contained HTML file, written top to bottom in build order: head and styles, then sections in page order, then scripts
</site>
<summary>one friendly sentence about what was built</summary>
Design rules for the site. It must look like a premium agency-made page, never a plain template:
- Invent a specific brand name and write real, vivid copy for that business. No lorem ipsum, no placeholders.
- 6 to 8 sections: sticky nav, hero with a strong headline and two buttons, features or services cards, an about or story block, testimonials, pricing or menu or gallery, a call to action, a footer.
- Pick a cohesive palette and define it as CSS variables. Use 2 Google Fonts (a display font plus a clean sans), a clear type scale, generous whitespace.
- Use gradients, soft shadows, rounded corners, hover and transition effects, CSS grid and flexbox. Fully responsive, with a mobile menu or stacked layout.
- No external images. Build visuals from CSS gradients, shapes, emoji and inline SVG.
- Add small JS: smooth scrolling, scroll-reveal with IntersectionObserver, and one interactive touch (tabs, toggle or counter).
- Keep CSS compact with shared classes so the whole file stays under about 14000 characters.
2. For anything else, answer normally in plain text with no tags, concisely.
3. Never put anything outside the tags in build mode. No markdown code fences.`;

const json = (o, status = 200, h = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...h } });

export default async (req, context) => {
  if (req.method !== "POST") return json({ error: "Use POST." }, 405, { allow: "POST" });
  // Same-origin only: reject browsers calling from another site
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(req.url).host) return json({ error: "Cross-origin requests are not allowed." }, 403);

  const key = process.env.GROQ_API_KEY;
  if (!key) return json({ error: "Server is missing GROQ_API_KEY." }, 500);

  const ip = context.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW);
  if (recent.length >= LIMIT)
    return json({ error: "Demo limit reached.", code: "limit" }, 429, { "retry-after": String(Math.ceil((WINDOW - (now - recent[0])) / 1000)) });

  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ error: "Request too large (10 KB max)." }, 413);
  let messages;
  try { messages = JSON.parse(raw).messages; } catch { return json({ error: "Invalid JSON." }, 400); }
  if (!Array.isArray(messages)) return json({ error: "messages must be an array." }, 400);
  messages = messages
    .filter((m) => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string")
    .slice(-8)
    .map(({ role, content }) => ({ role, content }));
  if (!messages.length) return json({ error: "No valid messages." }, 400);

  recent.push(now); hits.set(ip, recent);

  // llama-3.3-70b-versatile was shut down by Groq (Aug 2026); gpt-oss-120b is the recommended replacement
  const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
  let up;
  try {
    up = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model, stream: true, max_tokens: 6000,
        ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}), // keep hidden thinking short so tokens go to the page
        messages: [{ role: "system", content: SYSTEM }, ...messages],
      }),
    });
  } catch { return json({ error: "Could not reach the AI provider." }, 502); }

  if (!up.ok) return up.status === 429
    ? json({ error: "Demo limit reached.", code: "limit" }, 429)
    : json({ error: `AI provider error (${up.status}).` }, 502);
  return new Response(up.body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
};

export const config = { path: "/api/chat" };
