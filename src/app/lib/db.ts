import mongoose from 'mongoose'
import { config } from '../config'

const SERVER_SELECTION_TIMEOUT_MS = 10_000

// Mongoose strips query operators ($ne, $gt, ...) from user-supplied filter values. Zod validation
// is the first line of defence; this is the backstop if a raw object ever reaches a query.
mongoose.set('sanitizeFilter', true)

export const connectDB = async () => {
  await mongoose.connect(config.mongoUri, {
    serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
  })
}

export const disconnectDB = async () => {
  await mongoose.disconnect()
}
