import mongoose from 'mongoose'
import { config } from '../config'

const SERVER_SELECTION_TIMEOUT_MS = 10_000

// NoSQL-injection defence is Zod validation on every input plus never putting a raw req value into
// a filter. Mongoose's global `sanitizeFilter` is deliberately NOT enabled: it rewrites every
// nested `$` operator (`$in`, `$gt`, `$near`) and breaks our own server-built queries.

export const connectDB = async () => {
  await mongoose.connect(config.mongoUri, {
    serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
  })
}

export const disconnectDB = async () => {
  await mongoose.disconnect()
}
