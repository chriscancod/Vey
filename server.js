/**
 * VEYQ OS Backend — server.js
 * Mambru.inc · Veynor
 *
 * Deploy to Railway:
 *   1. Push this folder to a GitHub repo
 *   2. Connect to Railway → New Project → Deploy from GitHub
 *   3. Add environment variables (see bottom of this file)
 *   4. Railway auto-detects Node.js and runs `npm start`
 *
 * Routes:
 *   POST /api/chat              — AI chat (shared with Night.inc apps)
 *   POST /veyq/vey              — Vey AI OS assistant
 *   POST /veyq/account/create   — Create Veynor account
 *   POST /veyq/account/login    — Login
 *   GET  /veyq/account/profile  — Get profile (auth required)
 *   POST /veyq/account/sync     — Sync settings/notes
 *   GET  /health                — Health check
 */

const express = require('express')
const cors    = require('cors')
const crypto  = require('crypto')

const app  = express()
const PORT = process.env.PORT || 3000

// ── Middleware ─────────────────────────────────────────────────────
app.use(cors({ origin: '*' }))
app.use(express.json({ limit: '2mb' }))

// ── OpenAI client ──────────────────────────────────────────────────
const OPENAI_KEY = process.env.OPENAI_API_KEY

async function chat(system, messages, maxTokens = 400) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model:       'gpt-4o-mini',
      max_tokens:  maxTokens,
      temperature: 0.7,
      messages: [
        { role: 'system', content: system },
        ...messages.slice(-12),  // last 12 turns max
      ],
    }),
  })
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`)
  const d = await r.json()
  return d.choices[0]?.message?.content?.trim() || ''
}

// ── In-memory store (swap for a real DB like Railway Postgres later) ──
// For Founders Edition: 200 users max, in-memory is fine.
// When you're ready to scale: replace these Maps with pg queries.
const USERS    = new Map()   // email → { hash, salt, name, id, createdAt }
const PROFILES = new Map()   // userId → { accent, wmBehavior, avatar, syncData }
const TOKENS   = new Map()   // token → userId

function hashPwd(pass, salt) {
  return crypto.pbkdf2Sync(pass, salt, 100000, 64, 'sha256').toString('hex')
}
function makeToken() { return crypto.randomBytes(32).toString('hex') }
function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '')
  if (!token || !TOKENS.has(token)) return res.status(401).json({ error: 'Unauthorized' })
  req.userId = TOKENS.get(token)
  next()
}

// ═══════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════

// Health
app.get('/health', (_, res) => res.json({ status: 'ok', version: '3.0.0', product: 'VEYQ OS' }))

// ── Shared AI chat (Night.inc apps) ───────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { system, messages } = req.body
  if (!system || !Array.isArray(messages)) return res.status(400).json({ error: 'system + messages required' })
  try {
    const reply = await chat(system, messages)
    res.json({ reply })
  } catch(e) {
    console.error('/api/chat error:', e.message)
    res.status(500).json({ reply: 'Service temporarily unavailable.', error: e.message })
  }
})

// ── Vey AI — OS-aware assistant ───────────────────────────────────
app.post('/veyq/vey', async (req, res) => {
  const { message, context, messages = [] } = req.body
  if (!message) return res.status(400).json({ error: 'message required' })

  const system = `You are Vey, the AI built into VEYQ OS by Veynor, a Mambru.inc company.
