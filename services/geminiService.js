import config from '../config/env.js';
import { CATALOGO_OMAYA } from '../config/catalogo.js';

const LIMA_TIME_ZONE = 'America/Lima';
const SESSION_TTL_MS = Number(process.env.GEMINI_SESSION_TTL_MS || 30 * 60 * 1000);
const BOOKED_TTL_MS = Number(process.env.GEMINI_BOOKED_SESSION_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const DEBOUNCE_MS = Number(process.env.GEMINI_DEBOUNCE_MS || 0);
const MAX_HISTORY_MESSAGES = Number(process.env.GEMINI_MAX_HISTORY || 6);
const MAX_OUTPUT_TOKENS = 300;
const CLEANUP_MS = Number(process.env.GEMINI_CLEANUP_MS || 60 * 1000);
export const SYSTEM_PROMPT = `Eres el asistente virtual de [NOMBRE DE TU CLÍNICA]. Responde siempre breve, cálido y directo.

OBJETIVO
Responde con precisión a lo que el paciente consulta. Invita a agendar únicamente tras resolver su duda o si manifiesta interés en una cita. No repitas la invitación en cada respuesta.

REGLA DE LLEGADA / EN PUERTA (PRIORIDAD ALTA)
Si el paciente indica que ya está en camino, por llegar o en la puerta (ej. "ya estoy yendo", "llego en 15 min", "estoy afuera", "ya llegué"), responde de inmediato exactamente:
"¡Hola! Gracias por avisarnos. Nuestra asistente le llamará, espere un momento por favor."

CONTEXTO PREVIO
El saludo de bienvenida y presentación ya fue enviado en el primer contacto. No saludes de nuevo formalmente ni menciones imágenes, logos o archivos multimedia.

FORMATO OBLIGATORIO
- Máximo 2 a 3 oraciones breves y 1 a 2 emojis por mensaje.
- Prohibido redactar párrafos extensos o listas numeradas largas.
- Permite que el paciente escriba con total naturalidad; no le pidas comandos ni frases formateadas.
- Si recibes mensajes consecutivos en el historial, sintetízalos y responde al conjunto en un único mensaje.

PRECIOS REFERENCIALES (S/)
Consulta y diagnóstico: 30 · Profilaxis/limpieza profunda: 80 · Curación simple con resina: 70 · Blanqueamiento: 250 · Ortodoncia (evaluación/cuota inicial): 350 · Endodoncia: 280.
Entrega el precio exacto de inmediato y añade que el presupuesto final se valida en la evaluación clínica presencial.

FECHAS Y HORARIOS
Horario de atención: Lunes a sábado de 9:00 am a 8:00 pm.
- Acepta expresiones temporales como "mañana", "el viernes", "este sábado", o fechas puntuales.
- Si el paciente propone un horario fuera de la ventana de atención o un domingo, aclara el horario disponible amablemente.
- Si indica un rango ambiguo ("la otra semana", "cualquier día"), solicita el día exacto de su preferencia.

FLUJO DE AGENDAMIENTO
Pide un dato a la vez con naturalidad cuando el paciente desee agendar:
1. Nombre y apellido.
2. Número de contacto (valida si usamos el mismo número de WhatsApp desde el que escribe o prefiere otro).
3. Tratamiento o motivo de la consulta.
4. Día y turno/hora preferida.

Al reunir la información, resume los datos y notifica que el equipo de recepción se comunicará para confirmar la disponibilidad. NUNCA afirmes que la cita "ya está registrada/confirmada al 100%".`;
const chatSessions = new Map();
const failureCounts = new Map();

const MONTHS = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};
const WEEKDAYS = {
  domingo: 0, lunes: 1, martes: 2, miércoles: 3, miercoles: 3,
  jueves: 4, viernes: 5, sábado: 6, sabado: 6,
};

function sessionId(jid) {
  return String(jid || '').split('@')[0];
}

function scheduleCleanup(sid, session) {
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    chatSessions.delete(sid);
    failureCounts.delete(sid);
  }, session.booked ? BOOKED_TTL_MS : SESSION_TTL_MS);
  session.timer.unref?.();
}

async function restoreSession(sid, session) {
  const { getByPhone } = await import('./leadService.js');
  if (typeof getByPhone !== 'function') return;
  const stored = await getByPhone(sid);
  if (!stored) return;
  session.leadSnapshot = stored;
  session.booked = Boolean(stored.fecha_hora_iso || stored.fechaHoraISO);
}

