// api/miranda.js — Miranda · Agente de Voz Inmobiliario
// Vercel Serverless Function — maneja /api/miranda/*
// Retell llama a estos endpoints durante la conversación

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Seguridad: verificar que la petición viene de Retell ────────────────────
// Retell envía tu misma RETELL_API_KEY como Bearer token en las tool calls
function verificarRetell(req) {
  const auth = req.headers.authorization;
  const expected = `Bearer ${process.env.RETELL_API_KEY}`;
  return auth && auth === expected;
}

// ─── Helpers de precio ───────────────────────────────────────────────────────
function formatearPrecioNum(num) {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(num);
}

function formatearPrecio(precio, operacion) {
  const num = formatearPrecioNum(precio);
  return operacion === 'alquiler' ? `${num}/mes` : num;
}

async function triggerWebhook(url, payload) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000)
  });
}

// ─── Handlers por ruta ───────────────────────────────────────────────────────

async function buscarPropiedades(body, res) {
  const { zona, operacion, tipo, precio_max, habitaciones_min } = body;

  let query = supabase
    .from('propiedades')
    .select('id, titulo, tipo, operacion, precio, zona, habitaciones, metros_cuadrados, terraza, ascensor, descripcion, referencia, foto_principal')
    .eq('disponible', true)
    .limit(5);

  if (operacion)        query = query.eq('operacion', operacion);
  if (tipo)             query = query.eq('tipo', tipo);
  if (precio_max)       query = query.lte('precio', precio_max);
  if (habitaciones_min) query = query.gte('habitaciones', habitaciones_min);
  if (zona)             query = query.ilike('zona', `%${zona.toLowerCase().trim()}%`);

  query = query.order('destacada', { ascending: false }).order('precio', { ascending: true });

  const { data: propiedades, error } = await query;
  if (error) throw error;

  if (!propiedades || propiedades.length === 0) {
    return res.json({
      encontradas: 0,
      mensaje: 'No encontré propiedades con esos criterios en este momento.',
      propiedades: []
    });
  }

  const propiedadesFormateadas = propiedades.map(p => ({
    id: p.id,
    referencia: p.referencia,
    titulo: p.titulo,
    tipo: p.tipo,
    precio: formatearPrecio(p.precio, p.operacion),
    zona: p.zona,
    habitaciones: p.habitaciones,
    metros: p.metros_cuadrados ? `${p.metros_cuadrados}m²` : null,
    extras: [p.terraza ? 'terraza' : null, p.ascensor ? 'ascensor' : null].filter(Boolean).join(', ') || null,
    descripcion_corta: p.descripcion ? p.descripcion.substring(0, 120) + '...' : null
  }));

  return res.json({
    encontradas: propiedadesFormateadas.length,
    propiedades: propiedadesFormateadas,
    sugerencia_agente: propiedadesFormateadas.length > 1
      ? 'Describe la primera opción y pregunta si le interesa antes de mencionar las demás.'
      : 'Describe esta propiedad y ofrece agendar una visita.'
  });
}

async function calcularHipoteca(body, res) {
  const {
    precio_propiedad,
    entrada_porcentaje = 20,
    plazo_anos = 25,
    tipo_interes_anual = 3.2
  } = body;

  if (!precio_propiedad || precio_propiedad <= 0) {
    return res.status(400).json({ error: 'precio_propiedad es requerido y debe ser mayor que 0' });
  }

  const entrada = (precio_propiedad * entrada_porcentaje) / 100;
  const capital = precio_propiedad - entrada;
  const meses = plazo_anos * 12;
  const tasaMensual = tipo_interes_anual / 100 / 12;

  const cuotaMensual = tasaMensual === 0
    ? capital / meses
    : (capital * tasaMensual * Math.pow(1 + tasaMensual, meses)) / (Math.pow(1 + tasaMensual, meses) - 1);

  const totalPagado = cuotaMensual * meses;
  const totalIntereses = totalPagado - capital;

  return res.json({
    precio_propiedad: formatearPrecioNum(precio_propiedad),
    entrada: formatearPrecioNum(entrada),
    entrada_porcentaje: `${entrada_porcentaje}%`,
    capital_prestado: formatearPrecioNum(capital),
    cuota_mensual: formatearPrecioNum(Math.round(cuotaMensual)),
    plazo: `${plazo_anos} años`,
    tipo_interes: `${tipo_interes_anual}% TIN`,
    total_intereses: formatearPrecioNum(Math.round(totalIntereses)),
    total_pagado: formatearPrecioNum(Math.round(totalPagado)),
    nota: 'Cálculo orientativo. Condiciones definitivas sujetas a estudio bancario.'
  });
}

