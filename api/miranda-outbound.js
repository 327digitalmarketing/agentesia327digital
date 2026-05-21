// api/miranda-outbound.js — Miranda · Llamadas SALIENTES (Outbound)
// Vercel Serverless Function — maneja /api/miranda/outbound/*
//
// Miranda llama proactivamente a clientes en 5 escenarios:
//   1. Nuevo lead inmediato   → llama en <5 min tras entrar en el CRM
//   2. Seguimiento post-visita → llama 24h después de una visita
//   3. Nueva propiedad match  → llama a leads cuyo perfil coincide
//   4. Recordatorio de visita → llama 2h antes de la visita agendada
//   5. Llamada manual         → el agente humano dispara la llamada
//   6. Generar CSV para batch → exporta leads para el batch caller de Retell

const Retell         = require('retell-sdk');
const { createClient } = require('@supabase/supabase-js');

const retell   = new Retell({ apiKey: process.env.RETELL_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ─── Middlewares ─────────────────────────────────────────────────────────────

function verificarMake(req) {
  return req.headers['x-make-secret'] === process.env.MAKE_OUTBOUND_SECRET;
}

function horarioPermitido() {
  const hora = new Date().toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid',
    hour: 'numeric',
    hour12: false
  });
  const h = parseInt(hora);
  return h >= 9 && h < 20;
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ─── Helper central: crear llamada saliente via Retell ───────────────────────

async function crearLlamada({ telefono, contexto = {}, motivo = 'seguimiento' }) {
  const telefonoLimpio = telefono.replace(/\s/g, '').replace(/^00/, '+');
  if (!telefonoLimpio.startsWith('+')) {
    throw new Error(`Teléfono no válido: ${telefono}. Debe estar en formato E.164 (+34...)`);
  }

  const llamada = await retell.call.createPhoneCall({
    from_number:       process.env.TWILIO_PHONE_NUMBER,
    to_number:         telefonoLimpio,
    override_agent_id: process.env.RETELL_AGENT_ID,
    retell_llm_dynamic_variables: {
      nombre_lead:       contexto.nombre       || 'cliente',
      motivo_llamada:    motivo,
      propiedad_interes: contexto.propiedad    || '',
      zona_preferida:    contexto.zona         || '',
      presupuesto:       contexto.presupuesto  ? `${contexto.presupuesto}€` : '',
      fecha_visita:      contexto.fecha_visita || '',
      notas_previas:     contexto.notas        || ''
    },
    metadata: {
      lead_id:   contexto.lead_id || null,
      motivo,
      origen:    contexto.origen  || 'api',
      timestamp: new Date().toISOString()
    }
  });

  if (contexto.lead_id) {
    await supabase.from('llamadas_salientes').insert({
      lead_id:        contexto.lead_id,
      retell_call_id: llamada.call_id,
      motivo,
      estado:         'iniciada',
      created_at:     new Date().toISOString()
    }).catch(e => console.warn('[supabase-log]', e.message));
  }

  return llamada;
}

// ─── Handlers por escenario ──────────────────────────────────────────────────

// ESCENARIO 1 — Lead nuevo: llamar en menos de 5 minutos
// Trigger: Make.com al detectar un nuevo registro en la tabla leads
async function nuevoLead(body, res) {
  const { lead_id, nombre, telefono, zona, presupuesto, operacion, fuente } = body;

  if (!telefono) return res.status(400).json({ error: 'telefono es requerido' });
  if (!horarioPermitido()) {
    return res.json({ llamada_iniciada: false, motivo: 'Fuera de horario permitido (9-20h)' });
  }

  const { data: llamadasPrevias } = await supabase
    .from('llamadas_salientes')
    .select('id')
    .eq('lead_id', lead_id)
    .eq('motivo', 'nuevo_lead')
    .limit(1);

  if (llamadasPrevias?.length > 0) {
    return res.json({ llamada_iniciada: false, motivo: 'Lead ya fue contactado previamente' });
  }

  const llamada = await crearLlamada({
    telefono,
    motivo: 'nuevo_lead',
    contexto: {
      lead_id,
      nombre,
      zona,
      presupuesto,
      propiedad: operacion || 'propiedad',
      origen:    fuente    || 'web'
    }
  });

  await supabase.from('leads').update({ estado: 'contactado' }).eq('id', lead_id);

  return res.json({
    llamada_iniciada: true,
    call_id:  llamada.call_id,
    mensaje:  `Miranda llamando a ${nombre} (${telefono})`
  });
}

// ESCENARIO 2 — Seguimiento post-visita (24h después)
// Trigger: Make.com con scheduler — busca visitas de hace 24h
async function seguimientoVisita(res) {
  const hace24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const hace26h = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();

  const { data: visitas } = await supabase
    .from('visitas')
    .select(`
      id,
      fecha_visita,
      leads!inner(id, nombre, telefono, notas),
      propiedades!inner(titulo, zona, precio)
    `)
    .eq('estado', 'completada')
    .gte('fecha_visita', hace26h)
    .lte('fecha_visita', hace24h);

  if (!visitas || visitas.length === 0) {
    return res.json({ procesadas: 0, mensaje: 'No hay visitas para seguimiento' });
  }

  const resultados = [];
  for (const visita of visitas) {
    if (!horarioPermitido()) break;
    try {
      const llamada = await crearLlamada({
        telefono: visita.leads.telefono,
        motivo:   'seguimiento_visita',
        contexto: {
          lead_id:   visita.leads.id,
          nombre:    visita.leads.nombre,
          propiedad: visita.propiedades.titulo,
          zona:      visita.propiedades.zona,
          notas:     visita.leads.notas
        }
      });
      resultados.push({ lead: visita.leads.nombre, call_id: llamada.call_id, ok: true });
      await delay(3000);
    } catch (e) {
      resultados.push({ lead: visita.leads.nombre, error: e.message, ok: false });
    }
  }

  return res.json({ procesadas: resultados.length, resultados });
}

// ESCENARIO 3 — Nueva propiedad que coincide con perfil de leads
// Trigger: Make.com cuando se añade una propiedad nueva a Supabase
async function nuevaPropiedad(body, res) {
  const { propiedad_id, titulo, zona, precio, operacion, habitaciones } = body;

  let query = supabase
    .from('leads')
    .select('id, nombre, telefono, zona_preferida, presupuesto_max, habitaciones_min, operacion, estado')
    .neq('estado', 'descartado')
    .neq('estado', 'cerrado')
    .lte('presupuesto_max', precio * 1.15)
    .gte('presupuesto_max', precio * 0.85);

  if (operacion)    query = query.eq('operacion', operacion);
  if (habitaciones) query = query.lte('habitaciones_min', habitaciones);

  const { data: leadsCoincidentes } = await query.limit(20);

  if (!leadsCoincidentes || leadsCoincidentes.length === 0) {
    return res.json({ contactados: 0, mensaje: 'No hay leads que coincidan con esta propiedad' });
  }

  const leadsZona = leadsCoincidentes.filter(lead => {
    if (!lead.zona_preferida?.length) return true;
    return lead.zona_preferida.some(z =>
      zona.toLowerCase().includes(z.toLowerCase()) ||
      z.toLowerCase().includes(zona.toLowerCase())
    );
  });

  const resultados = [];
  for (const lead of leadsZona.slice(0, 10)) {
    if (!horarioPermitido()) break;
    try {
      const llamada = await crearLlamada({
        telefono: lead.telefono,
        motivo:   'nueva_propiedad',
        contexto: {
          lead_id:     lead.id,
          nombre:      lead.nombre,
          propiedad:   titulo,
          zona,
          presupuesto: lead.presupuesto_max
        }
      });
      resultados.push({ lead: lead.nombre, call_id: llamada.call_id, ok: true });
      await delay(4000);
    } catch (e) {
      resultados.push({ lead: lead.nombre, error: e.message, ok: false });
    }
  }

  return res.json({
    propiedad:          titulo,
    leads_coincidentes: leadsZona.length,
    contactados:        resultados.length,
    resultados
  });
}

// ESCENARIO 4 — Recordatorio de visita (2h antes)
// Trigger: Make.com con scheduler cada hora — busca visitas en 2h
async function recordatorioVisita(res) {
  const en2h    = new Date(Date.now() + 2.00 * 60 * 60 * 1000).toISOString();
  const en2h15m = new Date(Date.now() + 2.25 * 60 * 60 * 1000).toISOString();

  const { data: visitas } = await supabase
    .from('visitas')
    .select(`
      id,
      fecha_visita,
      leads!inner(id, nombre, telefono),
      propiedades!inner(titulo, direccion, zona)
    `)
    .eq('estado', 'confirmada')
    .gte('fecha_visita', en2h)
    .lte('fecha_visita', en2h15m);

  if (!visitas?.length) {
    return res.json({ procesadas: 0 });
  }

  const resultados = [];
  for (const visita of visitas) {
    const fechaFormateada = new Date(visita.fecha_visita).toLocaleString('es-ES', {
      weekday: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid'
    });
    try {
      const llamada = await crearLlamada({
        telefono: visita.leads.telefono,
        motivo:   'recordatorio_visita',
        contexto: {
          lead_id:      visita.leads.id,
          nombre:       visita.leads.nombre,
          propiedad:    visita.propiedades.titulo,
          zona:         visita.propiedades.zona,
          fecha_visita: fechaFormateada
        }
      });
      resultados.push({ lead: visita.leads.nombre, ok: true, call_id: llamada.call_id });
      await delay(2000);
    } catch (e) {
      resultados.push({ lead: visita.leads.nombre, ok: false, error: e.message });
    }
  }

  return res.json({ procesadas: resultados.length, resultados });
}

// ESCENARIO 5 — Llamada individual manual (desde dashboard / CRM)
// El agente humano selecciona un lead y hace click en "Llamar con Miranda"
async function llamarLead(body, res) {
  const { lead_id, motivo = 'contacto_manual' } = body;

  if (!lead_id) return res.status(400).json({ error: 'lead_id es requerido' });

  const { data: lead, error } = await supabase
    .from('leads')
    .select('*')
    .eq('id', lead_id)
    .single();

  if (error || !lead) return res.status(404).json({ error: 'Lead no encontrado' });
  if (!lead.telefono)  return res.status(400).json({ error: 'El lead no tiene teléfono registrado' });

  const llamada = await crearLlamada({
    telefono: lead.telefono,
    motivo,
    contexto: {
      lead_id:     lead.id,
      nombre:      lead.nombre,
      zona:        lead.zona_preferida?.join(', '),
      presupuesto: lead.presupuesto_max,
      notas:       lead.notas
    }
  });

  return res.json({
    llamada_iniciada: true,
    call_id:  llamada.call_id,
    lead:     lead.nombre,
    telefono: lead.telefono
  });
}

// ESCENARIO 6 — Generar CSV para batch caller de Retell
// GET /api/miranda/outbound/generar-csv?estado=nuevo&score_min=6
async function generarCsv(query, res) {
  const { estado, score_min = 1, operacion, zona } = query;

  let q = supabase
    .from('leads')
    .select('nombre, telefono, zona_preferida, presupuesto_max, score, notas')
    .gte('score', parseInt(score_min))
    .not('telefono', 'is', null);

  if (estado)    q = q.eq('estado', estado);
  if (operacion) q = q.eq('operacion', operacion);

  const { data: leads } = await q.order('score', { ascending: false }).limit(200);

  if (!leads?.length) {
    return res.status(404).json({ error: 'No hay leads con esos filtros' });
  }

  const filas = leads.map(l => {
    const telefono = l.telefono.replace(/\s/g, '').replace(/^00/, '+');
    return [
      telefono,
      l.nombre || '',
      (l.zona_preferida || []).join('/'),
      l.presupuesto_max || '',
      l.notas?.substring(0, 100) || ''
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
  });

  const csv = [
    'phone_number,nombre_lead,zona_preferida,presupuesto,notas_previas',
    ...filas
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="miranda_batch_${Date.now()}.csv"`);
  return res.send('﻿' + csv); // BOM para Excel en español
}

// ─── Handler principal ───────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  // Subruta: /api/miranda/outbound/nuevo-lead → /nuevo-lead
  const urlPath = (req.url || '').split('?')[0].replace(/^\/api\/miranda\/outbound/, '');

  // GET /health — sin autenticación
  if (req.method === 'GET' && urlPath === '/health') {
    return res.json({ status: 'ok', agent: 'Miranda Outbound', timestamp: new Date().toISOString() });
  }

  if (!verificarMake(req)) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  // GET — generar CSV
  if (req.method === 'GET' && urlPath === '/generar-csv') {
    try {
      return await generarCsv(req.query || {}, res);
    } catch (err) {
      console.error('[outbound/generar-csv]', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};

  try {
    switch (urlPath) {
      case '/nuevo-lead':
        return await nuevoLead(body, res);
      case '/seguimiento-visita':
        return await seguimientoVisita(res);
      case '/nueva-propiedad':
        return await nuevaPropiedad(body, res);
      case '/recordatorio-visita':
        return await recordatorioVisita(res);
      case '/llamar-lead':
        return await llamarLead(body, res);
      default:
        return res.status(404).json({ error: 'Endpoint no encontrado' });
    }
  } catch (err) {
    console.error(`[miranda/outbound${urlPath}]`, err.message);
    return res.status(500).json({ error: err.message });
  }
};
