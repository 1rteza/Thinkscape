# Thinkscape (Phase 1)
Chat + a "website builds itself" visualization. Vanilla JS, no build step. Backend: Netlify Function proxying **Groq** (free tier).

## Deploy
1. `git init && git add . && git commit -m "Thinkscape" ` then push to a new GitHub repo.
2. Netlify: **Add new site -> Import from Git**, pick the repo (publish dir `.`, functions `netlify/functions` come from `netlify.toml`). Don't drag-and-drop: the function needs a Git deploy.
3. Site settings -> Environment variables: add `GROQ_API_KEY` (from console.groq.com). Optional: `GROQ_MODEL` (default `llama-3.3-70b-versatile`).
4. Deploy (or trigger a redeploy after adding variables).

## Test locally
```
npm i -g netlify-cli
echo "GROQ_API_KEY=your_key" > .env   # keep out of Git
netlify dev
```

## Notes
- The key lives only in the function; nothing secret is in front-end code.
- Limits: 8 requests/hour per IP (in-memory, resets on cold start), 10 KB body, last 8 messages. When the limit or Groq's quota is hit, users get a friendly message and a **Replay** button (uses the last build, or a built-in sample, with zero API calls).
- Free models sometimes skip the tags; `parse()` in `app.js` falls back to raw HTML detection and a default plan.
- Switch provider: change the URL/body in `chat.mjs` and `extractDelta()` in `app.js`.