You are sharp, direct, and deeply integrated with the OS. You are not a chatbot — you are the intelligence of the machine.
Current OS context: ${context || 'VEYQ OS 3.0, NOR1 silicon, user unknown.'}
Rules:
- Keep replies under 3 sentences unless asked for more.
- Never use markdown, bullet points, or bold text.
- If the user asks about the VEYQ hardware: NOR1 is a custom ARM chip designed by Veynor. VEYQ is a 119x119mm square desktop with a 24" OLED on an articulating spine. Framework-style upgradeability. Founders Edition: 200 units.
- If asked about apps you can control: Terminal, Files, Notes, Calculator, Clock, Clickey Manager, Device Hub, Account, Settings, GRIND Browser.
- Be real. Be Vey.`

  try {
    const reply = await chat(system, [...messages, { role: 'user', content: message }], 300)
    res.json({ reply })
  } catch(e) {
    console.error('/veyq/vey error:', e.message)
    res.status(500).json({ reply: 'Server offline. I can still control your OS — try "open terminal".' })
  }
})

// ── GRIND AI coach (existing Night.inc route) ─────────────────────
app.post('/grind/coach', async (req, res) => {
  const { message, context } = req.body
  if (!message) return res.status(400).json({ error: 'message required' })
  const system = `You are a sharp, direct AI productivity coach built into GRIND Browser for builders and students. ${context || ''} Max 2 sentences. No fluff. Be real and actionable.`
  try {
    const reply = await chat(system, [{ role: 'user', content: message }], 200)
    res.json({ reply })
  } catch(e) {
    res.status(500).json({ reply: 'Server unavailable. Stay locked in.' })
  }
})

// ── Account: Create ───────────────────────────────────────────────
app.post('/veyq/account/create', async (req, res) => {
  const { email, password, name } = req.body
  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: 'Valid email and 8+ char password required' })
  }
  if (USERS.has(email.toLowerCase())) {
    return res.status(409).json({ error: 'Account already exists. Try signing in.' })
  }
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = hashPwd(password, salt)
  const id   = crypto.randomUUID()
  USERS.set(email.toLowerCase(), { hash, salt, name: name || 'Veynor User', id, email: email.toLowerCase(), createdAt: new Date().toISOString() })
  PROFILES.set(id, {})
  const token = makeToken()
  TOKENS.set(token, id)
  console.log(`[VEYQ] New account: ${email}`)
  res.json({ token, name: name || 'Veynor User', message: 'Account created. Welcome to Veynor.' })
})

// ── Account: Login ────────────────────────────────────────────────
app.post('/veyq/account/login', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' })
  const user = USERS.get(email.toLowerCase())
  if (!user) return res.status(401).json({ error: 'No account found for this email' })
  const hash = hashPwd(password, user.salt)
  if (hash !== user.hash) return res.status(401).json({ error: 'Incorrect password' })
  const token = makeToken()
  TOKENS.set(token, user.id)
  res.json({ token, name: user.name })
})

// Also support the existing grind account routes for compatibility
app.post('/grind/account/create', async (req, res) => {
  // Forward to unified route
  req.body.name = req.body.name || req.body.username
  const r = await new Promise((resolve) => {
    const mockRes = { status: (c) => ({ json: (d) => resolve({ code: c, data: d }) }), json: (d) => resolve({ code: 200, data: d }) }
    // Re-call the handler logic inline
    const { email, password, name } = req.body
    if (!email || !password || password.length < 8) { resolve({ code: 400, data: { error: 'Valid email and 8+ char password required' } }); return }
    if (USERS.has(email.toLowerCase())) { resolve({ code: 409, data: { error: 'Account already exists' } }); return }
    const salt = crypto.randomBytes(16).toString('hex')
    const hash = hashPwd(password, salt)
    const id   = crypto.randomUUID()
    USERS.set(email.toLowerCase(), { hash, salt, name: name||'User', id, email: email.toLowerCase(), createdAt: new Date().toISOString() })
    PROFILES.set(id, {})
    const token = makeToken()
    TOKENS.set(token, id)
    resolve({ code: 200, data: { token, name } })
  })
  res.status(r.code).json(r.data)
})

// ── Account: Get profile ──────────────────────────────────────────
app.get('/veyq/account/profile', authMiddleware, (req, res) => {
  const user    = [...USERS.values()].find(u => u.id === req.userId)
  const profile = PROFILES.get(req.userId) || {}
  if (!user) return res.status(404).json({ error: 'User not found' })
  res.json({ name: user.name, email: user.email, createdAt: user.createdAt, ...profile })
})

// ── Account: Sync (settings, notes, accent) ───────────────────────
app.post('/veyq/account/sync', authMiddleware, (req, res) => {
  const { accent, wmBehavior, notes, bookmarks } = req.body
  const existing = PROFILES.get(req.userId) || {}
  PROFILES.set(req.userId, { ...existing, accent, wmBehavior, notes, bookmarks, syncedAt: new Date().toISOString() })
  res.json({ ok: true, syncedAt: PROFILES.get(req.userId).syncedAt })
})

// Also support the GRIND profile sync route
app.post('/grind/profile/sync', authMiddleware, (req, res) => {
  const { profile, bookmarks, history } = req.body
  const existing = PROFILES.get(req.userId) || {}
  PROFILES.set(req.userId, { ...existing, grindProfile: profile, bookmarks, history: (history||[]).slice(0,50), syncedAt: new Date().toISOString() })
  res.json({ ok: true })
})

app.get('/grind/profile/load', authMiddleware, (req, res) => {
  const p = PROFILES.get(req.userId) || {}
  res.json({ profile: p.grindProfile, bookmarks: p.bookmarks, history: p.history })
})

// ── 404 handler ───────────────────────────────────────────────────
app.use((_, res) => res.status(404).json({ error: 'Not found' }))

// ── Error handler ─────────────────────────────────────────────────
app.use((err, _, res, __) => {
  console.error('Unhandled error:', err)
  res.status(500).json({ error: 'Internal server error' })
})

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`VEYQ OS Backend running on port ${PORT}`)
  console.log(`Built for the climb. — Veynor · Mambru.inc`)
})

/*
═══════════════════════════════════════════════════════════
RAILWAY DEPLOY CHECKLIST:

1. Environment variables to set in Railway dashboard:
   OPENAI_API_KEY=sk-...
   NODE_ENV=production
   PORT=3000 (Railway sets this automatically)

2. This package.json goes in the /backend folder:
   {
     "name": "veyq-os-backend",
     "version": "3.0.0",
     "main": "server.js",
     "scripts": { "start": "node server.js" },
     "dependencies": {
       "express": "^4.18.2",
       "cors": "^2.8.5"
     }
   }

3. Deploy:
   cd backend
   railway init
   railway up

4. Get your URL from Railway dashboard.
   Update RAILWAY const in:
     - src/renderer/index.html
     - src/renderer/apps/account.js
     - src/renderer/apps/vey-ai.js

5. To add a real database later:
   railway add postgres
   Then replace the Maps above with pg queries.
   User data currently lives in memory — resets on restart.
   Fine for Founders Edition dev. Not for production scale.
═══════════════════════════════════════════════════════════
*/
