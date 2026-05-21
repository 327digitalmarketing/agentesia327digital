// api/whatsapp.js — Nova v5 (Vercel KV para memoria, igual que Ari)

const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');

const GEMINI_KEY  = process.env.GEMINI_API_KEY;
const TWILIO_SID  = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+17622093727';

const AT_TOKEN = process.env.AIRTABLE_TOKEN   || '';
const AT_BASE  = process.env.AIRTABLE_BASE_ID || '';
const AT_TABLE = 'Conversaciones';

const KV_URL   = process.env.UPSTASH_REDIS_REST_URL   || process.env.KV_REST_API_URL   || '';
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';

const SA_PATH = path.join(__dirname, 'gcal-sa.json');
const SA      = JSON.parse(fs.readFileSync(SA_PATH, 'utf8'));
const GCAL_EMAIL = SA.client_email;
const GCAL_KEY   = SA.private_key;
const GCAL_ID    = process.env.GCAL_CALENDAR_ID || '327digitalpost@gmail.com';
const GCAL_TZ    = process.env.GCAL_TIMEZONE    || 'Europe/Madrid';

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres Nova, Especialista Comercial IA de 327 Digital Marketing.

Empresa: 327 Digital Marketing — Agencia de marketing digital con IA. Mercado: USA, España y Latinoamérica. Web: www.327digital.com | Contacto: ventas@327digital.com

Tu rol:
- Entender el negocio del usuario y explicar cómo 327 Digital puede ayudarle de forma concreta
- Presentar los servicios según el contexto del usuario (nunca listar todos de golpe)
- Manejar objeciones con empatía y ejemplos reales
- Ofrecer una demo gratuita de 15 minutos cuando el usuario muestre interés claro
- Cuando el usuario confirme la demo: pedir nombre completo, email, tipo de negocio y fecha/hora (uno por uno, de forma natural)
- Cuando tengas los 4 datos de la demo, confirmar con: DEMO_CONFIRMADA: nombre | email | negocio | fecha

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

// ─── Google Calendar ──────────────────────────────────────────────────────────

async function getGoogleToken() {
  const now = Math.floor(Date.now() / 1000);
  const hdr = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const pld = Buffer.from(JSON.stringify({
    iss: GCAL_EMAIL,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  })).toString('base64url');
  const unsigned = `${hdr}.${pld}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(GCAL_KEY, 'base64url');
  const r   = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${sig}`
    })
  });
  return (await r.json()).access_token;
}

async function createCalendarEvent({ name, email, business_type, date, time }) {
  try {
    const token = await getGoogleToken();
    if (!token) return null;
    const [h, m] = time.split(':').map(Number);
    const endH   = String(h < 23 ? h + 1 : 0).padStart(2, '0');
    const startDT = `${date}T${time}:00`;
    const endDT   = `${date}T${endH}:${String(m).padStart(2, '0')}:00`;
    const r = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GCAL_ID)}/events`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary:     `Demo 327 Digital — ${name}`,
          description: `Tipo de negocio: ${business_type}\nContacto: ${email}`,
          start: { dateTime: startDT, timeZone: GCAL_TZ },
          end:   { dateTime: endDT,   timeZone: GCAL_TZ },
          reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] }
        })
      }
    );
    const body = await r.json();
    return r.ok ? body : null;
  } catch { return null; }
}

// ─── Resend ───────────────────────────────────────────────────────────────────

async function sendConfirmationEmail({ name, email, business_type, fecha }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  const firstName = name.split(' ')[0];
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Nova · 327 Digital <nova@327digital.com>',
      to:   [email],
      subject: `✅ Tu demo con 327 Digital está confirmada`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:32px;background:#f9f9f9;border-radius:12px">
          <h2 style="color:#002D72">¡Hola ${firstName}!</h2>
          <p>Tu demo con <strong>327 Digital Marketing</strong> ha quedado confirmada.</p>
          <table style="width:100%;margin:24px 0;border-collapse:collapse">
            <tr><td style="padding:8px;color:#555">📅 Fecha y hora</td><td style="padding:8px;font-weight:bold">${fecha}</td></tr>
            <tr><td style="padding:8px;color:#555">🏢 Negocio</td><td style="padding:8px;font-weight:bold">${business_type}</td></tr>
          </table>
          <p>Nuestro equipo se pondrá en contacto contigo para enviarte el enlace de la reunión.</p>
          <p style="color:#888;font-size:13px">327 Digital Marketing · ventas@327digital.com</p>
        </div>
      `
    })
  }).catch(() => {});
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

// ─── Detectar confirmación de demo y agendar ──────────────────────────────────

const MONTHS = { enero:'01',febrero:'02',marzo:'03',abril:'04',mayo:'05',junio:'06',julio:'07',agosto:'08',septiembre:'09',octubre:'10',noviembre:'11',diciembre:'12' };

function parseDate(text) {
  const m = text.match(/(\d{1,2})\s+de\s+(\w+)(?:\s+de\s+(\d{4}))?(?:.*?(\d{1,2})[:.h](\d{2}))?/i);
  if (m) {
    const day  = m[1].padStart(2, '0');
    const mon  = MONTHS[m[2].toLowerCase()] || '05';
    const year = m[3] || new Date().getFullYear().toString();
    const hour = m[4] ? m[4].padStart(2, '0') : '10';
    const min  = m[5] || '00';
    return { date: `${year}-${mon}-${day}`, time: `${hour}:${min}` };
  }
  const d = new Date(); d.setDate(d.getDate() + 7);
  return { date: d.toISOString().slice(0, 10), time: '10:00' };
}

async function handleBookingConfirmation(reply, phone) {
  const match = reply.match(/DEMO_CONFIRMADA:\s*([^|]+)\|([^|]+)\|([^|]+)\|(.+)/i);
  if (!match) return reply;

  const name          = match[1].trim();
  const email         = match[2].trim();
  const business_type = match[3].trim();
  const fechaText     = match[4].trim();
  const { date, time } = parseDate(fechaText);

  await Promise.all([
    createCalendarEvent({ name, email, business_type, date, time }),
    sendConfirmationEmail({ name, email, business_type, fecha: fechaText })
  ]);

  return `✅ ¡Listo ${name.split(' ')[0]}! Tu demo está confirmada para el ${fechaText}. Te hemos enviado un correo de confirmación a ${email}. ¡Hasta pronto! 🚀`;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  const b       = req.body || {};
  const msgBody = (b.Body || b.body || '').trim();
  const msgFrom = b.From || b.from || '';

  if (msgBody && msgFrom) {
    try {
      const history = await getHistory(msgFrom);
      let reply     = await callGemini(msgBody, history);
      reply         = await handleBookingConfirmation(reply, msgFrom);

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
