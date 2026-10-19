// A tiny in-process job loop (no cron package, R2). Each job is a function that is safe to run twice at
// once, because every action it takes is an atomic conditional update; a second server instance running
// the same job is therefore harmless. The scheduler only adds one rule of its own: a job never overlaps
// itself on this instance, so a slow pass is not started again on top of itself.

interface Job {
  name: string
  intervalMs: number
  run: () => Promise<void>
}

const jobs: Job[] = []
const timers: NodeJS.Timeout[] = []
const running = new Map<string, Promise<void>>()

export const registerJob = (job: Job) => {
  jobs.push(job)
}

const runOnce = (job: Job) => {
  if (running.has(job.name)) return
  const pass = job
    .run()
    // A job that throws must not stop the schedule: log it and try again on the next beat.
    .catch((error: unknown) => console.error(`Scheduled job "${job.name}" failed:`, error))
    .finally(() => running.delete(job.name))
  running.set(job.name, pass)
}

export const startScheduler = () => {
  for (const job of jobs) {
    const timer = setInterval(() => runOnce(job), job.intervalMs)
    // The HTTP server keeps the process alive; the timer alone must not.
    timer.unref()
    timers.push(timer)
  }
}

// Stops the timers and waits for passes that are already running, so shutdown does not cut one off.
export const stopScheduler = async () => {
  for (const timer of timers) clearInterval(timer)
  timers.length = 0
  await Promise.allSettled([...running.values()])
}
