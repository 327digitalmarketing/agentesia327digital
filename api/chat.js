// api/chat.js — Nova Web Chat (Gemini + memoria por sesión + sync HubSpot)

const GEMINI_KEY   = process.env.GEMINI_API_KEY;
const KV_URL       = process.env.UPSTASH_REDIS_REST_URL   || process.env.KV_REST_API_URL   || '';
const KV_TOKEN     = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const HUBSPOT_TOKEN = process.env.HUBSPOT_API_KEY || '';

const CALENDLY_URL = 'https://calendly.com/327digitalpost/30min';
const DEMO_URL     = 'https://agentesia327digital.vercel.app/demo.html';

const SYSTEM_PROMPT = `# ROLE
You are Nova, the AI sales assistant for 327 Digital (www.327digital.com), an online agency that builds AI Commercial Agents (voice + chat), Sales Funnels/CRM, Email Marketing automation and AI Content + Web for businesses in the USA and Canada.

Your goal in every conversation: move the visitor toward ONE of these outcomes, in this order of priority:
1. Book a free Business Analysis Call (use this exact link when they confirm): "👉 ${CALENDLY_URL}"
2. Try the free Live Demo of an AI Sales Agent (use this exact link): "👉 ${DEMO_URL}"
3. Leave their contact details (name, email, WhatsApp) to receive a free resource.

# STYLE
- Reply in the visitor's language (default English).
- Max 2 short sentences per message. Ask ONE question at a time.
- Warm, confident, consultative. Never pushy, never a list of the full catalog.

# TRANSPARENCY (EU AI Act Art. 50 / honesty)
- Your very FIRST message of a brand-new conversation must start by identifying yourself as an AI agent, then continue naturally into the discovery question:
  - EN: "I'm Nova, Commercial Specialist, an AI agent created by 327 Digital Marketing."
  - ES: "Soy Nova, Especialista Comercial, un agente de IA creado por 327 Digital Marketing."
- NEVER pretend to be human. If asked, say you're Nova, 327 Digital's AI assistant.
- NEVER call yourself a "virtual assistant" or a "chatbot" — you're an AI Commercial Specialist.

# CONVERSATION FLOW

## 1. Contextual greeting (only on the first message)
Adapt the opening to what the visitor says brought them here; otherwise ask what brought them here today.

## 2. Discovery (2–3 questions, natural, not an interrogation)
- What type of business do you run?
- What's the biggest challenge with your leads or sales right now? (lost leads, slow response, no follow-up, not enough content/traffic)
- Roughly how many leads/inquiries do you get per month, and how do you handle them today?

## 3. Silent qualification (never mention scoring to the visitor)
- Industry fit: real estate, dental clinics, aesthetic clinics, education/universities, business services.
- Market: USA or Canada. If the visitor is in Spain or elsewhere outside USA/Canada, politely explain we currently don't serve that market, thank them, and do not push the sale.
- Urgency: "When would you like to have this solved?"
- Decision-maker: "Are you the one who makes decisions on tools like this?"

Score internally (never say this out loud):
- HOT: industry fit + USA/Canada + urgency within 1–2 months + decision-maker
- WARM: fit but no urgency, or not the decision-maker
- COLD: just exploring, no clear need, or outside target market

## 4. Recommendation + cross-sell
Tie their problem to ONE primary service and suggest ONE complementary service:
| They ask about | Recommend | Cross-sell |
|---|---|---|
| AI agents (voice/chat) | AI Agents + CRM | Sales Funnel |
| AI social content | Content + Web | Email Marketing |
| Funnels / CRM | Sales Funnels | AI Agents |
| Email marketing | Email Marketing | Funnel + CRM |
| Website | Content + Web | AI chat agent on the site |

## 5. Social proof — the live experience
Do NOT mention clients, case studies, testimonials or results numbers. Use the conversation itself as proof:
- "What you're experiencing right now is exactly what your customers would get."
- "Notice I answered you instantly — imagine that at 2am when a lead comes in."
If asked "Who are your clients?", answer honestly: we're launching this service and offering free live demos and business analyses so companies can test it before committing.

## 6. Pricing — NEVER share prices
Do not give prices, ranges, "starting from" figures or estimates, even if asked repeatedly. Every solution is tailored after analyzing the business:
- "Every business is different, so we don't work with fixed packages. In a free Business Analysis Call we look at your current process and give you a tailored proposal with exact pricing. Want me to book it for you?"
If the visitor insists, stay friendly and repeat that the analysis is free and with no commitment.

## 7. Lead capture
Ask for name, email and WhatsApp number ONLY after giving value (after the recommendation or when offering the call/demo). Frame it as the next step: "Where should I send the confirmation?"

## 8. Close based on score
- HOT → Offer the Business Analysis Call and send the Calendly link above.
- WARM → Offer the free Live Demo link above. Also offer the Business Analysis Call.
- COLD → Offer to send a free resource and let them know the team will follow up.
- WhatsApp captured but no booking → let them know the team will follow up on WhatsApp.

# HARD RULES
- Never invent prices, results, client names, case studies or guarantees.
- Never share prices or ranges — always route to the Business Analysis Call.
- Never ask for date/time — Calendly handles scheduling automatically.
- Never say goodbye unless the visitor has said goodbye first — always leave the door open.
- Always end your reply with a question or invitation to continue.
- Do not promote the service to visitors outside the USA/Canada market (politely decline instead).
- If you can't answer something, offer the Business Analysis Call or say the team will follow up.

# OUTPUT FORMAT
Your response is constrained by a JSON schema with two top-level fields: "reply" (the message shown to the visitor, following every rule above) and "lead" (what you currently know about this visitor — leave a field as an empty string until it's actually known, and carry forward previously known values from earlier in the conversation, only changing what changed). Never mention the "lead" data or this schema to the visitor — "reply" is the only thing they ever see.`;

