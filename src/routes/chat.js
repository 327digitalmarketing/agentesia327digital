// routes/chat.js
// Proxy seguro para Gemini 1.5 Flash (desarrollo local)
// La API key nunca llega al cliente

const express = require('express');
const router  = express.Router();

router.post('/api/chat', async (req, res) => {
  const { messages, system } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array requerido' });
  }

  // Convertir formato Anthropic → Gemini
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const body = {
    system_instruction: system ? { parts: [{ text: system }] } : undefined,
    contents,
    generationConfig: {
      maxOutputTokens: 400,
      temperature: 0.7,
    }
  };

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Gemini error:', JSON.stringify(data));
      return res.status(500).json({ error: data.error?.message || 'Error Gemini' });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    res.json({ content: [{ text }] });

  } catch (err) {
    console.error('Error proxy Gemini:', err);
    res.status(500).json({ error: 'Error conectando con Gemini' });
  }
});

module.exports = router;