export function getOrCreateSession(jid) {
  const sid = sessionId(jid);
  let session = chatSessions.get(sid);
  if (!session) {
    session = {
      history: [],
      timer: null,
      lastUserMessageAt: 0,
      booked: false,
      leadSnapshot: null,
      paused: false,
      restorePromise: null,
    };
    session.restorePromise = restoreSession(sid, session).catch(() => null);
    chatSessions.set(sid, session);
  }
  scheduleCleanup(sid, session);
  return session;
}

export async function ensureSessionLoaded(session) {
  if (session?.restorePromise) {
    await session.restorePromise;
    session.restorePromise = null;
  }
  return session;
}

export function pauseSessionById(jid) {
  const sid = sessionId(jid);
  const session = getOrCreateSession(sid);
  session.paused = true;
  return true;
}

export function resumeSessionById(jid) {
  const session = chatSessions.get(sessionId(jid));
  if (!session) return false;
  session.paused = false;
  return true;
}

export function isSessionPaused(jid) {
  return Boolean(chatSessions.get(sessionId(jid))?.paused);
}

export function resetSession(jid) {
  const sid = sessionId(jid);
  chatSessions.delete(sid);
  failureCounts.delete(sid);
  return true;
}

export function mergeRecentUserMessages(history, windowMs = 10000) {
  if (!Array.isArray(history)) return [];
  const result = [];
  for (const message of history) {
    if (message.role !== 'user' || !result.length) {
      result.push(message);
      continue;
    }
    const previous = result[result.length - 1];
    if (previous.role === 'user' && message.at && previous.at && message.at - previous.at <= windowMs) {
      const text = [...(previous.parts || []), ...(message.parts || [])]
        .map((part) => part.text || '').filter(Boolean).join(' ');
      previous.parts = [{ text }];
      previous.text = text;
      previous.at = message.at;
    } else {
      result.push(message);
    }
  }
  return result;
}

function normalizeHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const partText = (Array.isArray(entry.parts) ? entry.parts : [])
    .map((part) => part?.text || '')
    .join(' ')
    .trim();
  const text = (entry.text && String(entry.text).trim()) || partText || '';
  if (!text) return null;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (/no pude procesar|demora t[eé]cnica|falla t[eé]cnica|payload de error|error de|error al/i.test(normalized)) {
    return null;
  }
  return { ...entry, text: normalized, parts: [{ text: normalized }] };
}

function compactHistoryForPrompt(history, maxMessages = MAX_HISTORY_MESSAGES) {
  if (!Array.isArray(history)) return [];
  return history
    .map(normalizeHistoryEntry)
    .filter(Boolean)
    .slice(-maxMessages);
}

function textFromHistory(history) {
  return compactHistoryForPrompt(history)
    .filter((entry) => entry.role === 'user')
    .map((entry) => entry.text || '')
    .filter(Boolean)
    .join('\n');
}