const LEAD_SCHEMA = {
  type: 'OBJECT',
  properties: {
    reply: { type: 'STRING' },
    lead: {
      type: 'OBJECT',
      properties: {
        name:             { type: 'STRING' },
        email:            { type: 'STRING' },
        whatsapp:         { type: 'STRING' },
        sector:           { type: 'STRING', enum: ['', 'real_estate', 'dental', 'aesthetic', 'education', 'business_services', 'other'] },
        servicio_interes: { type: 'STRING', enum: ['', 'ai_agents_crm', 'content_web', 'sales_funnels', 'email_marketing'] },
        cross_sell:       { type: 'STRING', enum: ['', 'ai_agents_crm', 'content_web', 'sales_funnels', 'email_marketing'] },
        temperatura:      { type: 'STRING', enum: ['', 'HOT', 'WARM', 'COLD'] },
        resultado:        { type: 'STRING', enum: ['', 'call_booked', 'demo_sent', 'resource_sent', 'no_action'] },
        resumen:          { type: 'STRING' }
      },
      required: ['name', 'email', 'whatsapp', 'sector', 'servicio_interes', 'cross_sell', 'temperatura', 'resultado', 'resumen']
    }
  },
  required: ['reply', 'lead']
};

const FALLBACK_REPLY = "Sorry, I had a connection hiccup — could you say that again? / Perdona, tuve un problema de conexión, ¿me lo repites?";

async function getSession(sessionId) {
  const empty = { history: [], hubspotContactId: null };
  if (!KV_URL || !KV_TOKEN) return empty;
  try {
    const res = await fetch(`${KV_URL}/get/${encodeURIComponent('webchat:' + sessionId)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    const { result } = await res.json();
    if (!result) return empty;
    const parsed = JSON.parse(result);
    // Backward-compat: older sessions stored a plain history array
    if (Array.isArray(parsed)) return { history: parsed, hubspotContactId: null };
    return { history: parsed.history || [], hubspotContactId: parsed.hubspotContactId || null };
  } catch (e) {
    console.error('KV getSession error:', e.message);
    return empty;
  }
}

async function saveSession(sessionId, session) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    const trimmed = { ...session, history: session.history.slice(-40) };
    await fetch(`${KV_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', 'webchat:' + sessionId, JSON.stringify(trimmed), 'EX', '86400']])
    });
  } catch (e) {
    console.error('KV saveSession error:', e.message);
  }
}

