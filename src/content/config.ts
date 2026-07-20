import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const productos = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/productos' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    category: z.enum(['cumpleanos', 'bebe', 'decoracion', 'regalo']),
    image: z.string(),
    featured: z.boolean().default(false),
  }),
});

export const collections = { productos };
