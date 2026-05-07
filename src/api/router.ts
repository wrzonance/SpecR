import { type Router as RouterType, Router } from 'express'
import { healthHandler } from './health.js'

export const router: RouterType = Router()

router.get('/health', healthHandler)
