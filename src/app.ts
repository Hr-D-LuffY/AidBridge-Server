import express, { type Request, type Response } from 'express'
import httpStatus from 'http-status'
import { sendResponse } from './app/utils/sendResponse'

const app = express()

app.use(express.json())

app.get('/', (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Welcome to AidBridge - bridging people in crisis with the help they need',
    data: {},
  })
})

app.get('/api/v1/health', (_req: Request, res: Response) => {
  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'AidBridge server is running',
    data: { uptime: process.uptime() },
  })
})

export default app
