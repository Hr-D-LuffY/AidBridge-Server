import app from './app'
import { config } from './app/config'
import { DISPATCH_TICK_MS } from './app/constants/dispatch'
import { connectDB, disconnectDB } from './app/lib/db'
import { registerJob, startScheduler, stopScheduler } from './app/lib/scheduler'
import { DispatchService } from './app/module/dispatch/dispatch.service'

const main = async () => {
  await connectDB()
  console.log('Database connected')

  // Background jobs start only once the database is up. Later steps register theirs here too.
  registerJob({
    name: 'dispatch',
    intervalMs: DISPATCH_TICK_MS,
    run: () => DispatchService.runTick(),
  })
  startScheduler()

  const server = app.listen(config.port, () => {
    console.log(`AidBridge server listening on port ${config.port}`)
  })

  const shutdown = () => {
    server.close(async () => {
      await stopScheduler()
      await disconnectDB()
      process.exit(0)
    })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(async (error) => {
  console.error('Failed to start server:', error)
  await disconnectDB()
  process.exit(1)
})
