// One-time setup: creates Nova's custom contact properties in HubSpot if missing.
// Usage: HUBSPOT_API_KEY=pat-xxx node scripts/setup-hubspot-properties.js

const TOKEN = process.env.HUBSPOT_API_KEY;
if (!TOKEN) {
  console.error('Missing HUBSPOT_API_KEY env var.');
  process.exit(1);
}

const PROPERTIES = [
  {
    name: 'nova_sector',
    label: 'Nova — Sector',
    type: 'enumeration',
    fieldType: 'select',
    groupName: 'contactinformation',
    options: [
      { label: 'Real Estate',        value: 'real_estate' },
      { label: 'Dental',             value: 'dental' },
      { label: 'Aesthetic Clinic',   value: 'aesthetic' },
      { label: 'Education',          value: 'education' },
      { label: 'Business Services',  value: 'business_services' },
      { label: 'Other',              value: 'other' }
    ]
  },
  {
    name: 'nova_servicio_interes',
    label: 'Nova — Primary Service',
    type: 'enumeration',
    fieldType: 'select',
    groupName: 'contactinformation',
    options: [
      { label: 'AI Agents + CRM',   value: 'ai_agents_crm' },
      { label: 'Content + Web',     value: 'content_web' },
      { label: 'Sales Funnels',     value: 'sales_funnels' },
      { label: 'Email Marketing',   value: 'email_marketing' }
    ]
  },
  {
    name: 'nova_cross_sell',
    label: 'Nova — Cross-sell',
    type: 'enumeration',
    fieldType: 'select',
    groupName: 'contactinformation',
    options: [
      { label: 'AI Agents + CRM',   value: 'ai_agents_crm' },
      { label: 'Content + Web',     value: 'content_web' },
      { label: 'Sales Funnels',     value: 'sales_funnels' },
      { label: 'Email Marketing',   value: 'email_marketing' }
    ]
  },
  {
    name: 'nova_temperatura',
    label: 'Nova — Temperature',
    type: 'enumeration',
    fieldType: 'select',
    groupName: 'contactinformation',
    options: [
      { label: 'Hot',  value: 'HOT' },
      { label: 'Warm', value: 'WARM' },
      { label: 'Cold', value: 'COLD' }
    ]
  },
  {
    name: 'nova_resultado',
    label: 'Nova — Outcome',
    type: 'enumeration',
    fieldType: 'select',
    groupName: 'contactinformation',
    options: [
      { label: 'Call Booked',    value: 'call_booked' },
      { label: 'Demo Sent',      value: 'demo_sent' },
      { label: 'Resource Sent',  value: 'resource_sent' },
      { label: 'No Action',     value: 'no_action' }
    ]
  },
  {
    name: 'nova_resumen',
    label: 'Nova — Summary',
    type: 'string',
    fieldType: 'textarea',
    groupName: 'contactinformation'
  }
];

async function propertyExists(name) {
  const res = await fetch(`https://api.hubapi.com/crm/v3/properties/contacts/${name}`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  return res.ok;
}

async function createProperty(prop) {
  const res = await fetch('https://api.hubapi.com/crm/v3/properties/contacts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(prop)
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${body}`);
  }
}

(async () => {
  for (const prop of PROPERTIES) {
    const exists = await propertyExists(prop.name);
    if (exists) {
      console.log(`[skip] ${prop.name} already exists`);
      continue;
    }
    try {
      await createProperty(prop);
      console.log(`[created] ${prop.name}`);
    } catch (e) {
      console.error(`[error] ${prop.name}:`, e.message);
    }
  }
})();
