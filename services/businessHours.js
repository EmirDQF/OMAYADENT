const LIMA_TIME_ZONE = 'America/Lima';
const OPEN_MINUTES = 9 * 60;
const CLOSE_MINUTES = 20 * 60;

function getLimaParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: LIMA_TIME_ZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    weekday: values.weekday,
    minutes: Number(values.hour) * 60 + Number(values.minute),
  };
}

export function isWithinBusinessHours(date = new Date()) {
  const { weekday, minutes } = getLimaParts(date);
  return weekday !== 'Sun' && minutes >= OPEN_MINUTES && minutes < CLOSE_MINUTES;
}

export function isArrivalIntent(text) {
  if (typeof text !== 'string') return false;
  return /\b(?:ya\s+estoy\s+(?:yendo|aqui|afuera)|estoy\s+afuera|llego\s+en\s+\d+\s*(?:minutos?|mins?)|estoy\s+a\s+\d+\s*(?:minutos?|mins?)|estoy\s+en\s+(?:la\s+)?puerta|ya\s+llegue)\b/i.test(text.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
}

export const AFTER_HOURS_MESSAGE = `Gracias por escribir a OMAYA DENT. En este momento estamos fuera de nuestro horario de atención (lunes a sábado, de 9:00 AM a 8:00 PM; domingo cerrado), pero nuestra asistente virtual puede ayudarle ahora mismo:
1. Resolver dudas sobre tratamientos y precios.
2. Registrar sus datos para agendar una cita (nombre, DNI, fecha/hora deseada y especialidad).
3. Dejar su solicitud registrada para que el equipo la revise.

¿En qué tratamiento podemos ayudarle?`;

export const ARRIVAL_MESSAGE = '¡Hola! Gracias por avisarnos. Nuestra asistente le llamará, espere un momento por favor.';
