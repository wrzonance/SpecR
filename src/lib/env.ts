import * as z from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  NODE_ENV: z.enum(['development', 'test', 'production']),
  LOG_LEVEL: z.string().default('info'),
  OCR_MIN_CHARS_PER_PAGE: z.coerce.number().int().positive().default(16),
});

const result = schema.safeParse(process.env);

if (!result.success) {
  process.stderr.write('Invalid environment variables:\n');
  process.stderr.write(JSON.stringify(result.error.issues, null, 2) + '\n');
  process.exit(1);
}

export const config = result.data;
export type Config = typeof result.data;
