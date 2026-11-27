// Thinkscape: chat + "website builds itself" visualization. Vanilla ES module.
const $ = (s) => document.querySelector(s), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
const DEFAULT_PLAN = ["Layout skeleton", "Color and typography", "Content sections", "Interactions"]; // used when the model skips <plan>
const EXPECTED = 12000; // typical site length (chars), used to estimate progress
const PROMPTS = ["A landing page for a coffee shop", "A portfolio for a photographer", "A pricing page for a SaaS app"];
// Tiny built-in build so visitors can see the effect after the free quota runs out
const SAMPLE = `<plan>
- Layout skeleton
- Color and typography
- Hero section
- Interactions
</plan>
<site>
<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:system-ui;background:#0d1117;color:#fff}.hero{padding:15vh 8vw;background:linear-gradient(135deg,#312e81,#0d1117)}h1{font-size:3rem;margin:0 0 12px}button{background:#8b7bff;border:0;color:#fff;padding:12px 22px;border-radius:99px;font-size:1rem}</style></head><body>
<section class="hero"><h1>Hello, Thinkscape</h1><p>This sample page was built without calling any API.</p><button onclick="this.textContent='Clicked!'">Try me</button></section>
</body></html>
</site>
<summary>A tiny sample landing page, replayed for free.</summary>`;
const state = { messages: [], last: null, view: "", ctrl: null, busy: false };

/* ---------- Stream parser ---------- */
// Provider-specific: OpenAI-compatible SSE (Groq). For Gemini use j.candidates?.[0]?.content?.parts?.[0]?.text,
// for Anthropic use j.delta?.text. This is the only line that changes per provider.
const extractDelta = (j) => j.choices?.[0]?.delta?.content || "";

async function readSSE(body, onDelta) {
  const reader = body.getReader(), dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop(); // keep partial line for next chunk
    for (const l of lines) {
      if (!l.startsWith("data:")) continue;
      const d = l.slice(5).trim();
      if (d === "[DONE]") return;
      try { const t = extractDelta(JSON.parse(d)); if (t) onDelta(t); } catch { /* ignore keep-alives */ }
    }
  }
}

