import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { validateApiKey } from './_api-key.js';

export const config = { runtime: 'edge' };

const BOOTSTRAP_CACHE_KEYS = {
  earthquakes:      'seismology:earthquakes:v1',
  outages:          'infra:outages:v1',
  serviceStatuses:  'infra:service-statuses:v1',
  sectors:          'market:sectors:v1',
  etfFlows:         'market:etf-flows:v1',
  macroSignals:     'economic:macro-signals:v1',
  bisPolicy:        'economic:bis:policy:v1',
  bisExchange:      'economic:bis:eer:v1',
  bisCredit:        'economic:bis:credit:v1',
  shippingRates:    'supply_chain:shipping:v2',
  chokepoints:      'supply_chain:chokepoints:v1',
  minerals:         'supply_chain:minerals:v1',
  giving:           'giving:summary:v1',
  climateAnomalies: 'climate:anomalies:v1',
  wildfires:        'wildfire:fires:v1',
};

const FEATURE_SECRET_REQUIREMENTS = {
  aiOllama: ['OLLAMA_API_URL', 'OLLAMA_MODEL'],
  aiOpenAI: ['OPENAI_API_KEY'],
  aiGroq: ['GROQ_API_KEY'],
  aiOpenRouter: ['OPENROUTER_API_KEY'],
  economicFred: ['FRED_API_KEY'],
  energyEia: ['EIA_API_KEY'],
  internetOutages: ['CLOUDFLARE_API_TOKEN'],
  acledConflicts: ['ACLED_ACCESS_TOKEN'],
  abuseChThreatIntel: ['URLHAUS_AUTH_KEY'],
  alienvaultOtxThreatIntel: ['OTX_API_KEY'],
  abuseIpdbThreatIntel: ['ABUSEIPDB_API_KEY'],
  wingbitsEnrichment: ['WINGBITS_API_KEY'],
  aisRelay: ['WS_RELAY_URL', 'AISSTREAM_API_KEY'],
  openskyRelay: ['VITE_OPENSKY_RELAY_URL', 'OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET'],
  finnhubMarkets: ['FINNHUB_API_KEY'],
  nasaFirms: ['NASA_FIRMS_API_KEY'],
  wtoTrade: ['WTO_API_KEY'],
  supplyChain: ['FRED_API_KEY'],
  newsPerFeedFallback: [],
  aviationStack: ['AVIATIONSTACK_API'],
  icaoNotams: ['ICAO_API_KEY'],
};

const NEG_SENTINEL = '__WM_NEG__';

function hasEnvSecret(key) {
  return typeof process.env[key] === 'string' && process.env[key].trim().length > 0;
}

function envEnabled(name) {
  const raw = process.env[name];
  if (typeof raw !== 'string' || !raw.trim()) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function isOpenAiProviderDisabled() {
  return envEnabled('LLM_DISABLE_OPENAI')
    || envEnabled('DISABLE_OPENAI')
    || envEnabled('OPENAI_DISABLED');
}

function computeFeatureAvailability() {
  const features = {};
  for (const [featureId, requiredSecrets] of Object.entries(FEATURE_SECRET_REQUIREMENTS)) {
    if (featureId === 'aiOpenAI' && isOpenAiProviderDisabled()) {
      features[featureId] = false;
      continue;
    }
    features[featureId] = requiredSecrets.every(hasEnvSecret);
  }
  return features;
}

async function getCachedJsonBatch(keys) {
  const result = new Map();
  if (keys.length === 0) return result;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return result;

  // Always read unprefixed keys — bootstrap is a read-only consumer of
  // production cache data. Preview/branch deploys don't run handlers that
  // populate prefixed keys, so prefixing would always miss.
  const pipeline = keys.map((k) => ['GET', k]);
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(pipeline),
    signal: AbortSignal.timeout(3000),
  });
  if (!resp.ok) return result;

  const data = await resp.json();
  for (let i = 0; i < keys.length; i++) {
    const raw = data[i]?.result;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed !== NEG_SENTINEL) result.set(keys[i], parsed);
      } catch { /* skip malformed */ }
    }
  }
  return result;
}

export default async function handler(req) {
  if (isDisallowedOrigin(req))
    return new Response('Forbidden', { status: 403 });

  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: cors });

  const apiKeyResult = validateApiKey(req);
  if (apiKeyResult.required && !apiKeyResult.valid)
    return new Response(JSON.stringify({ error: apiKeyResult.error }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    });

  const url = new URL(req.url);
  const requested = url.searchParams.get('keys')?.split(',').filter(Boolean);
  const capabilities = { features: computeFeatureAvailability() };
  const registry = requested
    ? Object.fromEntries(Object.entries(BOOTSTRAP_CACHE_KEYS).filter(([k]) => requested.includes(k)))
    : BOOTSTRAP_CACHE_KEYS;

  const keys = Object.values(registry);
  const names = Object.keys(registry);

  let cached;
  try {
    cached = await getCachedJsonBatch(keys);
  } catch {
    return new Response(JSON.stringify({ data: {}, missing: names, capabilities }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
    });
  }

  const data = {};
  const missing = [];
  for (let i = 0; i < names.length; i++) {
    const val = cached.get(keys[i]);
    if (val !== undefined) data[names[i]] = val;
    else missing.push(names[i]);
  }

  return new Response(JSON.stringify({ data, missing, capabilities }), {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/json',
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30',
    },
  });
}
