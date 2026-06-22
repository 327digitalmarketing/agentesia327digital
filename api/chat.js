// api/chat.js — Nova Web Chat (Gemini + memoria por sesión)

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const KV_URL     = process.env.UPSTASH_REDIS_REST_URL   || process.env.KV_REST_API_URL   || '';
const KV_TOKEN   = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';

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

async function getHistory(sessionId) {
  if (!KV_URL || !KV_TOKEN) return [];
  try {
    const res = await fetch(`${KV_URL}/get/${encodeURIComponent('webchat:' + sessionId)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    const { result } = await res.json();
    return result ? JSON.parse(result) : [];
  } catch (e) {
    console.error('KV getHistory error:', e.message);
    return [];
  }
}

async function saveHistory(sessionId, history) {
  if (!KV_URL || !KV_TOKEN) return;
  try {
    const trimmed = history.slice(-40);
    await fetch(`${KV_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', 'webchat:' + sessionId, JSON.stringify(trimmed), 'EX', '86400']])
    });
  } catch (e) {
    console.error('KV saveHistory error:', e.message);
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
        generationConfig: { maxOutputTokens: 600, temperature: 0.7 }
      })
    }
  );
  const data  = await r.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || '').join('') || '¿En qué más puedo ayudarte?';
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
    const history    = await getHistory(sessionId);
    const reply      = await callGemini(message, history);
    const newHistory = [
      ...history,
      { role: 'user',  parts: [{ text: message }] },
      { role: 'model', parts: [{ text: reply   }] }
    ];
    saveHistory(sessionId, newHistory).catch(e => console.error('KV error:', e));
    return res.status(200).json({ reply });
  } catch (err) {
    console.error('Nova chat error:', err);
    return res.status(500).json({ error: 'Error interno' });
  }
};