export function extractLeadDataFromText(text = '', senderPhone = '', lastBotQuestion = null) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const cleanText = text.trim();
  const normalized = cleanText.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const lowerText = normalized.toLowerCase();
  const data = { nombre: null, telefono: null, motivo: null, fecha_preferida: null, fechaHora: null };

  const phoneMatch = cleanText.match(/\b9\d{8}\b/);
  if (phoneMatch) {
    data.telefono = phoneMatch[0];
  } else if (/^(?:este|este numero|este mismo|aqui|por aca|al mio|si)$/i.test(normalized) || lastBotQuestion === 'telefono') {
    const senderDigits = String(senderPhone).replace(/\D/g, '');
    data.telefono = senderDigits.match(/(?:51)?(9\d{8})/)?.[1] || null;
  }

  const treatments = [
    'tratamiento de conducto', 'ortodoncia', 'brackets', 'frenillos', 'limpieza',
    'profilaxis', 'sarro', 'blanqueamiento', 'curacion', 'curaciones', 'resina',
    'caries', 'endodoncia', 'extraccion', 'sacar muela', 'muela del juicio',
    'implante', 'protesis', 'consulta', 'evaluacion', 'revision', 'diagnostico',
  ];
  const treatment = treatments.find((item) => new RegExp('\\b' + item + '\\b', 'i').test(lowerText));
  if (treatment) data.motivo = treatment.charAt(0).toUpperCase() + treatment.slice(1);

  const dateMatch = cleanText.match(/\b(?:hoy|mañana|pasado mañana|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado)(?:\s+\d{1,2}\s+de\s+[a-záéíóú]+)?(?:\s+(?:a\s*las?\s*)?\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.|de la tarde|de la mañana)?)?/i)
    || cleanText.match(/\b\d{1,2}\s*(?:de\s*)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+(?:a\s*las?\s*)?\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?)?/i);
  const timeMatch = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.|de la tarde|de la mañana)\b|\b(?:mañana|tarde|noche)\b/i.test(cleanText);
  if (dateMatch && (timeMatch || /\b(?:hoy|mañana|pasado mañana|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado)\b/i.test(cleanText))) {
    data.fecha_preferida = timeMatch ? cleanText : dateMatch[0].trim();
    data.fechaHora = data.fecha_preferida;
  }

  const explicitName = cleanText.match(/^(?:me llamo|mi nombre es|soy)\s+(.+)$/i);
  const isNameContext = lastBotQuestion === 'nombre' || Boolean(explicitName);
  if (isNameContext) {
    const rawName = (explicitName?.[1] || cleanText).replace(/[^\p{L}\s'-]/gu, '').trim();
    const words = rawName.split(/\s+/).filter(Boolean);
    if (words.length >= 1 && words.length <= 4 && !/\d/.test(rawName) && !data.motivo) data.nombre = rawName;
  }

  return Object.values(data).some(Boolean) ? data : null;
}

export function isValidName(name) {
  return typeof name === 'string'
    && name.trim().length >= 2
    && !/^(?:no proporcionad[oa]|dr\.?\s*\w+|estimado|paciente)$/i.test(name.trim());
}

export function isExplicitConfirmation(text) {
  if (typeof text !== 'string') return false;
  const value = text.trim().toLowerCase();
  if (/\b(pero|cambiar|reprogramar|otra hora|otra fecha|prefiero|no puedo|espera|luego)\b/.test(value)) return false;
  return /^(?:sí|si|confirmo|confirmado|correcto|vale|perfecto|ok|claro|de acuerdo|gracias)(?:[,.]?\s*(?:sí|si|confirmo|confirmado|correcto|vale|perfecto|ok|claro|de acuerdo|gracias))*[.!]?$/.test(value);
}

function extractResultText(result) {
  if (typeof result === 'string') return result;
  if (typeof result?.text === 'string') return result.text;
  const response = result?.response;
  if (typeof response?.text === 'string') return response.text;
  return response?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join(' ').trim() || '';
}

export function sanitizeModelTextOutput(rawText) {
  if (typeof rawText !== 'string') return '';
  let text = rawText
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .replace(/\[ENVIAR[_ ]?IMAGEN:[^\]]+\]/gi, '')
    .replace(/\[AGENDAR_CITA:\{[\s\S]*?\}\]/gi, '')
    .trim();
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      text = typeof parsed.response === 'string' ? parsed.response
        : typeof parsed.text === 'string' ? parsed.text : text;
    } catch {
      text = text.replace(/^\s*\{\s*"(?:response|texto|text|message)"\s*:\s*"([\s\S]*)"\s*\}\s*$/i, '$1');
    }
  }
  return text.replace(/[*_]/g, '').replace(/\s+/g, ' ').trim();
}