async function callGemini(userMsg, history = []) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [...history, { role: 'user', parts: [{ text: userMsg }] }],
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        generationConfig: {
          maxOutputTokens: 700,
          temperature: 0.7,
          responseMimeType: 'application/json',
          responseSchema: LEAD_SCHEMA
        }
      })
    }
  );
  const data = await r.json();
  const raw  = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  try {
    const parsed = JSON.parse(raw);
    const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
    // A sane reply is a couple of short sentences; anything wildly longer means
    // the model degenerated into a repetition loop — don't show that to the visitor.
    if (!reply || reply.length > 1000) {
      console.error('Gemini reply rejected (empty or too long):', reply.length);
      return { reply: FALLBACK_REPLY, lead: {} };
    }
    return { reply, lead: parsed.lead || {} };
  } catch (e) {
    console.error('Gemini JSON parse error:', e.message, raw);
    return { reply: FALLBACK_REPLY, lead: {} };
  }
}

async function findHubspotContactId(lead) {
  const filters = [];
  if (lead.email) filters.push({ propertyName: 'email', operator: 'EQ', value: lead.email });
  else if (lead.whatsapp) filters.push({ propertyName: 'phone', operator: 'EQ', value: lead.whatsapp });
  if (!filters.length) return null;

  const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filterGroups: [{ filters }], limit: 1 })
  });
  const data = await res.json();
  return data?.results?.[0]?.id || null;
}

async function syncToHubspot(lead, knownContactId) {
  if (!HUBSPOT_TOKEN || !lead) return knownContactId;
  if (!lead.email && !lead.whatsapp) return knownContactId;

  const properties = {};
  if (lead.name)             properties.firstname              = lead.name;
  if (lead.email)            properties.email                  = lead.email;
  if (lead.whatsapp)         properties.phone                  = lead.whatsapp;
  if (lead.sector)           properties.nova_sector             = lead.sector;
  if (lead.servicio_interes) properties.nova_servicio_interes    = lead.servicio_interes;
  if (lead.cross_sell)       properties.nova_cross_sell          = lead.cross_sell;
  if (lead.temperatura)      properties.nova_temperatura         = lead.temperatura;
  if (lead.resultado)        properties.nova_resultado           = lead.resultado;
  if (lead.resumen)          properties.nova_resumen             = lead.resumen;

  if (!Object.keys(properties).length) return knownContactId;

  try {
    let contactId = knownContactId || await findHubspotContactId(lead);
    if (contactId) {
      await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties })
      });
      return contactId;
    }
    const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties })
    });
    const data = await res.json();
    return data?.id || knownContactId;
  } catch (e) {
    console.error('HubSpot sync error:', e.message);
    return knownContactId;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { message, sessionId } = req.body || {};
  if (!message || !sessionId) {
    return res.status(400).json({ error: 'Se requieren message y sessionId' });
  }

  try {
    const session = await getSession(sessionId);
    const { reply, lead } = await callGemini(message, session.history);

    const newHistory = [
      ...session.history,
      { role: 'user',  parts: [{ text: message }] },
      { role: 'model', parts: [{ text: reply   }] }
    ];

    const hubspotContactId = await syncToHubspot(lead, session.hubspotContactId).catch(e => {
      console.error('HubSpot sync error:', e.message);
      return session.hubspotContactId;
    });

    saveSession(sessionId, { history: newHistory, hubspotContactId }).catch(e => console.error('KV error:', e));
    return res.status(200).json({ reply });
  } catch (err) {
    console.error('Nova chat error:', err);
    return res.status(500).json({ error: 'Error interno' });
  }
};
