import { type Router as RouterType, Router } from 'express';
import { healthHandler } from './health.js';
import { getSpecHandler, updateSpecHandler } from './specs.js';
import { validateBody } from './middleware/validate.js';
import { PatchSpecBodySchema } from '../ast/index.js';

export const router: RouterType = Router();

router.get('/health', healthHandler);
router.get('/specs/:id', getSpecHandler);
router.patch('/specs/:id', validateBody(PatchSpecBodySchema), updateSpecHandler);
