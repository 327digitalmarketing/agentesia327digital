// api/whatsapp.js — Nova (Gemini + Calendly)

const GEMINI_KEY  = process.env.GEMINI_API_KEY;
const TWILIO_SID  = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+17622093727';

const AT_TOKEN = process.env.AIRTABLE_TOKEN   || '';
const AT_BASE  = process.env.AIRTABLE_BASE_ID || '';
const AT_TABLE = 'Conversaciones';

const KV_URL   = process.env.UPSTASH_REDIS_REST_URL   || process.env.KV_REST_API_URL   || '';
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres Nova, Especialista Comercial IA de 327 Digital Marketing.

Empresa: 327 Digital Marketing — Agencia de marketing digital con IA. Mercado: USA, España y Latinoamérica. Web: www.327digital.com | Contacto: ventas@327digital.com

Tu rol:
- Entender el negocio del usuario y explicar cómo 327 Digital puede ayudarle de forma concreta
- Presentar los servicios según el contexto del usuario (nunca listar todos de golpe)
- Manejar objeciones con empatía y ejemplos reales
- Ofrecer una demo gratuita de 30 minutos cuando el usuario muestre interés claro
- Cuando el usuario CONFIRME que quiere la demo: enviarle el link de Calendly exactamente así:

"¡Perfecto! Aquí puedes elegir el horario que mejor te venga para tu demo gratuita de 30 minutos:
👉 https://calendly.com/327digitalpost/30min
Te llegará confirmación por email automáticamente."

Servicios de 327 Digital:
- Agentes Comerciales IA: responden, califican y agendan 24/7 por WhatsApp, web o Instagram
- Contenido con IA: posts, blogs, copywriting y ads en fracción del tiempo
- Email Marketing IA: campañas automáticas personalizadas por comportamiento del cliente
- Embudos de Ventas IA: de visitante a cliente en piloto automático

Tono: Cercano, directo y profesional. Máximo 3-4 líneas por mensaje.

Reglas absolutas:
- NUNCA te llames "asistente virtual" — eres Especialista Comercial IA
- NUNCA menciones "chatbot"
- NUNCA inventes precios
- NUNCA pidas datos de fecha/hora — Calendly lo gestiona automáticamente
- NUNCA te despidas si el usuario no se ha despedido — siempre deja la puerta abierta
- SIEMPRE termina tu respuesta con una pregunta o invitación a continuar
- Responde siempre en el idioma del usuario`;

// ─── Vercel KV — Memoria de conversación (igual que el array de Ari) ──────────

async function getHistory(phone) {
  if (!KV_URL || !KV_TOKEN) return [];
  try {
    const res  = await fetch(`${KV_URL}/get/${encodeURIComponent('chat:' + phone)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    const { result } = await res.json();
    return result ? JSON.parse(result) : [];
  } catch (e) {
    console.error('KV getHistory error:', e.message);
    return [];
  }
}

async function saveHistory(phone, history) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    const trimmed = history.slice(-40); // últimos 20 intercambios
    await fetch(`${KV_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', 'chat:' + phone, JSON.stringify(trimmed), 'EX', '604800']])
    });
  } catch (e) {
    console.error('KV saveHistory error:', e.message);
  }
}

// ─── Airtable — Log de conversaciones (opcional, fire & forget) ───────────────

function logToAirtable(phone, userMsg, novaReply) {
  if (!AT_TOKEN || !AT_BASE) return;
  fetch(`https://api.airtable.com/v0/${AT_BASE}/${encodeURIComponent(AT_TABLE)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      records: [{ fields: { Telefono: phone, Mensaje: userMsg, Respuesta: novaReply } }]
    })
  }).catch(() => {});
}

// ─── Gemini ───────────────────────────────────────────────────────────────────

async function callGemini(userMsg, history = []) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [...history, { role: 'user', parts: [{ text: userMsg }] }],
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        generationConfig: { maxOutputTokens: 600, temperature: 0.7 }
      })
    }
  );
  const data  = await r.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || '').join('') || '¿En qué más puedo ayudarte?';
}



// ─── Twilio ───────────────────────────────────────────────────────────────────

async function sendWhatsApp(to, body) {
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH}`).toString('base64');
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body }).toString()
  });
}

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  const b       = req.body || {};
  const msgBody = (b.Body || b.body || '').trim();
  const msgFrom = b.From || b.from || '';

  if (msgBody && msgFrom) {
    try {
      const history = await getHistory(msgFrom);
      const reply = await callGemini(msgBody, history);

      const newHistory = [
        ...history,
        { role: 'user',  parts: [{ text: msgBody }] },
        { role: 'model', parts: [{ text: reply   }] }
      ];

      logToAirtable(msgFrom, msgBody, reply); // log opcional, fire & forget

      await Promise.all([
        sendWhatsApp(msgFrom, reply),
        saveHistory(msgFrom, newHistory)
      ]);
    } catch (err) {
      console.error('Nova error:', err);
    }
  }

  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send('<Response></Response>');
};
