import app from './app'
import { config } from './app/config'
import { connectDB, disconnectDB } from './app/lib/db'

const main = async () => {
  await connectDB()
  console.log('Database connected')

  const server = app.listen(config.port, () => {
    console.log(`AidBridge server listening on port ${config.port}`)
  })

  const shutdown = () => {
    server.close(async () => {
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