async function calificarLead(body, res) {
  const {
    nombre, email, presupuesto_max, zona_preferida,
    tipo_inmueble, operacion, plazo_compra, score, notas,
    retell_call_id, from_number, telefono
  } = body;

  const leadData = {
    nombre: nombre || 'Desconocido',
    telefono: from_number || telefono || 'Sin teléfono',
    email: email || null,
    presupuesto_max: presupuesto_max || null,
    zona_preferida: zona_preferida || [],
    tipo_inmueble: tipo_inmueble || null,
    operacion: operacion || null,
    plazo_compra: plazo_compra || null,
    score: score || 5,
    notas: notas || null,
    retell_call_id: retell_call_id || null,
    estado: 'nuevo',
    fuente: 'llamada_entrante',
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from('leads')
    .upsert(leadData, { onConflict: 'telefono', returning: 'minimal' });

  if (error) throw error;

  if (process.env.MAKE_WEBHOOK_LEADS_URL) {
    triggerWebhook(process.env.MAKE_WEBHOOK_LEADS_URL, {
      tipo: 'nuevo_lead',
      lead: leadData,
      timestamp: new Date().toISOString()
    }).catch(e => console.warn('[make-webhook]', e.message));
  }

  return res.json({ guardado: true, mensaje: 'Lead guardado correctamente' });
}

async function enviarFicha(body, res) {
  const { propiedad_id, referencia, from_number, telefono } = body;

  let query = supabase.from('propiedades').select('*');
  if (propiedad_id)   query = query.eq('id', propiedad_id);
  else if (referencia) query = query.eq('referencia', referencia);
  else return res.json({ enviado: false, mensaje: 'No se especificó propiedad' });

  const { data: propiedad, error } = await query.single();
  if (error || !propiedad) return res.json({ enviado: false, mensaje: 'Propiedad no encontrada' });

  const tel = from_number || telefono;
  if (!tel) return res.json({ enviado: false, mensaje: 'No se tiene el teléfono del lead' });

  if (process.env.MAKE_WEBHOOK_WHATSAPP_URL) {
    await triggerWebhook(process.env.MAKE_WEBHOOK_WHATSAPP_URL, {
      tipo: 'enviar_ficha',
      telefono_destino: tel,
      propiedad: {
        titulo: propiedad.titulo,
        precio: formatearPrecio(propiedad.precio, propiedad.operacion),
        zona: propiedad.zona,
        habitaciones: propiedad.habitaciones,
        metros: propiedad.metros_cuadrados,
        descripcion: propiedad.descripcion,
        foto_url: propiedad.foto_principal,
        referencia: propiedad.referencia
      }
    });
    return res.json({ enviado: true, mensaje: `Ficha de ${propiedad.titulo} enviada por WhatsApp` });
  }

  return res.json({ enviado: false, mensaje: 'Servicio de WhatsApp no configurado' });
}

async function webhookPostcall(body, res) {
  const {
    event, call_id, from_number, duration_ms,
    transcript, summary, custom_analysis_data
  } = body;

  if (event !== 'call_ended') return res.json({ received: true });

  const updateData = {
    retell_call_id: call_id,
    duracion_llamada: duration_ms ? Math.round(duration_ms / 1000) : null,
    transcript: transcript || null,
    resumen_llamada: summary || null,
    estado: custom_analysis_data?.visita_agendada ? 'visita_agendada' : 'contactado',
    updated_at: new Date().toISOString()
  };

  await supabase.from('leads').update(updateData).eq('retell_call_id', call_id);

  if (custom_analysis_data?.calidad_lead === 'alto' && process.env.MAKE_WEBHOOK_NOTIFICACION_URL) {
    triggerWebhook(process.env.MAKE_WEBHOOK_NOTIFICACION_URL, {
      tipo: 'lead_calidad_alta',
      call_id,
      from_number,
      duracion_segundos: Math.round(duration_ms / 1000),
      resumen: summary,
      analisis: custom_analysis_data
    }).catch(e => console.warn('[make-notificacion]', e.message));
  }

  return res.json({ received: true });
}

// ─── Respuesta JSON helper ───────────────────────────────────────────────────
function jsonRes(res, status, data) {
  res.status(status).json(data);
}

// ─── Handler principal ───────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  // Extraer la subruta: /api/miranda/buscar-propiedades → /buscar-propiedades
  const urlPath = (req.url || '').split('?')[0].replace(/^\/api\/miranda/, '');

  // GET /health — sin autenticación
  if (req.method === 'GET' && urlPath === '/health') {
    return res.json({
      status: 'ok',
      agent: 'Miranda',
      timestamp: new Date().toISOString(),
      version: '2.0.0',
      retell_agent_id: process.env.RETELL_AGENT_ID || 'agent_02209e2c6612d2e35447a6a899'
    });
  }

  // POST /webhook-postcall — usa secreto diferente (HMAC de Retell)
  if (req.method === 'POST' && urlPath === '/webhook-postcall') {
    try {
      return await webhookPostcall(req.body || {}, res);
    } catch (err) {
      console.error('[webhook-postcall]', err.message);
      return jsonRes(res, 500, { error: err.message });
    }
  }

  // El resto requiere autenticación Bearer
  if (!verificarRetell(req)) {
    return jsonRes(res, 401, { error: 'No autorizado' });
  }

  if (req.method !== 'POST') {
    return jsonRes(res, 405, { error: 'Method not allowed' });
  }

  const body = req.body || {};

  try {
    switch (urlPath) {
      case '/buscar-propiedades':
        return await buscarPropiedades(body, res);
      case '/calcular-hipoteca':
        return await calcularHipoteca(body, res);
      case '/calificar-lead':
        return await calificarLead(body, res);
      case '/enviar-ficha':
        return await enviarFicha(body, res);
      default:
        return jsonRes(res, 404, { error: 'Endpoint no encontrado' });
    }
  } catch (err) {
    console.error(`[miranda${urlPath}]`, err.message);
    return jsonRes(res, 500, { error: 'Error interno', mensaje: 'Tuve un problema técnico. ¿Me puede dar un momento?' });
  }
};
