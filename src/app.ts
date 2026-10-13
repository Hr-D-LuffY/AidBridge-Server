import cors from 'cors'
import express, { type Request, type Response } from 'express'
import helmet from 'helmet'
import httpStatus from 'http-status'
import { config } from './app/config'
import { globalErrorHandler } from './app/middleware/globalErrorHandler'
import { notFound } from './app/middleware/notFound'
import { authLimiter, generalLimiter } from './app/middleware/rateLimiter'
import { AuthRoutes } from './app/module/auth/auth.route'
import { MessageRoutes } from './app/module/message/message.route'
import { SosRoutes } from './app/module/sos/sos.route'
import { TaskRoutes } from './app/module/task/task.route'
import { UserRoutes } from './app/module/user/user.route'
import { VolunteerRequestRoutes } from './app/module/volunteer-request/volunteer-request.route'
import { sendResponse } from './app/utils/sendResponse'

const JSON_BODY_LIMIT = '1mb'
const PROXY_HOPS_IN_PRODUCTION = 1

const app = express()

// Behind a hosting proxy (Render, etc.) the client IP is in X-Forwarded-For. Trusting it lets the
// rate limiter see the real IP; locally there is no proxy, so don't trust the header.
if (config.nodeEnv === 'production') app.set('trust proxy', PROXY_HOPS_IN_PRODUCTION)

app.use(helmet())
app.use(cors({ origin: config.clientUrl }))
app.use(express.json({ limit: JSON_BODY_LIMIT }))

app.get('/', (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Welcome to AidBridge - bridging people in crisis with the help they need',
    data: {},
  })
})

// Registered before the rate limiter so uptime monitors can't be throttled out.
app.get('/api/v1/health', (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'AidBridge server is running',
    data: { uptime: process.uptime() },
  })
})

app.use('/api/v1', generalLimiter)

app.use('/api/v1/auth', authLimiter, AuthRoutes)
app.use('/api/v1/users', UserRoutes)
app.use('/api/v1/volunteer-requests', VolunteerRequestRoutes)
app.use('/api/v1/sos/:sosId/messages', MessageRoutes)
app.use('/api/v1/sos', SosRoutes)
app.use('/api/v1/tasks', TaskRoutes)

app.use(notFound)
app.use(globalErrorHandler)

export default app
