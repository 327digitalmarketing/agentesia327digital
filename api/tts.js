// api/tts.js — Vercel Serverless Function
// Proxy seguro para ElevenLabs TTS — la API key nunca llega al cliente

// Voces seleccionadas:
// Español España   → Charlotte  (21m00Tcm4TlvDq8ikWAM) — cálida, femenina, española
// Español Latino   → Valentina  (XB0fDUnXU5powFXDhCwa) — natural, neutral latam
// Otros idiomas    → Multilingual Charlotte

const VOICES = {
  es: '21m00Tcm4TlvDq8ikWAM',   // Charlotte — Español España
  la: 'XB0fDUnXU5powFXDhCwa',   // Charlotte multilingual — Latam neutro
  en: '21m00Tcm4TlvDq8ikWAM',
  pt: '21m00Tcm4TlvDq8ikWAM',
  fr: '21m00Tcm4TlvDq8ikWAM',
  ar: '21m00Tcm4TlvDq8ikWAM',
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, lang } = req.body;
  if (!text) return res.status(400).json({ error: 'text requerido' });

  const voiceId = VOICES[lang] || VOICES['es'];

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.3,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!response.ok) {
      const err = await response.json();
      console.error('ElevenLabs error:', err);
      return res.status(500).json({ error: 'Error TTS' });
    }

    const audioBuffer = await response.arrayBuffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(audioBuffer));

  } catch (err) {
    console.error('TTS proxy error:', err);
    res.status(500).json({ error: 'Error conectando con ElevenLabs' });
  }
};
