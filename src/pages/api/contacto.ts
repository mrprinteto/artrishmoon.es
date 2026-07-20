import type { APIRoute } from 'astro';
import { z } from 'zod';
import { Resend } from 'resend';

export const prerender = false;

// ─── In-memory rate limiter ───────────────────────────────────────────────────
// Works within a warm serverless instance. For multi-instance production,
// replace with Upstash Redis (@upstash/ratelimit).
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 3; // max requests
const RATE_LIMIT_WINDOW_MS = 60_000; // per minute

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return true;
  }
  entry.count++;
  return false;
}

// ─── Validation schema ────────────────────────────────────────────────────────
const contactSchema = z.object({
  nombre: z
    .string()
    .min(2, 'El nombre debe tener al menos 2 caracteres')
    .max(100, 'El nombre es demasiado largo'),
  email: z.string().email('Introduce un email válido'),
  tipo: z.enum(['cumpleanos', 'evento', 'regalo', 'otro'], {
    errorMap: () => ({ message: 'Selecciona un tipo de encargo válido' }),
  }),
  telefono: z
    .string()
    .max(30, 'El teléfono es demasiado largo')
    .regex(/^[+\d\s\-().]*$/, 'El teléfono no es válido')
    .optional()
    .or(z.literal('')),
  mensaje: z
    .string()
    .min(10, 'El mensaje debe tener al menos 10 caracteres')
    .max(2000, 'El mensaje es demasiado largo'),
  website: z.string().max(0).optional().or(z.literal('')), // honeypot
});

const TIPO_LABELS: Record<string, string> = {
  cumpleanos: 'Cartel de cumpleaños',
  evento: 'Decoración de evento',
  regalo: 'Regalo personalizado',
  otro: 'Otro',
};

function buildEmailHtml(data: z.infer<typeof contactSchema>): string {
  return `
    <!DOCTYPE html>
    <html lang="es">
    <head><meta charset="utf-8" /></head>
    <body style="font-family: 'Inter', sans-serif; background: #faf6f9; padding: 24px;">
      <div style="max-width: 560px; margin: 0 auto; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(43,34,48,0.08);">
        <div style="background: #ac8ec2; padding: 24px 28px;">
          <h1 style="margin: 0; color: #fff; font-size: 18px; font-weight: 600;">
            Nuevo mensaje desde ArtrishMoon.es
          </h1>
        </div>
        <div style="padding: 24px 28px;">
          <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <tr>
              <td style="padding: 8px 0; color: #8a6f9e; width: 130px; vertical-align: top;">Nombre</td>
              <td style="padding: 8px 0; color: #2b2230; font-weight: 600;">${data.nombre}</td>
            </tr>
            <tr style="border-top: 1px solid #f1e2ef;">
              <td style="padding: 8px 0; color: #8a6f9e; vertical-align: top;">Email</td>
              <td style="padding: 8px 0;">
                <a href="mailto:${data.email}" style="color: #ac8ec2;">${data.email}</a>
              </td>
            </tr>
            <tr style="border-top: 1px solid #f1e2ef;">
              <td style="padding: 8px 0; color: #8a6f9e; vertical-align: top;">Tipo de encargo</td>
              <td style="padding: 8px 0; color: #2b2230;">${TIPO_LABELS[data.tipo] ?? data.tipo}</td>
            </tr>
            ${
              data.telefono
                ? `<tr style="border-top: 1px solid #f1e2ef;">
              <td style="padding: 8px 0; color: #8a6f9e; vertical-align: top;">Teléfono</td>
              <td style="padding: 8px 0; color: #2b2230;">${data.telefono}</td>
            </tr>`
                : ''
            }
            <tr style="border-top: 1px solid #f1e2ef;">
              <td style="padding: 8px 0; color: #8a6f9e; vertical-align: top;">Mensaje</td>
              <td style="padding: 8px 0; color: #2b2230; white-space: pre-wrap;">${data.mensaje}</td>
            </tr>
          </table>
        </div>
        <div style="padding: 16px 28px; background: #f1e2ef; font-size: 12px; color: #8a6f9e;">
          Enviado desde artrishmoon.es · ${new Date().toLocaleString('es-ES')}
        </div>
      </div>
    </body>
    </html>
  `;
}

// ─── Route handler ────────────────────────────────────────────────────────────
export const POST: APIRoute = async ({ request }) => {
  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  // Resolve client IP
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    request.headers.get('x-real-ip') ??
    '0.0.0.0';

  if (isRateLimited(ip)) {
    return json(
      { ok: false, error: 'Demasiadas solicitudes. Espera un minuto e inténtalo de nuevo.' },
      429
    );
  }

  // Parse body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Solicitud inválida.' }, 400);
  }

  // Validate
  const result = contactSchema.safeParse(body);
  if (!result.success) {
    return json({ ok: false, errors: result.error.flatten().fieldErrors }, 422);
  }

  const data = result.data;

  // Honeypot: silently accept but do not send
  if (data.website) {
    return json({ ok: true }, 200);
  }

  // Send email
  try {
    const resend = new Resend(import.meta.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: 'ArtrishMoon <noreply@artrishmoon.es>',
      to: [import.meta.env.TO_EMAIL as string],
      replyTo: data.email,
      subject: `[ArtrishMoon] ${TIPO_LABELS[data.tipo]} — ${data.nombre}`,
      html: buildEmailHtml(data),
    });

    if (error) {
      console.error('[api/contacto] Resend API error:', error);
      return json({ ok: false, error: 'Error al enviar. Inténtalo de nuevo.' }, 500);
    }

    return json({ ok: true }, 200);
  } catch (err) {
    console.error('[api/contacto] Unexpected error:', err);
    return json({ ok: false, error: 'Error interno. Inténtalo de nuevo.' }, 500);
  }
};