// Re-parses the full buffer each time, so tags split across chunks are never a problem.
function parse(t) {
  const s = t.trimStart();
  const looksHtml = /^(```(?:html)?\s*)?(<!doctype|<html)/i.test(s); // fallback: model skipped the tags
  const build = s.startsWith("<plan>") || s.startsWith("<site>") || looksHtml;
  const grab = (tag) => {
    const i = t.indexOf(`<${tag}>`); if (i < 0) return null;
    const a = i + tag.length + 2, j = t.indexOf(`</${tag}>`, a);
    return { text: j < 0 ? t.slice(a) : t.slice(a, j), done: j >= 0 };
  };
  if (!build) {
    if (s.length < 10 && ["<plan>", "<site>", "<thoughts>"].some((x) => x.startsWith(s))) return { mode: "undecided" };
    // Normal question: <thoughts> steps, then <answer>. Falls back to plain text if the model skips the tags.
    const th = grab("thoughts"), an = grab("answer");
    const thoughts = th ? th.text.split("\n").slice(0, th.done ? undefined : -1)
      .map((l) => l.replace(/^\s*[-*\d.)]+\s*/, "").trim()).filter(Boolean).slice(0, 6) : [];
    const body = an ? an.text : th ? "" : t;
    return { mode: "chat", thoughts, answer: body.replace(/<\/?[a-z]*$/i, "").trim() };
  }
  const plan = grab("plan"), site = grab("site"), sum = grab("summary");
  let html = site ? site.text : looksHtml ? s : "";
  html = html.replace(/^\s*```(?:html)?\s*/i, "").replace(/```\s*$/, "");
  let steps = DEFAULT_PLAN;
  if (plan) {
    const lines = plan.text.split("\n"); if (!plan.done) lines.pop(); // drop the line still streaming
    steps = lines.map((l) => l.replace(/^\s*[-*\d.)]+\s*/, "").trim()).filter(Boolean).slice(0, 6);
  }
  return { mode: "build", steps, html, summary: sum ? sum.text.trim() : "",
    siteDone: site ? site.done || /<\/html>/i.test(site.text) : /<\/html>/i.test(html) };
}

/* ---------- Preview renderer ---------- */
const VOID = new Set("area base br col embed hr img input link meta source track wbr".split(" "));
const LIVE = "<style>body>:last-child{outline:1px solid #8b7bff99;outline-offset:-1px}</style><script>scrollTo(0,1e9)</script>";
function closeHtml(h) {
  h = h.replace(/<[^>]*$/, "").replace(/<!--(?![\s\S]*?-->)[\s\S]*$/, ""); // cut half-written tag/comment
  const sc = h.lastIndexOf("<script");
  if (sc >= 0 && !/<\/script>/i.test(h.slice(sc))) h = h.slice(0, sc);  // never run half a script
  const st = h.lastIndexOf("<style");
  if (st >= 0 && !/<\/style>/i.test(h.slice(st))) h += "</style>";
  const stack = [];
  h.replace(/<!--[\s\S]*?-->|<(script|style)[\s\S]*?<\/\1>/gi, "")
   .replace(/<(\/?)([a-z][\w-]*)[^>]*?(\/?)>/gi, (m, c, n, self) => {
     n = n.toLowerCase(); if (VOID.has(n) || self) return;
     if (c) { const i = stack.lastIndexOf(n); if (i >= 0) stack.length = i; } else stack.push(n);
   });
  return h + stack.reverse().map((n) => `</${n}>`).join("");
}
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const highlight = (s) => esc(s).replace(/(&lt;!--[\s\S]*?(?:--&gt;|$))|(&lt;\/?[\w!-]+)|("[^"\n]*")/g,
  (m, c, t) => `<i class="${c ? "c" : t ? "t" : "s"}">${m}</i>`);

// Thought map: one list item per step, earlier steps tick off as new ones arrive
function syncMap(ol, labels, cur) {
  for (let i = ol.children.length; i < labels.length; i++) {
    const li = el("li", "", labels[i]); if (i === 0 && labels[0].startsWith("You asked")) li.dataset.q = 1; ol.append(li);
  }
  [...ol.children].forEach((li, i) => (li.className = i < cur ? "done" : i === cur ? "active" : ""));
}

/* ---------- One run = one streamed response (live or replayed) ---------- */
function makeRun(bubble, record = true, question = "") {
  const ui = { phase: $("#phase"), time: $("#time"), chars: $("#chars"), steps: $("#steps"), code: $("#code"), frame: $("#frame"), wrap: $("#wrap"), actions: $("#actions"), tmap: $("#think .tmap") };
  let raw = "", mode = "undecided", p = {}, t0 = 0, timer = 0, n = 0, dirty = false, pv = "", tchain, ans;

  function paint(final) {
    ui.time.textContent = ((Date.now() - t0) / 1000).toFixed(1) + "s";
    if (!dirty && !final) return;
    dirty = false;
    if (mode === "chat") return paintChat(final);
    const html = p.html || "", len = html.length, done = final || p.siteDone;
    ui.chars.textContent = len.toLocaleString() + " chars";
    ui.phase.textContent = final ? "Done" : p.siteDone ? "Finishing" : len ? "Writing code" : "Planning";
    // Plan tracker: steps tick off as the HTML grows
    for (let i = ui.steps.children.length; i < p.steps.length; i++) ui.steps.append(el("li", "", p.steps[i]));
    const cur = done ? p.steps.length : len ? Math.min(p.steps.length - 1, Math.floor(Math.min(len / EXPECTED, .98) * p.steps.length)) : 0;
    [...ui.steps.children].forEach((li, i) => (li.className = i < cur ? "done" : i === cur ? "active" : ""));
    ui.code.innerHTML = highlight(html) + (final ? "" : '<b class="cur"></b>');
    ui.code.scrollTop = 1e9;
    if (len && (final || ++n % 3 === 1)) { // throttle: preview about every 300 ms
      const doc = p.siteDone ? html : closeHtml(html) + (final ? "" : LIVE);
      if (doc !== pv) { pv = doc; ui.frame.srcdoc = doc; }
    }
  }
  function paintChat(final) {
    const th = p.thoughts || [], q = question.length > 70 ? question.slice(0, 70) + "…" : question;
    const labels = [...(q ? ["You asked: " + q] : []), ...th];
    if (p.answer) labels.push("Writing the answer");
    const cur = final ? labels.length : labels.length - 1;
    syncMap(ui.tmap, labels, cur); syncMap(tchain, labels, cur);
    tchain.hidden = !th.length; // model skipped the thoughts: show just the answer
    ans.textContent = p.answer || "";
    ui.chars.textContent = (p.answer || "").length.toLocaleString() + " chars";
    ui.phase.textContent = final ? "Done" : p.answer ? "Answering" : "Thinking";
    scrollLog();
  }
  function startChat() {
    t0 = Date.now(); ui.actions.hidden = true; ui.tmap.replaceChildren(); document.body.dataset.view = "think";
    bubble.classList.remove("thinking"); tchain = el("ol", "tmap tchain"); ans = el("div", "ans"); bubble.replaceChildren(tchain, ans);
    timer = setInterval(() => paint(false), 100);
  }
  function startBuild() {
    t0 = Date.now(); ui.actions.hidden = true; ui.steps.replaceChildren(); ui.code.textContent = ""; ui.frame.srcdoc = "";
    ui.wrap.classList.add("live"); document.body.dataset.view = "build";
    if (matchMedia("(max-width:860px)").matches) setTab("build");
    bubble.classList.remove("thinking"); bubble.textContent = "Building your site…";
    timer = setInterval(() => paint(false), 100);
  }
  return {
    get raw() { return raw; },
    feed(d) {
      raw += d; p = parse(raw);
      if (mode === "undecided" && p.mode !== "undecided") { mode = p.mode; mode === "build" ? startBuild() : startChat(); }
      dirty = true;
    },
    end(err) {
      clearInterval(timer); ui.wrap.classList.remove("live");
      if (mode === "build") {
        dirty = true; paint(true);
        if (err) ui.phase.textContent = "Stopped";
        const sum = p.summary || (err ? "Build stopped early." : "Your site is ready.");
        bubble.textContent = sum;
        if (p.html) { state.view = p.html; ui.actions.hidden = false; if (record) state.last = raw; }
        if (record) state.messages.push({ role: "assistant", content: "[Built a website] " + sum }); // keep history small (10 KB cap)
      } else if (mode === "chat") {
        dirty = true; paint(true);
        if (record) state.messages.push({ role: "assistant", content: (p.answer || raw).trim() }); // store the answer only, not the tags
      } else bubble.classList.remove("thinking");
    },
  };
}

/* ---------- Pacer: Groq streams very fast, so release text at a watchable speed ---------- */
function pacer(run) {
  let q = "", wait = null;
  const id = setInterval(() => {
    if (state.ctrl?.signal.aborted) q = "";
    if (!q) { wait?.(); wait = null; return; }
    const n = Math.max(15, Math.ceil(q.length / 600)); // about 500+ chars/sec, speeds up if far behind
    run.feed(q.slice(0, n)); q = q.slice(n);
  }, 30);
  return { push: (t) => (q += t), drain: () => new Promise((r) => (q ? (wait = r) : r())), stop: () => clearInterval(id) };
}

/* ---------- UI ---------- */
const log = $("#log"), input = $("#input");
const scrollLog = () => (log.scrollTop = log.scrollHeight);
function addMsg(kind, text = "") { $("#empty")?.remove(); const m = el("div", "msg " + kind, text); log.append(m); scrollLog(); return m; }
function setBusy(b) { state.busy = b; $("#send").hidden = b; $("#stop").hidden = !b; $("#replay").disabled = b; }
function setTab(t) { document.body.dataset.tab = t; document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === t)); }
const errText = (e) => e.limit ? "Demo limit reached: the free AI quota is used up for now. Try the replay to see the full build effect!"
  : e instanceof TypeError ? "Network problem. Check your connection and try again." : e.message;

function showErr(bubble, e) {
  bubble.className = "msg ai err"; bubble.textContent = errText(e);
  if (e.limit) { const b = el("button", "", "▶ Replay a build"); b.onclick = () => replay(state.last || SAMPLE); bubble.append(el("br"), b); }
}

async function send(text) {
  addMsg("user", text); state.messages.push({ role: "user", content: text });
  const bubble = addMsg("ai"); bubble.classList.add("thinking"); bubble.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
  setBusy(true); state.ctrl = new AbortController();
  const run = makeRun(bubble, true, text); let pc;
  try {
    const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: state.messages.slice(-8) }), signal: state.ctrl.signal });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw Object.assign(new Error(j.error || `Error ${res.status}`), { limit: res.status === 429 }); }
    pc = pacer(run); await readSSE(res.body, pc.push); await pc.drain(); pc.stop(); run.end();
  } catch (e) {
    const aborted = e.name === "AbortError";
    pc?.stop(); run.end(e);
    if (!run.raw) { state.messages.pop(); aborted ? bubble.remove() : showErr(bubble, e); }
    else if (!aborted) bubble.append(el("div", "note", "⚠ " + errText(e)));
  } finally { setBusy(false); }
}

// Replay: feed stored raw text through the very same pipeline, no API call
async function replay(raw) {
  if (state.busy || !raw) return;
  setBusy(true); state.ctrl = new AbortController();
  const run = makeRun(addMsg("ai"), false), step = Math.max(8, Math.ceil(raw.length / 300));
  try { for (let i = 0; i < raw.length && !state.ctrl.signal.aborted; i += step) { run.feed(raw.slice(i, i + step)); await sleep(20); } }
  finally { run.end(); setBusy(false); }
}

const grow = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px"; };
input.addEventListener("input", grow);
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#form").requestSubmit(); } });
$("#form").onsubmit = (e) => { e.preventDefault(); const t = input.value.trim(); if (!t || state.busy) return; input.value = ""; grow(); send(t); };
$("#stop").onclick = () => state.ctrl?.abort();
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => setTab(b.dataset.t)));
PROMPTS.forEach((t) => { const b = el("button", "", t); b.onclick = () => !state.busy && send(t); $("#chips").append(b); });

$("#replay").onclick = () => replay(state.last || SAMPLE);
$("#full").onclick = () => window.open(URL.createObjectURL(new Blob([state.view], { type: "text/html" })), "_blank");
$("#copy").onclick = async (e) => { try { await navigator.clipboard.writeText(state.view); e.target.textContent = "Copied ✓"; } catch { e.target.textContent = "Copy failed"; } setTimeout(() => (e.target.textContent = "Copy code"), 1500); };
$("#dl").onclick = () => { const a = el("a"); a.href = URL.createObjectURL(new Blob([state.view], { type: "text/html" })); a.download = "site.html"; a.click(); };
$("#tog").onclick = (e) => { const m = $("#wrap").classList.toggle("mobile"); e.target.textContent = m ? "Desktop width" : "Mobile width"; };
