import mongoose, { type ClientSession } from 'mongoose'

// Runs `work` in a MongoDB transaction: every write made with the given session commits together or
// not at all. Throwing (an AppError, say) rolls everything back and rethrows. MongoDB may run the
// callback more than once on a transient error, so keep side effects (emails, uploads) outside it.
export const runInTransaction = async <T>(work: (session: ClientSession) => Promise<T>) => {
  const session = await mongoose.startSession()
  try {
    let result: T | undefined
    await session.withTransaction(async () => {
      result = await work(session)
    })
    return result as T
  } finally {
    await session.endSession()
  }
}