function limaNow() {
  return new Intl.DateTimeFormat('es-PE', {
    timeZone: LIMA_TIME_ZONE, weekday: 'long', year: 'numeric', month: 'long',
    day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(new Date());
}

export function buildSystemPromptWithContext(jid, session = null, clinic = null) {
  const profile = clinic || config.clinicProfile || {};
  const address = profile.address || 'Av. Los Próceres 450, Lima, Perú';
  const hours = profile.hours || 'Lunes a sábado de 9:00 a. m. a 8:00 p. m.';
  const snapshot = session?.leadSnapshot;
  const patientName = snapshot?.nombre || extractLeadDataFromText(textFromHistory(session?.history))?.nombre;
  const booked = session?.booked ? '\nEsta sesión ya tiene una cita registrada. No vuelvas a pedir sus datos salvo que solicite cambios.' : '';
  const systemPrompt = SYSTEM_PROMPT.replaceAll('[NOMBRE DE TU CLÍNICA]', profile.name || 'OMAYA DENT');
  return `${systemPrompt}\n\nDATOS ACTUALIZADOS:\n- Clínica: ${profile.name || 'OMAYA DENT'}\n- Dirección: ${address}\n- Horario: ${hours}\n- Fecha y hora actual en Lima: ${limaNow()}\n- Número de WhatsApp del usuario: ${sessionId(jid)}\n  ${patientName ? `- Nombre del paciente ya proporcionado: ${patientName}` : ''}${snapshot ? `- Datos ya proporcionados: ${JSON.stringify(snapshot)}` : ''}${booked}`;
}

export function parseTextToLimaDate(text) {
  if (typeof text !== 'string') return null;
  const now = new Date(Date.now());
  const base = new Date(Date.UTC(Number(new Intl.DateTimeFormat('en', { timeZone: LIMA_TIME_ZONE, year: 'numeric' }).format(now)), Number(new Intl.DateTimeFormat('en', { timeZone: LIMA_TIME_ZONE, month: 'numeric' }).format(now)) - 1, Number(new Intl.DateTimeFormat('en', { timeZone: LIMA_TIME_ZONE, day: 'numeric' }).format(now))));
  const value = text.toLowerCase();
  if (value.includes('pasado mañana')) base.setUTCDate(base.getUTCDate() + 2);
  else if (value.includes('mañana')) base.setUTCDate(base.getUTCDate() + 1);
  else if (!value.includes('hoy')) {
    const weekday = Object.entries(WEEKDAYS).find(([name]) => value.includes(name));
    if (weekday) while (base.getUTCDay() !== weekday[1]) base.setUTCDate(base.getUTCDate() + 1);
    const date = value.match(/(\d{1,2})\s*(?:de\s*)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/);
    if (date) base.setUTCDate(1), base.setUTCMonth(MONTHS[date[2]] - 1), base.setUTCDate(Number(date[1]));
  }
  const time = value.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
    || value.match(/\ba\s*las?\s+(\d{1,2})(?::(\d{2}))?\b/i);
  if (!time) return null;
  let hour = Number(time[1]);
  if (time[3]?.toLowerCase() === 'pm' && hour < 12) hour += 12;
  if (time[3]?.toLowerCase() === 'am' && hour === 12) hour = 0;
  base.setUTCHours(hour + 5, Number(time[2] || 0), 0, 0);
  return base.toISOString().replace('.000Z', '+00:00');
}

export function parseTextToLimaISO(text) {
  return parseTextToLimaDate(text)?.replace('.000Z', '+00:00') || null;
}

export function formatLimaFechaHoraText(iso) {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return null;
  const date = new Intl.DateTimeFormat('es-PE', { timeZone: LIMA_TIME_ZONE, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
  const time = new Intl.DateTimeFormat('es-PE', { timeZone: LIMA_TIME_ZONE, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
  return `${date}, ${time.replace(/\s*a\.?\s*m\.?/i, ' AM').replace(/\s*p\.?\s*m\.?/i, ' PM')}`;
}

function buildRequest(client, message, session, jid, options) {
  const systemPrompt = buildSystemPromptWithContext(jid, session, options.clinic);
  const history = compactHistoryForPrompt(mergeRecentUserMessages(session.history))
    .map((entry) => `${entry.role === 'model' ? 'Asistente' : 'Paciente'}: ${entry.text}`)
    .join('\n');
  const messageParts = Array.isArray(options.messageParts) && options.messageParts.length
    ? options.messageParts
    : [{ type: 'text', content: String(message || '') }];
  const prompt = `${systemPrompt}

${history}
Cliente: ${messageParts.filter((part) => part.type === 'text').map((part) => part.content).join('\n')}`;
  if (typeof client?.generateContent === 'function') {
    const parts = [];
    let previousInputType = null;
    for (const part of messageParts) {
      if (part.type === 'image') {
        parts.push({ inlineData: { mimeType: part.mimeType, data: part.base64Data } });
        if (part.caption) parts.push({ text: part.caption });
        previousInputType = 'image';
      } else {
        const previous = parts[parts.length - 1];
        if (previous?.text && previousInputType === 'text') {
          previous.text += `\n${part.content}`;
        } else {
          parts.push({ text: part.content });
        }
        previousInputType = 'text';
      }
    }
    return {
      structured: true,
      request: {
        contents: [{ role: 'user', parts: [{ text: prompt }, ...parts] }],
        systemInstruction: systemPrompt,
        generationConfig: { maxOutputTokens: options.maxOutputTokens || MAX_OUTPUT_TOKENS },
      },
    };
  }
  return { structured: false, prompt };
}

async function callGemini(client, request, options) {
  const attempts = Math.max(1, Number(options.maxRetries ?? 1) + 1);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (request.structured) return await client.generateContent(request.request, { model: config.gemini.model });
      if (typeof client?.generate === 'function') {
        return await client.generate(request.prompt, { model: config.gemini.model, maxOutputTokens: options.maxOutputTokens || MAX_OUTPUT_TOKENS });
      }
      throw new Error('Gemini client does not support generate or generateContent');
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts && /timeout|network|ECONNRESET|ECONNREFUSED|5\d{2}/i.test(String(error?.message || error))) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      } else {
        break;
      }
    }
  }
  throw lastError;
}

function collectLead(session, message, senderPhone = null) {
  const current = extractLeadDataFromText(textFromHistory(session.history), senderPhone);
  const incoming = extractLeadDataFromText(message, senderPhone);
  const lead = {
    nombre: incoming?.nombre || current?.nombre || session.leadSnapshot?.nombre || null,
    telefono: incoming?.telefono || current?.telefono || session.leadSnapshot?.telefono || null,
    motivo: incoming?.motivo || current?.motivo || session.leadSnapshot?.motivo || null,
    fechaHora: incoming?.fechaHora || current?.fechaHora || session.leadSnapshot?.fecha_hora_texto || null,
  };
  if (lead.fechaHora) {
    lead.fechaHoraISO = parseTextToLimaISO(lead.fechaHora);
    if (lead.fechaHoraISO) lead.fechaHora = formatLimaFechaHoraText(lead.fechaHoraISO);
  }
  lead.ready_to_notify = Boolean(isValidName(lead.nombre) && /^9\d{8}$/.test(lead.telefono || '') && lead.motivo && lead.fechaHoraISO);
  return Object.values(lead).some(Boolean) ? lead : null;
}

export function determinarCategoriaImagen(mensaje, respuestaIA) {
  const texto = String(mensaje || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!texto.trim()) return null;

  const exclusiones = [
    /\b(?:atienden|abierto|abierta|siguen|hora|horario|horarios)\b/,
    /\b(?:cuota|cuotas|mensualidad|mensualidades|financiamiento|forma de pago|formas de pago)\b/,
    /\b(?:sacar cita|agendar|quiero cita|turno|reservar|reserva)\b/,
    /^(?:hola|buenas(?: tardes| dias| noches)?|gracias|ok|dale)[!.?\s]*$/,
  ];
  if (exclusiones.some((pattern) => pattern.test(texto))) return null;

  const mapeoTratamientos = [
    { claves: ['bracket', 'brackets', 'ortodoncia', 'frenillos', 'frenos', 'invisalign'], categoria: 'ortodoncia' },
    { claves: ['antes y despues', 'resultados ortodoncia', 'caso ortodoncia'], categoria: 'ortodoncia_1' },
    { claves: ['implante', 'implantes'], categoria: 'implantes' },
    { claves: ['limpieza', 'profilaxis', 'destartraje', 'sarro'], categoria: 'limpieza' },
    { claves: ['kit preventivo', 'preventivo', 'kit dental', 'kit'], categoria: 'kit_preventivo' },
    { claves: ['resina', 'resinas', 'curacion', 'curaciones', 'restauracion', 'restauración'], categoria: 'restauracion' },
    { claves: ['carilla', 'carillas', 'diseño de sonrisa', 'sonrisa'], categoria: 'carillas' },
    { claves: ['blanqueamiento', 'blanquear'], categoria: 'blanqueamiento' },
    { claves: ['endodoncia', 'conducto'], categoria: 'endodoncia' },
    { claves: ['odontopediatria', 'odontopediatría', 'niño', 'niños', 'bebe', 'hijo'], categoria: 'odontopediatria' },
    { claves: ['protesis', 'prótesis', 'placa'], categoria: 'protesis' },
    { claves: ['extraccion', 'extracción', 'muela del juicio', 'sacar muela'], categoria: 'extraccion' },
    { claves: ['periodoncia', 'encia', 'encía', 'encias'], categoria: 'periodoncia' },
    { claves: ['corona', 'coronas', 'funda'], categoria: 'corona' },
    { claves: ['gingivectomia', 'gingivectomía'], categoria: 'gingivectomia' },
    { claves: ['cuanto cuesta la evaluacion', 'costo de consulta', 'que incluye el chequeo', 'diagnostico', 'consulta inicial'], categoria: 'evaluacion' },
    { claves: ['ubicacion', 'ubicados', 'ubicadas', 'sede', 'direccion', 'mapa', 'donde queda', 'donde quedan'], categoria: 'ubicacion' },
    { claves: ['fachada', 'clinica', 'consultorio', 'instalaciones'], categoria: 'fachada' },
  ];

  for (const item of mapeoTratamientos) {
    if (item.claves.some((clave) => texto.includes(clave))) {
      return item.categoria;
    }
  }

  return null;
}

export function getImagenCategoria(categoria) {
  if (!categoria) return null;
  const valor = CATALOGO_OMAYA[categoria] || CATALOGO_OMAYA.default || CATALOGO_OMAYA.tratamientos || null;
  // Si la categoría tiene varias fotos (ej. casos antes/después), elige una al azar
  // en vez de mandar siempre la primera — así no se repite la misma imagen cada vez.
  if (Array.isArray(valor)) {
    return valor[Math.floor(Math.random() * valor.length)];
  }
  return valor;
}

export async function obtenerRespuestaIA(jid, mensaje, options = {}) {
  const session = getOrCreateSession(jid);
  await ensureSessionLoaded(session);
  const sid = sessionId(jid);
  const now = Date.now();
  if (!options.skipDebounce && now - session.lastUserMessageAt < DEBOUNCE_MS) {
    return { texto: null, leadData: null, skipResponse: true };
  }
  session.lastUserMessageAt = now;
  const messageParts = Array.isArray(options.messageParts) && options.messageParts.length
    ? options.messageParts
    : [{ type: 'text', content: String(mensaje || '') }];
  const messageText = messageParts.filter((part) => part.type === 'text').map((part) => part.content).join('\n');
  session.history.push({ role: 'user', parts: [{ text: messageText }], at: now });
  session.history = compactHistoryForPrompt(session.history, MAX_HISTORY_MESSAGES);
  try {
    const result = await callGemini(options.client, buildRequest(options.client, messageText, session, jid, { ...options, messageParts }), options);
    const rawText = extractResultText(result);
    const leadData = collectLead(session, messageText, sid);
    let texto = sanitizeModelTextOutput(rawText);
    if (!leadData?.ready_to_notify && !session.booked && /\b(?:tu cita|qued[oó]\s+agendada|ya est[aá]\s+agendada)\b/i.test(texto)) {
      texto = 'Para ayudarte a agendar, indícame tu nombre, teléfono, tratamiento y fecha o turno preferido. 😊📅';
    }
    session.history.push({ role: 'model', parts: [{ text: rawText || '' }] });
    session.history = compactHistoryForPrompt(session.history, MAX_HISTORY_MESSAGES);
    failureCounts.delete(sid);

    const categoria = determinarCategoriaImagen(messageText, rawText);
    const imagenURL = getImagenCategoria(categoria);

    if (leadData?.ready_to_notify && !options.skipLeadPersistence) {
      session.booked = true;
      session.leadSnapshot = { ...leadData, fecha_hora_texto: leadData.fechaHora, fecha_hora_iso: leadData.fechaHoraISO, confirmedAt: new Date().toISOString() };
      try {
        const { saveLeadSnapshot } = await import('./leadService.js');
        await saveLeadSnapshot(sid, session.leadSnapshot);
      } catch (error) {
        console.warn('geminiService: lead snapshot persistence failed:', error?.message || error);
      }
      scheduleCleanup(sid, session);
    }

    return { texto, leadData, imagenURL, skipLeadPersistence: Boolean(options.skipLeadPersistence) };
  } catch (error) {
    const failures = (failureCounts.get(sid) || 0) + 1;
    failureCounts.set(sid, failures);
    return {
      texto: null,
      leadData: null,
      imagenURL: null,
      skipResponse: true,
    };
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, session] of chatSessions) {
    if (now - session.lastUserMessageAt > (session.booked ? BOOKED_TTL_MS : SESSION_TTL_MS)) {
      chatSessions.delete(sid);
      failureCounts.delete(sid);
    }
  }
}, CLEANUP_MS).unref?.();

export default {
  obtenerRespuestaIA,
  sanitizeModelTextOutput,
  isExplicitConfirmation,
  pauseSessionById,
  resumeSessionById,
  isSessionPaused,
  resetSession,
  getOrCreateSession,
  extractLeadDataFromText,
  isValidName,
  determinarCategoriaImagen,
  getImagenCategoria,
};